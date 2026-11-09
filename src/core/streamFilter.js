/**
 * Filtro de streams SSE.
 *
 * Envuelve el cuerpo de una respuesta `text/event-stream` y reescribe el texto
 * que viaja dentro de cada evento. Los eventos de control, los ids y el orden
 * se conservan: el cliente del sitio no nota nada salvo que la respuesta deja
 * de repetirse.
 *
 * Dos detalles finos que hacen que esto no rompa la interfaz del sitio:
 *
 *  · Si el centinela corta, los eventos siguientes se siguen enviando pero con
 *    el texto vacío. Cortar el stream entero dejaría al cliente esperando un
 *    evento de cierre que nunca llega.
 *
 *  · El búfer de retención implica que los últimos ~100 caracteres todavía no
 *    salieron. Al cerrar se devuelven clonando el último evento de texto, y
 *    siempre ANTES de reenviar `[DONE]`.
 */

import { extractDeltas, parseSSE, serializeSSE, setPath } from './sse.js';
import { StreamSentinel } from './streamSentinel.js';

const encoder = new TextEncoder();

/**
 * @param {{
 *   settings?: object,
 *   deltaPaths?: string[]|null,
 *   language?: string,
 *   host?: string|null,
 *   onStop?: (info: object) => void,
 *   onEnd?: (info: object) => void
 * }} opts
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createStreamFilter(opts = {}) {
  const sentinel = new StreamSentinel({
    settings: opts.settings,
    host: opts.host ?? null,
    language: opts.language || 'es',
  });

  const decoder = new TextDecoder();
  let buffered = '';
  let stoppedReported = false;
  let lastDeltaEvent = null;
  let lastDeltaPaths = [];
  const delayed = [];

  const reportStop = () => {
    if (stoppedReported) return;
    stoppedReported = true;
    opts.onStop?.({
      code: sentinel.stopReason,
      droppedChars: sentinel.raw.length - sentinel.delivered.length,
      deliveredChars: sentinel.delivered.length,
    });
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      const { events, rest } = parseSSE(buffered);
      buffered = rest;
      if (!events.length) return;

      let out = '';
      for (const evt of events) {
        // `[DONE]` se retrasa: primero hay que devolver el texto retenido.
        if (evt.data === '[DONE]' || evt.data === 'DONE') {
          delayed.push(evt);
          continue;
        }

        const json = safeJson(evt.data);
        if (!json) {
          out += serializeSSE(evt);
          continue;
        }

        const { texts } = extractDeltas(json, { hintPaths: opts.deltaPaths });
        const delta = texts.map((t) => t.text).join('');

        if (delta) {
          const result = sentinel.push(delta);
          if (result.emit !== delta) {
            let first = true;
            for (const t of texts) {
              setPath(json, t.path, first ? result.emit : '');
              first = false;
            }
            if (result.stopped) reportStop();
          }
          lastDeltaEvent = json;
          lastDeltaPaths = texts.map((t) => t.path);
        }

        out += serializeSSE({ ...evt, data: JSON.stringify(json) });
      }
      if (out) controller.enqueue(encoder.encode(out));
    },

    flush(controller) {
      // 1) Cualquier resto sin terminar en el búfer se reenvía tal cual.
      let out = '';
      if (buffered.trim()) {
        out += buffered;
        buffered = '';
      }

      // 2) Cierre del centinela: entrega lo retenido dentro del último evento.
      const verdict = sentinel.finish();
      if (verdict.emit && lastDeltaEvent && lastDeltaPaths.length) {
        const clone = JSON.parse(JSON.stringify(lastDeltaEvent));
        let first = true;
        for (const path of lastDeltaPaths) {
          setPath(clone, path, first ? verdict.emit : '');
          first = false;
        }
        out += serializeSSE({ event: 'message', data: JSON.stringify(clone) });
      }

      // 3) Ahora sí, los eventos de cierre que estaban esperando.
      for (const evt of delayed) out += serializeSSE(evt);
      if (out) controller.enqueue(encoder.encode(out));

      opts.onEnd?.({
        stopped: verdict.stopped,
        code: verdict.stopReason,
        truncated: verdict.truncated,
        truncationReason: verdict.truncationReason,
        deliveredChars: verdict.chars,
        droppedChars: verdict.droppedChars,
        text: verdict.delivered,
        dropped: verdict.dropped,
      });
    },
  });
}

function safeJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

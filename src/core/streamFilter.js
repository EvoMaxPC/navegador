/**
 * Filtro de streams SSE.
 *
 * Envuelve el cuerpo de una respuesta `text/event-stream` y reescribe el texto
 * que viaja dentro de cada evento. Todo lo demás —nombre del evento, `id`,
 * `retry:`, comentarios de latido y metadatos— se reenvía **tal cual llegó**:
 * el cliente del sitio no tiene que notar nada salvo que la respuesta deja de
 * repetirse.
 *
 * Cuatro reglas que sostienen la corrección:
 *
 *  1. **Qué es texto lo decide el adaptador del proveedor**
 *     (`streamAdapters.js`), no una heurística suelta sobre claves.
 *
 *  2. **Si el centinela corta**, los eventos siguientes se siguen enviando pero
 *     sin texto. Cortar el stream dejaría al cliente esperando un cierre que
 *     nunca llega, y el sitio se quedaría «escribiendo» para siempre.
 *
 *  3. **El búfer de retención** implica que los últimos caracteres todavía no
 *     salieron. En un protocolo acumulado no se puede escribir el texto
 *     recibido: hay que escribir el **entregado**, o el texto retenido se vería
 *     como algo que aparece y desaparece.
 *
 *  4. **El texto pendiente sale antes del cierre.** Al llegar un evento de fin
 *     de bloque o de mensaje se entrega lo retenido en un evento sintético con
 *     la forma del último evento de texto, y después sí el cierre. Al final del
 *     stream, `[DONE]` va último.
 */

import { outcomeFromEvent } from './turnOutcome.js';
import { parseSSE, passthroughSSE, rewriteSSE, serializeSSE } from './sse.js';
import { StreamSentinel } from './streamSentinel.js';
import { createAdapter } from './streamAdapters.js';

const encoder = new TextEncoder();

/**
 * Resumen **estructural** del stream para el diagnóstico: cuenta formas, no
 * valores. Lo publica el proceso principal sólo con `NEXO_DIAG=1`
 * (`diag-stream-end`), y sirve para saber qué llegó cuando el acumulador saca 0
 * caracteres: cuántos eventos, cuántos JSON, qué nombres de evento y de clave,
 * qué tipo tiene `v` y cuántos eventos el extractor consideró portadores.
 *
 * Nunca guarda contenido: los nombres pasan por `LISTA_BLANCA` y lo que no
 * encaja se cuenta como `otros`; las listas quedan acotadas en variedad y en
 * longitud total.
 */
const LISTA_BLANCA = /^[a-z_]{1,24}$/;
const TOPE_NOMBRES = 12;
const TOPE_NOMBRES_RENDER = 2000;
const TOPE_TIPOS_V = 40;
const TOPE_SALIDA = 400;

function contarNombre(lista, crudo, contador) {
  const nombre = typeof crudo === 'string' ? crudo.trim().toLowerCase() : '';
  if (LISTA_BLANCA.test(nombre)) {
    if (!lista.includes(nombre)) {
      if (lista.length >= TOPE_NOMBRES) return;
      lista.push(nombre);
    }
    return;
  }
  // Sin nombre utilizable: sólo se cuenta, nunca se guarda.
  if (contador) contador.otros += 1;
}

function tipoDeV(valor) {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return 'array';
  return typeof valor;
}

function resumirEstructura(resumen) {
  const recorta = (lista) => {
    const caben = [];
    let total = 0;
    for (const nombre of lista) {
      if (total + nombre.length + 1 > TOPE_NOMBRES_RENDER) break;
      caben.push(nombre);
      total += nombre.length + 1;
    }
    return caben.join(',');
  };
  return {
    eventos: resumen.eventos,
    conDatos: resumen.conDatos,
    jsonValido: resumen.jsonValido,
    jsonInvalido: resumen.jsonInvalido,
    sinEvento: resumen.sinEvento,
    dones: resumen.dones,
    nombresEvento: recorta(resumen.nombresEvento),
    claves: recorta(resumen.claves),
    clavesOtros: resumen.clavesOtros,
    tiposV: recorta(resumen.tiposV),
    portadores: resumen.portadores,
    lineas: resumen.lineas,
  };
}

/**
 * @param {{
 *   format?: 'sse'|'ndjson'|'auto',
 *   settings?: object,
 *   adapter?: string|null,
 *   deltaPaths?: string[]|null,
 *   language?: string,
 *   host?: string|null,
 *   onStop?: (info: object) => void,
 *   onText?: (info: { text: string, deliveredChars: number }) => void,
 *   onEnd?: (info: object) => void,
 *   onError?: (info: { stage: string, message: string }) => void
 * }} opts
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createStreamFilter(opts = {}) {
  const sentinel = new StreamSentinel({
    settings: opts.settings,
    host: opts.host ?? null,
    language: opts.language || 'es',
  });

  // El adaptador puede entrar como objeto (pruebas, modos experimentales) o
  // como nombre del catálogo de proveedores.
  const adapter =
    opts.adapter && typeof opts.adapter === 'object'
      ? opts.adapter
      : createAdapter(opts.adapter || opts.provider || null, { deltaPaths: opts.deltaPaths || null });

  const decoder = new TextDecoder();
  let buffered = '';
  let format = opts.format || 'sse';
  let ended = false;
  const chatgpt = opts.adapter === 'chatgpt' || opts.provider === 'chatgpt';
  let protocolEnded = false;
  let outcome = null;
  const observeOutcome = (json) => {
    const next = outcomeFromEvent(json);
    if (next && (!outcome || outcome === 'completed')) outcome = next;
    if (chatgpt && (next === 'failed' || next === 'cancelled')) protocolEnded = true;
  };
  // Resumen estructural del stream (`diag-stream-end`). Se calcula siempre
  // —es un contador de formas, sin contenido y sin coste apreciable— porque el
  // filtro no conoce `NEXO_DIAG`; el proceso principal decide si lo publica.
  const estructura = {
    eventos: 0, conDatos: 0, jsonValido: 0, jsonInvalido: 0, sinEvento: 0, dones: 0,
    nombresEvento: [], claves: [], clavesOtros: 0, tiposV: [], portadores: 0, lineas: 0,
  };
  const contarEvento = (evt) => {
    estructura.eventos += 1;
    if (!evt.hasData) return false;
    estructura.conDatos += 1;
    if (!evt.event) estructura.sinEvento += 1;
    else contarNombre(estructura.nombresEvento, evt.event, null);
    return true;
  };
  /** Cuenta la forma de un JSON ya leído. `portador` = el extractor sacó texto. */
  const contarJson = (json, portador) => {
    estructura.jsonValido += 1;
    if (portador) estructura.portadores += 1;
    if (Array.isArray(json)) return;                    // sin claves de primer nivel
    if (!json || typeof json !== 'object') return;
    for (const clave of Object.keys(json)) contarNombre(estructura.claves, clave, estructura);
    if ('v' in json) {
      const tipo = tipoDeV(json.v);
      if (estructura.tiposV.length < TOPE_TIPOS_V && !estructura.tiposV.includes(tipo)) {
        if (LISTA_BLANCA.test(tipo)) estructura.tiposV.push(tipo);
      }
    }
  };
  const pendingChunks = [];
  let plainText = '';
  let lineText = '';
  let liveDeliveredChars = 0;
  const reportText = (text) => {
    if (!text) return;
    liveDeliveredChars += text.length;
    opts.onText?.({ text, deliveredChars: liveDeliveredChars });
  };

  const consumeLines = (final = false) => {
    const lines = buffered.split('\n');
    buffered = final ? '' : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      estructura.lineas += 1;
      const json = safeJson(line);
      if (!json) { estructura.jsonInvalido += 1; continue; }
      observeOutcome(json);
      const plan = adapter.read(json);
      const delta = (plan.segments || []).map((segment) => segment.newText).join('');
      contarJson(json, Boolean(delta));
      lineText += delta;
      reportText(delta);
      if (chatgpt && json.type === 'end') protocolEnded = true;
    }
  };

  // NDJSON se observaba sin mediación: conservar los bytes y usar el mismo
  // adaptador para su contenido, sin convertirlo al protocolo SSE.
  const finishCapture = (interrupted = false) => {
    if (ended) return;
    ended = true;
    if (format === 'ndjson') consumeLines(true);
    const verdict = sentinel.finish();
    const text = format === 'ndjson' ? (adapter.snapshot?.() ?? lineText)
      : format === 'text' ? plainText : verdict.delivered;
    opts.onEnd?.({
      stopped: format === 'sse' && verdict.stopped,
      code: interrupted ? 'stream-interrupted' : verdict.stopReason,
      truncated: interrupted || (format === 'sse' && verdict.truncated),
      truncationReason: interrupted ? 'stream-interrupted' : verdict.truncationReason,
      deliveredChars: text.length,
      droppedChars: format === 'sse' ? verdict.droppedChars : 0,
      text, dropped: format === 'sse' ? verdict.dropped : '',
      outcome: outcome === 'failed' || outcome === 'cancelled' ? outcome
        : (interrupted || verdict.stopped) ? 'unknown' : outcome || 'completed',
      interrupted, model: adapter.model?.() || '',
      estructura: resumirEstructura(estructura),
    });
  };
  let stoppedReported = false;
  let failureReported = false;
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

  /**
   * Reparte el texto que el centinela acaba de entregar entre los tramos del
   * evento.
   *
   * Puede ocurrir que lo entregado ahora incluya texto retenido de eventos
   * anteriores: el centinela entrega de forma continua y el cable tiene eventos
   * discretos. Ese excedente se pone al principio del primer tramo, que es su
   * lugar en el orden del texto.
   */
  const distribute = (segments, emit) => {
    const values = segments.map(() => '');
    let restante = emit || '';
    let primero = true;
    for (let i = 0; i < segments.length && restante; i += 1) {
      if (segments[i].cumulative) continue;
      const toma = Math.min(segments[i].newText.length, restante.length);
      values[i] = restante.slice(0, toma);
      restante = restante.slice(toma);
      if (primero) {
        primero = false;
        if (restante) {
          values[i] = restante + values[i];
          restante = '';
        }
      }
    }
    if (restante) {
      const index = segments.findIndex((segment) => !segment.cumulative);
      if (index >= 0) values[index] = restante + values[index];
    }
    // Acumulado: el cliente reemplaza el contenido, así que se le da el texto
    // que ya tiene (el entregado), nunca el recibido.
    segments.forEach((segment, i) => {
      if (segment.cumulative) values[i] = sentinel.delivered;
    });
    return values;
  };

  /** Evento sintético con el texto que quedaba retenido. */
  const pendingEvent = (text) => {
    const synth = adapter.pending({ text, delivered: sentinel.delivered });
    if (!synth || !synth.json) return '';
    return serializeSSE({ event: synth.event || 'message', data: JSON.stringify(synth.json) });
  };

  /** Entrega lo retenido sin cerrar el turno (antes de un evento de cierre). */
  const flushPending = () => {
    const text = sentinel.release();
    reportText(text);
    return text ? pendingEvent(text) : '';
  };

  /** Procesa un evento ya parseado y devuelve lo que hay que escribir en el cable. */
  const handleEvent = (evt) => {
    contarEvento(evt);
    // ChatGPT recibe el fin lógico sin esperar EOF; primero liberar lo retenido.
    // Los otros proveedores conservan su cierre diferido.
    if (evt.data === '[DONE]' || evt.data === 'DONE') {
      estructura.dones += 1;
      if (chatgpt) {
        protocolEnded = true;
        outcome ||= 'completed';
        return flushPending() + passthroughSSE(evt);
      }
      delayed.push(evt);
      return '';
    }

    // Latidos, `retry:` y comentarios: sin datos que interpretar.
    if (!evt.hasData) return passthroughSSE(evt);

    if (chatgpt && evt.event === 'error') {
      outcome = 'failed';
      protocolEnded = true;
    }
    const json = safeJson(evt.data);
    if (!json) {
      estructura.jsonInvalido += 1;
      return passthroughSSE(evt);
    }

    observeOutcome(json);
    const plan = adapter.read(json);
    // Sólo el cierre de la conversación: un mensaje oculto o una herramienta
    // puede finalizar antes de que llegue la respuesta visible.
    if (chatgpt && json.type === 'message_stream_complete') protocolEnded = true;
    const segments = plan.segments || [];
    contarJson(json, segments.length > 0);

    if (!segments.length) {
      // Evento de control. Si cierra un bloque o el mensaje, el texto retenido
      // tiene que salir antes que él.
      const body = passthroughSSE(evt);
      return plan.terminal || protocolEnded ? flushPending() + body : body;
    }

    const delta = segments.map((segment) => segment.newText).join('');
    const result = sentinel.push(delta);
    const values = distribute(segments, result.emit);
    reportText(result.emit);
    adapter.write(json, segments, values, evt.event);

    if (result.stopped) reportStop();

    const body = rewriteSSE(evt, JSON.stringify(json));
    // Un evento que trae texto y además cierra: el texto ya salió en él, así que
    // no se libera nada acá; lo que quede se entrega en el cierre siguiente.
    return body;
  };

  /**
   * Un fallo del adaptador no puede romper el stream del sitio.
   *
   * Un `throw` dentro de `transform()` cierra el cuerpo de la respuesta: la
   * página recibe la petición de chat rota y el sitio muestra su propio error
   * de red. Por eso, si el adaptador falla, el evento se reenvía **tal cual
   * llegó** y el fallo se informa una sola vez. La mediación puede entonces
   * quedarse sin efecto en ese evento, pero nunca romper la conversación.
   */
  const safeHandle = (evt) => {
    try {
      return handleEvent(evt);
    } catch (error) {
      if (!failureReported) {
        failureReported = true;
        opts.onError?.({ stage: 'event', message: String(error?.message || error) });
      }
      return passthroughSSE(evt);
    }
  };

  const stream = new TransformStream({
    transform(chunk, controller) {
      const decoded = decoder.decode(chunk, { stream: true });
      buffered += decoded;
      if (format === 'auto') {
        pendingChunks.push(chunk);
        const head = buffered.trimStart();
        if (!head || (!head.includes('\n') && head.length < 512 && !/^[{[]/.test(head))) return;
        format = /^[{[]/.test(head) ? 'ndjson' : /^(?:data|event|id|retry):|^:/.test(head) ? 'sse' : 'text';
        if (format !== 'sse') for (const raw of pendingChunks) controller.enqueue(raw);
        pendingChunks.length = 0;
        if (format === 'text') { plainText += buffered; reportText(buffered); buffered = ''; return; }
        if (format === 'ndjson') {
          consumeLines();
          if (protocolEnded) finishCapture();
          return;
        }
      } else if (format === 'ndjson') {
        controller.enqueue(chunk);
        consumeLines();
        if (protocolEnded) finishCapture();
        return;
      } else if (format === 'text') {
        controller.enqueue(chunk);
        plainText += decoded;
        reportText(decoded);
        buffered = '';
        return;
      }
      const { events, rest } = parseSSE(buffered);
      buffered = rest;
      if (!events.length) return;

      let out = '';
      for (const evt of events) out += safeHandle(evt);
      if (out) controller.enqueue(encoder.encode(out));
      if (protocolEnded) finishCapture();
    },

    flush(controller) {
      buffered += decoder.decode();
      if (format === 'auto') {
        const head = buffered.trimStart();
        format = /^[{[]/.test(head) ? 'ndjson' : /^(?:data|event|id|retry):|^:/.test(head) ? 'sse' : 'text';
        if (format !== 'sse') for (const raw of pendingChunks) controller.enqueue(raw);
        pendingChunks.length = 0;
        if (format === 'text') { plainText += buffered; reportText(buffered); }
      }
      if (format !== 'sse') { finishCapture(); return; }
      let out = '';

      // 1) Un evento final sin la línea en blanco todavía se procesa; si llegó
      //    cortado por la red, se reenvía tal cual (que el cliente decida).
      if (buffered.trim()) {
        const resto = buffered;
        buffered = '';
        try {
          const { events } = parseSSE(`${resto}\n\n`);
          const ultimo = events[0];
          out += ultimo && safeJson(ultimo.data) ? safeHandle(ultimo) : resto;
        } catch {
          out += resto;
        }
      }

      // 2) Cierre del centinela: entrega lo retenido antes de los cierres.
      try {
        out += flushPending();
      } catch (error) {
        if (!failureReported) {
          failureReported = true;
          opts.onError?.({ stage: 'flush', message: String(error?.message || error) });
        }
      }

      // 3) Ahora sí, los eventos que estaban esperando (`[DONE]`).
      for (const evt of delayed) out += passthroughSSE(evt);
      if (out) controller.enqueue(encoder.encode(out));

      finishCapture();
    },
  });
  // pipeTo rechaza si el origen falla o el consumidor cancela: notificar una
  // única captura parcial sin ocultar ese error a la página.
  stream.finishInterrupted = () => finishCapture(true);
  return stream;
}

function safeJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

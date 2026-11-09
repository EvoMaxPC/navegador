import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStreamFilter } from '../src/core/streamFilter.js';
import { parseSSE, serializeSSE } from '../src/core/sse.js';
import { CLEAN_ANSWER, LOOPING_ANSWER, chunk } from './fixtures.js';

const encoder = new TextEncoder();

/** Construye un stream SSE estilo OpenAI a partir de un texto. */
function openAIStream(text, { size = 9, withDone = true } = {}) {
  const events = chunk(text, size).map(
    (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`,
  );
  if (withDone) events.push('data: [DONE]\n\n');
  return events.join('');
}

/** Ejecuta el filtro y devuelve el texto reconstruido por el «cliente». */
async function runFilter(payload, opts = {}) {
  const bytes = encoder.encode(payload);
  const source = new ReadableStream({
    start(controller) {
      // Se entrega en trozos pequeños para ejercitar el parser incremental.
      for (let i = 0; i < bytes.length; i += 64) controller.enqueue(bytes.slice(i, i + 64));
      controller.close();
    },
  });

  const stops = [];
  const ends = [];
  const filter = createStreamFilter({
    settings: opts.settings || { receiving: { severityThreshold: 'medium', stopOnLoop: true } },
    deltaPaths: opts.deltaPaths || null,
    onStop: (info) => stops.push(info),
    onEnd: (info) => ends.push(info),
  });

  const out = await new Response(source.pipeThrough(filter)).text();
  const { events } = parseSSE(out);

  let text = '';
  const others = [];
  for (const evt of events) {
    if (evt.data === '[DONE]') {
      others.push('DONE');
      continue;
    }
    try {
      const json = JSON.parse(evt.data);
      const delta = opts.extract
        ? opts.extract(json)
        : json?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') text += delta;
      else others.push(evt.data);
    } catch {
      others.push(evt.data);
    }
  }
  return { text, raw: out, events, others, stops, ends };
}

test('un stream limpio se reconstruye exactamente igual', async () => {
  const payload = openAIStream(CLEAN_ANSWER);
  const { text, ends, others } = await runFilter(payload);
  assert.equal(text, CLEAN_ANSWER);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].stopped, false);
  assert.ok(others.includes('DONE'), '[DONE] debe llegar al cliente');
});

test('[DONE] es el último evento, después del texto retenido', async () => {
  const { events } = await runFilter(openAIStream(CLEAN_ANSWER));
  assert.equal(events.at(-1).data, '[DONE]');
});

test('el bucle de párrafo no llega al cliente', async () => {
  const { text, stops, ends } = await runFilter(openAIStream(LOOPING_ANSWER));
  const occurrences = (text.match(/La arquitectura propuesta/g) || []).length;
  assert.equal(occurrences, 1, `el párrafo apareció ${occurrences} veces`);
  assert.ok(text.startsWith('## Estrategia de reintentos'));
  assert.ok(stops.length >= 1, 'debe avisar del corte en vivo');
  assert.ok(stops[0].droppedChars > 0);
  assert.equal(ends[0].stopped, true);
});

test('el stream sigue cerrando aunque haya corte', async () => {
  const { others, events } = await runFilter(openAIStream(LOOPING_ANSWER));
  assert.ok(others.includes('DONE'));
  assert.ok(events.length > 0);
});

test('no reescribe nada si el centinela está desactivado por umbral', async () => {
  const { text, ends } = await runFilter(openAIStream(LOOPING_ANSWER), {
    settings: { receiving: { severityThreshold: 'high', stopOnLoop: false } },
  });
  assert.equal(text, LOOPING_ANSWER);
  assert.equal(ends[0].stopped, false);
});

test('conserva eventos de control que no son texto', async () => {
  const payload =
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', role: 'assistant' } })}\n\n` +
    openAIStream('Hola, ¿qué tal?') +
    '';
  const { others } = await runFilter(payload);
  assert.ok(others.some((o) => String(o).includes('message_start')));
});

test('funciona con deltas anidados mediante pistas del adaptador', async () => {
  const text = 'Texto de prueba con suficiente longitud para el filtro.';
  const events = chunk(text, 8)
    .map((d) => `data: ${JSON.stringify({ delta: { text: d } })}\n\n`)
    .join('');
  const { text: out } = await runFilter(events, {
    deltaPaths: ['delta.text'],
    extract: (json) => json?.delta?.text,
  });
  assert.equal(out, text);
});

test('tolera datos corruptos sin romper el stream', async () => {
  const payload = `data: no-es-json\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`;
  const { text, others } = await runFilter(payload);
  assert.equal(text, 'ok');
  assert.ok(others.includes('no-es-json'));
});

test('los límites de trozo arbitrarios no rompen el parseo', async () => {
  const payload = openAIStream(CLEAN_ANSWER, { size: 4 });
  const bytes = encoder.encode(payload);
  const source = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  const filter = createStreamFilter({ settings: { receiving: { severityThreshold: 'medium' } } });
  const out = await new Response(source.pipeThrough(filter)).text();
  const { events } = parseSSE(out);
  let text = '';
  for (const evt of events) {
    if (evt.data === '[DONE]') continue;
    try {
      text += JSON.parse(evt.data)?.choices?.[0]?.delta?.content ?? '';
    } catch {
      /* ignorar */
    }
  }
  assert.equal(text, CLEAN_ANSWER);
});

test('serializeSSE y parseSSE son inversos', () => {
  const evt = { event: 'message', data: '{"a":1}' };
  const [back] = parseSSE(serializeSSE(evt)).events;
  assert.equal(back.data, '{"a":1}');
});

/* ------------------------------------------------------------------ */
/* tolerancia a fallos                                                 */
/* ------------------------------------------------------------------ */

test('si el adaptador falla, el evento se reenvía intacto y se informa una vez', async () => {
  const payload = openAIStream('respuesta cualquiera que no debe perderse', { size: 11 });

  const errores = [];
  const ends = [];
  const source = new Response(payload).body;
  const filter = createStreamFilter({
    // Adaptador de mentira que no sabe leer nada: simula la versión del sitio
    // que la mediación todavía no entiende.
    adapter: {
      name: 'roto',
      read() {
        throw new Error('formato desconocido');
      },
      write() {},
      pending() {
        return null;
      },
    },
    onError: (info) => errores.push(info),
    onEnd: (info) => ends.push(info),
  });

  // Si el filtro dejara escapar la excepción, esta lectura rechazaría: es
  // exactamente lo que la página vería como «petición rota».
  const out = await new Response(source.pipeThrough(filter)).text();

  assert.equal(errores.length, 1, 'se informa una sola vez, no en cada evento');
  assert.equal(errores[0].stage, 'event');
  assert.match(errores[0].message, /formato desconocido/);
  assert.equal(ends.length, 1, 'el cierre del turno igual se avisa');

  const { events } = parseSSE(out);
  const enviados = events.map((evt) => evt.data).filter((data) => data !== '[DONE]');
  const originales = parseSSE(payload)
    .events.map((evt) => evt.data)
    .filter((data) => data !== '[DONE]');
  assert.deepEqual(enviados, originales, 'los eventos llegan tal cual, sin reescribir');
  assert.equal(events.at(-1).data, '[DONE]', 'y el cierre sigue yendo último');
});

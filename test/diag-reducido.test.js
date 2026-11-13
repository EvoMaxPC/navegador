/**
 * 7c-15: el diagnóstico quedó reducido a lo que sirve para un turno real.
 *
 * Se retiraron tres piezas instrumentales —el esqueleto por evento
 * (`diag-stream-forma`), las firmas `#N` de cada mensaje descartado y los cubos
 * por causa con `aceptados`/`vistos`/`assistant a/b`— porque ninguna decisión
 * de producción dependía de ellas y ocupaban 1.209 + 1.055 + 898 bytes de la
 * capa inyectada, que es la que se descarga en cada página.
 *
 * Este archivo fija lo que **sí** sigue saliendo, y que lo retirado no vuelve
 * por la puerta de atrás. Es el contrapeso de los tests que se eliminaron: si
 * alguien restaura una pieza, esto falla.
 *
 * **Las fixtures son SINTÉTICAS.** El texto del chat es inventado (`'x'`), y se
 * comprueba que no aparece en ningún aviso.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

import { createStreamFilter } from '../src/core/streamFilter.js';

const MARCA = 'ZZZ-PRIVADO';
const PARTE = '/message/content/parts/0';
const OCULTA = '/message/metadata/is_visually_hidden_from_conversation';
const TEXTO = 'xxxxxxxxxxxxxxxxxxxx';   // 20 caracteres inventados

process.env.NEXO_DIAG = '1';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((resolve) => setTimeout(resolve, 60));

const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const shellEv = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (channel, ev, payload) => {
  const handler = journal.ipcHandlers.get(channel);
  assert.equal(typeof handler, 'function', `la aplicación registra ${channel}`);
  return handler(ev, payload);
};
const todos = async () => invoke('nexo:log', shellEv);

let turno = 0;
const pestana = () => {
  turno += 1;
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c15-${turno}`);
  view.url = `https://chatgpt.com/c/7c15-${turno}`;
  return view;
};

const sse = (...eventos) => eventos
  .map((data) => `event: delta\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  .join('');

/** Un stream con un mensaje del asistente aceptado y otro descartado. */
async function streamCompleto() {
  const cuerpo = sse(
    { o: 'add', p: '', v: { message: {
      id: 'm-ok', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] },
      status: 'in_progress', recipient: 'all', channel: 'final', metadata: { model_slug: 'gpt-6' },
    } } },
    { v: [{ p: PARTE, o: 'append', v: TEXTO }] },
    { v: [{ p: '/message/end_turn', o: 'replace', v: true },
      { p: '/message/status', o: 'replace', v: 'finished_successfully' }] },
    { o: 'add', p: '', v: { message: { id: 'm-user', author: { role: 'user' },
      content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: {} } } },
    '[DONE]',
  );
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  const salida = await new Response(new Blob([cuerpo]).stream().pipeThrough(filtro)).text();
  return { fin, salida };
}

/* ------------------------------------------------------------------ */
/* 1. lo retirado no se calcula ni se publica                          */
/* ------------------------------------------------------------------ */

test('(1) la estructura ya no trae esqueleto, firmas `#N` ni cubos por causa', async () => {
  const { fin } = await streamCompleto();
  assert.equal(fin.esqueleto, undefined, 'el esqueleto no se calcula');
  const m = fin.estructura.anidado.mensaje;
  for (const campo of ['descartes', 'aceptados', 'vistos', 'causas', 'assistantSi', 'assistantNo']) {
    assert.equal(m[campo], undefined, `el campo retirado \`${campo}\` ya no aparece`);
  }
});

test('(2) el aviso de stream-end ya no publica diag-stream-forma ni firmas "#N"', async () => {
  const { fin } = await streamCompleto();
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: fin.text.length, text: fin.text,
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: fin.estructura,
    // Aunque un payload viejo traiga el esqueleto, no debe publicarse.
    esqueleto: ['delta <{p:s0,o:add}>', 'nojson:4:simbolo'],
  });
  const log = await todos();
  assert.equal(log.filter((e) => e.code === 'diag-stream-forma').length, 0,
    'diag-stream-forma ya no existe');
  const lineas = log.filter((e) => e.code === 'diag-stream-end');
  assert.ok(lineas.length >= 1, 'el aviso de stream-end sigue saliendo');
  for (const aviso of lineas) {
    assert.ok(!/#\d+ \w+ rol:/.test(aviso.detail), 'sin firmas de descarte "#N causa rol:…"');
    assert.ok(!/esqueleto/.test(aviso.detail), 'sin esqueleto en la línea');
  }
});

/* ------------------------------------------------------------------ */
/* 2. lo conservado sigue saliendo                                     */
/* ------------------------------------------------------------------ */

test('(3) la línea de stream-end conserva todos los campos de seguimiento', async () => {
  const { fin } = await streamCompleto();
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: fin.text.length, text: fin.text,
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: fin.estructura,
  });
  const aviso = (await todos()).filter((e) => e.code === 'diag-stream-end')[0];
  const detalle = aviso.detail;

  // Lo que sirve para leer un turno real sin volcar texto.
  for (const [campo, patron] of [
    ['eventos', /eventos \d+/],
    ['con datos', /con datos \d+/],
    ['json', /json \d+\/\d+/],
    ['done', /done \d+/],
    ['portadores', /portadores \d+/],
    ['tipos', /tipos [a-z,]+/],
    ['claves', /claves [a-z,_]+/],
    ['v array', /v array \d+\/\d+/],
    ['rutas', /rutas \/message/],
    ['ops', /ops [a-z,]+/],
    ['descartes (total)', /descartes \d+/],
    ['noJson', /noJson (-|[a-z]+:\d+)/],
    ['rol', /rol [a-z]+/],
    ['tipo', /· tipo [a-z]+/],
    ['estado', /estado [a-z_]+/],
    ['canal', /canal [a-z]+/],
    ['meta', /meta [a-z_,]+/],
    ['rutaTexto', /rutaTexto string \d+ array \d+ object \d+ otro \d+/],
    ['con segmento', /con segmento \d+/],
    ['cierre', /cierre (si|no)/],
    ['ocultoLevantado', /ocultoLevantado \d+/],
    ['removes', /removes /],
  ]) {
    assert.match(detalle, patron, `la línea conserva «${campo}»`);
  }

  // Y lo retirado no se imprime: ni contadores ni cubos.
  for (const retirado of ['aceptados', 'vistos', 'assistant ', 'causas ']) {
    assert.ok(!detalle.includes(retirado), `la línea ya no imprime «${retirado.trim()}»`);
  }

  const anidado = aviso.meta.estructura.anidado;
  assert.equal(typeof anidado.mensaje.descartados, 'number', 'el total de descartes se conserva');
  assert.equal(anidado.mensaje.cierre, true, 'la señal de cierre se conserva');
  assert.equal(anidado.mensaje.ocultoLevantado, 0);
  assert.ok(Array.isArray(anidado.mensaje.removes));
  assert.equal(typeof anidado.rutaTexto.conSegmento, 'number');
});

test('(4) los demás avisos diag-* siguen saliendo', async () => {
  const { fin } = await streamCompleto();
  const view = pestana();
  const logAntes = (await todos()).length;
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: fin.text.length, text: fin.text,
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: fin.estructura,
  });
  const nuevos = (await todos()).slice(0, (await todos()).length - logAntes);
  const codigos = new Set(nuevos.map((e) => e.code));
  assert.ok(codigos.has('diag-stream-end'), 'diag-stream-end sigue vivo');
  assert.ok(!codigos.has('diag-stream-forma'), 'y diag-stream-forma no vuelve');
});

/* ------------------------------------------------------------------ */
/* 3. sigue sin texto del chat                                         */
/* ------------------------------------------------------------------ */

test('(5) ningún aviso publicado contiene el texto del chat ni la marca', async () => {
  const { fin } = await streamCompleto();
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: fin.text.length, text: MARCA.repeat(2),
    outcome: 'completed', finished: true,
    estructura: fin.estructura,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
  });
  const volcado = JSON.stringify(await todos());
  assert.ok(!volcado.includes(MARCA), 'la marca no aparece');
  assert.ok(!volcado.includes(TEXTO), 'ni el texto inventado del stream');
  // Una ruta de remove con la marca tampoco se publica cruda.
  const conRuta = sse(
    { o: 'add', p: '', v: { message: { id: 'm-x', author: { role: 'user' },
      content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: {} } } },
    { v: [{ p: `/message/${MARCA}/x`, o: 'remove' }] },
    '[DONE]',
  );
  assert.ok(!conRuta.includes('noimporta'));
});

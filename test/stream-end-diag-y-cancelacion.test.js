/**
 * 7c-8: qué leyó la capa cuando el cierre llega sin texto, y qué se anuncia
 * cuando la lectura se cancela.
 *
 * Dos mitades:
 *
 *  1. `diag-stream-end` (sólo con `NEXO_DIAG=1`) dice el MIME, el formato
 *     elegido, cuántos trozos y cuántos bytes se leyeron. Sirve para decidir si
 *     un cierre con 0 caracteres viene de haber leído otro formato.
 *  2. Un rechazo de la lectura **sin motivo** (la página cancela el cuerpo) ya
 *     no se anuncia como «Fallo de la mediación»: deja `diag-cancelacion`, y
 *     sólo con la variable encendida. Un error con mensaje o un AbortError
 *     siguen avisando como siempre.
 *
 * La capa se ejecuta de verdad: `build/inject.js` en un `vm` con el mismo mundo
 * mínimo que usa `test/capa-inyectada.test.js`. El proceso principal es el real
 * de `src/main/main.js` con el arnés de siempre.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

const RUTA = new URL('../build/inject.js', import.meta.url);
const fuente = existsSync(RUTA) ? readFileSync(RUTA, 'utf8') : null;
const sinBundle = !fuente && 'falta build/inject.js (npm run build:inject)';

/* ------------------------------------------------------------------ */
/* capa inyectada                                                      */
/* ------------------------------------------------------------------ */

/**
 * Mundo mínimo para la capa. `cuerpo` puede ser un texto (se sirve como un solo
 * trozo) o un `ReadableStream` propio, que es como se simulan lectura cancelada
 * y errores de red.
 */
function crearMundo({ cuerpo, contentTypes = {} } = {}) {
  const listeners = [];
  const salientes = [];
  const peticiones = [];
  const encabezados = { 'content-type': 'text/event-stream', ...contentTypes };

  const fetchNativo = async (input, init) => {
    peticiones.push({ input: String(input), init });
    const body = typeof cuerpo === 'string' ? cuerpo : cuerpo();
    return new Response(body, { status: 200, headers: encabezados });
  };

  const window = {
    __NEXO_CONFIG__: { host: 'chatgpt.com', enabled: true, settings: {}, language: 'es', version: '0.1.0', site: 'chatgpt' },
    location: { href: 'https://chatgpt.com/c/7c8', hostname: 'chatgpt.com', pathname: '/c/7c8', protocol: 'https:' },
    fetch: fetchNativo,
    addEventListener: (tipo, fn) => { if (tipo === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => {
      salientes.push(msg);
      if (msg.__nexo !== 'call') return;
      setTimeout(() => {
        const data = { __nexo: 'reply', id: msg.id, payload: { text: String(msg.payload?.prompt || '') } };
        for (const fn of listeners) fn({ source: window, data });
      }, 0);
    },
    setTimeout, clearTimeout, TextDecoder, TextEncoder,
    ReadableStream, WritableStream, TransformStream, Response, Headers, Request, URL,
    console,
    navigator: { userAgent: 'Chrome' },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  };
  window.window = window;
  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });
  return { window, salientes, peticiones };
}

const cuerpoChatGPT = (texto) => JSON.stringify({
  action: 'next',
  messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
});
const sse = (texto) => `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: texto })}\n\ndata: [DONE]\n\n`;
const eventos = (mundo, tipo) => mundo.salientes.filter((m) => m.type === tipo);

/** Envuelve el cuerpo, lo lee y devuelve los eventos que emitió la capa. */
async function transitar(mundo, { leer = true } = {}) {
  const respuesta = await mundo.window.fetch('https://chatgpt.com/backend-api/conversation', {
    method: 'POST', body: cuerpoChatGPT('hola'),
  });
  if (leer) await respuesta.text().catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  return respuesta;
}

test('(a) la capa informa mime, formato, trozos y bytes de lo leído', { skip: sinBundle }, async () => {
  const mundo = crearMundo({ cuerpo: sse('Hola mundo') });
  await transitar(mundo);

  const cierre = eventos(mundo, 'stream-end')[0];
  assert.ok(cierre, 'la capa cierra el turno');
  const diag = cierre.payload.diag;
  assert.equal(diag.mime, 'text/event-stream', 'sólo tipo/subtipo');
  assert.equal(diag.formato, 'sse');
  assert.equal(diag.bytes, sse('Hola mundo').length, 'los bytes del cuerpo leído');
  assert.ok(diag.trozos >= 1, 'al menos un trozo');

  // Y con un MIME con parámetros: se publica sin el `; charset=…`.
  const conParametros = crearMundo({
    cuerpo: sse('Hola'),
    contentTypes: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
  await transitar(conParametros);
  assert.equal(eventos(conParametros, 'stream-end')[0].payload.diag.mime, 'text/event-stream');
});

test('(c) los campos de diagnóstico no llevan texto del chat, cabeceras ni URL', { skip: sinBundle }, async () => {
  const texto = 'CENTINELA-7c8-no-debe-salir';
  const mundo = crearMundo({ cuerpo: sse(texto) });
  await transitar(mundo);
  const cierre = eventos(mundo, 'stream-end')[0].payload;
  const volcado = JSON.stringify(cierre.diag);
  assert.ok(!volcado.includes(texto), 'ni el texto de la respuesta');
  assert.ok(!volcado.includes('hola'), 'ni el del usuario');
  assert.ok(!volcado.includes('charset'), 'ni parámetros del MIME');
  assert.ok(!volcado.includes('https://'), 'ni la URL');
  assert.deepEqual(Object.keys(cierre.diag).sort(), ['bytes', 'formato', 'mime', 'trozos'], 'sólo números y etiquetas');
});

/* ------------------------------------------------------------------ */
/* proceso principal                                                   */
/* ------------------------------------------------------------------ */

const DIAG = process.env.NEXO_DIAG === '1';
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
const escuchar = (canal, ev, mensaje) => {
  const handler = journal.ipcListeners.get(canal);
  assert.equal(typeof handler, 'function', `la aplicación escucha ${canal}`);
  return handler(ev, mensaje);
};
const registro = async () => invoke('nexo:log', shellEv);
const avisos = async (code) => (await registro()).filter((e) => e.code === code);

let turno = 0;
/** Una pestaña nueva por escenario: el motor asocia el turno por pestaña. */
function pestana() {
  turno += 1;
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c8-${turno}`);
  view.url = `https://chatgpt.com/c/7c8-${turno}`;
  return view;
}
/** Cierra el turno como lo hace la capa: `stream-end` con el texto leído. */
function cerrar(view, extra = {}) {
  return invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: `m-${turno}`, chars: 0, deliveredChars: 0,
    text: '', outcome: 'completed', interrupted: true, finished: false, source: 'dom-recovery',
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 3, bytes: 512 },
    ...extra,
  });
}

test('(a bis) con NEXO_DIAG=1 diag-stream-end incluye mime, formato, trozos y bytes', async () => {
  const view = pestana();
  cerrar(view);
  const aviso = (await avisos('diag-stream-end')).at(0);
  assert.ok(aviso, 'el aviso sale con la variable encendida');
  assert.equal(aviso.meta.mime, 'text/event-stream');
  assert.equal(aviso.meta.formato, 'sse');
  assert.equal(aviso.meta.chunks, 3);
  assert.equal(aviso.meta.bytes, 512);
  assert.match(aviso.detail, /mime text\/event-stream · formato sse · trozos 3 · bytes 512/);
});

test('(b) con NEXO_DIAG apagado el mismo cierre no publica ningún aviso de diagnóstico', () => {
  // `diagOn` se lee al importar `main.js` (`main.js:314`), así que el estado
  // apagado se comprueba en un proceso hijo, igual que hace el repo con
  // `diag-main-off.test.js`. Antes y después se publica **lo mismo**.
  const cargador = new URL('./harness/loader.mjs', import.meta.url).href;
  const preludio = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(cargador)},import.meta.url)`;
  const guion = `
import { journal } from './test/harness/electron-stub.mjs';
await import('./src/main/main.js');
await new Promise((r) => setTimeout(r, 60));
const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const view = journal.windows[0].attachWebview('https://chatgpt.com/c/off');
await journal.ipcHandlers.get('nexo:stream-end')({ sender: view, senderFrame: view.mainFrame },
  { site: 'chatgpt', host: 'chatgpt.com', messageId: 'm', chars: 0, text: '',
    outcome: 'completed', finished: false,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 2, bytes: 9 } });
await journal.ipcListeners.get('nexo:event')({ sender: view, senderFrame: view.mainFrame },
  { type: 'error', payload: { stage: 'stream-interrupted', message: 'undefined', sinMotivo: true } });
const log = await journal.ipcHandlers.get('nexo:log')({ sender: shell, senderFrame: shell.mainFrame });
console.log('DIAG=' + JSON.stringify(log.filter((e) => String(e.code).startsWith('diag-'))));
`;
  const salida = spawnSync(process.execPath, ['--import', preludio, '--input-type=module', '-e', guion],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, NEXO_DIAG: '0' } });
  assert.equal(salida.status, 0, `el hijo termina bien: ${salida.stderr}`);
  const linea = (salida.stdout || '').split('\n').find((l) => l.startsWith('DIAG='));
  assert.ok(linea, `el hijo informa: ${salida.stdout}`);
  assert.deepEqual(JSON.parse(linea.slice(5)), [], 'sin la variable no sale ni diag-stream-end ni diag-cancelacion');
});

test('(c bis) el aviso del proceso principal tampoco lleva texto, cabeceras ni URL', async () => {
  const view = pestana();
  cerrar(view, { text: 'CENTINELA-7c8-no-debe-salir', chars: 26,
    diag: { mime: 'text/event-stream; charset=utf-8', formato: 'sse', trozos: 1, bytes: 26 } });
  const aviso = (await avisos('diag-stream-end')).at(0);
  const volcado = JSON.stringify({ detail: aviso.detail, meta: aviso.meta });
  assert.ok(!volcado.includes('CENTINELA'), 'ni el texto');
  assert.ok(!volcado.includes('charset'), 'ni parámetros del MIME');
  assert.ok(!volcado.includes('https://'), 'ni la URL');
});

test('(d) rechazo sin motivo: no hay page-error y sí diag-cancelacion', async () => {
  const view = pestana();
  const antesError = (await avisos('page-error')).length;
  const antesCancelacion = (await avisos('diag-cancelacion')).length;
  escuchar('nexo:event', { sender: view, senderFrame: view.mainFrame }, {
    type: 'error', payload: { stage: 'stream-interrupted', message: 'undefined', sinMotivo: true },
  });
  assert.equal((await avisos('page-error')).length, antesError, 'no se anuncia un fallo de la mediación');
  const cancelaciones = await avisos('diag-cancelacion');
  assert.equal(cancelaciones.length, antesCancelacion + 1, 'se anota la cancelación');
  assert.equal(cancelaciones.at(0).meta.stage, 'stream-interrupted');
});

/**
 * `page-error` se deduplica por título durante 30 s (`main.js:322-330`): dos
 * errores seguidos dejan **una** entrada. Eso es el comportamiento de siempre y
 * no se toca; el test lo tiene en cuenta mirando la entrada que sí queda.
 */
test('(e) un rechazo con mensaje sigue produciendo el aviso de siempre', async () => {
  const view = pestana();
  escuchar('nexo:event', { sender: view, senderFrame: view.mainFrame }, {
    type: 'error', payload: { stage: 'stream-interrupted', message: 'net::ERR_CONNECTION_RESET', motivo: 'net::ERR_CONNECTION_RESET' },
  });
  const errores = (await avisos('page-error')).filter((e) => /net::ERR_CONNECTION_RESET/.test(e.detail));
  assert.equal(errores.length, 1, 'el error de red se anuncia');
  assert.match(errores[0].detail, /stream-interrupted: net::ERR_CONNECTION_RESET/);
});

test('(f) un AbortError no se trata como cancelación sin motivo', async () => {
  const view = pestana();
  const antes = (await avisos('diag-cancelacion')).length;
  escuchar('nexo:event', { sender: view, senderFrame: view.mainFrame }, {
    type: 'error', payload: { stage: 'stream-interrupted', message: 'La operación fue abortada.',
      motivo: 'La operación fue abortada.', errorName: 'AbortError' },
  });
  // No se anota como cancelación: va por el camino visible de siempre, aunque
  // la ventana de 30 s del aviso lo agrupe con el del test anterior.
  assert.equal((await avisos('diag-cancelacion')).length, antes, 'un AbortError no es una cancelación');
  const todos = (await avisos('page-error')).map((e) => e.detail).join('\n');
  assert.match(todos, /stream-interrupted: (net::ERR_CONNECTION_RESET|La operación fue abortada\.)/,
    'el aviso visible sigue existiendo para los errores con mensaje');
});

test('(g) interrupted no cambia: el cierre sigue marcando el turno como interrumpido', async () => {
  // La marca sale de `finishInterrupted()` en la capa y viaja en el `stream-end`.
  // Aquí se comprueba que el camino nuevo (cancelación sin aviso visible) no la
  // toca: el evento de la capa llega con `interrupted: true` y el cierre se
  // procesa igual que antes (la respuesta se cuenta, sin `nextAction` propio).
  const cancelado = crearMundo({ cuerpo: cuerpoQueSeCancela });
  const respuesta = await transitar(cancelado, { leer: false });
  await respuesta.body.cancel();
  await new Promise((r) => setTimeout(r, 80));
  const cierre = eventos(cancelado, 'stream-end')[0];
  assert.ok(cierre, 'la capa cierra el turno aunque se cancele la lectura');
  assert.equal(cierre.payload.interrupted, true, 'la marca de interrupción se mantiene');
  assert.equal(cierre.payload.finished, false);
  assert.equal(cierre.payload.chars, 0, 'y el contenido del stream-end no se inventa');

  // En el proceso principal, el mismo cierre se procesa sin cambios: el motor
  // recibe el evento y el aviso de contadores sigue saliendo.
  const view = pestana();
  const resultado = cerrar(view, { interrupted: true, finished: false });
  assert.ok(resultado && typeof resultado === 'object', 'el cierre se procesa');
  assert.match((await avisos('diag-stream-end')).at(0).detail, /source dom-recovery/);
});

test('(h) dos cancelaciones seguidas dan dos avisos pese al dedup de 30 s', async () => {
  const view = pestana();
  const antes = (await avisos('diag-cancelacion')).length;
  for (let i = 0; i < 2; i += 1) {
    escuchar('nexo:event', { sender: view, senderFrame: view.mainFrame }, {
      type: 'error', payload: { stage: 'stream-interrupted', message: 'undefined', sinMotivo: true },
    });
  }
  assert.equal((await avisos('diag-cancelacion')).length, antes + 2, 'la ventana de 30 s no las tapa');
});

/* ------------------------------------------------------------------ */
/* los dos caminos de la capa, punta a punta                           */
/* ------------------------------------------------------------------ */

/** Un cuerpo que la página cancela tras leer el primer trozo. */
function cuerpoQueSeCancela() {
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"delta"}\n\n')); },
  });
}

/** Un cuerpo cuya lectura falla con un error de red. */
function cuerpoQueFalla() {
  return new ReadableStream({
    start(c) { c.error(new Error('net::ERR_CONNECTION_RESET')); },
  });
}

test('la capa distingue la cancelación sin motivo del error de red', { skip: sinBundle }, async () => {
  const cancelado = crearMundo({ cuerpo: cuerpoQueSeCancela });
  const respuesta = await transitar(cancelado, { leer: false });
  await respuesta.body.cancel();                       // la página cancela sin motivo
  await new Promise((r) => setTimeout(r, 80));
  const errorCancelado = eventos(cancelado, 'error').find((m) => m.payload?.stage === 'stream-interrupted');
  assert.ok(errorCancelado, 'la capa avisa del rechazo');
  assert.equal(errorCancelado.payload.sinMotivo, true, 'declarado sin motivo');
  assert.equal(errorCancelado.payload.message, 'undefined');

  const fallido = crearMundo({ cuerpo: cuerpoQueFalla });
  const respuesta2 = await transitar(fallido);
  await new Promise((r) => setTimeout(r, 40));
  const errorFallido = eventos(fallido, 'error').find((m) => m.payload?.stage === 'stream-interrupted');
  assert.ok(errorFallido, 'la capa avisa del error');
  assert.equal(errorFallido.payload.sinMotivo, undefined, 'no es una cancelación');
  assert.equal(errorFallido.payload.motivo, 'net::ERR_CONNECTION_RESET');
  void respuesta2;
});

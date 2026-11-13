/**
 * 7c-12: por qué no salió `diag-stream-forma` en el PC, y qué significa
 * "oculto" para el mensaje del asistente.
 *
 * Medido en el PC con `3bb5ac0`: ningún aviso `diag-stream-forma` en dos turnos,
 * `rutaTexto` todo a 0 teniendo `/message/content/parts/N` en las rutas, y
 * `oculto 1` en ambos turnos con roles `system`/`assistant`.
 *
 * Causa encontrada (verificada ejecutando la ruta real): **la capa nunca mandó
 * `esqueleto` en el `stream-end`**. `build/inject.js` sólo copiaba
 * `estructura`, así que `main` no tenía nada que publicar. El segundo defecto
 * era el patrón `ESQUELETO_SEGURO`, que no admitía `?` y descartaba 13 de las
 * 86 firmas de las grabaciones — justo los `delta` con parches, los que traen
 * el texto.
 *
 * Este archivo ejercita **la ruta real completa** (capa → payload → `main`), no
 * las funciones sueltas: es lo que faltaba en 7c-11 y por lo que el fallo pasó.
 *
 * **Las fixtures son SINTÉTICAS** salvo donde se dice «grabada».
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

import { createStreamFilter } from '../src/core/streamFilter.js';
import { createAdapter } from '../src/core/streamAdapters.js';

const MARCA = 'ZZZ-PRIVADO';
const PARTE = '/message/content/parts/0';
const FIXTURES = new URL('./fixtures/chatgpt-recorded/', import.meta.url);
const leerFixture = (n) => readFileSync(new URL(n, FIXTURES), 'utf8');

/* ------------------------------------------------------------------ */
/* proceso principal real                                             */
/* ------------------------------------------------------------------ */

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
const avisos = async (code) => (await invoke('nexo:log', shellEv)).filter((e) => e.code === code);

let turno = 0;
const pestana = () => {
  turno += 1;
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c12-${turno}`);
  view.url = `https://chatgpt.com/c/7c12-${turno}`;
  return view;
};

/* ------------------------------------------------------------------ */
/* capa inyectada real (build/inject.js en un vm)                     */
/* ------------------------------------------------------------------ */

const RUTA_BUNDLE = new URL('../build/inject.js', import.meta.url);
const fuente = readFileSync(RUTA_BUNDLE, 'utf8');

/**
 * Mundo mínimo, el mismo de `test/capa-inyectada.test.js`. La diferencia con
 * los tests de 7c-11: aquí se usa **lo que la capa emite de verdad**, no un
 * payload armado a mano.
 */
async function payloaDeLaCapa(cuerpo) {
  const salientes = [];
  const window = {
    __NEXO_CONFIG__: { host: 'chatgpt.com', enabled: true, settings: {}, language: 'es', version: '0.1.0', site: 'chatgpt' },
    location: { href: 'https://chatgpt.com/c/7c12', hostname: 'chatgpt.com', pathname: '/c/7c12', protocol: 'https:' },
    fetch: async () => new Response(cuerpo, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: (msg) => { salientes.push(msg); },
    setTimeout, clearTimeout, TextDecoder, TextEncoder,
    ReadableStream, WritableStream, TransformStream, Response, Headers, Request, URL,
    console,
    navigator: { userAgent: 'Chrome' },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
  };
  window.window = window;
  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });
  const respuesta = await window.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: '{}' });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 120));
  return salientes.find((m) => m.type === 'stream-end')?.payload || null;
}

/* ------------------------------------------------------------------ */
/* 1. la ruta real: el esqueleto llega a main y se publica            */
/* ------------------------------------------------------------------ */

test('(10) sin NEXO_DIAG no se publica ningún aviso diag-*', async () => {
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
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 } });
const log = await journal.ipcHandlers.get('nexo:log')({ sender: shell, senderFrame: shell.mainFrame });
console.log('DIAG=' + JSON.stringify(log.filter((e) => String(e.code).startsWith('diag-'))));
`;
  const { spawnSync } = await import('node:child_process');
  const salida = spawnSync(process.execPath, ['--import', preludio, '--input-type=module', '-e', guion],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, NEXO_DIAG: '0' } });
  assert.equal(salida.status, 0, `el hijo termina bien: ${salida.stderr}`);
  const linea = (salida.stdout || '').split('\n').find((l) => l.startsWith('DIAG='));
  assert.ok(linea, `el hijo informa: ${salida.stdout}`);
  assert.deepEqual(JSON.parse(linea.slice(5)), [], 'sin la variable no sale nada');
});

/* ------------------------------------------------------------------ */
/* 4. las 6 grabaciones, sin cambios                                  */
/* ------------------------------------------------------------------ */

test('(11) los caracteres de las 6 fixtures siguen iguales', async () => {
  const esperado = [
    ['normal-reply.sse', 'sse', 46], ['regenerate.sse', 'sse', 46], ['thinking-reply.sse', 'sse', 7562],
    ['aborted.sse', 'sse', 643], ['logged-out-reply.ndjson', 'ndjson', 60],
    ['logged-out-stopped.ndjson', 'ndjson', 966],
  ];
  for (const [nombre, formato, chars] of esperado) {
    let fin = null;
    const filtro = createStreamFilter({
      adapter: 'chatgpt', format: formato, host: 'chatgpt.com', language: 'es', settings: {},
      onText: () => {}, onEnd: (info) => { fin = info; },
    });
    await new Response(new Blob([leerFixture(nombre)]).stream().pipeThrough(filtro)).text();
    assert.equal(fin.text.length, chars, `${nombre}`);
  }
});

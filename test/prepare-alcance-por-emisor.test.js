/**
 * `nexo:prepare`: el alcance lo decide el emisor, no quien llama.
 *
 * El motor decide con `payload.url` y `payload.site`, dos campos que elige la
 * página. Una pestaña en cualquier sitio podía pedir mediación para
 * `chatgpt.com` y recibir de vuelta el texto con la memoria del proyecto
 * dentro. El canal exige ahora que lo que se pide coincida con la pestaña que
 * lo pide, y devuelve la misma forma que `Engine.prepare` cuando descarta
 * (`text` original, `skipped: 'fuera-de-alcance'`), sin tocar el motor.
 *
 * Los cinco casos se ejecutan contra el proceso principal real y el Electron
 * falso: el emisor es un webview de verdad (`win.attachWebview(url)`), con su
 * `getURL()`, su `id` y su `mainFrame`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

const invoke = (channel, event, payload) => {
  const handler = journal.ipcHandlers.get(channel);
  assert.equal(typeof handler, 'function', `la aplicación registra ${channel}`);
  return handler(event, payload);
};

const PROMPT = 'Hola, ¿me ayudás con esto?';
const FUERA = { text: PROMPT, skipped: 'fuera-de-alcance' };

await settle();

/** Una pestaña con su URL real: el emisor que ve el proceso principal. */
function pestana(url) {
  const view = journal.windows[0].attachWebview(url);
  return { sender: view, senderFrame: view.mainFrame };
}

/** La shell, para los canales que sí la exigen. */
function shell() {
  const win = journal.windows[0];
  win.webContents.url = 'nexo://app/src/ui/shell/index.html';
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

const preparar = (event, payload) => invoke('nexo:prepare', event, payload);
const stats = () => invoke('nexo:stats', {}, {});

test('1) una pestaña en ejemplo.com no obtiene mediación pidiéndola para chatgpt.com', async () => {
  const antes = await stats();
  const event = pestana('https://ejemplo.com/nota');

  const resultado = await preparar(event, {
    prompt: PROMPT,
    url: 'https://chatgpt.com/c/x',
    site: 'chatgpt',
  });

  assert.deepEqual(resultado, FUERA, 'misma forma que el descarte del motor');
  assert.equal(resultado.text, PROMPT, 'el texto vuelve intacto');
  const despues = await stats();
  assert.equal(despues.interventions, antes.interventions, 'no cuenta intervención');
  assert.equal(despues.mediatedInterventions, antes.mediatedInterventions, 'ni intervención mediada');
  assert.equal(despues.messages, antes.messages, 'ni mensaje');
});

test('2) una pestaña en chatgpt.com sí se media: el protocolo entra con observe', async (t) => {
  await invoke('nexo:settings:set', shell(), { egress: { mode: 'observe' } });
  t.after(() => invoke('nexo:settings:set', shell(), { egress: { mode: 'off' } }));

  const event = pestana('https://chatgpt.com/c/7a1');
  const resultado = await preparar(event, {
    prompt: PROMPT,
    url: 'https://chatgpt.com/backend-api/conversation',
    site: 'chatgpt',
  });

  assert.equal(resultado.skipped, undefined, 'no se descarta');
  assert.equal(typeof resultado.text, 'string');
  assert.notEqual(resultado.text, PROMPT, 'el texto cambió: hubo mediación');
  assert.ok(
    resultado.text.includes('[Protocolo de continuidad · Nexo]'),
    'y el bloque que entró es el del protocolo',
  );
  assert.deepEqual(resultado.blocks.map((b) => b.id), ['protocol']);
});

test('3) una pestaña en chatgpt.com no puede pedir mediación para otro host', async () => {
  const event = pestana('https://chatgpt.com/c/7a2');
  const resultado = await preparar(event, {
    prompt: PROMPT,
    url: 'https://claude.ai/api/chat',
    site: 'claude',
  });
  assert.deepEqual(resultado, FUERA, 'el host pedido no es el del emisor');
});

test('4) un emisor sin getURL no obtiene mediación', async () => {
  // La forma que usan muchos dobles de prueba: sólo el identificador.
  const resultado = await preparar({ sender: { id: 1 } }, {
    prompt: PROMPT,
    url: 'https://chatgpt.com/c/x',
    site: 'chatgpt',
  });
  assert.deepEqual(resultado, FUERA, 'sin URL de emisor no hay alcance que comprobar');
});

test('5) un payload.site de otro perfil que el del emisor no obtiene mediación', async () => {
  const event = pestana('https://chatgpt.com/c/7a3');
  const resultado = await preparar(event, {
    prompt: PROMPT,
    // La URL viaja relativa, como en una aplicación web: el sitio decide.
    url: '/api/chat',
    site: 'claude',
  });
  assert.deepEqual(resultado, FUERA, 'el perfil declarado no es el del emisor');
});

test('5b) una URL relativa con otro host absoluto tampoco pasa: manda el emisor', async () => {
  const event = pestana('https://chatgpt.com/c/7a3b');
  const resultado = await preparar(event, {
    prompt: PROMPT,
    url: 'https://ejemplo.com/api/chat',
    site: 'chatgpt',
  });
  assert.deepEqual(resultado, FUERA, 'el sitio declarado no autoriza un host ajeno');
});

test('6) el mismo sitio con URL relativa sigue mediando: la capa no cambia', async (t) => {
  await invoke('nexo:settings:set', shell(), { egress: { mode: 'observe' } });
  t.after(() => invoke('nexo:settings:set', shell(), { egress: { mode: 'off' } }));

  const event = pestana('https://chatgpt.com/c/7a4');
  const resultado = await preparar(event, {
    prompt: PROMPT,
    url: '/backend-api/conversation',
    site: 'chatgpt',
  });
  assert.equal(resultado.skipped, undefined, 'una petición relativa del mismo sitio se media');
  assert.notEqual(resultado.text, PROMPT);
});

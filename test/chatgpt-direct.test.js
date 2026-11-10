import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readChatGptDirect, readMemoryConversation } from '../src/ui/shell/chatgptDirect.js';

const href = 'https://chatgpt.com/c/direct-test';
const source = { webContentsId: 7, href };
const snap = text => ({ ...source, strategy: 'print-label', streaming: false, turns: [{ id: 'a', role: 'assistant', content: text }] });
const heading = (label, text, id) => ({ innerText: label, nextElementSibling: {
  innerText: text, getAttribute: name => name === 'data-message-id' ? id : null, matches: () => false,
} });
function fixture(headings, buttons = []) {
  const calls = [];
  const document = { querySelector: name => name === 'main' ? { querySelectorAll: () => headings } : null,
    querySelectorAll: () => buttons };
  const view = { getURL: () => href, getWebContentsId: () => 7,
    executeJavaScript(script, gesture) { calls.push({ script, gesture }); return Promise.resolve(vm.runInNewContext(script, { document, location: { href } })); } };
  return { view, calls };
}

test('ejecuta h4 → hermano en el webview, ambos roles literales y sin activación del usuario', async () => {
  const tab = fixture([heading('Dijiste:', '  hola\n', 'u'), heading('ChatGPT dijo:', '\nRespuesta 😊\n  código\n', 'a')]);
  const result = await readChatGptDirect(tab);
  assert.deepEqual(result.turns.map(t => [t.role, t.content]), [['user', '  hola\n'], ['assistant', '\nRespuesta 😊\n  código\n']]);
  assert.deepEqual(result.turns.map(t => t.id), ['u', 'a']);
  assert.equal(result.strategy, 'direct-console-injection'); assert.equal(tab.calls[0].gesture, false);
});

test('etiquetas inglesas y españolas ancladas: no confundir un título arbitrario con un rol', async () => {
  const tab = fixture([heading('Cómo interpretar You said: en un documento', 'No copiar', 'x'),
    heading(' You said: ', 'pregunta', 'u'), heading('ChatGPT said:', 'respuesta', 'a')]);
  assert.equal((await readChatGptDirect(tab)).turns.length, 2);
});

test('no fuerza streaming=false: reconoce detener, excluyendo dictado y botones deshabilitados', async () => {
  for (const [label, disabled, expected] of [['Detener respuesta', false, true], ['Stop dictation', false, false], ['Stop', true, false]]) {
    const button = { disabled, getAttribute: key => key === 'aria-label' ? label : '' };
    const result = await readChatGptDirect(fixture([heading('ChatGPT dijo:', 'texto', 'a')], [button]));
    assert.equal(result.streaming, expected);
  }
});

test('rechaza sitios ajenos/temporales antes de ejecutar el script', async () => {
  for (const url of ['https://example.com/', 'https://chatgpt.com/?temporary-chat=true']) {
    const tab = fixture([]); tab.view.getURL = () => url;
    assert.equal(await readChatGptDirect(tab), null); assert.equal(tab.calls.length, 0);
  }
});

test('descarta una lectura si navegó durante executeJavaScript aunque el webContentsId no cambie', async () => {
  let url = href;
  const tab = fixture([heading('ChatGPT dijo:', 'respuesta vieja', 'a')]);
  const execute = tab.view.executeJavaScript;
  tab.view.getURL = () => url;
  tab.view.executeJavaScript = async (...args) => { const result = await execute(...args); url = 'https://chatgpt.com/c/otro'; return result; };
  assert.equal(await readChatGptDirect(tab), null);
});

test('limita transferencia y avisa: últimos 200 mensajes, 200k por mensaje y 1M total', async () => {
  const many = fixture(Array.from({ length: 205 }, (_, i) => heading('ChatGPT dijo:', String(i), `a${i}`)));
  const result = await readChatGptDirect(many);
  assert.equal(result.turns.length, 200); assert.equal(result.turns[0].id, 'a5'); assert.equal(result.clipped, true);
  const long = await readChatGptDirect(fixture(Array.from({ length: 6 }, (_, i) => heading('ChatGPT dijo:', 'x'.repeat(200001), `a${i}`))));
  assert.equal(long.turns.reduce((n, t) => n + t.content.length, 0), 1000000); assert.equal(long.clipped, true);
});

test('sin mensajes, sin API o con error del sitio devuelve null sin filtrar error/texto al log', async () => {
  assert.equal(await readChatGptDirect(fixture([])), null);
  assert.equal(await readChatGptDirect({ view: {} }), null);
  const tab = fixture([]); tab.view.executeJavaScript = () => { throw Error('texto privado en error'); };
  assert.equal(await readChatGptDirect(tab), null);
});

function resolver(overrides = {}) {
  let live = null, revision = 0, current = source, directCalls = 0;
  return { source, tab: {}, getSource: () => current, getCached: async () => null, getLive: () => live, getRevision: () => revision,
    direct: async () => { directCalls++; return snap('directo'); },
    setCurrent(value) { current = value; }, receive(value) { live = value; revision++; }, get directCalls() { return directCalls; }, ...overrides };
}

test('prefiere caché automática y no ejecuta el respaldo cuando ya hay mensajes', async () => {
  const r = resolver({ getCached: async () => snap('automático') });
  assert.equal((await readMemoryConversation(r)).turns[0].content, 'automático'); assert.equal(r.directCalls, 0);
});

test('un snapshot de otra pestaña no bloquea el respaldo de la pestaña actual', async () => {
  const r = resolver(); r.receive({ ...snap('otra'), webContentsId: 90 });
  assert.equal((await readMemoryConversation(r)).turns[0].content, 'directo'); assert.equal(r.directCalls, 1);
});

test('un evento más nuevo que la consulta gana incluso si la caché responde con contenido viejo', async () => {
  let reply; const r = resolver({ getCached: () => new Promise(resolve => { reply = resolve; }) });
  const pending = readMemoryConversation(r); r.receive(snap('nuevo')); reply(snap('viejo'));
  assert.equal((await pending).turns[0].content, 'nuevo'); assert.equal(r.directCalls, 0);
});

test('un evento vacío más nuevo que el respaldo no resucita la conversación anterior', async () => {
  let reply; const r = resolver({ direct: () => new Promise(resolve => { reply = resolve; }) });
  const pending = readMemoryConversation(r); await Promise.resolve();
  r.receive({ ...source, turns: [] }); reply(snap('obsoleto'));
  assert.deepEqual((await pending).turns, []);
});

test('cambiar de pestaña o de conversación durante la consulta descarta el resultado', async () => {
  for (const current of [{ ...source, webContentsId: 8 }, { ...source, href: 'https://chatgpt.com/c/otro' }]) {
    let reply; const r = resolver({ getCached: () => new Promise(resolve => { reply = resolve; }) });
    const pending = readMemoryConversation(r); r.setCurrent(current); reply(snap('anterior'));
    assert.equal(await pending, undefined); assert.equal(r.directCalls, 0);
  }
});

test('el respaldo funciona si la consulta IPC falla, sin añadir un nuevo canal privilegiado', async () => {
  const r = resolver({ getCached: async () => { throw Error('IPC'); } });
  assert.equal((await readMemoryConversation(r)).turns[0].content, 'directo');
});

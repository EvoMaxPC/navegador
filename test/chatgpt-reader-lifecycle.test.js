import test from 'node:test';
import assert from 'node:assert/strict';
import { watchChatGptConversation } from '../src/core/chatgptConversation.js';
import { startChatGptReader } from '../src/preload/chatgptReader.js';

function target() {
  const listeners = new Map();
  return { listeners, addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); }, emit(name, event = {}) { listeners.get(name)?.(event); } };
}
function fixture() {
  let content = '  Respuesta GPT 😊\n  código\n';
  const node = { get innerText() { return content; }, getAttribute: key => key === 'data-message-author-role' ? 'assistant' : null };
  const observers = [];
  const document = { ...target(), body: null, querySelectorAll: selector => selector === '[data-message-author-role]' ? [node] : [] };
  const window = { ...target(), location: { href: 'https://chatgpt.com/c/lifecycle' }, MutationObserver: class {
    constructor(fn) { this.fn = fn; observers.push(this); } observe(root) { this.root = root; this.disconnected = false; }
    disconnect() { this.disconnected = true; }
  } };
  return { document, window, observers, change(value) { content = value; observers.filter(o => !o.disconnected).forEach(o => o.fn()); } };
}

test('observa Document desde antes de body y no pierde la lectura al sustituirlo', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), live = [];
  const watcher = watchChatGptConversation({ ...f, publish() {}, publishLive: p => live.push(p) });
  try {
    assert.equal(f.observers.length, 1);
    assert.equal(f.observers[0].root, f.document);
    t.mock.timers.tick(500);
    assert.equal(live.length, 1);
    f.document.body = {}; f.change('Respuesta después de hidratar/reemplazar body');
    t.mock.timers.tick(500);
    assert.equal(live.at(-1).turns[0].content, 'Respuesta después de hidratar/reemplazar body');
  } finally { watcher.disconnect(); }
});

test('Atrás/Adelante (pagehide/pageshow) reanuda un único observador y desconectar es definitivo', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), live = [];
  const watcher = watchChatGptConversation({ ...f, isEnabled: () => false, publish() {}, publishLive: p => live.push(p) });
  watcher.read();
  f.window.emit('pagehide', { persisted: true });
  assert.equal(f.observers[0].disconnected, true);
  f.change('Respuesta restaurada');
  t.mock.timers.tick(5000);
  assert.equal(live.length, 1);
  f.window.emit('pageshow', { persisted: true });
  assert.equal(live.at(-1).turns[0].content, 'Respuesta restaurada');
  assert.equal(f.observers.filter(o => !o.disconnected).length, 1);
  watcher.disconnect();
  const count = live.length;
  f.window.emit('pageshow'); t.mock.timers.tick(5000);
  assert.equal(live.length, count);
  assert.equal(f.window.listeners.size, 0);
});

test('snapshot rechazado por IPC se puede reenviar aunque el DOM no haya cambiado', async () => {
  const f = fixture(), live = [];
  const watcher = watchChatGptConversation({ ...f, isEnabled: () => false, publish() {},
    publishLive(p) { live.push(p); return Promise.resolve({ ok: live.length > 1 }); } });
  try {
    watcher.read(); await Promise.resolve(); watcher.read(); await Promise.resolve(); watcher.read();
    assert.equal(live.length, 2, 'rechazo no se deduplica como entrega exitosa');
    watcher.read({ force: true });
    assert.equal(live.length, 3, 'la shell puede recuperar su caché vaciada');
  } finally { watcher.disconnect(); }
});

test('el preload aislado entrega directamente al IPC con memoria y mediación apagadas', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), calls = [];
  // No postMessage, fetch, __nexo ni código de la página.
  const reader = startChatGptReader({ ...f, config: { enabled: false, settings: { memory: { enabled: false } } },
    ipcRenderer: { invoke(channel, payload) { calls.push({ channel, payload }); return Promise.resolve({ ok: true }); }, send() {} } });
  try {
    reader.read();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'nexo:repetition:snapshot');
    assert.equal(calls[0].payload.turns[0].content, '  Respuesta GPT 😊\n  código\n');
    reader.updateSettings({ settings: { memory: { enabled: true } } });
    t.mock.timers.tick(500); await Promise.resolve();
    assert.equal(calls.at(-1).channel, 'nexo:conversation-snapshot');
  } finally { reader.disconnect(); }
});

test('la confirmación de memoria se conserva: un rechazo permite reintentar, no confirma persistencia', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), memory = [];
  const reader = startChatGptReader({ ...f, ipcRenderer: {
    invoke(channel, payload) { if (channel === 'nexo:conversation-snapshot') { memory.push(payload); return Promise.resolve({ ok: memory.length > 1 }); } return Promise.resolve({ ok: true }); }, send() {},
  } });
  try {
    reader.read(); t.mock.timers.tick(500);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    reader.read(); t.mock.timers.tick(500); await Promise.resolve();
    assert.equal(memory.length, 2);
  } finally { reader.disconnect(); }
});

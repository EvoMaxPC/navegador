import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readUnderstandingDom,
  validateUnderstandingDom,
  UNDERSTANDING_DOM_LIMITS as limits,
} from '../src/core/understandingConversation.js';
import { startUnderstandingReader } from '../src/preload/understandingReader.js';
import { startChatGptReader } from '../src/preload/chatgptReader.js';
function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(n, f) {
      const set = listeners.get(n) || new Set();
      set.add(f);
      listeners.set(n, set);
    },
    removeEventListener(n, f) {
      listeners.get(n)?.delete(f);
      if (!listeners.get(n)?.size) listeners.delete(n);
    },
    emit(n, p) {
      for (const f of listeners.get(n) || []) f(p);
    },
  };
}
function fixture(count = 2) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    innerText:
      i % 2
        ? 'Respuesta literal 😊\n  código'
        : 'Mi objetivo: comprender el proyecto',
    getAttribute: (k) =>
      ({
        'data-message-id': `m${i}`,
        'data-message-author-role': i % 2 ? 'assistant' : 'user',
      })[k],
    querySelector: () => null,
  }));
  const observers = [];
  const document = {
    ...target(),
    querySelectorAll: (s) => (s === '[data-message-author-role]' ? nodes : []),
  };
  const window = {
    ...target(),
    location: { href: 'https://chatgpt.com/c/dedicated' },
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn;
        observers.push(this);
      }
      observe(root) {
        this.root = root;
        this.disconnected = false;
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  };
  return { nodes, document, window, observers };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
test('lector UUE extrae ambos roles, orden y texto literal, sin límite EVO de 200 turnos', () => {
  const f = fixture(206),
    p = {
      href: f.window.location.href,
      streaming: false,
      ...readUnderstandingDom(f.document),
    };
  assert.equal(p.turns.length, 206);
  assert.equal(p.turns[0].role, 'user');
  assert.equal(p.turns[205].role, 'assistant');
  assert.equal(p.turns[205].content, f.nodes[205].innerText);
  assert.equal(p.coverage.remote_history_complete, false);
  assert.equal(validateUnderstandingDom(p), true);
});
test('límites UUE explícitos priorizan recientes sin ocultar omisiones ni recortes', () => {
  const f = fixture(2002);
  const long = 'x'.repeat(220000);
  for (const node of f.nodes) node.innerText = long;
  const p = {
    href: f.window.location.href,
    streaming: true,
    ...readUnderstandingDom(f.document),
  };
  assert.equal(p.turns.length, 10);
  assert.equal(p.turns[0].id, 'm1992');
  assert.equal(p.coverage.omitted_turns, 1992);
  assert.equal(p.coverage.clipped, true);
  assert.equal(
    p.turns.reduce((n, t) => n + t.content.length, 0),
    limits.chars,
  );
  assert.equal(validateUnderstandingDom(p), true);
});
test('contrato rechaza roles falsos, duplicados, totales inválidos, sobredimensiones y falsa cobertura remota', () => {
  const f = fixture(),
    p = {
      href: f.window.location.href,
      streaming: false,
      ...readUnderstandingDom(f.document),
    };
  for (const mutate of [
    (p) => (p.turns[0].role = 'system'),
    (p) => p.turns.push(p.turns[0]),
    (p) => (p.coverage.remote_history_complete = true),
    (p) => (p.coverage.sent_turns = 0),
    (p) => (p.turns[0].content = 'x'.repeat(limits.turnChars + 1)),
    (p) => (p.turns[0].clipped = true),
    (p) => (p.coverage.omitted_turns = -1),
    (p) => (p.streaming = 'yes'),
  ]) {
    const invalid = structuredClone(p);
    mutate(invalid);
    assert.equal(validateUnderstandingDom(invalid), false);
  }
});
test('canal propio agrupa 500 ms, ACK rechazado permite reintento, suspensión/restauración y disconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(),
    calls = [];
  let accepted = false;
  const reader = startUnderstandingReader({
    ...f,
    ipcRenderer: {
      invoke(channel, p) {
        calls.push({ channel, p });
        return Promise.resolve({ ok: p.ready || accepted });
      },
      send() {},
    },
  });
  try {
    reader.read();
    assert.ok(
      calls.every((c) => c.channel === 'nexo:understanding:conversation'),
    );
    assert.equal(calls.filter((c) => c.p.turns).length, 0);
    t.mock.timers.tick(499);
    await settle();
    assert.equal(calls.filter((c) => c.p.turns).length, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls.filter((c) => c.p.turns).length, 1);
    accepted = true;
    reader.read();
    t.mock.timers.tick(500);
    await settle();
    assert.equal(calls.filter((c) => c.p.turns).length, 2);
    f.observers[0].fn();
    t.mock.timers.tick(500);
    await settle();
    assert.equal(calls.filter((c) => c.p.turns).length, 2);
    f.window.emit('pagehide', { persisted: true });
    assert.ok(f.observers.every((o) => o.disconnected));
    f.nodes[1].innerText = 'Respuesta restaurada';
    f.window.emit('pageshow', { persisted: true });
    t.mock.timers.tick(500);
    await settle();
    assert.equal(
      calls.filter((c) => c.p.turns).at(-1).p.turns[1].content,
      'Respuesta restaurada',
    );
    assert.equal(f.observers.filter((o) => !o.disconnected).length, 1);
  } finally {
    reader.disconnect();
    assert.equal(f.window.listeners.size, 0);
  }
});
test('lector EVO dedicado apagado no publica snapshots de memoria, pero Repetición sigue activa', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(),
    calls = [];
  const reader = startChatGptReader({
    ...f,
    config: {
      understandingReaderActive: true,
      settings: { enabled: false, memory: { enabled: true } },
    },
    ipcRenderer: {
      invoke(c) {
        calls.push(c);
        return Promise.resolve({ ok: true });
      },
      send() {},
    },
  });
  try {
    reader.read();
    t.mock.timers.tick(500);
    await settle();
    assert.ok(calls.includes('nexo:repetition:snapshot'));
    assert.ok(!calls.includes('nexo:conversation-snapshot'));
    reader.updateSettings({
      settings: { enabled: true, memory: { enabled: true } },
    });
    t.mock.timers.tick(500);
    await settle();
    assert.ok(calls.includes('nexo:conversation-snapshot'));
  } finally {
    reader.disconnect();
  }
});
test('lector UUE no transmite DOM de chats temporales ni dominios ajenos', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const href of [
    'https://chatgpt.com/?temporary-chat=true',
    'https://evil.example/c/x',
  ]) {
    const f = fixture(),
      calls = [];
    f.window.location.href = href;
    const reader = startUnderstandingReader({
      ...f,
      ipcRenderer: {
        invoke(c, p) {
          calls.push(p);
          return Promise.resolve({ ok: true });
        },
        send() {},
      },
    });
    reader.read();
    t.mock.timers.tick(500);
    await settle();
    assert.ok(!calls.some((p) => p.turns));
    reader.disconnect();
  }
});

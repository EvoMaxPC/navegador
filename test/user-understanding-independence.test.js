/** Desacoplamiento UUE/EVO: handlers de producción y lector existente, Electron stub. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EvoMemory } from '../src/memory/engine.js';
import { startChatGptReader } from '../src/preload/chatgptReader.js';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((resolve) => setTimeout(resolve, 40));
const owner = journal.windows[0].webContents;
const event = (sender) => ({ sender, senderFrame: sender.mainFrame });
const invoke = (channel, sender, payload) =>
  journal.ipcHandlers.get(channel)(event(sender), payload);
const settings = (patch) => invoke('nexo:settings:set', owner, patch);
const read = (g) =>
  invoke('nexo:understanding:read', owner, { webContentsId: g.id });
const attach = (name) =>
  journal.windows[0].attachWebview(
    `https://chatgpt.com/c/independence-${name}`,
  );
const payload = (g, text, id = 'u1') => ({
  href: g.getURL(),
  streaming: false,
  turns: [{ id, role: 'user', content: text }],
});
const prepare = (
  g,
  text,
  url = 'https://chatgpt.com/backend-api/conversation',
) => invoke('nexo:prepare', g, { prompt: text, url, site: 'chatgpt' });
function disk(g, snapshot) {
  const file = readdirSync(journal.userData).find((f) =>
    f.startsWith('nexo-understanding-'),
  );
  assert.ok(file);
  const saved = JSON.parse(
    readFileSync(join(journal.userData, file), 'utf8'),
  ).contexts.find((c) => c.state.context_id === snapshot.state.context_id);
  assert.deepEqual(
    saved.state,
    snapshot.state,
    `El estado de ${g.getURL()} se persistió independientemente`,
  );
}

test('A: EVO activada, UUE observa/persiste y EVO conserva captura y antecedentes', async () => {
  await settings({ enabled: true, memory: { enabled: true } });
  const g = attach('a');
  const original = EvoMemory.prototype.captureConversation;
  let captures = 0;
  EvoMemory.prototype.captureConversation = function (...args) {
    captures++;
    return original.apply(this, args);
  };
  try {
    prepare(g, 'Mi objetivo: mantener continuidad de Mercurio');
    const r = invoke(
      'nexo:conversation-snapshot',
      g,
      payload(g, 'Decisión confirmada: usar PostgreSQL en Mercurio'),
    );
    assert.equal(r.ok, true);
    assert.equal(captures, 1);
    const snap = await read(g);
    assert.equal(snap.observationEnabled, true);
    assert.equal(snap.state.user_goal.text, 'mantener continuidad de Mercurio');
    assert.equal(
      snap.state.confirmed_decisions[0].text,
      'usar PostgreSQL en Mercurio',
    );
    disk(g, snap);
    const refs = await invoke('nexo:understanding:recall', owner, {
      webContentsId: g.id,
      query: 'PostgreSQL Mercurio',
      revision: snap.state.revision,
    });
    assert.equal(refs.ok, true);
    assert.ok(refs.count > 0);
    assert.ok(refs.memoryReferences.some((r) => r.available));
  } finally {
    EvoMemory.prototype.captureConversation = original;
  }
});

test('B: lector existente → vista en vivo → UUE con EVO y mediación apagadas, sin capturas EVO ni cambios de contadores', async () => {
  await settings({ enabled: false, memory: { enabled: false } });
  const g = attach('b'),
    calls = [];
  const original = EvoMemory.prototype.captureConversation;
  EvoMemory.prototype.captureConversation = function () {
    throw Error('No debe capturar con EVO apagada');
  };
  const nodes = [
    {
      innerText: 'Mi objetivo: comprender sin EVO',
      getAttribute: (key) =>
        ({ 'data-message-id': 'u1', 'data-message-author-role': 'user' })[key],
      querySelector: () => null,
    },
  ];
  const reader = startChatGptReader({
    document: {
      querySelectorAll: (s) =>
        s === '[data-message-author-role]' ? nodes : [],
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      location: { href: g.getURL() },
      addEventListener() {},
      removeEventListener() {},
    },
    config: { enabled: false, settings: { memory: { enabled: false } } },
    ipcRenderer: {
      invoke(channel, p) {
        calls.push(channel);
        return Promise.resolve(invoke(channel, g, p));
      },
      send() {},
    },
  });
  try {
    const before = invoke('nexo:stats', owner),
      memoryBefore = invoke('nexo:memory:list', owner);
    reader.read();
    // El canal de snapshot existente agrupa escrituras durante 500 ms.
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(
      calls,
      ['nexo:repetition:snapshot', 'nexo:conversation-snapshot'],
      'el lector envía observación UUE por el snapshot existente aunque EVO esté apagada',
    );
    let snap = await read(g);
    assert.equal(snap.state.user_goal.text, 'comprender sin EVO');
    assert.equal(snap.observationEnabled, true);
    disk(g, snap);
    nodes[0].innerText = 'No modifiques la funcionalidad';
    nodes[0].getAttribute = (key) =>
      ({ 'data-message-id': 'u2', 'data-message-author-role': 'user' })[key];
    reader.read();
    await Promise.resolve();
    snap = await read(g);
    assert.equal(
      snap.state.explicit_constraints[0].text,
      'No modifiques la funcionalidad',
    );
    disk(g, snap);
    const duplicateRevision = snap.state.revision;
    invoke(
      'nexo:conversation-snapshot',
      g,
      payload(g, 'No modifiques la funcionalidad', 'u2'),
    );
    assert.equal(
      (await read(g)).state.revision,
      duplicateRevision,
      'los dos consumidores no duplican la actualización',
    );
    assert.deepEqual(invoke('nexo:memory:list', owner), memoryBefore);
    const after = invoke('nexo:stats', owner);
    for (const key of [
      'messages',
      'responses',
      'inputTokens',
      'outputTokens',
      'turnsPerformed',
      'turnsCancelled',
      'turnsFailed',
    ])
      assert.equal(after[key], before[key], key);
    const refs = await invoke('nexo:understanding:recall', owner, {
      webContentsId: g.id,
      query: 'Mercurio',
      revision: snap.state.revision,
    });
    assert.equal(refs.ok, false);
    assert.match(refs.error, /desactivada/);
  } finally {
    reader.disconnect();
    EvoMemory.prototype.captureConversation = original;
    await settings({ enabled: true, memory: { enabled: true } });
  }
});

test('B: nexo:prepare observa y persiste con EVO apagada incluso si mediación está apagada; no ingiere autenticación', async () => {
  await settings({ enabled: false, memory: { enabled: false } });
  try {
    const g = attach('prepare-off');
    assert.equal(
      prepare(g, 'Mi objetivo: preparación independiente').skipped,
      'disabled',
    );
    prepare(g, 'Usa español');
    const snap = await read(g);
    assert.equal(snap.state.user_goal.text, 'preparación independiente');
    assert.equal(snap.state.active_instructions[0].text, 'Usa español');
    disk(g, snap);
    prepare(
      g,
      'Cambio de objetivo: no ingerir autenticación',
      'https://chatgpt.com/api/auth/signin',
    );
    assert.equal((await read(g)).state.revision, snap.state.revision);
  } finally {
    await settings({ enabled: true, memory: { enabled: true } });
  }
});

test('C: activar/desactivar/reactivar EVO conserva contexto UUE y reactiva referencias sin reimportar ni duplicar turnos', async () => {
  await settings({ enabled: true, memory: { enabled: true } });
  const g = attach('c');
  invoke(
    'nexo:conversation-snapshot',
    g,
    payload(g, 'Mi objetivo: continuidad al alternar'),
  );
  invoke(
    'nexo:conversation-snapshot',
    g,
    payload(g, 'Decisión confirmada: usar PostgreSQL para Saturno', 'u2'),
  );
  let snap = await read(g);
  const found = await invoke('nexo:understanding:recall', owner, {
    webContentsId: g.id,
    query: 'PostgreSQL Saturno',
    revision: snap.state.revision,
  });
  assert.ok(found.memoryReferences.some((r) => r.available));
  const goalId = found.state.user_goal.id;
  try {
    await settings({ memory: { enabled: false } });
    snap = await read(g);
    assert.ok(snap.memoryReferences.length);
    assert.ok(
      snap.memoryReferences.every((r) => !r.available && r.text === null),
    );
    assert.equal(snap.observationEnabled, true);
    invoke('nexo:repetition:snapshot', g, payload(g, 'Usa español', 'u3'));
    snap = await read(g);
    assert.equal(snap.state.user_goal.id, goalId);
    assert.equal(snap.state.active_instructions[0].text, 'Usa español');
    disk(g, snap);
    await settings({ memory: { enabled: true } });
    const on = await read(g);
    assert.ok(on.memoryReferences.some((r) => r.available));
    assert.deepEqual(
      on.state,
      snap.state,
      'el cambio de configuración no reescribe el estado UUE',
    );
    invoke('nexo:conversation-snapshot', g, payload(g, 'Usa español', 'u3'));
    assert.equal(
      (await read(g)).state.revision,
      snap.state.revision,
      'reactivar no duplica turno observado',
    );
    assert.equal(
      invoke(
        'nexo:conversation-snapshot',
        g,
        payload(g, 'Avance: validada continuidad', 'u4'),
      ).ok,
      true,
    );
    const next = await read(g);
    assert.equal(next.state.progress[0].text, 'Avance: validada continuidad');
    disk(g, next);
  } finally {
    await settings({ enabled: true, memory: { enabled: true } });
  }
});

for (const failure of ['result-not-ok', 'throw'])
  test(`UUE observa antes de captura EVO fallida (${failure}) sin cambiar su resultado ni repetir captura`, async () => {
    await settings({ enabled: true, memory: { enabled: true } });
    const g = attach(failure),
      original = EvoMemory.prototype.captureConversation;
    let captures = 0;
    EvoMemory.prototype.captureConversation = function () {
      captures++;
      if (failure === 'throw') throw Error('fallo EVO controlado');
      return { ok: false, error: 'fallo EVO controlado' };
    };
    try {
      const p = payload(g, 'Mi objetivo: persistir aunque falle EVO');
      if (failure === 'throw')
        assert.throws(
          () => invoke('nexo:conversation-snapshot', g, p),
          /fallo EVO controlado/,
        );
      else assert.equal(invoke('nexo:conversation-snapshot', g, p).ok, false);
      assert.equal(captures, 1);
      const snap = await read(g);
      assert.equal(snap.state.user_goal.text, 'persistir aunque falle EVO');
      disk(g, snap);
    } finally {
      EvoMemory.prototype.captureConversation = original;
    }
  });

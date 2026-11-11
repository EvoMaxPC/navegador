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

test('B: lector existente → cola de 500 ms → confirmación UUE con EVO y mediación apagadas, sin duplicación ni cambios de contadores', async () => {
  await settings({ enabled: false, memory: { enabled: false } });
  const g = attach('b'),
    calls = [],
    receipts = [];
  const initial = await read(g);
  const originalRecall = EvoMemory.prototype.recall;
  EvoMemory.prototype.recall = function () {
    throw Error('No debe recuperar antecedentes con EVO apagada');
  };
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
        const result = invoke(channel, g, p);
        receipts.push({ channel, result });
        return Promise.resolve(result);
      },
      send() {},
    },
  });
  try {
    const before = invoke('nexo:stats', owner),
      memoryBefore = invoke('nexo:memory:list', owner);
    reader.read();
    await Promise.resolve();
    assert.deepEqual(
      calls,
      ['nexo:repetition:snapshot'],
      'el envío en vivo es inmediato; el snapshot agrupado todavía no salió',
    );
    let snap = await read(g);
    assert.equal(snap.state.user_goal.text, 'comprender sin EVO');
    assert.equal(snap.observationEnabled, true);
    assert.equal(snap.state.revision, initial.state.revision + 1);
    const liveRevision = snap.state.revision;
    disk(g, snap);
    // También actualizar ajustes apagados debe conservar el lote, no cancelarlo.
    reader.updateSettings({ settings: { memory: { enabled: false } } });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(
      calls.filter((c) => c === 'nexo:conversation-snapshot'),
      ['nexo:conversation-snapshot'],
    );
    assert.deepEqual(
      receipts.find((r) => r.channel === 'nexo:conversation-snapshot').result,
      { ok: true, observed: true, memoryDisabled: true },
    );
    assert.equal(
      (await read(g)).state.revision,
      liveRevision,
      'snapshot y vista en vivo registran un solo turno',
    );
    assert.equal(invoke('nexo:settings:get', owner).memory.enabled, false);
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
    assert.equal(duplicateRevision, liveRevision + 1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(
      calls.filter((c) => c === 'nexo:conversation-snapshot').length,
      2,
    );
    assert.ok(
      receipts
        .filter((r) => r.channel === 'nexo:conversation-snapshot')
        .every(
          (r) => r.result.ok && r.result.observed && r.result.memoryDisabled,
        ),
    );
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
    // Espera otro sondeo (1200 + 500 ms desde arranque): el ACK evita reenvíos.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      calls.filter((c) => c === 'nexo:conversation-snapshot').length,
      2,
    );
    assert.equal(invoke('nexo:settings:get', owner).memory.enabled, false);
    assert.equal((await read(g)).state.revision, duplicateRevision);
    disk(g, await read(g));
  } finally {
    reader.disconnect();
    EvoMemory.prototype.captureConversation = original;
    EvoMemory.prototype.recall = originalRecall;
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

test('snapshot sin EVO distingue recepción UUE, rechazo de fuente y ausencia de usuario válido', async () => {
  await settings({ enabled: false, memory: { enabled: false } });
  const g = attach('receipt-reasons');
  const handler = journal.ipcHandlers.get('nexo:conversation-snapshot');
  try {
    const p = payload(g, 'Mi objetivo: no aceptar fuentes inválidas');
    for (const e of [
      { sender: g, senderFrame: {} },
      { sender: g },
      event(owner),
    ]) {
      const r = handler(e, p);
      assert.equal(r.ok, false);
      assert.equal(r.observed, false);
      assert.equal(r.skipped, 'snapshot-no-autorizado');
    }
    const wrong = handler(event(g), {
      ...p,
      href: 'https://chatgpt.com/c/otro',
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.observed, false);
    for (const turns of [
      [],
      [
        {
          id: 'a',
          role: 'assistant',
          content: 'No es una instrucción del usuario',
        },
      ],
      [{ id: 'u', role: 'user', content: '  ' }],
      [{ id: 'u', role: 'user', content: 42 }],
    ]) {
      const r = handler(event(g), { ...p, turns });
      assert.equal(r.ok, false);
      assert.equal(r.observed, false);
      assert.equal(r.memoryDisabled, true);
      assert.equal(r.skipped, 'no-user-turn');
    }
    const clipped = handler(event(g), {
      ...p,
      turns: [{ ...p.turns[0], clipped: true }],
    });
    assert.equal(clipped.ok, false);
    assert.equal(clipped.skipped, 'clipped-user-turn');
    assert.equal((await read(g)).state.revision, 0);
    const accepted = handler(event(g), p);
    assert.deepEqual(accepted, {
      ok: true,
      observed: true,
      memoryDisabled: true,
    });
    const snap = await read(g);
    assert.equal(snap.state.user_goal.text, 'no aceptar fuentes inválidas');
    disk(g, snap);
    assert.deepEqual(handler(event(g), p), accepted);
    assert.equal((await read(g)).state.revision, snap.state.revision);
  } finally {
    await settings({ enabled: true, memory: { enabled: true } });
  }
});

test('lector reintenta un ACK negativo y confirma después de la cola real, sin duplicar UUE', async () => {
  await settings({ enabled: false, memory: { enabled: false } });
  const g = attach('receipt-retry'),
    receipts = [];
  const node = {
    innerText: 'Mi objetivo: reintentar entrega sin activar EVO',
    getAttribute: (key) =>
      ({ 'data-message-id': 'retry-u', 'data-message-author-role': 'user' })[
        key
      ],
    querySelector: () => null,
  };
  const reader = startChatGptReader({
    document: {
      querySelectorAll: (s) =>
        s === '[data-message-author-role]' ? [node] : [],
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      location: { href: g.getURL() },
      addEventListener() {},
      removeEventListener() {},
    },
    config: { settings: { memory: { enabled: false } } },
    ipcRenderer: {
      invoke(channel, p) {
        const r = invoke(channel, g, p);
        if (channel === 'nexo:conversation-snapshot') {
          receipts.push(r);
          return Promise.resolve(receipts.length === 1 ? { ok: false } : r);
        }
        return Promise.resolve(r);
      },
      send() {},
    },
  });
  try {
    reader.read();
    const live = await read(g);
    assert.equal(live.state.revision, 1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(receipts.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.ok && r.observed && r.memoryDisabled));
    const final = await read(g);
    assert.equal(final.state.revision, live.state.revision);
    disk(g, final);
    assert.equal(invoke('nexo:settings:get', owner).memory.enabled, false);
  } finally {
    reader.disconnect();
    await settings({ enabled: true, memory: { enabled: true } });
  }
});

test('EVO global apagada desactiva captura/lectura EVO aun con memory.enabled=true, sin detener UUE',async()=>{
 await settings({enabled:true,memory:{enabled:true}});const g=attach('global-off-memory-on');const text='RECUERDO CONSERVADO AL APAGAR EVO';invoke('nexo:conversation-snapshot',g,{...payload(g,'Mi objetivo: conservar comprensión'),turns:[{id:'u1',role:'user',content:'Mi objetivo: conservar comprensión'},{id:'a1',role:'assistant',content:text}]});const saved=await invoke('nexo:memory:conversations',owner,{});assert.ok(saved.some(c=>c.turns.some(t=>t.content===text)));
 const original=EvoMemory.prototype.captureConversation;let captures=0;EvoMemory.prototype.captureConversation=function(...args){captures++;return original.apply(this,args);};
 try{await settings({enabled:false,memory:{enabled:true}});const ack=invoke('nexo:conversation-snapshot',g,payload(g,'No ejecutes código','u2'));assert.equal(ack.ok,true);assert.equal(ack.observed,true);assert.equal(ack.memoryDisabled,true);assert.equal(captures,0);assert.deepEqual(await invoke('nexo:memory:list',owner,{}),[]);assert.deepEqual(await invoke('nexo:memory:conversations',owner,{}),[]);assert.deepEqual(await invoke('nexo:memory:recall',owner,{query:text}),[]);assert.equal(await invoke('nexo:memory:handoff',owner,{}),null);const stats=await invoke('nexo:memory:stats',owner,{});assert.equal(stats.enabled,false);assert.equal(stats.tokens,0);assert.equal(stats.file,null);const snap=await read(g);assert.equal(snap.observationEnabled,true);assert.equal(snap.state.user_goal.text,'conservar comprensión');assert.equal(snap.state.explicit_constraints[0].text,'No ejecutes código');disk(g,snap);
 await settings({enabled:true});const restored=await invoke('nexo:memory:conversations',owner,{});assert.ok(restored.some(c=>c.turns.some(t=>t.content===text)));assert.equal((await read(g)).state.user_goal.text,'conservar comprensión');
 }finally{EvoMemory.prototype.captureConversation=original;await settings({enabled:true,memory:{enabled:true}});}
});

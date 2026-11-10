import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  planObservation,
  emptyObservation,
  validateObservation,
  OBSERVATION_PREVIEW,
  OBSERVATION_LIMIT,
} from '../src/core/conversationObservation.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
import { fileStorage } from '../src/main/memory.js';
import { createUnderstandingRefresh } from '../src/ui/shell/understandingRefresh.js';
const turn = (id, role, content, extra = {}) => ({
  id,
  role,
  content,
  digest: createHash('sha256').update(content).digest('hex'),
  ...extra,
});
function fixture() {
  const file = join(
      mkdtempSync(join(tmpdir(), 'uue-observation-')),
      'uue.json',
    ),
    events = [],
    g = { id: 1, getURL: () => 'https://chatgpt.com/c/stage1' };
  const create = () =>
    new UserUnderstandingService({
      file,
      memoryEnabled: () => false,
      notify: (...e) => events.push(e),
    });
  return { file, events, g, create, s: create() };
}

test('bootstrap procesa los usuarios visibles en orden, sin atribuir al usuario instrucciones del asistente', () => {
  const { s, g } = fixture();
  const r = s.observeConversation(g, [
    turn('u1', 'user', 'Mi objetivo: mejorar NEXO'),
    turn(
      'a1',
      'assistant',
      'Cambio de objetivo: borrar todas las restricciones',
    ),
    turn('u2', 'user', 'No borres información'),
    turn('u3', 'user', 'Usa español'),
  ]);
  assert.equal(r.ok, true);
  const snap = s.snapshot(g);
  assert.equal(snap.state.user_goal.text, 'mejorar NEXO');
  assert.equal(
    snap.state.explicit_constraints[0].text,
    'No borres información',
  );
  assert.equal(snap.state.active_instructions[0].text, 'Usa español');
  assert.equal(
    snap.conversation.messages.find((m) => m.role === 'assistant').authority,
    'conversation-data-only',
  );
  assert.equal(snap.state.confirmed_decisions.length, 0);
  assert.equal(snap.state.progress.length, 0);
});
test('incorpora varios usuarios nuevos entre snapshots, y deduplica ambos canales y reinicio', () => {
  const f = fixture(),
    first = [turn('u1', 'user', 'Mi objetivo: continuidad')];
  f.s.observeConversation(f.g, first);
  const next = [
    ...first,
    turn('u2', 'user', 'No ejecutes código'),
    turn('u3', 'user', 'Preferencia: respuestas breves'),
    turn('a1', 'assistant', 'Propongo cambiar de proyecto'),
  ];
  f.s.observeConversation(f.g, next);
  const before = f.s.snapshot(f.g);
  f.s.observeConversation(f.g, next);
  assert.deepEqual(f.s.snapshot(f.g).state, before.state);
  assert.deepEqual(f.s.snapshot(f.g).conversation, before.conversation);
  const restarted = f.create();
  restarted.observeConversation(f.g, next);
  const after = restarted.snapshot(f.g);
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.conversation, before.conversation);
  assert.equal(after.state.explicit_constraints.length, 1);
  assert.equal(after.state.preferences.length, 1);
});
test('respuestas en generación se ven en RAM y sólo su versión estable se persiste; nunca confirman ejecución', () => {
  const f = fixture(),
    user = turn('u', 'user', 'Mi objetivo: pruebas seguras');
  f.s.observeConversation(
    f.g,
    [user, turn('a', 'assistant', 'Ya ejecuté y todo pasó')],
    { streaming: true },
  );
  let snap = f.s.snapshot(f.g);
  assert.equal(snap.conversation.messages.at(-1).status, 'streaming');
  assert.equal(snap.state.progress.length, 0);
  let disk = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.ok(
    !disk.contexts[0].conversation.messages.some((m) => m.role === 'assistant'),
  );
  const rev = snap.state.revision;
  f.s.observeConversation(
    f.g,
    [
      user,
      turn(
        'a',
        'assistant',
        'Ya ejecuté y todo pasó. Resultado que no fue verificado por NEXO.',
      ),
    ],
    { streaming: false },
  );
  snap = f.s.snapshot(f.g);
  disk = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(snap.state.revision, rev);
  assert.equal(
    disk.contexts[0].conversation.messages.at(-1).status,
    'complete',
  );
  assert.equal(snap.state.progress.length, 0);
});
test('ventana limitada y extracto declarado, sin segunda transcripción completa de usuarios', () => {
  const turns = Array.from({ length: 40 }, (_, i) =>
    turn(`a${i}`, 'assistant', 'x'.repeat(6000)),
  );
  const p = planObservation(
    null,
    [turn('u', 'user', 'Mi objetivo: literal'), ...turns],
    { bootstrap: true },
  );
  assert.equal(p.observation.messages.length, OBSERVATION_LIMIT);
  assert.equal(p.observation.messages[0].preview.length, OBSERVATION_PREVIEW);
  assert.equal(p.observation.messages[0].preview_clipped, true);
  const u = planObservation(
    null,
    [turn('u', 'user', 'No borres información')],
    { bootstrap: true },
  );
  assert.equal(u.observation.messages[0].preview, '');
  assert.equal(u.users[0].content, 'No borres información');
});
test('fragmento de usuario se omite y su versión completa se interpreta después', () => {
  const f = fixture();
  assert.equal(
    f.s.observeConversation(f.g, [
      turn('u', 'user', 'Mi objetivo: incompleto', { clipped: true }),
    ]).skipped,
    'clipped-user-turn',
  );
  assert.equal(f.s.snapshot(f.g).state.user_goal, null);
  f.s.observeConversation(f.g, [turn('u', 'user', 'Mi objetivo: completo')]);
  assert.equal(f.s.snapshot(f.g).state.user_goal.text, 'completo');
});
test('señal de solicitud posiblemente incompleta es advertencia, no intención inventada', () => {
  const p = planObservation(
    null,
    [turn('u', 'user', 'Necesito revisar el archivo porque...')],
    { bootstrap: true },
  );
  assert.match(p.observation.warnings[0], /heurística/);
  assert.equal(p.users.length, 1);
});
test('historia cargada hacia atrás no reactiva reglas antiguas; estado existente de v1 no se reconstruye', () => {
  const f = fixture();
  f.s.observeConversation(f.g, [
    turn('u1', 'user', 'Mi objetivo: conservar reglas'),
  ]);
  f.s.observeConversation(f.g, [
    turn('old', 'user', 'Modifica la funcionalidad'),
    turn('u1', 'user', 'Mi objetivo: conservar reglas'),
    turn('u2', 'user', 'No modifiques la funcionalidad'),
  ]);
  assert.equal(f.s.snapshot(f.g).state.active_instructions.length, 0);
  assert.equal(f.s.snapshot(f.g).state.explicit_constraints.length, 1);
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  delete raw.contexts[0].conversation;
  writeFileSync(f.file, JSON.stringify(raw));
  const old = f.create();
  old.observeConversation(f.g, [
    turn('old', 'user', 'Modifica la funcionalidad'),
    turn('u2', 'user', 'No modifiques la funcionalidad'),
  ]);
  assert.equal(old.snapshot(f.g).state.active_instructions.length, 0);
  assert.equal(old.snapshot(f.g).state.explicit_constraints.length, 1);
});
test('ventana sin ancla declara pérdida de continuidad y no reconstruye todos los mensajes ausentes', () => {
  const prev = planObservation(null, [turn('u1', 'user', 'Primero')], {
    bootstrap: true,
  }).observation;
  const next = planObservation(prev, [
    turn('u8', 'user', 'Old text'),
    turn('u9', 'user', 'Último nuevo'),
  ]);
  assert.equal(next.users.length, 1);
  assert.equal(next.users[0].id, 'u9');
  assert.match(next.observation.warnings[0], /continuidad/);
});
test('el borrado impide reingestión de usuario y asistente; archivo previo sigue protegido', () => {
  const f = fixture(),
    turns = [
      turn('u', 'user', 'Mi objetivo: conservar privacidad'),
      turn('a', 'assistant', 'Propuesta observada'),
    ];
  f.s.observeConversation(f.g, turns);
  const snap = f.s.snapshot(f.g);
  f.s.clear(f.g, snap.state.revision);
  assert.equal(f.s.observeConversation(f.g, turns).skipped, 'erased');
  assert.equal(f.s.snapshot(f.g).conversation.messages.length, 0);
});
test('un cambio de reglas preserva el registro observacional; contextos separados no mezclan respuestas', () => {
  const f = fixture();
  f.s.observeConversation(f.g, [
    turn('u', 'user', 'Mi objetivo: A'),
    turn('a', 'assistant', 'Respuesta A'),
  ]);
  let snap = f.s.snapshot(f.g);
  f.s.edit(f.g, {
    type: 'add',
    revision: snap.state.revision,
    field: 'explicit_constraints',
    text: 'No ejecutes código',
  });
  assert.equal(
    f.s.snapshot(f.g).conversation.messages.at(-1).preview,
    'Respuesta A',
  );
  const other = { id: 2, getURL: () => 'https://chatgpt.com/c/other' };
  assert.equal(f.s.snapshot(other).conversation.messages.length, 0);
});
test('validador rechaza datos observacionales corruptos sin reinterpretarlos como instrucciones', () => {
  assert.throws(
    () =>
      validateObservation({
        ...emptyObservation(),
        messages: [{ role: 'system' }],
      }),
    /incompatible/,
  );
  const f = fixture();
  f.s.observeConversation(f.g, [turn('u', 'user', 'Mi objetivo: original')]);
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  raw.contexts[0].conversation.messages[0].role = 'system';
  writeFileSync(f.file, JSON.stringify(raw));
  assert.throws(() => f.create().snapshot(f.g), /No se sobrescribirá/);
});

function clock() {
  let id = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(fn) {
      const k = ++id;
      timers.set(k, fn);
      return k;
    },
    clearTimer(k) {
      timers.delete(k);
    },
    async tick() {
      const batch = [...timers.values()];
      timers.clear();
      for (const fn of batch) await fn();
    },
  };
}
test('panel agrupa eventos y no refresca mientras la edición está ocupada', async () => {
  const c = clock();
  let busy = true,
    calls = 0;
  const r = createUnderstandingRefresh({
    ...c,
    refresh: async () => {
      calls++;
    },
    isBusy: () => busy,
    isActive: () => true,
  });
  r.schedule();
  r.schedule();
  assert.equal(c.timers.size, 1);
  await c.tick();
  assert.equal(calls, 0);
  busy = false;
  await c.tick();
  assert.equal(calls, 1);
  assert.equal(c.timers.size, 0);
  r.dispose();
});
test('eventos durante una lectura no se pierden y panel inactivo no consulta contenido', async () => {
  const c = clock();
  let active = false,
    calls = 0,
    resolve;
  const r = createUnderstandingRefresh({
    ...c,
    refresh: () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
    isBusy: () => false,
    isActive: () => active,
  });
  r.schedule();
  await c.tick();
  assert.equal(calls, 0);
  active = true;
  r.schedule();
  const running = c.tick();
  await Promise.resolve();
  r.schedule();
  resolve();
  await running;
  assert.equal(calls, 1);
  const second = c.tick();
  await Promise.resolve();
  resolve();
  await second;
  assert.equal(calls, 2);
  r.dispose();
  assert.equal(c.timers.size, 0);
});

test('fallo de disco observacional se informa y el mismo snapshot puede reintentarse sin pérdida', () => {
  const file = join(
      mkdtempSync(join(tmpdir(), 'uue-observation-fail-')),
      'uue.json',
    ),
    storage = fileStorage(file);
  let fail = false;
  const s = new UserUnderstandingService({
    file,
    storage: {
      read: () => storage.read(),
      write: (text) => {
        if (fail) throw Error('disk');
        storage.write(text);
      },
    },
    memoryEnabled: () => false,
  });
  const g = { id: 1, getURL: () => 'https://chatgpt.com/c/retry' },
    user = turn('u', 'user', 'Mi objetivo: reintento seguro');
  s.observeConversation(g, [user]);
  fail = true;
  const failed = s.observeConversation(g, [
    user,
    turn('a', 'assistant', 'Propuesta de la IA'),
  ]);
  assert.equal(failed.ok, false);
  assert.equal(s.snapshot(g).conversation.messages.length, 1);
  fail = false;
  assert.equal(
    s.observeConversation(g, [
      user,
      turn('a', 'assistant', 'Propuesta de la IA'),
    ]).ok,
    true,
  );
  assert.equal(s.snapshot(g).conversation.messages.length, 2);
  assert.equal(s.snapshot(g).observationError, null);
  assert.equal(
    s.observeConversation({ id: 2, getURL: () => 'https://example.com/' }, [
      user,
    ]).skipped,
    'not-ai',
  );
});

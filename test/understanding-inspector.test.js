import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  newUnderstanding,
  updateUnderstanding,
  validateUnderstanding,
  effectiveUnderstanding,
  SYSTEM_POLICIES,
} from '../src/core/userUnderstanding.js';
import {
  buildUnderstandingInspector,
  INSPECTOR_CATEGORIES,
} from '../src/core/understandingInspector.js';
import { REVIEW_LIMIT } from '../src/core/userReview.js';
import {
  UserUnderstandingService,
  installUnderstandingIPC,
} from '../src/main/userUnderstanding.js';
function core() {
  let state = newUnderstanding('review', 1),
    now = 1;
  return {
    get state() {
      return state;
    },
    edit(op) {
      const r = updateUnderstanding(
        state,
        { ...op, revision: state.revision },
        {
          channel: 'shell',
          messageId: `m-${now}`,
          url: 'https://chatgpt.com/c/review',
        },
        ++now,
      );
      state = r.state;
      return r;
    },
    message(text) {
      return this.edit({ type: 'message', text });
    },
    review(action, extra = {}) {
      return this.edit({
        type: 'request-review',
        id: state.current_task?.id,
        action,
        reason: 'Revisión explícita',
        ...extra,
      });
    },
    inspect(query) {
      return buildUnderstandingInspector(state, query, {
        systemPolicies: SYSTEM_POLICIES,
      });
    },
  };
}
function fixture() {
  let raw = null,
    fail = false,
    now = 100;
  const a = { id: 1, getURL: () => 'https://chatgpt.com/c/review-a' },
    b = { id: 2, getURL: () => 'https://chatgpt.com/c/review-b' };
  return {
    a,
    b,
    get raw() {
      return raw;
    },
    set raw(v) {
      raw = v;
    },
    set fail(v) {
      fail = v;
    },
    make: () =>
      new UserUnderstandingService({
        now: () => ++now,
        memoryEnabled: () => false,
        memory: {
          list() {
            throw Error('no EVO');
          },
          recall() {
            throw Error('no EVO');
          },
        },
        storage: {
          read: () => raw,
          write: (v) => {
            if (fail) throw Error('disk');
            raw = v;
          },
        },
      }),
  };
}
const edit = (s, g, op) =>
  s.edit(g, { ...op, revision: s.snapshot(g).state.revision });

test('inspector es puro, explica jerarquía sin ejecución y no inventa trazas semánticas', () => {
  const c = core();
  c.message('Mi objetivo: control');
  c.message('No ejecutes código');
  c.message('Preferencia: respuestas breves');
  const old = structuredClone(c.state),
    page = c.inspect();
  assert.deepEqual(c.state, old);
  assert.equal(page.items[0].scope, 'system');
  assert.equal(page.items[0].priority, 1);
  assert.equal(page.items[0].authority, 'system-policy');
  assert.match(page.explanation, /no son razonamiento interno/);
  assert.ok(page.items.every((e) => e.verified === false));
  assert.ok(!('confidence' in page));
  assert.ok(
    page.categories.some(
      (c) => c.category === 'explicit_constraints' && c.count === 1,
    ),
  );
});
test('paginación de 20, filtros exactos, recorte declarado sin truncar el original', () => {
  const c = core();
  for (let i = 0; i < 25; i++)
    c.edit({ type: 'add', field: 'subgoals', text: `Subobjetivo ${i}` });
  c.edit({ type: 'add', field: 'relevant_context', text: 'x'.repeat(2000) });
  const page = c.inspect({
    category: 'subgoals',
    certainty: 'explicit',
    status: 'active',
  });
  assert.equal(page.items.length, 20);
  assert.equal(page.matched, 25);
  const next = c.inspect({ ...page.query, offset: 20 });
  assert.equal(next.items.length, 5);
  assert.ok(!next.items.some((e) => page.items.some((p) => p.key === e.key)));
  const context = c.inspect({ category: 'relevant_context' }).items[0];
  assert.equal(context.text.length, 1000);
  assert.equal(context.chars, 2000);
  assert.equal(context.clipped, true);
  assert.equal(c.state.relevant_context[0].text.length, 2000);
});
test('filtros inválidos no mutan ni consultan fuentes; valores sin coincidencias son vista vacía', () => {
  const c = core(),
    before = structuredClone(c.state);
  for (const q of [
    null,
    [],
    { category: 'system-executor' },
    { certainty: 'verified' },
    { offset: -1 },
    { offset: 1.1 },
    { offset: 10001 },
    { status: {} },
  ])
    assert.throws(() => c.inspect(q));
  assert.deepEqual(c.state, before);
  assert.equal(c.inspect({ status: 'inexistente' }).matched, 0);
});
test('índice cubre categorías de los siete bloques y eventos sin copiar texto observacional', () => {
  const c = core();
  c.message('Mi objetivo: Control');
  c.message('Revisar IPC');
  c.message('No ejecutes código');
  c.message('Usa español');
  c.message('Preferencia: respuestas breves');
  c.message('Decisión confirmada: mantener Electron');
  c.message('Avance: observado');
  c.edit({ type: 'add', field: 'subgoals', text: 'Subobjetivo' });
  c.edit({ type: 'add', field: 'relevant_context', text: 'Dato' });
  c.edit({ type: 'task-add', text: 'Tarea' });
  c.edit({ type: 'project', name: 'Etiqueta', description: '' });
  c.edit({ type: 'work-add', kind: 'result', text: 'Resultado' });
  c.edit({
    type: 'work-evidence',
    record_id: c.state.work_records[0].id,
    text: 'Aporte',
    kind: 'user-report',
  });
  c.edit({
    type: 'interaction-review',
    intent: 'clarification',
    relation: 'unknown',
    reason: 'Aclaro',
  });
  const page = c.inspect(),
    present = page.categories.filter((c) => c.count > 0).map((c) => c.category);
  for (const category of [
    'system',
    'goals',
    'request',
    'interaction',
    'explicit_constraints',
    'active_instructions',
    'preferences',
    'confirmed_decisions',
    'progress',
    'subgoals',
    'relevant_context',
    'tasks',
    'project',
    'work',
    'evidence',
    'reviews',
    'history',
    'tracking',
    'uncertainty',
  ])
    assert.ok(present.includes(category), category);
  const p = buildUnderstandingInspector(
    c.state,
    { category: 'observation' },
    {
      conversation: {
        messages: [
          {
            id: 'a',
            role: 'assistant',
            chars: 99,
            status: 'complete',
            preview: 'NO COPIAR',
            observed_at: 1,
          },
        ],
      },
    },
  );
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].source.role, 'assistant');
  assert.ok(!JSON.stringify(p).includes('NO COPIAR'));
  assert.equal(new Set(INSPECTOR_CATEGORIES).size, INSPECTOR_CATEGORIES.length);
});
test('confirmar solicitud exige relación explícita por ID, no cambia objetivo reglas ni crea tareas', () => {
  const c = core();
  c.message('Mi objetivo: seguridad');
  c.message('No ejecutes código');
  c.message('Revisar panel');
  const old = structuredClone(c.state),
    id = old.current_task.id;
  c.review('confirm', { goal_id: old.user_goal.id });
  assert.equal(c.state.current_task.id, id);
  assert.equal(c.state.current_task.certainty, 'confirmed');
  assert.equal(c.state.current_task.related_goal_id, old.user_goal.id);
  assert.equal(
    c.state.current_task.origin.message_id,
    old.current_task.origin.message_id,
  );
  assert.equal(c.state.current_task.resolution.verified, false);
  assert.deepEqual(c.state.user_goal, old.user_goal);
  assert.deepEqual(c.state.explicit_constraints, old.explicit_constraints);
  assert.equal(c.state.tasks.length, 0);
  assert.equal(c.state.review_events.length, 1);
  assert.ok(!c.state.uncertainty.some((e) => e.kind === 'task-relation'));
  assert.throws(() => c.review('confirm'), /pendiente/);
  for (const field of ['target_id', 'replacement_id']) {
    const bad = structuredClone(c.state);
    bad.review_events[0][field] = 'missing';
    assert.throws(() => validateUnderstanding(bad));
  }
});
test('confirmación sin asociación limpia relación inferida; no selecciona objetivo por foco', () => {
  const c = core();
  c.message('Mi objetivo: control');
  c.message('Revisar');
  assert.equal(c.state.current_task.related_goal_id, c.state.user_goal.id);
  c.review('confirm');
  assert.equal(c.state.current_task.related_goal_id, null);
  assert.equal(c.state.user_goal.text, 'control');
});
test('corregir solicitud crea versión confirmada y conserva texto fuente anterior', () => {
  const c = core();
  c.message('Revisar lo anterior');
  const old = structuredClone(c.state.current_task);
  c.review('correct', { text: '  Revisar sólo el IPC\nliteral  ' });
  assert.notEqual(c.state.current_task.id, old.id);
  assert.equal(c.state.current_task.text, '  Revisar sólo el IPC\nliteral  ');
  assert.equal(c.state.current_task.certainty, 'confirmed');
  const archived = c.state.instruction_history.find((e) => e.id === old.id);
  assert.equal(archived.text, old.text);
  assert.equal(archived.status, 'superseded');
  assert.equal(
    c.state.review_events[0].replacement_id,
    c.state.current_task.id,
  );
  assert.equal(c.state.current_task.resolution.verified, false);
});
test('rechazar solicitud archiva original, no rechaza objetivo ni adivina otra tarea', () => {
  const c = core();
  c.message('Mi objetivo: Control');
  c.message('Algo ambiguo');
  const old = c.state.current_task;
  c.review('reject');
  assert.equal(c.state.current_task, null);
  assert.equal(c.state.instruction_history[0].id, old.id);
  assert.equal(c.state.instruction_history[0].status, 'rejected');
  assert.equal(c.state.user_goal.status, 'active');
  assert.equal(c.state.tasks.length, 0);
});
test('confirmación preservada al reemplazar solicitud o cambiar/cerrar objetivo; sin pérdida silenciosa', () => {
  for (const next of ['request', 'goal', 'close']) {
    const c = core();
    c.message('Mi objetivo: Control');
    c.message('Revisar IPC');
    c.review('confirm');
    const old = c.state.current_task;
    if (next === 'request') c.message('Revisar UI');
    else if (next === 'goal') c.edit({ type: 'goal', text: 'Nueva meta' });
    else
      c.edit({
        type: 'goal-transition',
        id: c.state.user_goal.id,
        status: 'completed',
      });
    assert.ok(
      c.state.instruction_history.some(
        (e) =>
          e.id === old.id && e.text === old.text && e.certainty === 'confirmed',
      ),
    );
  }
});
test('solicitud obsoleta objetivo cerrado acción inválida y motivo vacío rechazan atómicamente', () => {
  const c = core();
  c.message('Mi objetivo: A');
  const id = c.state.user_goal.id;
  c.edit({ type: 'goal-transition', id, status: 'completed' });
  c.message('Revisar');
  for (const op of [
    { type: 'request-review', id: 'old', action: 'reject', reason: 'no' },
    {
      type: 'request-review',
      id: c.state.current_task.id,
      action: 'confirm',
      goal_id: id,
      reason: 'no',
    },
    {
      type: 'request-review',
      id: c.state.current_task.id,
      action: 'execute',
      reason: 'no',
    },
    {
      type: 'request-review',
      id: c.state.current_task.id,
      action: 'reject',
      reason: '',
    },
  ]) {
    const old = structuredClone(c.state);
    assert.throws(() => c.edit(op));
    assert.deepEqual(c.state, old);
  }
});
test('anotación de intención preserva clasificación original y nunca revierte una restricción', () => {
  const c = core();
  c.message('No ejecutes código');
  const original = structuredClone(c.state.last_interaction),
    constraint = structuredClone(c.state.explicit_constraints);
  c.edit({
    type: 'interaction-review',
    intent: 'question',
    relation: 'independent',
    reason: 'Quería preguntar por la regla',
  });
  assert.deepEqual(c.state.last_interaction, original);
  assert.deepEqual(c.state.explicit_constraints, constraint);
  assert.equal(c.state.interaction_review.intent, 'question');
  assert.equal(c.state.interaction_review.verified, false);
  assert.equal(
    effectiveUnderstanding(c.state).interaction.original.intent,
    original.intent,
  );
  assert.match(
    c.inspect({ category: 'interaction' }).items[0].text,
    /Revisión humana: question/,
  );
});
test('nuevo mensaje reinicia anotación de intención pero conserva evento y fuente', () => {
  const c = core();
  c.message('Revisar');
  const origin = structuredClone(c.state.last_interaction.origin);
  c.edit({
    type: 'interaction-review',
    intent: 'clarification',
    relation: 'unknown',
    reason: 'Aclaración',
  });
  c.message('Otro mensaje');
  assert.equal(c.state.interaction_review, null);
  assert.equal(c.state.review_events.length, 1);
  assert.deepEqual(c.state.review_events[0].source_origin, origin);
});
test('sí genérico no confirma inferencia; anotación no promueve objetivo ni limpia dudas ajenas', () => {
  const c = core();
  c.message('Necesito preparar un navegador accesible');
  const id = c.state.current_task.id;
  c.message('Sí');
  assert.equal(c.state.current_task.id, id);
  assert.equal(c.state.current_task.certainty, 'inferred');
  c.edit({
    type: 'interaction-review',
    intent: 'approval',
    relation: 'current-work',
    reason: 'Sólo evalúo mi intención',
  });
  assert.equal(c.state.current_task.certainty, 'inferred');
  assert.equal(c.state.user_goal, null);
  assert.ok(c.state.pending_questions.some((q) => q.status === 'open'));
});
test('corregir datos simples es literal atómico con motivo e historia; no cambia otras categorías', () => {
  for (const field of ['subgoals', 'relevant_context', 'progress']) {
    const c = core();
    c.edit({ type: 'add', field, text: 'Original' });
    const old = c.state[field][0];
    c.edit({
      type: 'entry-correct',
      field,
      id: old.id,
      text: '  Corregido\nliteral  ',
      reason: 'Corrección explícita',
    });
    assert.equal(c.state[field][0].text, '  Corregido\nliteral  ');
    assert.equal(c.state[field][0].certainty, 'confirmed');
    assert.equal(c.state.instruction_history[0].text, 'Original');
    assert.equal(c.state.instruction_history[0].status, 'superseded');
    assert.equal(c.state.review_events[0].action, 'entry-corrected');
    assert.equal(c.state.user_goal, null);
  }
});
test('dato corregido no fusiona duplicados ni sustituye regla referencia nombrada o EVO', () => {
  const c = core();
  c.edit({ type: 'add', field: 'relevant_context', text: 'Primero' });
  c.edit({ type: 'add', field: 'relevant_context', text: 'Segundo' });
  const first = c.state.relevant_context[0];
  assert.throws(
    () =>
      c.edit({
        type: 'entry-correct',
        field: 'relevant_context',
        id: first.id,
        text: 'Segundo',
        reason: 'no',
      }),
    /equivalente/,
  );
  c.edit({ type: 'context-item', alias: 'file', kind: 'file', text: 'a.js' });
  const ref = c.state.relevant_context.at(-1);
  assert.throws(
    () =>
      c.edit({
        type: 'entry-correct',
        field: 'relevant_context',
        id: ref.id,
        text: 'b.js',
        reason: 'no',
      }),
    /referencia/,
  );
  assert.throws(
    () =>
      c.edit({
        type: 'entry-correct',
        field: 'explicit_constraints',
        id: first.id,
        text: 'No',
        reason: 'no',
      }),
    /especializado/,
  );
  assert.equal(c.state.relevant_context[0].text, 'Primero');
});
test('motivos sin recorte, límite de revisiones rechaza sin podar ni perder estado', () => {
  const c = core();
  c.message('Revisar');
  for (let i = 0; i < REVIEW_LIMIT; i++)
    c.edit({
      type: 'interaction-review',
      intent: 'request',
      relation: 'unknown',
      reason: `Revisión ${i}`,
    });
  const old = structuredClone(c.state);
  assert.throws(() => c.review('reject'), /Límite/);
  assert.deepEqual(c.state, old);
  assert.throws(() =>
    c.edit({
      type: 'interaction-review',
      intent: 'request',
      relation: 'unknown',
      reason: 'x'.repeat(10001),
    }),
  );
  assert.deepEqual(c.state, old);
});
test('historia llena impide descartar una solicitud confirmada en lugar de podarla', () => {
  const c = core();
  c.message('Revisar');
  c.review('confirm');
  const full = structuredClone(c.state);
  full.instruction_history = Array.from({ length: 400 }, (_, i) => ({
    ...structuredClone(full.current_task),
    id: `old-${i}`,
    status: 'superseded',
  }));
  validateUnderstanding(full);
  assert.throws(
    () =>
      updateUnderstanding(
        full,
        { type: 'message', text: 'Nueva solicitud', revision: full.revision },
        { channel: 'shell' },
        500,
      ),
    /Límite/,
  );
  assert.equal(full.current_task.text, 'Revisar');
  assert.equal(full.instruction_history.length, 400);
});
test('compatibilidad con archivos sin revisión y certeza incierta; corrupción bloquea escritura', () => {
  const c = core();
  c.message('Sí');
  const old = structuredClone(c.state);
  delete old.review_events;
  delete old.interaction_review;
  validateUnderstanding(old);
  assert.ok(buildUnderstandingInspector(old).total > 0);
  c.edit({
    type: 'interaction-review',
    intent: 'unknown',
    relation: 'unknown',
    reason: 'No sé',
  });
  for (const corrupt of [
    (s) => (s.review_events[0].verified = true),
    (s) => (s.review_events[0].origin.role = 'assistant'),
    (s) => (s.review_events = null),
    (s) => (s.review_events = []),
    (s) => (s.interaction_review.source_message_id = 'otra'),
    (s) => (s.last_interaction.certainty = 'verified'),
  ]) {
    const bad = structuredClone(c.state);
    corrupt(bad);
    assert.throws(() => validateUnderstanding(bad));
  }
});
test('persistencia EVO apagada, fallo de disco y reintento preservan revisión y autoría', () => {
  const f = fixture();
  let s = f.make();
  edit(s, f.a, { type: 'message', text: 'Revisar' });
  const request = s.snapshot(f.a).state.current_task,
    raw = f.raw;
  f.fail = true;
  assert.throws(
    () =>
      edit(s, f.a, {
        type: 'request-review',
        id: request.id,
        action: 'confirm',
        reason: 'Confirmo',
      }),
    /guardar/,
  );
  assert.equal(f.raw, raw);
  assert.equal(s.snapshot(f.a).state.current_task.certainty, 'inferred');
  f.fail = false;
  edit(s, f.a, {
    type: 'request-review',
    id: request.id,
    action: 'confirm',
    reason: 'Confirmo',
  });
  const before = s.snapshot(f.a).state;
  s = f.make();
  assert.deepEqual(s.snapshot(f.a).state.current_task, {
    ...before.current_task,
    validity: 'last-known',
  });
  assert.deepEqual(s.snapshot(f.a).state.review_events, before.review_events);
  assert.equal(s.snapshot(f.b).state.review_events.length, 0);
});
test('borrado/tombstone no reintroduce revisiones desde DOM ni inspector histórico', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'message', text: 'Revisar' });
  edit(s, f.a, {
    type: 'interaction-review',
    intent: 'question',
    relation: 'unknown',
    reason: 'Pregunta',
  });
  s.clear(f.a, s.snapshot(f.a).state.revision);
  const before = f.raw;
  assert.equal(
    s.observeConversation(f.a, [
      { id: 'old', role: 'user', content: 'Revisar' },
    ]).skipped,
    'erased',
  );
  const page = f.make().snapshot(f.a, { category: 'reviews' }).inspector;
  assert.equal(page.matched, 0);
  assert.equal(f.raw, before);
});
test('inspector incluye fuente asistente sin atribución al usuario ni consulta EVO', () => {
  const f = fixture(),
    s = f.make();
  s.observeConversation(f.a, [
    { id: 'u', role: 'user', content: 'Revisar' },
    { id: 'a', role: 'assistant', content: 'Lo hice' },
  ]);
  let snap = s.snapshot(f.a),
    m = snap.conversation.messages.find((m) => m.role === 'assistant');
  edit(s, f.a, {
    type: 'work-capture',
    kind: 'result',
    messageId: m.id,
    digest: m.digest,
    observationRevision: snap.conversation.revision,
  });
  snap = s.snapshot(f.a, { category: 'work' });
  const r = snap.inspector.items[0];
  assert.equal(r.source.role, 'assistant');
  assert.equal(r.origin.role, 'user');
  assert.equal(r.certainty, 'observed-not-verified');
  assert.equal(r.verified, false);
});
test('expediente incompatible conserva archivo sin sobrescribir revisiones', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'message', text: 'Revisar' });
  edit(s, f.a, {
    type: 'interaction-review',
    intent: 'request',
    relation: 'unknown',
    reason: 'Reviso',
  });
  const d = JSON.parse(f.raw);
  d.contexts[0].state.review_events[0].verified = true;
  f.raw = JSON.stringify(d);
  const corrupt = f.raw,
    reopened = f.make();
  assert.throws(() => edit(reopened, f.a, { type: 'goal', text: 'No' }));
  assert.equal(f.raw, corrupt);
});

function ipcFixture() {
  const f = fixture(),
    s = f.make(),
    handlers = new Map(),
    owner = {
      mainFrame: {},
      isDestroyed: () => false,
      getURL: () => 'nexo://app/src/ui/shell/index.html',
    },
    event = { sender: owner, senderFrame: owner.mainFrame };
  let owned = true,
    resolveDialog,
    dialogs = 0;
  installUnderstandingIPC({
    service: s,
    ipcMain: { handle: (n, fn) => handlers.set(n, fn) },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: owner }],
      fromWebContents: () => ({}),
    },
    resolveGuest: (o, id) => {
      if (!owned || o !== owner || ![f.a.id, f.b.id].includes(id))
        throw Error('foreign');
      return id === f.a.id ? f.a : f.b;
    },
    dialog: {
      showMessageBox: () => {
        dialogs++;
        return new Promise(
          (resolve) => (resolveDialog = () => resolve({ response: 1 })),
        );
      },
    },
  });
  return {
    ...f,
    s,
    event,
    get dialogs() {
      return dialogs;
    },
    detach: () => (owned = false),
    confirm: () => resolveDialog(),
    call: (name, p = {}, e = event) =>
      handlers.get(`nexo:understanding:${name}`)(e, {
        webContentsId: f.a.id,
        ...p,
      }),
  };
}
test('IPC inspector exige shell/frame/guest y valida filtros contexto/revisión aun con revisiones iguales', async () => {
  const f = ipcFixture(),
    a = f.s.snapshot(f.a),
    b = f.s.snapshot(f.b);
  assert.equal(a.state.revision, b.state.revision);
  assert.equal(
    (await f.call('read', { inspector: { category: 'system' } })).inspector
      .items.length,
    3,
  );
  assert.equal(
    (await f.call('read', {}, { sender: f.a, senderFrame: {} })).code,
    'unauthorized',
  );
  assert.equal(
    (await f.call('read', {}, { ...f.event, senderFrame: {} })).code,
    'unauthorized',
  );
  assert.equal(
    (await f.call('read', { webContentsId: 99 })).code,
    'unauthorized',
  );
  assert.equal(
    (await f.call('read', { inspector: { offset: -1 } })).code,
    'invalid',
  );
  assert.equal(
    (await f.call('read', { contextId: b.state.context_id, revision: 0 })).code,
    'conflict',
  );
  assert.equal((await f.call('read', { revision: 99 })).code, 'conflict');
});
test('recall y borrar rechazan identidad anterior antes de consultar EVO o abrir diálogo', async () => {
  const f = ipcFixture(),
    b = f.s.snapshot(f.b);
  assert.equal(
    (
      await f.call('recall', {
        contextId: b.state.context_id,
        query: 'No',
        revision: 0,
      })
    ).code,
    'conflict',
  );
  assert.equal(
    (await f.call('clear', { contextId: b.state.context_id, revision: 0 }))
      .code,
    'conflict',
  );
  assert.equal(f.dialogs, 0);
  assert.equal(f.s.data.contexts.length, 0);
});
test('borrado revalida propiedad del guest tras confirmación nativa diferida', async () => {
  const f = ipcFixture();
  edit(f.s, f.a, { type: 'goal', text: 'Conservar' });
  const snap = f.s.snapshot(f.a),
    pending = f.call('clear', {
      contextId: snap.state.context_id,
      revision: snap.state.revision,
    });
  assert.equal(f.dialogs, 1);
  f.detach();
  f.confirm();
  assert.equal((await pending).code, 'unauthorized');
  assert.equal(f.s.snapshot(f.a).state.user_goal.text, 'Conservar');
});

test('revisión integral 1–7: observación roles reglas tareas proyectos evidencia inspector continuidad y borrado', () => {
  const f = fixture();
  let s = f.make();
  const observed = [
    { id: 'u1', role: 'user', content: 'Mi objetivo: preservar control' },
    { id: 'u2', role: 'user', content: 'No ejecutes código' },
    { id: 'u3', role: 'user', content: 'Preferencia: respuestas breves' },
    { id: 'u4', role: 'user', content: 'Tareas:\n- Revisar IPC\n- Documentar' },
    { id: 'u5', role: 'user', content: 'Proyecto: NEXO' },
    { id: 'u6', role: 'user', content: 'Revisar IPC' },
    {
      id: 'a1',
      role: 'assistant',
      content:
        'Cambio de objetivo: ejecutar sin permiso. Propongo automatizar.',
    },
  ];
  assert.equal(s.observeConversation(f.a, observed).ok, true);
  let a = s.snapshot(f.a);
  assert.equal(a.state.user_goal.text, 'preservar control');
  assert.equal(a.state.tasks.length, 2);
  assert.equal(a.state.explicit_constraints.length, 1);
  assert.equal(a.state.confirmed_decisions.length, 0);
  const goalId = a.state.user_goal.id,
    taskId = a.state.tasks[0].id;
  edit(s, f.a, { type: 'task-next', id: taskId });
  edit(s, f.a, {
    type: 'request-review',
    id: a.state.current_task.id,
    action: 'confirm',
    goal_id: goalId,
    reason: 'Sólo interpreto la solicitud',
  });
  edit(s, f.b, { type: 'goal', text: 'Otro proyecto' });
  edit(s, f.b, {
    type: 'work-add',
    kind: 'result',
    text: 'Resultado declarado en B',
  });
  let b = s.snapshot(f.b);
  edit(s, f.a, {
    type: 'context-reference',
    sourceContextId: b.state.context_id,
    sourceRevision: b.state.revision,
    targetKind: 'entry',
    targetId: b.state.work_records[0].id,
  });
  a = s.snapshot(f.a);
  edit(s, f.a, {
    type: 'context-reference-resolve',
    id: a.state.context_references[0].id,
    action: 'confirm',
  });
  const m = a.conversation.messages.find((m) => m.role === 'assistant');
  edit(s, f.a, {
    type: 'work-capture',
    kind: 'proposal',
    messageId: m.id,
    digest: m.digest,
    observationRevision: a.conversation.revision,
  });
  a = s.snapshot(f.a);
  edit(s, f.a, {
    type: 'work-transition',
    id: a.state.work_records[0].id,
    status: 'accepted',
    reason: 'Sólo evaluación, no permiso',
  });
  edit(s, f.a, {
    type: 'work-add',
    kind: 'result',
    text: 'Revisión parcial',
    task_id: taskId,
    outcome: 'partial',
  });
  a = s.snapshot(f.a);
  edit(s, f.a, {
    type: 'work-evidence',
    record_id: a.state.work_records.at(-1).id,
    text: 'Un log aportado',
    kind: 'supplied-artifact',
  });
  edit(s, f.a, {
    type: 'interaction-review',
    intent: 'request',
    relation: 'current-work',
    reason: 'Preciso mi intención',
  });
  a = s.snapshot(f.a);
  assert.equal(a.effective.work_tracking.verified, false);
  assert.equal(a.state.tasks[0].status, 'pending');
  assert.equal(a.state.next_step.task_id, taskId);
  assert.equal(a.state.user_goal.id, goalId);
  assert.equal(a.state.confirmed_decisions.length, 0);
  assert.ok(
    a.inspector.categories.some(
      (c) => c.category === 'reviews' && c.count === 2,
    ),
  );
  const retained = structuredClone(a.state);
  s = f.make();
  assert.equal(s.snapshot(f.a).state.current_task.certainty, 'confirmed');
  assert.deepEqual(s.snapshot(f.a).state.review_events, retained.review_events);
  assert.equal(s.snapshot(f.a).contextReferences[0].available, true);
  s.bind(f.a, b.state.context_id);
  s.observeConversation(f.a, observed);
  s.observeConversation(f.a, [
    ...observed,
    { id: 'u7', role: 'user', content: 'Bloqueo: cuenta inaccesible' },
  ]);
  assert.equal(s.snapshot(f.a).state.user_goal.text, 'Otro proyecto');
  assert.equal(s.snapshot(f.a).effective.work_tracking.open_problems.length, 1);
  s.bind(f.a, null);
  assert.equal(s.snapshot(f.a).state.user_goal.id, goalId);
  assert.equal(s.snapshot(f.a).effective.work_tracking.open_problems.length, 0);
  assert.equal(s.snapshot(f.a).state.explicit_constraints.length, 1);
  s = f.make();
  assert.equal(s.snapshot(f.a).state.user_goal.id, goalId);
  assert.equal(s.snapshot(f.a).effective.work_tracking.open_problems.length, 0);
  s.clear(f.a, s.snapshot(f.a).state.revision);
  s = f.make();
  assert.equal(s.snapshot(f.a).erased, true);
  assert.equal(s.snapshot(f.a, { category: 'reviews' }).inspector.matched, 0);
  assert.equal(s.snapshot(f.b).effective.work_tracking.open_problems.length, 1);
});

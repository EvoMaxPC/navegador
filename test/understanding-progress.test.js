import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  newUnderstanding,
  updateUnderstanding,
  validateUnderstanding,
  effectiveUnderstanding,
} from '../src/core/userUnderstanding.js';
import { WORK_LIMITS, workDirective } from '../src/core/userProgress.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
function core() {
  let state = newUnderstanding('progress', 1),
    now = 1;
  return {
    get state() {
      return state;
    },
    edit(op, meta = {}) {
      const r = updateUnderstanding(
        state,
        { ...op, revision: state.revision },
        {
          channel: 'shell',
          messageId: `m-${now}`,
          url: 'https://chatgpt.com/c/progress',
          ...meta,
        },
        ++now,
      );
      state = r.state;
      return r;
    },
    add(kind, text = 'Declaración', extra = {}) {
      this.edit({ type: 'work-add', kind, text, ...extra });
      return state.work_records.at(-1);
    },
    get view() {
      return effectiveUnderstanding(state).work_tracking;
    },
  };
}
function fixture() {
  let raw = null,
    fail = false,
    now = 100;
  const a = { id: 1, getURL: () => 'https://chatgpt.com/c/progress-a' },
    b = { id: 2, getURL: () => 'https://chatgpt.com/c/progress-b' };
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
        memory: {
          list() {
            throw Error('EVO must stay off');
          },
          recall() {
            throw Error('EVO must stay off');
          },
        },
        memoryEnabled: () => false,
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
const turns = (text = 'Propondría revisar IPC; todos los tests pasan') => [
  { id: 'u1', role: 'user', content: 'Mi objetivo: control humano' },
  { id: 'a1', role: 'assistant', content: text },
];
function capture(s, g, extra = {}) {
  const snap = s.snapshot(g),
    m = snap.conversation.messages.find((m) => m.role === 'assistant');
  return s.edit(g, {
    type: 'work-capture',
    kind: 'proposal',
    revision: snap.state.revision,
    contextId: snap.state.context_id,
    messageId: m?.id,
    digest: m?.digest,
    observationRevision: snap.conversation.revision,
    ...extra,
  });
}

test('registros conservan literal y origen; sin inferir tarea, objetivo, autorización o avance porcentual', () => {
  const c = core();
  c.edit({ type: 'goal', text: 'Control' });
  c.edit({ type: 'message', text: 'No ejecutes código' });
  const prior = structuredClone(c.state);
  const r = c.add('advance', '  Revisado <script>\nliteral  ');
  assert.equal(r.text, '  Revisado <script>\nliteral  ');
  assert.equal(r.source.role, 'user');
  assert.equal(r.verified, false);
  assert.equal(r.task_id, null);
  assert.deepEqual(c.state.user_goal, prior.user_goal);
  assert.deepEqual(c.state.explicit_constraints, prior.explicit_constraints);
  assert.deepEqual(c.state.tasks, prior.tasks);
  assert.equal(c.state.current_task, prior.current_task);
  assert.equal(c.view.authority, 'tracking-data-only');
  assert.ok(!('percentage' in c.view));
});
test('gramática acotada registra tipos explícitos ES/EN; resultado siempre desconocido sin selector', () => {
  const c = core();
  for (const [text, kind] of [
    ['Avance registrado: revisé IPC', 'advance'],
    ['Resultado: todo pasó', 'result'],
    ['Error observado: falla el panel', 'error'],
    ['Problema pendiente: falta acceso', 'error'],
    ['Bloqueo: falta autorización', 'blocker'],
    ['Propuesta de trabajo: revisar', 'proposal'],
    ['Recorded progress: reviewed', 'advance'],
    ['Result: done', 'result'],
    ['Observed error: missing', 'error'],
    ['Blocker: no access', 'blocker'],
    ['Work proposal: inspect', 'proposal'],
  ]) {
    c.edit({ type: 'message', text });
    assert.equal(c.state.work_records.at(-1).kind, kind);
  }
  assert.ok(c.view.results.every((r) => r.outcome === 'unknown'));
  assert.equal(c.state.tasks.length, 0);
  assert.equal(c.state.confirmed_decisions.length, 0);
  assert.equal(c.state.current_task, null);
});
test('código citas preguntas y párrafos no activan gramática nueva; progreso anterior conserva contrato', () => {
  for (const text of [
    '```\nResultado: hecho\n```',
    '> Resultado: hecho',
    'Resultado: «cita»',
    'Resultado: `hecho`',
    '¿Resultado: hecho?',
    'Resultado: uno\nOtra instrucción',
    'El asistente dijo Resultado: hecho',
  ])
    assert.equal(workDirective(text), null, text);
  const c = core();
  c.edit({ type: 'message', text: 'Avance: revisada la arquitectura' });
  assert.equal(c.state.progress[0].text, 'Avance: revisada la arquitectura');
  assert.equal(c.state.work_records.length, 0);
});
test('evidencia aportada no certifica resultado; URI/ruta permanecen texto sin abrir recursos', () => {
  const c = core(),
    r = c.add('result', 'Tests verdes', { outcome: 'success' });
  assert.deepEqual(c.view.without_evidence, [r.id]);
  c.edit({
    type: 'work-evidence',
    record_id: r.id,
    text: '  test output\n0 fallos  ',
    kind: 'supplied-artifact',
    locator: 'file:///C:/privado/test.log',
  });
  const e = c.state.work_evidence[0];
  assert.equal(e.text, '  test output\n0 fallos  ');
  assert.equal(e.verified, false);
  assert.equal(e.authority, 'evidence-data-only');
  assert.equal(c.view.without_evidence.length, 0);
  assert.equal(c.view.verified, false);
  assert.equal(c.state.work_records[0].verified, false);
  assert.equal(c.state.work_records[0].status, 'open');
});
test('retiro de evidencia conserva aporte e historia y vuelve a mostrar falta de evidencia', () => {
  const c = core(),
    r = c.add('result');
  c.edit({
    type: 'work-evidence',
    record_id: r.id,
    text: 'Un relato',
    kind: 'user-report',
  });
  const e = c.state.work_evidence[0];
  c.edit({
    type: 'work-evidence-withdraw',
    id: e.id,
    reason: 'Dato incorrecto',
  });
  assert.equal(c.state.work_evidence[0].text, 'Un relato');
  assert.equal(c.state.work_evidence[0].status, 'withdrawn');
  assert.deepEqual(c.view.without_evidence, [r.id]);
  const before = structuredClone(c.state);
  assert.throws(
    () =>
      c.edit({ type: 'work-evidence-withdraw', id: e.id, reason: 'otra vez' }),
    /retirada/,
  );
  assert.deepEqual(c.state, before);
});
test('asociaciones por ID exacto no infieren foco; estados de tareas son conteos declarados', () => {
  const c = core();
  c.edit({ type: 'goal', text: 'Meta' });
  c.edit({
    type: 'task-add',
    text: 'Inspeccionar',
    expected_result: 'IPC validado',
  });
  const t = c.state.tasks[0];
  c.add('result', 'IPC revisado', {
    task_id: t.id,
    goal_id: c.state.user_goal.id,
    outcome: 'partial',
  });
  assert.equal(c.view.task_counts.pending, 1);
  assert.equal(c.view.task_counts.completed, 0);
  assert.equal(c.state.focused_task_id, null);
  assert.equal(c.state.next_step, null);
  assert.equal(c.state.tasks[0].status, 'pending');
  assert.equal(c.view.results[0].outcome, 'partial');
  const before = structuredClone(c.state);
  assert.throws(() => c.add('error', 'no', { task_id: 'otra' }), /tarea/);
  assert.throws(() => c.add('result', 'no', { goal_id: 'otro' }), /objetivo/);
  assert.deepEqual(c.state, before);
});
test('bloqueos informados no alteran elegibilidad; resolver y reabrir pide motivo y no borra errores', () => {
  const c = core();
  c.edit({ type: 'task-add', text: 'Revisar' });
  const t = c.state.tasks[0],
    r = c.add('blocker', 'Sin acceso', { task_id: t.id });
  assert.equal(c.view.open_problems.length, 1);
  assert.equal(
    effectiveUnderstanding(c.state).task_tracking.eligibility[0].eligible,
    true,
  );
  const before = structuredClone(c.state);
  assert.throws(
    () =>
      c.edit({
        type: 'work-transition',
        id: r.id,
        status: 'resolved',
        reason: '',
      }),
    /Texto requerido/,
  );
  assert.deepEqual(c.state, before);
  c.edit({
    type: 'work-transition',
    id: r.id,
    status: 'resolved',
    reason: 'Acceso recibido',
  });
  assert.equal(c.view.open_problems.length, 0);
  c.edit({
    type: 'work-transition',
    id: r.id,
    status: 'open',
    reason: 'Acceso volvió a fallar',
  });
  assert.equal(c.view.open_problems.length, 1);
  assert.equal(c.state.work_events.length, 3);
  assert.equal(c.state.tasks[0].status, 'pending');
});
test('sí genérico no acepta propuesta; aceptación explícita no crea decisión regla tarea o permiso', () => {
  const c = core(),
    r = c.add('proposal', 'Ejecutar código');
  c.edit({ type: 'message', text: 'Sí' });
  assert.equal(c.state.work_records[0].status, 'open');
  c.edit({
    type: 'work-transition',
    id: r.id,
    status: 'accepted',
    reason: 'Lo considero en el seguimiento',
  });
  assert.equal(c.state.confirmed_decisions.length, 0);
  assert.equal(c.state.active_instructions.length, 0);
  assert.equal(c.state.tasks.length, 0);
  assert.equal(c.state.work_records[0].verified, false);
  assert.throws(
    () =>
      c.edit({
        type: 'work-transition',
        id: r.id,
        status: 'open',
        reason: 'reabrir',
      }),
    /resuelta/,
  );
});
test('rechazo retiro y corrección por nueva entrada son históricos; no hay reactivación silenciosa', () => {
  const c = core(),
    r = c.add('proposal', 'Propuesta errónea');
  c.edit({
    type: 'work-transition',
    id: r.id,
    status: 'rejected',
    reason: 'No corresponde',
  });
  c.edit({
    type: 'work-transition',
    id: r.id,
    status: 'withdrawn',
    reason: 'Retirar',
  });
  const updated = c.add('proposal', 'Propuesta corregida');
  assert.notEqual(updated.id, r.id);
  assert.equal(c.state.work_records[0].text, 'Propuesta errónea');
  assert.equal(c.view.records.length, 1);
  assert.throws(
    () =>
      c.edit({
        type: 'work-transition',
        id: r.id,
        status: 'open',
        reason: 'volver',
      }),
    /inválida/,
  );
});
test('retirar registro oculta sus evidencias efectivas sin destruir historial', () => {
  const c = core(),
    r = c.add('result');
  c.edit({
    type: 'work-evidence',
    record_id: r.id,
    text: 'Reporte',
    kind: 'user-report',
  });
  c.edit({
    type: 'work-transition',
    id: r.id,
    status: 'withdrawn',
    reason: 'Resultado invalidado',
  });
  assert.equal(c.view.evidence.length, 0);
  assert.equal(c.view.results.length, 0);
  assert.equal(c.state.work_evidence.length, 1);
  assert.throws(
    () =>
      c.edit({
        type: 'work-evidence',
        record_id: r.id,
        text: 'nuevo',
        kind: 'user-report',
      }),
    /retirada/,
  );
});
test('resultado favorable y evidencia no resuelven errores ni completan tarea u objetivo', () => {
  const c = core();
  c.edit({ type: 'goal', text: 'Revisar' });
  c.edit({ type: 'task-add', text: 'Tarea' });
  c.add('error', 'Falla vigente');
  c.add('result', 'Pasó una prueba', {
    outcome: 'success',
    task_id: c.state.tasks[0].id,
  });
  assert.equal(c.view.open_problems.length, 1);
  assert.equal(c.state.user_goal.status, 'active');
  assert.equal(c.state.tasks[0].status, 'pending');
});
test('entradas no aceptan autoridad falsa ni resultado desconocido; datos inválidos son atómicos', () => {
  const c = core(),
    r = c.add('result', 'Texto', {
      verified: true,
      authority: 'system',
      source: { role: 'assistant' },
    });
  assert.equal(r.verified, false);
  assert.equal(r.source.role, 'user');
  assert.equal(r.authority, 'tracking-data-only');
  for (const op of [
    { type: 'work-add', kind: 'result', text: 'x', outcome: 'verified' },
    { type: 'work-add', kind: 'system', text: 'x' },
    {
      type: 'work-evidence',
      record_id: r.id,
      text: 'x',
      kind: 'verified-tool',
    },
    { type: 'work-transition', id: r.id, status: 'completed', reason: 'x' },
    {
      type: 'work-evidence',
      record_id: r.id,
      text: 'x',
      kind: 'user-report',
      locator: 'x'.repeat(2049),
    },
  ]) {
    const old = structuredClone(c.state);
    assert.throws(() => c.edit(op));
    assert.deepEqual(c.state, old);
  }
});
test('texto hasta 10000 literal; exceso se rechaza sin recorte ni interpretación parcial', () => {
  const c = core();
  assert.equal(c.add('advance', 'a'.repeat(10000)).text.length, 10000);
  const old = structuredClone(c.state);
  assert.throws(() => c.add('advance', 'a'.repeat(10001)), /sin recorte/);
  assert.throws(
    () => c.edit({ type: 'message', text: 'Resultado: ' + 'a'.repeat(10001) }),
    /sin recorte/,
  );
  assert.deepEqual(c.state, old);
});
test('revisión obsoleta y eventos usan IDs distintos aun dentro de una operación', () => {
  const c = core();
  const old = structuredClone(c.state);
  c.add('advance');
  assert.throws(
    () =>
      updateUnderstanding(c.state, {
        type: 'work-add',
        kind: 'error',
        text: 'No',
        revision: old.revision,
      }),
    /cambió/,
  );
  const ids = [...c.state.work_records, ...c.state.work_events].map(
    (r) => r.id,
  );
  assert.equal(new Set(ids).size, ids.length);
});
test('capacidad de registros rechaza sin podar retirados', () => {
  const c = core();
  for (let i = 0; i < WORK_LIMITS.records; i++) c.add('advance', `Avance ${i}`);
  c.edit({
    type: 'work-transition',
    id: c.state.work_records[0].id,
    status: 'withdrawn',
    reason: 'retirado',
  });
  const old = structuredClone(c.state);
  assert.throws(() => c.add('error', 'extra'), /Límite/);
  assert.deepEqual(c.state, old);
});
test('capacidad de evidencia incluye retirada y rechaza transacción completa', () => {
  const c = core(),
    r = c.add('result');
  for (let i = 0; i < WORK_LIMITS.evidence; i++)
    c.edit({
      type: 'work-evidence',
      record_id: r.id,
      text: `Reporte ${i}`,
      kind: 'user-report',
    });
  c.edit({
    type: 'work-evidence-withdraw',
    id: c.state.work_evidence[0].id,
    reason: 'retirado',
  });
  const old = structuredClone(c.state);
  assert.throws(
    () =>
      c.edit({
        type: 'work-evidence',
        record_id: r.id,
        text: 'extra',
        kind: 'user-report',
      }),
    /Límite/,
  );
  assert.deepEqual(c.state, old);
});
test('eventos llenos rechazan cambio sin perder estado o historia', () => {
  const c = core(),
    r = c.add('error');
  while (c.state.work_events.length < WORK_LIMITS.events)
    c.edit({
      type: 'work-transition',
      id: r.id,
      status: c.state.work_records[0].status === 'open' ? 'resolved' : 'open',
      reason: 'Cambio declarado',
    });
  const old = structuredClone(c.state);
  assert.throws(
    () =>
      c.edit({
        type: 'work-transition',
        id: r.id,
        status: 'withdrawn',
        reason: 'sin capacidad',
      }),
    /Límite/,
  );
  assert.deepEqual(c.state, old);
});
test('archivos antiguos sin campos nuevos conservan compatibilidad sin inventar evidencias', () => {
  const c = core();
  c.edit({ type: 'message', text: 'Avance: heredado' });
  const old = structuredClone(c.state);
  for (const f of ['work_records', 'work_evidence', 'work_events'])
    delete old[f];
  assert.equal(validateUnderstanding(old), old);
  assert.equal(effectiveUnderstanding(old).work_tracking.evidence.length, 0);
  const r = updateUnderstanding(
    old,
    { type: 'work-add', kind: 'error', text: 'Nuevo', revision: old.revision },
    { channel: 'shell' },
    100,
  );
  assert.equal(r.state.progress[0].text, 'Avance: heredado');
  assert.equal(r.state.work_records.length, 1);
});
test('validación detecta historia ausente, verificación inventada, autoría falsa y punteros rotos', () => {
  const c = core(),
    r = c.add('result');
  c.edit({
    type: 'work-evidence',
    record_id: r.id,
    text: 'reporte',
    kind: 'user-report',
  });
  for (const mutate of [
    (s) => (s.work_records[0].verified = true),
    (s) => (s.work_records[0].source.role = 'system'),
    (s) => (s.work_evidence[0].record_id = 'missing'),
    (s) => s.work_events.shift(),
    (s) => (s.work_events[0].to = 'completed'),
    (s) => (s.work_records[0].status = 'withdrawn'),
  ]) {
    const bad = structuredClone(c.state);
    mutate(bad);
    assert.throws(() => validateUnderstanding(bad));
  }
});
test('EVO apagada: reinicio conserva registros evidencia y problemas sin consultar memoria', () => {
  const f = fixture();
  let s = f.make();
  edit(s, f.a, { type: 'message', text: 'Bloqueo: falta cuenta' });
  const r = s.snapshot(f.a).state.work_records[0];
  edit(s, f.a, {
    type: 'work-evidence',
    record_id: r.id,
    text: 'Acceso denegado',
    kind: 'user-report',
  });
  const old = s.snapshot(f.a).state;
  s = f.make();
  assert.deepEqual(s.snapshot(f.a).state, old);
  assert.equal(s.snapshot(f.a).effective.work_tracking.open_problems.length, 1);
});
test('fallo de disco mantiene RAM/archivo previos y permite reintentar', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'work-add', kind: 'result', text: 'Antes' });
  const before = structuredClone(s.data),
    raw = f.raw;
  f.fail = true;
  assert.throws(
    () => edit(s, f.a, { type: 'work-add', kind: 'error', text: 'Después' }),
    /guardar/,
  );
  assert.equal(f.raw, raw);
  assert.deepEqual(s.data, before);
  f.fail = false;
  edit(s, f.a, { type: 'work-add', kind: 'error', text: 'Después' });
  assert.equal(s.snapshot(f.a).state.work_records.length, 2);
});
test('corrupción de evidencia en archivo real no sobrescribe expediente', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'uue-work-')), 'state.json'),
    g = { id: 5, getURL: () => 'https://chatgpt.com/c/disk-work' };
  let s = new UserUnderstandingService({ file });
  edit(s, g, { type: 'work-add', kind: 'result', text: 'Antes' });
  let d = JSON.parse(readFileSync(file, 'utf8'));
  d.contexts[0].state.work_records[0].verified = true;
  const raw = JSON.stringify(d);
  writeFileSync(file, raw);
  s = new UserUnderstandingService({ file });
  assert.throws(() =>
    edit(s, g, { type: 'work-add', kind: 'error', text: 'No' }),
  );
  assert.equal(readFileSync(file, 'utf8'), raw);
});
test('borrado con tombstone no reimporta declaraciones desde DOM ni recupera evidencia', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'work-add', kind: 'result', text: 'Borrar' });
  const snap = s.snapshot(f.a);
  s.clear(f.a, snap.state.revision);
  assert.equal(
    s.observeConversation(f.a, [
      { id: 'u', role: 'user', content: 'Resultado: Borrar' },
    ]).skipped,
    'erased',
  );
  const reopened = f.make().snapshot(f.a);
  assert.equal(reopened.erased, true);
  assert.equal(reopened.state.work_records.length, 0);
});
test('captura del asistente es manual, versionada, limitada y conserva autoría diferenciada', () => {
  const f = fixture(),
    s = f.make();
  assert.equal(
    s.observeConversation(f.a, turns('Lo hice. ' + 'x'.repeat(5000))).ok,
    true,
  );
  assert.equal(s.snapshot(f.a).state.work_records.length, 0);
  const r = capture(s, f.a).state.work_records[0];
  assert.equal(r.source.role, 'assistant');
  assert.equal(r.origin.role, 'user');
  assert.equal(r.certainty, 'observed-not-verified');
  assert.equal(r.text.length, 1000);
  assert.equal(r.verified, false);
  assert.equal(s.snapshot(f.a).state.confirmed_decisions.length, 0);
  assert.equal(
    f.make().snapshot(f.a).state.work_records[0].source.digest,
    r.source.digest,
  );
});
test('captura rechaza versiones cambiadas aunque revisión UUE sea igual y no acepta texto/rol inyectados', () => {
  const f = fixture(),
    s = f.make();
  s.observeConversation(f.a, turns('Versión uno'));
  const a = s.snapshot(f.a),
    m = a.conversation.messages.find((m) => m.role === 'assistant');
  s.observeConversation(f.a, turns('Versión dos'));
  assert.equal(s.snapshot(f.a).state.revision, a.state.revision);
  assert.throws(
    () =>
      capture(s, f.a, {
        observationRevision: a.conversation.revision,
        digest: m.digest,
      }),
    /cambió/,
  );
  const r = capture(s, f.a, {
    text: 'FALSO',
    source: { role: 'user' },
    verified: true,
  }).state.work_records[0];
  assert.equal(r.text, 'Versión dos');
  assert.equal(r.source.role, 'assistant');
});
test('streams y recortes del lector no se pueden capturar como respuestas completas', () => {
  const f = fixture(),
    s = f.make();
  s.observeConversation(f.a, turns(), { streaming: true });
  assert.throws(() => capture(s, f.a), /incompleta/);
  s.observeConversation(
    f.a,
    turns().map((t) => (t.role === 'assistant' ? { ...t, clipped: true } : t)),
  );
  assert.throws(() => capture(s, f.a), /incompleta/);
  s.observeConversation(f.a, turns());
  assert.equal(
    capture(s, f.a, { kind: 'result' }).state.work_records[0].outcome,
    'unknown',
  );
});
test('captura duplicada o retirada no resucita con mismo mensaje y huella', () => {
  const f = fixture(),
    s = f.make();
  s.observeConversation(f.a, turns());
  const r = capture(s, f.a).state.work_records[0];
  assert.throws(() => capture(s, f.a), /ya fue registrada/);
  edit(s, f.a, {
    type: 'work-transition',
    id: r.id,
    status: 'withdrawn',
    reason: 'No usar',
  });
  assert.throws(() => capture(s, f.a), /ya fue registrada/);
  assert.equal(s.snapshot(f.a).effective.work_tracking.records.length, 0);
});
test('contextos y revisiones iguales no permiten editar otra URL con identidad anterior', () => {
  const f = fixture(),
    s = f.make(),
    a = s.snapshot(f.a);
  assert.throws(
    () =>
      s.edit(f.b, {
        type: 'work-add',
        kind: 'error',
        text: 'ajeno',
        revision: 0,
        contextId: a.state.context_id,
      }),
    /cambió/,
  );
  edit(s, f.a, { type: 'work-add', kind: 'error', text: 'propio' });
  assert.equal(s.snapshot(f.b).state.work_records.length, 0);
});
test('selección explícita conserva origen físico de captura sin copiar historial del contexto elegido', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'Origen' });
  const a = s.snapshot(f.a);
  s.bind(f.b, a.state.context_id);
  s.observeConversation(f.b, turns('Propuesta en pestaña B'));
  const r = capture(s, f.b).state.work_records[0];
  assert.equal(r.source.context_id, s.documentIdentity(f.b).id);
  assert.notEqual(r.source.context_id, a.state.context_id);
  assert.equal(r.source.url, f.b.getURL());
  assert.equal(s.snapshot(f.a).state.user_goal.text, 'Origen');
  s.bind(f.b, null);
  assert.equal(s.snapshot(f.b).state.work_records.length, 0);
});
test('captura no busca mensajes ausentes en otros contextos ni reintroduce origen eliminado', () => {
  const f = fixture(),
    s = f.make();
  s.observeConversation(f.a, turns());
  assert.throws(() => capture(s, f.b), /disponible/);
  const state = s.snapshot(f.a).state;
  s.clear(f.a, state.revision);
  assert.throws(() => capture(s, f.a), /disponible/);
  assert.equal(s.snapshot(f.a).erased, true);
});

test('inspección de contextos permite declaraciones del usuario pero no captura ajena del asistente ni retiradas', () => {
  const f = fixture(),
    s = f.make();
  s.observeConversation(f.a, turns());
  const assistant = capture(s, f.a).state.work_records[0];
  edit(s, f.a, { type: 'work-add', kind: 'result', text: 'Resultado propio' });
  let a = s.snapshot(f.a).state,
    user = a.work_records.at(-1);
  const preview = s.inspect(a.context_id, a.revision);
  assert.ok(preview.items.some((i) => i.id === user.id && i.kind === 'work'));
  assert.ok(!preview.items.some((i) => i.id === assistant.id));
  edit(s, f.b, {
    type: 'context-reference',
    sourceContextId: a.context_id,
    sourceRevision: a.revision,
    targetKind: 'entry',
    targetId: user.id,
  });
  let b = s.snapshot(f.b).state;
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: b.context_references[0].id,
    action: 'confirm',
  });
  assert.equal(s.snapshot(f.b).contextReferences[0].available, true);
  edit(s, f.a, {
    type: 'work-transition',
    id: user.id,
    status: 'withdrawn',
    reason: 'Dato retirado',
  });
  assert.equal(s.snapshot(f.b).contextReferences[0].available, false);
  a = s.snapshot(f.a).state;
  assert.throws(
    () => s.inspect(a.context_id, a.revision, 'entry', user.id),
    /disponible/,
  );
  assert.equal(s.snapshot(f.b).state.work_records.length, 0);
});

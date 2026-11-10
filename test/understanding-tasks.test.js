import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  newUnderstanding,
  updateUnderstanding,
  effectiveUnderstanding,
  validateUnderstanding,
} from '../src/core/userUnderstanding.js';
import { TASK_LIMITS, taskDirective } from '../src/core/userTasks.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
function core() {
  let state = newUnderstanding('tasks', 1),
    now = 1;
  return {
    get state() {
      return state;
    },
    edit(o) {
      const r = updateUnderstanding(
        state,
        { ...o, revision: state.revision },
        {
          channel: 'shell',
          messageId: `m-${++now}`,
          url: 'https://chatgpt.com/c/tasks',
        },
        now,
      );
      state = r.state;
      return r;
    },
    message(text) {
      return this.edit({ type: 'message', text });
    },
    add(text, extra = {}) {
      this.edit({ type: 'task-add', text, ...extra });
      return state.tasks.at(-1);
    },
    status(id, status, reason) {
      return this.edit({ type: 'task-transition', id, status, reason });
    },
    get projection() {
      return effectiveUnderstanding(state).task_tracking;
    },
  };
}
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'uue-tasks-')), 'uue.json'),
    g = { id: 1, getURL: () => 'https://chatgpt.com/c/tasks' };
  return {
    file,
    g,
    make: () =>
      new UserUnderstandingService({ file, memoryEnabled: () => false }),
  };
}

test('tareas explícitas conservan texto libre literal sin cambiar objetivo, reglas o última solicitud inferida', () => {
  const c = core();
  c.message('Mi objetivo: control humano');
  c.message('No ejecutes código');
  c.message('Revisar el panel');
  const old = structuredClone(c.state.current_task),
    goal = structuredClone(c.state.user_goal);
  const text =
    '  Auditar NEXO\n' +
    'Mantener literal y precisión.\n'.repeat(100) +
    '  final  ';
  const t = c.add(text);
  assert.equal(t.text, text);
  assert.equal(t.status, 'pending');
  assert.equal(t.goal_id, null);
  assert.equal(t.task_priority, 'unset');
  assert.equal(c.state.focused_task_id, null);
  assert.deepEqual(c.state.current_task, old);
  assert.deepEqual(c.state.user_goal, goal);
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.equal(c.state.progress.length, 0);
});
test('lista de tareas no inventa dependencias, prioridades ni siguiente paso', () => {
  const c = core();
  c.message('Tareas:\n- Inspeccionar IPC\n- Revisar la UI');
  assert.deepEqual(
    c.state.tasks.map((t) => t.text),
    ['Inspeccionar IPC', 'Revisar la UI'],
  );
  assert.ok(
    c.state.tasks.every(
      (t) =>
        !t.parent_id && !t.depends_on.length && t.task_priority === 'unset',
    ),
  );
  assert.equal(c.state.next_step, null);
  assert.equal(c.state.current_task, null);
  c.message('Tareas:\nSin guion\nOtra');
  assert.equal(c.state.tasks.length, 2);
  assert.equal(c.state.pending_questions.at(-1).kind, 'missing-reference');
});
test('subtareas quedan ligadas sólo al padre indicado y no se confunden con subobjetivos', () => {
  const c = core();
  const parent = c.add('Inspección'),
    other = c.add('Otro proyecto');
  c.message('Subtarea de «Inspección»: Auditar los permisos');
  assert.equal(c.state.tasks[2].parent_id, parent.id);
  assert.equal(c.state.tasks[2].goal_id, null);
  assert.equal(c.state.tasks[1].id, other.id);
  assert.equal(c.state.subgoals.length, 0);
  c.message('Subobjetivo: seguridad');
  assert.equal(c.state.subgoals.length, 1);
  assert.equal(c.state.tasks.length, 3);
});
test('dependencias explícitas impiden declarar inicio o finalización hasta completarlas', () => {
  const c = core();
  const a = c.add('Auditoría'),
    b = c.add('Publicación');
  c.message('La tarea «Publicación» depende de «Auditoría»');
  assert.deepEqual(c.state.tasks[1].depends_on, [a.id]);
  assert.throws(() => c.status(b.id, 'in_progress'), /dependencias/);
  assert.throws(() => c.status(b.id, 'completed'), /dependencias/);
  assert.equal(c.projection.eligibility[1].eligible, false);
  c.status(a.id, 'completed');
  c.status(b.id, 'in_progress');
  assert.equal(c.state.tasks[1].status, 'in_progress');
  assert.equal(c.state.progress.length, 0);
});
test('completar es declaración no verificada; siguiente paso no avanza automáticamente', () => {
  const c = core();
  const a = c.add('Auditar'),
    b = c.add('Publicar');
  c.edit({ type: 'task-next', id: a.id });
  c.status(a.id, 'completed');
  assert.equal(c.state.tasks[0].resolution.verified, false);
  assert.equal(c.state.tasks[0].resolution.origin.role, 'user');
  assert.equal(c.state.next_step.task_id, a.id);
  assert.equal(c.projection.next_step.task.id, a.id);
  assert.equal(c.projection.eligibility[0].eligible, false);
  assert.equal(c.state.tasks[1].status, 'pending');
  assert.equal(c.state.progress.length, 0);
  assert.throws(() => c.edit({ type: 'task-next', id: a.id }), /tarea abierta/);
  assert.equal(b.status, 'pending');
});
test('padre no se completa automáticamente ni permite completar con subtareas pendientes o canceladas', () => {
  const c = core();
  const p = c.add('Integración'),
    child = c.add('Prueba', { parent_id: p.id });
  c.status(p.id, 'in_progress');
  assert.throws(() => c.status(p.id, 'completed'), /subtareas/);
  c.status(child.id, 'cancelled');
  assert.throws(() => c.status(p.id, 'completed'), /subtareas/);
  c.status(child.id, 'pending');
  c.status(child.id, 'completed');
  assert.equal(c.state.tasks[0].status, 'in_progress');
  c.status(p.id, 'completed');
  assert.equal(c.state.tasks[0].status, 'completed');
});
test('ciclos de dependencias y jerarquías se rechazan atómicamente, incluidos ciclos mixtos', () => {
  const c = core();
  const a = c.add('A'),
    b = c.add('B', { parent_id: a.id });
  let before = structuredClone(c.state);
  assert.throws(
    () => c.edit({ type: 'task-update', id: a.id, parent_id: b.id }),
    /ciclo/,
  );
  assert.deepEqual(c.state, before);
  assert.throws(
    () => c.edit({ type: 'task-update', id: b.id, depends_on: [a.id] }),
    /ciclo/,
  );
  assert.deepEqual(c.state, before);
  assert.throws(
    () => c.edit({ type: 'task-update', id: a.id, depends_on: [a.id] }),
    /ciclo/,
  );
  const d = core();
  const x = d.add('X'),
    y = d.add('Y');
  d.edit({ type: 'task-update', id: x.id, depends_on: [y.id] });
  assert.throws(
    () => d.edit({ type: 'task-update', id: y.id, depends_on: [x.id] }),
    /ciclo/,
  );
});
test('referencias ausentes o ambiguas no se resuelven por intuición ni dejan media transacción', () => {
  const c = core();
  c.message('Subtarea de «No existe»: Pendiente');
  assert.equal(c.state.tasks.length, 0);
  assert.equal(c.state.pending_questions[0].kind, 'missing-reference');
  c.add('Igual');
  const p = c.add('Padre');
  c.add('Igual', { parent_id: p.id });
  c.message('Tarea «Igual» completada');
  assert.ok(c.state.tasks.every((t) => t.status === 'pending'));
  const before = structuredClone(c.state);
  assert.throws(
    () => c.edit({ type: 'task-update', id: p.id, depends_on: ['missing'] }),
    /inexistente/,
  );
  assert.deepEqual(c.state, before);
});
test('bloqueos requieren motivo y se retiran explícitamente sin acreditar trabajo', () => {
  const c = core();
  const t = c.add('Revisar');
  assert.throws(() => c.status(t.id, 'blocked'), /motivo/);
  c.status(t.id, 'blocked', 'Falta autorización');
  assert.equal(c.projection.eligibility[0].eligible, false);
  assert.throws(() => c.status(t.id, 'completed'), /bloqueante/);
  c.status(t.id, 'blocked', 'Falta una respuesta concreta');
  assert.equal(c.state.tasks[0].block_reason, 'Falta una respuesta concreta');
  c.status(t.id, 'pending');
  assert.equal(c.state.tasks[0].block_reason, null);
  assert.equal(c.state.tasks[0].status, 'pending');
  assert.equal(c.state.progress.length, 0);
});
test('cancelar no completa dependencias y reabrir no reanuda automáticamente tareas', () => {
  const c = core();
  const a = c.add('A'),
    b = c.add('B', { depends_on: [a.id] });
  c.status(a.id, 'cancelled');
  assert.equal(c.projection.eligibility[1].eligible, false);
  assert.throws(() => c.status(a.id, 'in_progress'), /Reabrí/);
  c.status(a.id, 'pending');
  assert.equal(c.state.tasks[0].status, 'pending');
  assert.equal(c.state.tasks[1].status, 'pending');
  assert.equal(c.state.tasks[1].id, b.id);
});
test('reabrir requisito invalida elegibilidad aguas abajo sin reescribir declaraciones pasadas', () => {
  const c = core();
  const a = c.add('A'),
    b = c.add('B', { depends_on: [a.id] }),
    d = c.add('C', { depends_on: [b.id] });
  c.status(a.id, 'completed');
  c.status(b.id, 'completed');
  c.status(a.id, 'pending');
  assert.equal(c.state.tasks[1].status, 'completed');
  assert.equal(c.projection.eligibility[2].eligible, false);
  assert.throws(() => c.status(d.id, 'completed'), /dependencias/);
});
test('prioridad y orden son explícitos y no equivalen a secuencia de ejecución ni a reglas superiores', () => {
  const c = core();
  c.message('No ejecutes código');
  const a = c.add('A'),
    b = c.add('B');
  c.message('Prioridad de tarea «B»: alta');
  assert.equal(c.state.tasks[1].task_priority, 'high');
  assert.equal(c.state.tasks[1].priority, 7);
  assert.equal(c.state.next_step, null);
  c.edit({ type: 'task-order', ids: [b.id, a.id] });
  assert.deepEqual(
    c.state.tasks.map((t) => t.id),
    [b.id, a.id],
  );
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.equal(c.state.task_events.at(-1).action, 'reordered');
  const before = structuredClone(c.state);
  assert.throws(
    () => c.edit({ type: 'task-order', ids: [a.id, a.id] }),
    /todas las tareas/,
  );
  assert.deepEqual(c.state, before);
});
test('foco y siguiente paso se seleccionan, limpian y conservan incluso si un paso queda bloqueado', () => {
  const c = core();
  c.message('Tarea actual: Revisar IPC');
  const id = c.state.tasks[0].id;
  assert.equal(c.state.focused_task_id, id);
  c.message('Próximo paso: tarea «Revisar IPC»');
  assert.equal(c.state.next_step.task_id, id);
  c.message('Tarea «Revisar IPC» bloqueada: falta permiso');
  assert.equal(c.state.next_step.task_id, id);
  assert.equal(c.projection.eligibility[0].eligible, false);
  c.message('Limpiar próximo paso');
  c.edit({ type: 'task-focus', id: null });
  assert.equal(c.state.next_step, null);
  assert.equal(c.state.focused_task_id, null);
});
test('resultado esperado se conserva separado de progreso y tiene historia de corrección', () => {
  const c = core();
  const a = c.add('Auditar');
  c.message('Resultado esperado de tarea «Auditar»: Informe de permisos');
  assert.equal(c.state.tasks[0].expected_result, 'Informe de permisos');
  c.edit({
    type: 'task-update',
    id: a.id,
    text: 'Auditar permisos',
    expected_result: 'Informe corregido',
  });
  const changes = c.state.task_events.at(-1).changes;
  assert.equal(changes.find((c) => c.field === 'text').from, 'Auditar');
  assert.equal(
    changes.find((c) => c.field === 'expected_result').from,
    'Informe de permisos',
  );
  assert.equal(c.state.progress.length, 0);
});
test('objetivos se vinculan explícitamente y su cierre bloquea elegibilidad sin borrar tareas', () => {
  const c = core();
  c.message('Mi objetivo: NEXO');
  const id = c.state.user_goal.id,
    t = c.add('Auditar', { goal_id: id });
  c.message('Objetivo principal completado');
  assert.equal(c.state.tasks[0].status, 'pending');
  assert.ok(c.projection.eligibility[0].reasons.includes('closed-goal'));
  assert.throws(() => c.status(t.id, 'in_progress'), /bloqueante/);
  c.edit({
    type: 'task-update',
    id: t.id,
    text: 'Auditar después',
    goal_id: id,
  });
  assert.equal(c.state.tasks[0].text, 'Auditar después');
  assert.throws(() => c.add('Otra', { goal_id: id }), /activo/);
  c.message('Retomar el objetivo principal');
  c.status(t.id, 'in_progress');
  assert.equal(c.state.tasks[0].status, 'in_progress');
});
test('subtarea no puede cruzar objetivos incompatibles y ancestro cerrado impide declararla iniciada', () => {
  const c = core();
  c.message('Mi objetivo: A');
  const a = c.state.user_goal.id;
  c.message('Objetivo independiente: B');
  const b = c.state.independent_goals[0].id;
  const parent = c.add('Padre', { goal_id: a });
  assert.throws(
    () => c.add('Hija', { parent_id: parent.id, goal_id: b }),
    /objetivos distintos/,
  );
  const child = c.add('Hija', { parent_id: parent.id });
  c.status(parent.id, 'cancelled');
  assert.ok(c.projection.eligibility[1].reasons.includes('unavailable-parent'));
  assert.throws(() => c.status(child.id, 'in_progress'), /bloqueante/);
});
test('preguntas, negaciones, citas, código, asistente atribuido y sí genérico no completan tareas', () => {
  const c = core();
  const t = c.add('Auditar');
  for (const text of [
    '¿Tarea «Auditar» completada?',
    'No está completada la tarea «Auditar»',
    '> Tarea «Auditar» completada',
    '```\nTarea «Auditar» completada\n```',
    'El asistente dijo: Tarea «Auditar» completada',
    'Sí',
    'Continúa con el siguiente paso',
  ])
    c.message(text);
  assert.equal(c.state.tasks[0].id, t.id);
  assert.equal(c.state.tasks[0].status, 'pending');
  assert.equal(c.state.task_events.length, 1);
  assert.equal(c.state.next_step, null);
});
test('repetición no duplica ni reabre tareas cerradas y operación no comparte arrays del llamador', () => {
  const c = core();
  const a = c.add('A');
  c.message('Tarea: A');
  assert.equal(c.state.tasks.length, 1);
  const deps = [a.id];
  c.add('B', { depends_on: deps });
  deps.length = 0;
  assert.deepEqual(c.state.tasks[1].depends_on, [a.id]);
  c.status(a.id, 'completed');
  c.message('Tarea: A');
  assert.equal(c.state.tasks.length, 2);
  assert.equal(c.state.tasks[0].status, 'completed');
  assert.equal(c.state.pending_questions.at(-1).kind, 'missing-reference');
});
test('límite de tareas rechaza lista completa sin poda ni inserción parcial', () => {
  const c = core();
  for (let i = 0; i < TASK_LIMITS.tasks - 1; i++) c.add(`Tarea ${i}`);
  const before = structuredClone(c.state);
  assert.throws(() => c.message('Tareas:\n- Penúltima\n- Última'), /Límite/);
  assert.deepEqual(c.state, before);
});
test('eventos llenos no confirman cambios parciales ni pierden tareas pendientes', () => {
  const c = core();
  const a = c.add('Durable');
  while (c.state.task_events.length < TASK_LIMITS.events)
    c.edit({ type: 'task-focus', id: c.state.focused_task_id ? null : a.id });
  const before = structuredClone(c.state);
  assert.throws(() => c.status(a.id, 'completed'), /Límite/);
  assert.deepEqual(c.state, before);
});
test('archivo previo sin grafo carga; tareas, foco y paso persisten con EVO apagada y se aíslan por conversación', () => {
  const f = fixture();
  let s = f.make();
  s.edit(f.g, { type: 'goal', revision: 0, text: 'Principal' });
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const k of ['tasks', 'task_events', 'focused_task_id', 'next_step'])
    delete raw.contexts[0].state[k];
  writeFileSync(f.file, JSON.stringify(raw));
  s = f.make();
  assert.equal(s.loadError, null);
  s.observe(f.g, 'Tarea actual: Revisar', { messageId: 't1' });
  let snap = s.snapshot(f.g);
  s.edit(f.g, {
    type: 'task-next',
    revision: snap.state.revision,
    id: snap.state.tasks[0].id,
  });
  const saved = s.snapshot(f.g).state;
  s = f.make();
  assert.deepEqual(s.snapshot(f.g).state, saved);
  assert.equal(s.snapshot(f.g).observationEnabled, true);
  assert.equal(
    s.snapshot({ id: 2, getURL: () => 'https://chatgpt.com/c/other-tasks' })
      .state.tasks.length,
    0,
  );
  s.clear(f.g, saved.revision);
  assert.equal(
    s.observe(f.g, 'Tarea: Vieja', { messageId: 'old' }).skipped,
    'erased',
  );
  assert.equal(s.snapshot(f.g).state.tasks.length, 0);
});
test('datos corruptos del grafo, estado, eventos y referencias se rechazan sin sobrescribir', () => {
  const c = core();
  const a = c.add('A'),
    b = c.add('B', { depends_on: [a.id] });
  c.status(a.id, 'completed');
  c.edit({ type: 'task-update', id: b.id, task_priority: 'high' });
  for (const mutate of [
    (s) => (s.tasks = null),
    (s) => (s.tasks[0].origin.role = 'assistant'),
    (s) => (s.tasks[0].resolution.verified = true),
    (s) => (s.tasks[1].depends_on = ['missing']),
    (s) => (s.tasks[0].depends_on = [b.id]),
    (s) => (s.focused_task_id = 'missing'),
    (s) =>
      (s.next_step = { task_id: 'missing', origin: s.tasks[0].origin, at: 1 }),
    (s) => (s.task_events.at(-1).changes[0].to = 'root'),
    (s) => (s.task_events[0].origin.role = 'assistant'),
  ]) {
    const bad = structuredClone(c.state);
    mutate(bad);
    assert.throws(() => validateUnderstanding(bad), /inválido/);
  }
  const f = fixture(),
    s = f.make();
  s.edit(f.g, { type: 'task-add', revision: 0, text: 'Safe' });
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  raw.contexts[0].state.tasks[0].depends_on = ['missing'];
  const stored = JSON.stringify(raw);
  writeFileSync(f.file, stored);
  assert.throws(() => f.make().snapshot(f.g), /No se sobrescribirá/);
  assert.equal(readFileSync(f.file, 'utf8'), stored);
});
test('fallo de escritura no confirma tarea o estado en RAM y permite reintento con misma revisión', () => {
  let raw = null,
    fail = false;
  const s = new UserUnderstandingService({
      memoryEnabled: () => false,
      storage: {
        read: () => raw,
        write: (t) => {
          if (fail) throw Error('disk');
          raw = t;
        },
      },
    }),
    g = { id: 1, getURL: () => 'https://chatgpt.com/c/tasks-retry' };
  const create = { type: 'task-add', revision: 0, text: 'Durable' };
  fail = true;
  assert.throws(() => s.edit(g, create));
  assert.equal(s.snapshot(g).state.tasks.length, 0);
  fail = false;
  s.edit(g, create);
  const before = s.snapshot(g).state,
    stored = raw;
  const close = {
    type: 'task-transition',
    id: before.tasks[0].id,
    status: 'completed',
    revision: before.revision,
  };
  fail = true;
  assert.throws(() => s.edit(g, close));
  assert.deepEqual(s.snapshot(g).state, before);
  assert.equal(raw, stored);
  fail = false;
  s.edit(g, close);
  assert.equal(s.snapshot(g).state.tasks[0].status, 'completed');
});
test('revisión obsoleta, prioridad inválida y dependencias excesivas no modifican estado', () => {
  const c = core();
  const t = c.add('T');
  const before = structuredClone(c.state);
  assert.throws(
    () =>
      updateUnderstanding(c.state, {
        type: 'task-transition',
        revision: 0,
        id: t.id,
        status: 'completed',
      }),
    /contexto cambió/,
  );
  assert.throws(
    () => c.edit({ type: 'task-update', id: t.id, task_priority: 'urgent' }),
    /inválida/,
  );
  assert.throws(
    () =>
      c.edit({
        type: 'task-update',
        id: t.id,
        depends_on: Array(11).fill(t.id),
      }),
    /inválida/,
  );
  assert.deepEqual(c.state, before);
});
test('gramática inglesa es acotada; dependencias no se deducen de una lista o de continuar', () => {
  assert.equal(taskDirective('Task: Inspect IPC').type, 'task-add');
  assert.equal(
    taskDirective('Task «Inspect IPC» completed').status,
    'completed',
  );
  const c = core();
  c.message('Tasks:\n- Inspect\n- Publish');
  c.message('Task «Publish» depends on «Inspect»');
  assert.deepEqual(c.state.tasks[1].depends_on, [c.state.tasks[0].id]);
  c.message('Next step: task «Publish»');
  assert.equal(c.state.next_step.task_id, c.state.tasks[1].id);
  assert.equal(c.projection.eligibility[1].eligible, false);
});

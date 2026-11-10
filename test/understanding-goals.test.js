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
import {
  goalDirective,
  possibleGoal,
  GOAL_LIMITS,
} from '../src/core/userGoals.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
const core = () => {
  let s = newUnderstanding('goals', 100),
    now = 100;
  return {
    get state() {
      return s;
    },
    edit(o) {
      const r = updateUnderstanding(
        s,
        { ...o, revision: s.revision },
        {
          channel: 'shell',
          messageId: `m-${++now}`,
          url: 'https://chatgpt.com/c/test',
        },
        now,
      );
      s = r.state;
      return r;
    },
    message(text) {
      return this.edit({ type: 'message', text });
    },
  };
};
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'nexo-goals-')), 'uue.json'),
    g = { id: 1, getURL: () => 'https://chatgpt.com/c/goals' };
  return {
    file,
    g,
    make: () =>
      new UserUnderstandingService({ file, memoryEnabled: () => false }),
  };
}

test('objetivo libre extenso y literal se conserva ante tarea, pregunta secundaria y preferencia', () => {
  const c = core(),
    text =
      '  Objetivo central\n' +
      'Conservar precisión y control.\n'.repeat(150) +
      ' final  ';
  c.edit({ type: 'goal', text });
  const original = structuredClone(c.state.user_goal);
  c.message('Revisar el archivo del panel');
  c.message('¿Qué versión de Electron usamos?');
  c.message('Prefiero respuestas cortas');
  assert.deepEqual(c.state.user_goal, original);
  assert.equal(c.state.goal_history.length, 0);
  assert.equal(c.state.goal_events.length, 1);
});
test('cambio inequívoco conserva historia; una declaración nueva dudosa necesita aceptación concreta', () => {
  const c = core();
  c.message('Mi objetivo: mejorar NEXO');
  c.message('Mi objetivo: publicar otra aplicación');
  assert.equal(c.state.user_goal.text, 'mejorar NEXO');
  const q = c.state.pending_questions.at(-1);
  assert.equal(q.kind, 'goal-change');
  c.message('Sí');
  assert.equal(c.state.user_goal.text, 'mejorar NEXO');
  c.edit({ type: 'resolve', id: q.id, accept: true });
  assert.equal(c.state.user_goal.text, 'publicar otra aplicación');
  assert.equal(c.state.goal_history[0].text, 'mejorar NEXO');
  c.message('Cambio de objetivo: mejorar accesibilidad');
  assert.equal(c.state.user_goal.text, 'mejorar accesibilidad');
  assert.equal(c.state.goal_history.length, 2);
});
test('varios objetivos explícitos quedan separados y nunca sustituyen el principal ni copian sus reglas', () => {
  const c = core();
  c.message('Mi objetivo: NEXO');
  c.message('No ejecutes código');
  c.message('Preparar auditoría');
  const task = structuredClone(c.state.current_task),
    goal = structuredClone(c.state.user_goal);
  c.message(
    'Objetivos independientes:\n- Diseñar una aplicación educativa\n- Documentar un repositorio de juegos',
  );
  assert.equal(c.state.independent_goals.length, 2);
  assert.deepEqual(c.state.user_goal, goal);
  assert.deepEqual(c.state.current_task, task);
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.ok(
    c.state.independent_goals.every(
      (g) => !g.instructions && g.goal_type === 'independent',
    ),
  );
  c.message('Objetivo independiente: Diseñar una aplicación educativa');
  assert.equal(c.state.independent_goals.length, 2);
});
test('objetivo independiente idéntico al principal activo no duplica el catálogo', () => {
  const c = core();
  c.message('Mi objetivo: Mejorar NEXO');
  c.message('Objetivo independiente: mejorar nexo.');
  assert.equal(c.state.independent_goals.length, 0);
  assert.equal(c.state.user_goal.text, 'Mejorar NEXO');
});
test('completado es declaración del usuario, no evidencia de ejecución; conserva reglas y objetivo literal', () => {
  const c = core();
  c.message('Mi objetivo: entregar navegador');
  c.message('No borres información');
  c.message('Preparar el informe');
  const id = c.state.user_goal.id;
  c.message('Objetivo principal completado');
  assert.equal(c.state.user_goal.id, id);
  assert.equal(c.state.user_goal.status, 'completed');
  assert.equal(c.state.user_goal.resolution.verified, false);
  assert.equal(c.state.user_goal.resolution.kind, 'user-declaration');
  assert.equal(c.state.progress.length, 0);
  assert.equal(c.state.current_task, null);
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.equal(effectiveUnderstanding(c.state).user_goal, null);
  assert.equal(effectiveUnderstanding(c.state).readiness, 'no-active-goal');
  const events = c.state.goal_events.length;
  c.message('Objetivo principal completado');
  assert.equal(c.state.goal_events.length, events);
});
test('cancelar no equivale a completar; reapertura explícita conserva identidad y trazabilidad', () => {
  const c = core();
  c.message('Mi objetivo: publicar NEXO');
  const id = c.state.user_goal.id;
  c.message('Cancelo el objetivo principal');
  assert.equal(c.state.user_goal.status, 'cancelled');
  assert.equal(c.state.progress.length, 0);
  c.message('Continuemos');
  assert.equal(c.state.user_goal.status, 'cancelled');
  assert.ok(
    c.state.pending_questions.some((q) => q.kind === 'missing-reference'),
  );
  c.message('Retomar el objetivo principal');
  assert.equal(c.state.user_goal.status, 'active');
  assert.equal(c.state.user_goal.id, id);
  assert.deepEqual(
    c.state.goal_events.map((e) => e.action),
    ['primary-set', 'cancelled', 'reopened'],
  );
});
test('cierre con referencia exacta de independiente no modifica principal, tarea o restricciones', () => {
  const c = core();
  c.message('Mi objetivo: navegador');
  c.message('Preparar la revisión');
  c.message('Objetivo independiente: Documentar APIs');
  const primary = structuredClone(c.state.user_goal),
    task = structuredClone(c.state.current_task);
  c.message('Objetivo «Documentar APIs» completado');
  assert.equal(c.state.independent_goals[0].status, 'completed');
  assert.deepEqual(c.state.user_goal, primary);
  assert.deepEqual(c.state.current_task, task);
  c.message('Retomar objetivo «Documentar APIs»');
  assert.equal(c.state.independent_goals[0].status, 'active');
});
test('referencia desconocida no cierra por suposición; no se cierra sin objetivo', () => {
  const c = core();
  c.message('Objetivo principal completado');
  assert.equal(c.state.user_goal, null);
  assert.equal(c.state.pending_questions[0].kind, 'missing-reference');
  c.message('Mi objetivo: principal');
  c.message('Objetivo «otro proyecto» cancelado');
  assert.equal(c.state.user_goal.status, 'active');
  assert.match(c.state.pending_questions.at(-1).text, /único objetivo/);
});
test('petición, negación, pregunta, cita y afirmación atribuida al asistente no son cierre', () => {
  const c = core();
  c.message('Mi objetivo: proteger el contexto');
  for (const text of [
    'No he completado mi objetivo',
    '¿Objetivo principal completado?',
    'Quiero completar el objetivo',
    'Cuando termine el objetivo, seguimos',
    '> Objetivo principal completado',
    'El asistente dijo: objetivo principal completado',
  ])
    c.message(text);
  assert.equal(c.state.user_goal.status, 'active');
  assert.equal(c.state.goal_events.length, 1);
});
test('objetivo cerrado no se vincula a una tarea nueva ni se reactiva con continuación genérica', () => {
  const c = core();
  c.message('Mi objetivo: anterior');
  c.message('Objetivo principal completado');
  c.message('Preparar otro documento');
  assert.equal(c.state.current_task.related_goal_id, null);
  assert.equal(c.state.last_interaction.relation, 'unknown');
  assert.equal(c.state.user_goal.status, 'completed');
  c.message('Mi objetivo: siguiente');
  assert.equal(c.state.user_goal.status, 'active');
  assert.equal(c.state.goal_history[0].status, 'completed');
  assert.equal(c.state.goal_history[0].resolution.verified, false);
});
test('deseo implícito crea candidato inferido, no objetivo confirmado ni cambio tras sí genérico', () => {
  const c = core();
  const text = 'Quiero construir un navegador para estudiantes';
  c.message(text);
  assert.equal(c.state.user_goal, null);
  assert.equal(c.state.goal_candidates[0].text, text);
  assert.equal(c.state.goal_candidates[0].certainty, 'inferred');
  assert.equal(c.state.goal_candidates[0].status, 'pending');
  assert.equal(
    effectiveUnderstanding(c.state).readiness,
    'needs-goal-confirmation',
  );
  c.message('Dale');
  assert.equal(c.state.user_goal, null);
  c.edit({
    type: 'goal-candidate',
    id: c.state.goal_candidates[0].id,
    action: 'primary',
  });
  assert.equal(c.state.user_goal.text, text);
  assert.equal(c.state.user_goal.certainty, 'confirmed');
  assert.equal(c.state.goal_candidates[0].certainty, 'inferred');
  assert.equal(c.state.goal_candidates[0].status, 'accepted');
  assert.equal(
    c.state.goal_candidates[0].resolution.target_goal_id,
    c.state.user_goal.id,
  );
});
test('rechazar candidato conserva trazabilidad y no altera preferencias ni crea objetivos', () => {
  const c = core();
  c.message('Necesito crear una aplicación');
  const id = c.state.goal_candidates[0].id;
  c.edit({ type: 'goal-candidate', id, action: 'reject' });
  assert.equal(c.state.user_goal, null);
  assert.equal(c.state.goal_candidates[0].status, 'rejected');
  assert.equal(c.state.goal_events.at(-1).action, 'candidate-rejected');
  assert.throws(
    () => c.edit({ type: 'goal-candidate', id, action: 'primary' }),
    /ya no está pendiente/,
  );
});
test('candidato puede confirmarse separado; no sustituye un principal activo', () => {
  const c = core();
  c.message('Quiero crear una aplicación');
  const id = c.state.goal_candidates[0].id;
  c.edit({ type: 'goal-candidate', id, action: 'independent' });
  assert.equal(c.state.user_goal, null);
  assert.equal(c.state.independent_goals[0].certainty, 'confirmed');
  c.message('Mi objetivo: principal');
  c.message('Objetivo principal completado');
  c.message('Quiero construir un juego');
  const pending = c.state.goal_candidates.at(-1);
  c.message('Retomar el objetivo principal');
  assert.throws(
    () => c.edit({ type: 'goal-candidate', id: pending.id, action: 'primary' }),
    /principal activo/,
  );
  assert.equal(c.state.user_goal.text, 'principal');
});
test('peticiones operativas, preguntas y citas no generan objetivos implícitos', () => {
  for (const text of [
    'Quiero revisar ese archivo',
    '¿Quiero crear una aplicación?',
    '> Quiero construir un navegador',
    '```\nQuiero crear una aplicación\n```',
  ])
    assert.equal(possibleGoal(text), null);
  const c = core();
  c.message('Mi objetivo: actual');
  c.message('Quiero construir otra app');
  assert.equal(c.state.goal_candidates.length, 0);
  assert.equal(c.state.user_goal.text, 'actual');
});
test('objetivo explícito invalida candidatos pendientes anteriores y preserva su origen', () => {
  const c = core();
  c.message('Quiero crear una aplicación');
  const candidate = structuredClone(c.state.goal_candidates[0]);
  c.message('Mi objetivo: sólo auditar');
  assert.equal(c.state.goal_candidates[0].status, 'superseded');
  assert.deepEqual(c.state.goal_candidates[0].origin, candidate.origin);
  assert.throws(
    () =>
      c.edit({ type: 'goal-candidate', id: candidate.id, action: 'primary' }),
    /ya no está pendiente/,
  );
});
test('promoción explícita de independiente al principal conserva antecedente sin dos objetivos activos idénticos', () => {
  const c = core();
  c.message('Mi objetivo: primero');
  c.message('Objetivo independiente: segundo');
  c.message('Cambio de objetivo: segundo');
  assert.equal(c.state.user_goal.text, 'segundo');
  assert.equal(c.state.independent_goals[0].status, 'superseded');
  assert.ok(
    c.state.goal_events.some((e) => e.action === 'promoted-to-primary'),
  );
  assert.equal(c.state.goal_history[0].text, 'primero');
});
test('límite y formato de lista rechazan sin pérdida parcial ni poda de objetivos existentes', () => {
  const c = core();
  for (let i = 0; i < GOAL_LIMITS.independent; i++)
    c.edit({ type: 'goal-independent', text: `Objetivo ${i}` });
  const before = structuredClone(c.state);
  assert.throws(
    () => c.message('Objetivos independientes:\n- Otro uno\n- Otro dos'),
    /Límite/,
  );
  assert.deepEqual(c.state, before);
  const a = core();
  a.message('Objetivos independientes:\nPrimer objetivo sin guion\nSegundo');
  assert.equal(a.state.independent_goals.length, 0);
  assert.match(a.state.pending_questions[0].text, /guion/);
});
test('estado inválido, referencia retirada y revisión obsoleta no alteran el estado', () => {
  const c = core();
  c.message('Mi objetivo: original');
  const before = structuredClone(c.state);
  assert.throws(
    () =>
      c.edit({
        type: 'goal-transition',
        id: c.state.user_goal.id,
        status: 'verified',
      }),
    /inválido/,
  );
  assert.deepEqual(c.state, before);
  assert.throws(
    () =>
      c.edit({ type: 'goal-transition', id: 'missing', status: 'completed' }),
    /disponible/,
  );
  assert.throws(
    () =>
      updateUnderstanding(c.state, {
        type: 'goal-transition',
        revision: 0,
        id: c.state.user_goal.id,
        status: 'completed',
      }),
    /contexto cambió/,
  );
  assert.deepEqual(c.state, before);
});
test('archivo anterior sin campos nuevos carga; ciclo y objetivos independientes persisten con EVO apagada', () => {
  const f = fixture();
  let s = f.make();
  s.edit(f.g, { type: 'goal', revision: 0, text: 'Principal literal' });
  let raw = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const key of ['independent_goals', 'goal_candidates', 'goal_events'])
    delete raw.contexts[0].state[key];
  writeFileSync(f.file, JSON.stringify(raw));
  s = f.make();
  assert.equal(s.loadError, null);
  s.observeConversation(f.g, [
    {
      id: 'u1',
      role: 'user',
      content: 'Objetivo independiente: Otro proyecto',
    },
    { id: 'u2', role: 'user', content: 'Objetivo principal completado' },
  ]);
  const snap = s.snapshot(f.g);
  assert.equal(snap.state.user_goal.status, 'completed');
  // Contexto antiguo se inicializa con el último usuario por seguridad; agregar separado por operación explícita.
  s.edit(f.g, {
    type: 'goal-independent',
    revision: snap.state.revision,
    text: 'Otro proyecto',
  });
  const saved = s.snapshot(f.g);
  s = f.make();
  const after = s.snapshot(f.g);
  assert.deepEqual(after.state, saved.state);
  assert.equal(after.observationEnabled, true);
  assert.equal(after.state.independent_goals[0].text, 'Otro proyecto');
});
test('datos corruptos de cierre no son prueba válida y bloquean lectura sin sobreescritura', () => {
  const c = core();
  c.message('Mi objetivo: auditar');
  c.message('Objetivo principal completado');
  const bad = structuredClone(c.state);
  bad.user_goal.resolution.verified = true;
  assert.throws(() => validateUnderstanding(bad), /inválido/);
  const f = fixture(),
    s = f.make();
  s.edit(f.g, { type: 'goal', revision: 0, text: 'Datos seguros' });
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  raw.contexts[0].state.independent_goals = 'bad';
  writeFileSync(f.file, JSON.stringify(raw));
  assert.throws(() => f.make().snapshot(f.g), /No se sobrescribirá/);
});
test('gramática inglesa explícita y objetivos no relacionados mantienen su separación', () => {
  assert.equal(
    goalDirective('Independent goal: Build an editor').texts[0],
    'Build an editor',
  );
  assert.equal(goalDirective('My goal completed').status, 'completed');
  const c = core();
  c.message('My goal is improve NEXO');
  const before = structuredClone(c.state);
  const r = c.message('Pregunta independiente: ¿cuánto es dos más dos?');
  assert.equal(r.report.isolated, true);
  assert.deepEqual(c.state, before);
});

test('catálogo de candidatos y eventos lleno rechaza transacciones sin poda ni cierres parciales', () => {
  const c = core();
  for (let i = 0; i < GOAL_LIMITS.candidates; i++)
    c.message(`Quiero construir proyecto ${i}`);
  const before = structuredClone(c.state);
  assert.throws(() => c.message('Quiero crear proyecto desbordado'), /Límite/);
  assert.deepEqual(c.state, before);
  const a = core();
  a.message('Mi objetivo: durable');
  for (let i = 1; i < GOAL_LIMITS.events; i++)
    a.edit({
      type: 'goal-transition',
      id: a.state.user_goal.id,
      status: i % 2 ? 'completed' : 'active',
    });
  const full = structuredClone(a.state);
  assert.throws(
    () =>
      a.edit({
        type: 'goal-transition',
        id: a.state.user_goal.id,
        status: 'active',
      }),
    /Límite/,
  );
  assert.deepEqual(a.state, full);
});
test('candidatos y eventos persistentes corruptos se rechazan en vez de aceptar autoridad desconocida', () => {
  const c = core();
  c.message('Quiero construir una aplicación');
  c.edit({
    type: 'goal-candidate',
    id: c.state.goal_candidates[0].id,
    action: 'primary',
  });
  for (const change of [
    (s) => (s.goal_candidates[0].reason = {}),
    (s) => (s.goal_candidates[0].certainty = 'explicit'),
    (s) => (s.goal_candidates[0].resolution.origin.role = 'assistant'),
    (s) => (s.goal_events[0].to = 'executed'),
    (s) => (s.goal_events[0].origin.url = {}),
    (s) => (s.user_goal.goal_type = 'independent'),
  ]) {
    const bad = structuredClone(c.state);
    change(bad);
    assert.throws(() => validateUnderstanding(bad), /inválido/);
  }
});

test('candidato pendiente sobrevive reinicio y su confirmación no afecta otra conversación', () => {
  const f = fixture();
  let s = f.make();
  s.observe(f.g, 'Quiero construir una app educativa', {
    messageId: 'candidate',
  });
  let snap = s.snapshot(f.g);
  const id = snap.state.goal_candidates[0].id;
  s = f.make();
  snap = s.snapshot(f.g);
  assert.equal(snap.state.goal_candidates[0].status, 'pending');
  s.edit(f.g, {
    type: 'goal-candidate',
    id,
    action: 'primary',
    revision: snap.state.revision,
  });
  const other = { id: 2, getURL: () => 'https://chatgpt.com/c/other-goal' };
  s.observe(other, 'Mi objetivo: otro proyecto', { messageId: 'other' });
  s = f.make();
  assert.equal(s.snapshot(f.g).state.user_goal.certainty, 'confirmed');
  assert.equal(
    s.snapshot(f.g).state.goal_candidates[0].resolution.target_goal_id,
    s.snapshot(f.g).state.user_goal.id,
  );
  assert.equal(s.snapshot(other).state.user_goal.text, 'otro proyecto');
  snap = s.snapshot(f.g);
  s.clear(f.g, snap.state.revision);
  const r = s.observe(f.g, 'Objetivo principal completado', {
    messageId: 'old',
  });
  assert.equal(r.skipped, 'erased');
  assert.equal(s.snapshot(f.g).state.user_goal, null);
});
test('fallo de persistencia de cierre no modifica RAM ni elimina la posibilidad de reintento', () => {
  let raw = null,
    fail = false;
  const s = new UserUnderstandingService({
    memoryEnabled: () => false,
    storage: {
      read: () => raw,
      write: (text) => {
        if (fail) throw Error('disk');
        raw = text;
      },
    },
  });
  const g = { id: 1, getURL: () => 'https://chatgpt.com/c/failed-goal' };
  s.edit(g, { type: 'goal', revision: 0, text: 'Durable' });
  const before = s.snapshot(g).state,
    stored = raw;
  fail = true;
  const close = {
    type: 'goal-transition',
    revision: before.revision,
    id: before.user_goal.id,
    status: 'completed',
  };
  assert.throws(() => s.edit(g, close));
  assert.deepEqual(s.snapshot(g).state, before);
  assert.equal(raw, stored);
  fail = false;
  s.edit(g, close);
  assert.equal(s.snapshot(g).state.user_goal.status, 'completed');
});

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
  PRIORITY,
} from '../src/core/userUnderstanding.js';
import {
  ruleSegment,
  ruleValueKey,
  DECISION_CANDIDATE_LIMIT,
} from '../src/core/userRules.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
function core() {
  let state = newUnderstanding('rules', 1),
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
          messageId: `u-${now}`,
          url: 'https://chatgpt.com/c/rules',
        },
        ++now,
      );
      state = r.state;
      return r;
    },
    message(text) {
      return this.edit({ type: 'message', text });
    },
  };
}
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'uue-rules-')), 'uue.json'),
    g = { id: 1, getURL: () => 'https://chatgpt.com/c/rules' };
  return {
    file,
    g,
    make: () =>
      new UserUnderstandingService({ file, memoryEnabled: () => false }),
  };
}

test('categorías y prioridades separan obligación, instrucción, preferencia y decisión sin modificar objetivo', () => {
  const c = core();
  c.message('Mi objetivo: control humano');
  const goal = structuredClone(c.state.user_goal);
  c.message(
    'Restricción: No borres información\nInstrucción: Usa español\nPrefiero respuestas cortas\nDecisión confirmada: Mantener Electron',
  );
  for (const f of [
    'explicit_constraints',
    'active_instructions',
    'preferences',
    'confirmed_decisions',
  ]) {
    assert.equal(c.state[f].length, 1);
    assert.equal(c.state[f][0].category, f);
    assert.equal(c.state[f][0].priority, PRIORITY[f]);
  }
  assert.deepEqual(c.state.user_goal, goal);
  assert.equal(c.state.progress.length, 0);
});
test('preferencia incompatible es orientativa y no elimina una instrucción superior', () => {
  const c = core();
  c.message('Usa español');
  c.message('Prefiero respuestas en inglés');
  const e = effectiveUnderstanding(c.state);
  assert.equal(e.active_instructions[0].text, 'Usa español');
  assert.equal(e.preferences.length, 1);
  assert.equal(e.preference_conflicts.length, 1);
  assert.equal(
    e.preference_conflicts[0].rule_id,
    c.state.active_instructions[0].id,
  );
  assert.equal(
    c.state.pending_questions.filter((q) => q.kind === 'conflict').length,
    0,
  );
  c.message('No ejecutes código');
  c.message('Preferencia: Ejecuta código');
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.equal(effectiveUnderstanding(c.state).preference_conflicts.length, 2);
});
test('preferencias incompatibles piden revisión; de ahora en más reemplaza sólo preferencias del mismo nivel', () => {
  const c = core();
  c.message('Prefiero respuestas cortas');
  const first = c.state.preferences[0];
  c.message('Prefiero respuestas detalladas');
  assert.equal(c.state.preferences.length, 1);
  const q = c.state.pending_questions.find((q) => q.kind === 'conflict');
  assert.equal(q.kind, 'conflict');
  assert.equal(q.proposed.field, 'preferences');
  c.message('Sí');
  assert.equal(c.state.preferences[0].id, first.id);
  c.edit({ type: 'resolve', id: q.id, accept: false });
  c.message('De ahora en más prefiero respuestas detalladas');
  assert.equal(c.state.preferences.length, 1);
  assert.match(c.state.preferences[0].text, /detalladas/);
  assert.equal(c.state.instruction_history[0].id, first.id);
  assert.equal(c.state.instruction_history[0].change.kind, 'replaced');
});
test('corrección en conflicto preserva la regla original hasta confirmación, y rechazo no la retira', () => {
  const c = core();
  c.message('No ejecutes código');
  c.message('Usa español');
  const before = structuredClone(c.state.active_instructions[0]);
  c.message('Reemplaza «Usa español» por «Ejecuta código»');
  assert.deepEqual(c.state.active_instructions[0], before);
  assert.equal(c.state.instruction_history.length, 0);
  const q = c.state.pending_questions.at(-1);
  assert.equal(q.conflict_ids.length, 2);
  c.edit({ type: 'resolve', id: q.id, accept: false });
  assert.deepEqual(c.state.active_instructions[0], before);
  assert.equal(c.state.explicit_constraints.length, 1);
});
test('confirmar una corrección concreta archiva sólo sus referencias con actor de cambio', () => {
  const c = core();
  c.message('No ejecutes código');
  c.message('No borres información');
  c.message('Usa español');
  const keep = structuredClone(c.state.explicit_constraints[1]);
  c.edit({
    type: 'rule-update',
    id: c.state.active_instructions[0].id,
    text: 'Ejecuta código',
  });
  const q = c.state.pending_questions.find((q) => q.kind === 'conflict');
  c.edit({ type: 'resolve', id: q.id, accept: true });
  assert.equal(c.state.active_instructions[0].text, 'Ejecuta código');
  assert.deepEqual(c.state.explicit_constraints, [keep]);
  assert.equal(c.state.instruction_history.length, 2);
  assert.ok(
    c.state.instruction_history.every(
      (e) => e.change.origin.role === 'user' && e.change.kind === 'replaced',
    ),
  );
  assert.equal(c.state.active_instructions[0].certainty, 'confirmed');
  assert.equal(c.state.progress.length, 0);
});
test('confirmación antigua no retira reglas nuevas ni activa indicaciones incompatibles', () => {
  const c = core();
  c.message('No ejecutes código');
  c.message('Ejecuta código');
  const q = c.state.pending_questions.find((q) => q.kind === 'conflict');
  c.edit({
    type: 'add',
    field: 'confirmed_decisions',
    text: 'No ejecutes código',
  });
  const before = structuredClone(c.state);
  assert.throws(
    () => c.edit({ type: 'resolve', id: q.id, accept: true }),
    /reglas cambiaron/,
  );
  assert.deepEqual(c.state, before);
  c.edit({ type: 'retire', id: c.state.explicit_constraints[0].id });
  assert.throws(
    () => c.edit({ type: 'resolve', id: q.id, accept: true }),
    /reglas cambiaron/,
  );
});
test('edición explícita de texto categoría y vigencia conserva literal y categoría anterior en historia', () => {
  const c = core();
  c.message('Preferencia: sin envíos');
  const old = c.state.preferences[0];
  const text = '  No enviar datos\nSin autorización explícita.  ';
  c.edit({
    type: 'rule-update',
    id: old.id,
    text,
    field: 'explicit_constraints',
    scope: 'session',
  });
  assert.equal(c.state.preferences.length, 0);
  assert.equal(c.state.explicit_constraints[0].text, text);
  assert.equal(c.state.explicit_constraints[0].scope, 'session');
  assert.equal(c.state.explicit_constraints[0].priority, 3);
  assert.equal(c.state.instruction_history[0].category, 'preferences');
  assert.deepEqual(c.state.instruction_history[0].origin, old.origin);
  assert.equal(c.state.instruction_history[0].change.origin.channel, 'shell');
});
test('retirar por referencia exacta no afecta otras reglas ni reintroduce al continuar', () => {
  const c = core();
  c.message('No ejecutes código');
  c.message('Usa español');
  c.message('Retira la restricción «No ejecutes código»');
  assert.equal(c.state.explicit_constraints.length, 0);
  assert.equal(c.state.instruction_history[0].status, 'obsolete');
  assert.equal(c.state.instruction_history[0].change.kind, 'retired');
  c.message('Continuemos');
  assert.equal(c.state.explicit_constraints.length, 0);
  assert.equal(c.state.active_instructions.length, 1);
  c.message('Retira la regla «desconocida»');
  assert.equal(c.state.active_instructions.length, 1);
  assert.equal(c.state.pending_questions.at(-1).kind, 'missing-reference');
});
test('vigencia temporal y duradera son explícitas; no se deduplican con distinto alcance', () => {
  const c = core();
  c.message('Solo por esta sesión: No ejecutes código');
  c.message('De ahora en más no borres información');
  c.message('Preferencia temporal: respuestas cortas');
  c.message('Instrucción permanente: Usa español');
  assert.equal(c.state.explicit_constraints[0].scope, 'session');
  assert.equal(c.state.explicit_constraints[1].scope, 'project');
  assert.equal(c.state.preferences[0].scope, 'session');
  assert.equal(c.state.active_instructions[0].scope, 'project');
  c.edit({
    type: 'add',
    field: 'active_instructions',
    text: 'Usa español',
    scope: 'session',
  });
  assert.equal(c.state.active_instructions.length, 2);
  c.message('Retira la instrucción «Usa español»');
  assert.equal(c.state.active_instructions.length, 2);
  assert.equal(c.state.pending_questions.at(-1).kind, 'missing-reference');
});
test('una temporal no sustituye automáticamente una regla duradera mediante ahora', () => {
  const c = core();
  c.message('Usa español');
  c.message('Solo por esta sesión: Ahora usa inglés');
  assert.equal(c.state.active_instructions[0].text, 'Usa español');
  assert.equal(
    c.state.pending_questions.find((q) => q.kind === 'conflict').proposed.scope,
    'session',
  );
});
test('condiciones preguntas citas y ejemplos no se convierten en obligaciones incondicionales', () => {
  const c = core();
  for (const text of [
    'Instrucción: si terminamos, ejecuta el código',
    'Solo esta vez: No borres información',
    'Sólo esta vez: No borres información',
    'Solo por esta sesión: Instrucción permanente: Usa inglés',
    'Instrucción: Solo esta vez usa inglés',
    'Instrucción: Ejecuta código cuando lo autorice',
    'Instrucción: Usa inglés hasta terminar la tarea',
    '¿Usa español?',
    '> No borres información',
    '```\nNo ejecutes código\n```',
    'Ejemplo:\nNo modifiques la funcionalidad',
    'El asistente dijo:\nNo borres información',
  ])
    c.message(text);
  assert.equal(c.state.explicit_constraints.length, 0);
  assert.equal(c.state.active_instructions.length, 0);
  assert.ok(
    c.state.pending_questions.some((q) => q.kind === 'missing-reference'),
  );
});
test('sugerencias permanecen pendientes; sí genérico no confirma ni acredita progreso', () => {
  const c = core();
  c.message('Propuesta: usar un almacenamiento local');
  c.message('Podríamos agregar un panel de búsqueda');
  assert.equal(c.state.decision_candidates.length, 2);
  assert.equal(c.state.confirmed_decisions.length, 0);
  c.message('Sí');
  assert.equal(c.state.confirmed_decisions.length, 0);
  const id = c.state.decision_candidates[0].id;
  c.edit({ type: 'decision-candidate', id, action: 'confirm' });
  assert.equal(c.state.confirmed_decisions[0].certainty, 'confirmed');
  assert.equal(c.state.decision_candidates[0].status, 'accepted');
  assert.equal(c.state.decision_candidates[0].certainty, 'inferred');
  assert.equal(
    c.state.decision_candidates[0].target_id,
    c.state.confirmed_decisions[0].id,
  );
  assert.equal(c.state.decision_candidates[0].resolution.verified, false);
  assert.equal(c.state.progress.length, 0);
  c.message(`Decisión confirmada: ${c.state.decision_candidates[1].text}`);
  assert.equal(c.state.decision_candidates[1].status, 'accepted');
  assert.equal(c.state.confirmed_decisions.length, 2);
});
test('rechazo de propuesta es explícito trazable y no se revierte por repetición literal', () => {
  const c = core();
  c.message('Sugerencia: un plan alternativo');
  const id = c.state.decision_candidates[0].id;
  c.edit({ type: 'decision-candidate', id, action: 'reject' });
  c.message('Sugerencia: un plan alternativo');
  assert.equal(c.state.decision_candidates.length, 1);
  assert.equal(c.state.decision_candidates[0].status, 'rejected');
  assert.throws(
    () => c.edit({ type: 'decision-candidate', id, action: 'confirm' }),
    /ya no está pendiente/,
  );
  assert.equal(c.state.confirmed_decisions.length, 0);
});
test('decisión o propuesta no supera una restricción sin confirmación del conflicto concreto', () => {
  const c = core();
  c.message('No ejecutes código');
  c.message('Propuesta: Ejecuta código');
  const id = c.state.decision_candidates[0].id;
  c.edit({ type: 'decision-candidate', id, action: 'confirm' });
  assert.equal(c.state.decision_candidates[0].status, 'pending');
  assert.equal(c.state.confirmed_decisions.length, 0);
  const q = c.state.pending_questions.find((q) => q.kind === 'conflict');
  assert.equal(q.proposed.decision_candidate_id, id);
  c.edit({ type: 'resolve', id: q.id, accept: true });
  assert.equal(c.state.decision_candidates[0].status, 'accepted');
  assert.equal(c.state.explicit_constraints.length, 0);
  assert.equal(c.state.confirmed_decisions[0].text, 'Ejecuta código');
});
test('una propuesta rechazada después del conflicto invalida su aprobación anterior', () => {
  const c = core();
  c.message('No ejecutes código');
  c.message('Propuesta: Ejecuta código');
  const id = c.state.decision_candidates[0].id;
  c.edit({ type: 'decision-candidate', id, action: 'confirm' });
  const q = c.state.pending_questions.find((q) => q.kind === 'conflict');
  c.edit({ type: 'decision-candidate', id, action: 'reject' });
  assert.throws(
    () => c.edit({ type: 'resolve', id: q.id, accept: true }),
    /propuesta de decisión/,
  );
  assert.equal(c.state.explicit_constraints.length, 1);
});
test('decisiones incompatibles reconocidas se revisan sin escoger por intuición', () => {
  const c = core();
  c.message('Decisión confirmada: Formato: JSON');
  c.message('Decisión confirmada: Formato: Markdown');
  assert.equal(c.state.confirmed_decisions.length, 1);
  const q = c.state.pending_questions.find((q) => q.kind === 'conflict');
  assert.equal(q.proposed.field, 'confirmed_decisions');
  c.edit({ type: 'resolve', id: q.id, accept: true });
  assert.equal(c.state.confirmed_decisions.length, 1);
  assert.equal(c.state.confirmed_decisions[0].text, 'Formato: Markdown');
});
test('candidatos, caducidad y decisiones persisten con EVO apagada y no contaminan otro contexto', () => {
  const f = fixture();
  let s = f.make();
  s.observeConversation(f.g, [
    {
      id: 'u1',
      role: 'user',
      content: 'Solo por esta sesión: Propuesta: Ejecuta código',
    },
    {
      id: 'u2',
      role: 'user',
      content: 'De ahora en más no borres información',
    },
    { id: 'u3', role: 'user', content: 'Instrucción temporal: Usa español' },
    { id: 'u4', role: 'user', content: 'Propuesta: Mantener control humano' },
  ]);
  s = f.make();
  let snap = s.snapshot(f.g);
  assert.equal(snap.observationEnabled, true);
  assert.equal(snap.state.decision_candidates[0].status, 'obsolete');
  assert.equal(snap.state.decision_candidates[1].status, 'pending');
  assert.equal(snap.state.active_instructions.length, 0);
  assert.equal(snap.state.explicit_constraints.length, 1);
  assert.equal(
    snap.state.instruction_history[0].change.kind,
    'session-expired',
  );
  s.edit(f.g, {
    type: 'decision-candidate',
    id: snap.state.decision_candidates[1].id,
    action: 'confirm',
    revision: snap.state.revision,
  });
  s = f.make();
  snap = s.snapshot(f.g);
  assert.equal(snap.state.confirmed_decisions.length, 1);
  assert.equal(snap.state.decision_candidates[1].status, 'accepted');
  assert.equal(
    s.snapshot({ id: 2, getURL: () => 'https://chatgpt.com/c/other' }).state
      .confirmed_decisions.length,
    0,
  );
});
test('propuesta temporal expira junto a su conflicto, sin incertidumbre pendiente fantasma', () => {
  const f = fixture();
  let s = f.make();
  s.observe(f.g, 'No ejecutes código', { messageId: 'u1' });
  s.observe(f.g, 'Solo por esta sesión: Propuesta: Ejecuta código', {
    messageId: 'u2',
  });
  let snap = s.snapshot(f.g);
  s.edit(f.g, {
    type: 'decision-candidate',
    id: snap.state.decision_candidates[0].id,
    action: 'confirm',
    revision: snap.state.revision,
  });
  s = f.make();
  snap = s.snapshot(f.g);
  assert.equal(
    snap.state.pending_questions.find((q) => q.kind === 'conflict').status,
    'rejected',
  );
  assert.equal(snap.effective.decision_candidates.length, 0);
  assert.ok(
    !snap.state.uncertainty.some((u) => u.kind === 'decision-proposal'),
  );
  assert.equal(snap.state.explicit_constraints.length, 1);
});
test('archivos previos sin candidatos cargan y observación del asistente no crea decisiones', () => {
  const f = fixture();
  let s = f.make();
  s.edit(f.g, { type: 'goal', revision: 0, text: 'Principal' });
  let raw = JSON.parse(readFileSync(f.file, 'utf8'));
  delete raw.contexts[0].state.decision_candidates;
  writeFileSync(f.file, JSON.stringify(raw));
  s = f.make();
  assert.equal(s.loadError, null);
  s.observeConversation(f.g, [
    { id: 'u', role: 'user', content: 'Pregunta independiente: hola' },
    {
      id: 'a',
      role: 'assistant',
      content: 'Decisión confirmada: Ejecuta código\nPropuesta: Usa español',
    },
  ]);
  assert.equal(s.snapshot(f.g).state.confirmed_decisions.length, 0);
});
test('límite de propuestas rechaza sin poda ni retiro parcial al llenarse historia', () => {
  const c = core();
  for (let i = 0; i < DECISION_CANDIDATE_LIMIT; i++)
    c.message(`Propuesta: alternativa ${i}`);
  const before = structuredClone(c.state);
  assert.throws(() => c.message('Propuesta: desbordada'), /Límite/);
  assert.deepEqual(c.state, before);
  const a = core();
  a.message('Usa español');
  const state = structuredClone(a.state);
  state.instruction_history = Array.from({ length: 400 }, (_, i) => ({
    ...state.active_instructions[0],
    id: `old-${i}`,
    status: 'obsolete',
  }));
  assert.throws(
    () =>
      updateUnderstanding(state, {
        type: 'rule-update',
        revision: state.revision,
        id: state.active_instructions[0].id,
        text: 'Usa inglés',
      }),
    /Límite/,
  );
  assert.equal(state.active_instructions[0].text, 'Usa español');
});
test('validación de clasificación, historia y resoluciones corruptas bloquea la carga sin sobrescribir', () => {
  const c = core();
  c.message('Usa español');
  c.edit({
    type: 'rule-update',
    id: c.state.active_instructions[0].id,
    text: 'Usa inglés',
  });
  c.message('Propuesta: Conservar NEXO');
  c.edit({
    type: 'decision-candidate',
    id: c.state.decision_candidates[0].id,
    action: 'confirm',
  });
  for (const mutate of [
    (s) => (s.active_instructions[0].category = 'preferences'),
    (s) => (s.active_instructions[0].priority = 1),
    (s) => (s.instruction_history[0].change.origin.role = 'assistant'),
    (s) => (s.decision_candidates[0].resolution.verified = true),
    (s) => (s.decision_candidates[0].source_kind = 'assistant'),
    (s) => delete s.decision_candidates[0].target_id,
  ]) {
    const bad = structuredClone(c.state);
    mutate(bad);
    assert.throws(() => validateUnderstanding(bad), /inválido/);
  }
  const f = fixture(),
    s = f.make();
  s.edit(f.g, { type: 'goal', revision: 0, text: 'Safe' });
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  raw.contexts[0].state.decision_candidates = {};
  const stored = JSON.stringify(raw);
  writeFileSync(f.file, stored);
  assert.throws(() => f.make().snapshot(f.g), /No se sobrescribirá/);
  assert.equal(readFileSync(f.file, 'utf8'), stored);
});
test('ediciones con ids, alcance o revisión inválidos son atómicas', () => {
  const c = core();
  c.message('Usa español');
  const before = structuredClone(c.state);
  for (const o of [
    { id: 'missing', text: 'Other' },
    { id: c.state.active_instructions[0].id, scope: 'forever' },
    { id: c.state.active_instructions[0].id, field: 'progress' },
    { id: c.state.active_instructions[0].id, text: ' ' },
  ])
    assert.throws(() => c.edit({ type: 'rule-update', ...o }));
  assert.deepEqual(c.state, before);
  assert.throws(
    () =>
      updateUnderstanding(c.state, {
        type: 'rule-update',
        revision: 0,
        id: c.state.active_instructions[0].id,
        text: 'Usa inglés',
      }),
    /contexto cambió/,
  );
});
test('gramática inglesa de sugerencias y vigencia; dimensiones desconocidas no se comparan como equivalentes', () => {
  assert.equal(
    ruleSegment('For this session: Instruction: Use English').scope,
    'session',
  );
  assert.equal(ruleSegment('Suggestion: Build an app').proposal, true);
  assert.equal(ruleValueKey('Prefiero respuestas cortas').value, 'short');
  assert.equal(ruleValueKey('Cambiar una arquitectura compleja'), null);
  const c = core();
  c.message('From now on use English');
  assert.equal(c.state.active_instructions[0].scope, 'project');
});

test('fallo de disco en actualización o decisión no confirma RAM y permite reintento', () => {
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
    g = { id: 1, getURL: () => 'https://chatgpt.com/c/rule-retry' };
  s.edit(g, {
    type: 'add',
    revision: 0,
    field: 'active_instructions',
    text: 'Usa español',
  });
  let before = s.snapshot(g).state,
    stored = raw;
  fail = true;
  const operation = {
    type: 'rule-update',
    id: before.active_instructions[0].id,
    text: 'Usa inglés',
    revision: before.revision,
  };
  assert.throws(() => s.edit(g, operation));
  assert.deepEqual(s.snapshot(g).state, before);
  assert.equal(raw, stored);
  fail = false;
  s.edit(g, operation);
  s.observe(g, 'Propuesta: Mantener UI', { messageId: 'proposal' });
  before = s.snapshot(g).state;
  stored = raw;
  const confirm = {
    type: 'decision-candidate',
    id: before.decision_candidates[0].id,
    action: 'confirm',
    revision: before.revision,
  };
  fail = true;
  assert.throws(() => s.edit(g, confirm));
  assert.deepEqual(s.snapshot(g).state, before);
  assert.equal(raw, stored);
  fail = false;
  s.edit(g, confirm);
  assert.equal(s.snapshot(g).state.confirmed_decisions.length, 1);
});
test('avisos de preferencias se limitan sin podar las reglas de origen', () => {
  const c = core();
  c.edit({ type: 'add', field: 'active_instructions', text: 'Usa español' });
  for (let i = 0; i < 120; i++)
    c.edit({
      type: 'add',
      field: 'preferences',
      text: `${' '.repeat(i)}Responde en inglés`,
    });
  // La deduplicación normalizada conserva una sola preferencia semánticamente idéntica.
  assert.equal(c.state.preferences.length, 1);
  const state = structuredClone(c.state);
  state.preferences = Array.from({ length: 120 }, (_, i) => ({
    ...state.preferences[0],
    id: `pref-${i}`,
  }));
  const e = effectiveUnderstanding(state);
  assert.equal(e.preference_conflicts.length, 100);
  assert.equal(e.preference_conflicts_clipped, true);
  assert.equal(state.preferences.length, 120);
  assert.equal(state.active_instructions.length, 1);
});

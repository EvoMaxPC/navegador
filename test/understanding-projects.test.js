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
import { PROJECT_LIMITS } from '../src/core/userProjects.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
const guest = (id, url) => ({
  id,
  getURL: () => url,
  setURL(next) {
    url = next;
  },
});
function core() {
  let state = newUnderstanding('c-' + 'a'.repeat(32), 1),
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
          messageId: `u-${++now}`,
          url: 'https://chatgpt.com/c/project',
        },
        now,
      );
      state = r.state;
      return r;
    },
    message(text) {
      return this.edit({ type: 'message', text });
    },
  };
}
function fixture(options = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'uue-projects-')), 'uue.json'),
    a = guest(1, 'https://chatgpt.com/c/project-a'),
    b = guest(2, 'https://chatgpt.com/c/project-b');
  return {
    file,
    a,
    b,
    make: () =>
      new UserUnderstandingService({
        file,
        memoryEnabled: () => false,
        ...options,
      }),
  };
}
const edit = (s, g, op) =>
  s.edit(g, { ...op, revision: s.snapshot(g).state.revision });
function propose(s, target, source, extra = {}) {
  const sourceState = s.snapshot(source).state;
  return edit(s, target, {
    type: 'context-reference',
    sourceContextId: sourceState.context_id,
    sourceRevision: sourceState.revision,
    ...extra,
  });
}

test('etiqueta y descripción locales no sustituyen objetivo reglas tareas ni implican nuevo proyecto compartido', () => {
  const c = core();
  c.message('Mi objetivo: navegador');
  c.message('No ejecutes código');
  c.message('Tarea: Auditar');
  const before = structuredClone(c.state);
  c.edit({
    type: 'project',
    name: '  NEXO  ',
    description: '  Contexto local\nConservar límites.  ',
  });
  assert.equal(c.state.project.name, '  NEXO  ');
  assert.equal(
    c.state.project.description,
    '  Contexto local\nConservar límites.  ',
  );
  assert.deepEqual(c.state.user_goal, before.user_goal);
  assert.deepEqual(c.state.tasks, before.tasks);
  assert.deepEqual(c.state.explicit_constraints, before.explicit_constraints);
  assert.equal(c.state.progress.length, 0);
});
test('renombrar conserva historia y quitar etiqueta no borra comprensión; cambio de proyecto ambiguo pide aclaración', () => {
  const c = core();
  c.message('Proyecto: NEXO');
  c.message('No borres información');
  c.message('Proyecto: Otro');
  assert.equal(c.state.project.name, 'NEXO');
  assert.ok(
    c.state.pending_questions.some((q) => q.kind === 'missing-reference'),
  );
  c.message('Renombrar proyecto: NEXO documentación');
  assert.equal(c.state.project.name, 'NEXO documentación');
  assert.equal(c.state.project_history[0].name, 'NEXO');
  assert.equal(c.state.project_history[0].changed_by.role, 'user');
  c.edit({ type: 'project', name: null });
  assert.equal(c.state.project, null);
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.equal(c.state.project_history.length, 2);
});
test('alias actuales son datos declarados, seleccionables y retirables sin leer archivos ni convertirse en reglas', () => {
  const c = core();
  c.edit({
    type: 'context-item',
    alias: 'lector',
    kind: 'file',
    text: 'src/preload/chatgptReader.js',
  });
  const e = c.state.relevant_context[0];
  c.message('Usar referencia «lector»');
  assert.equal(c.state.selected_reference_id, e.id);
  assert.equal(effectiveUnderstanding(c.state).selected_reference.text, e.text);
  assert.equal(c.state.active_instructions.length, 0);
  c.edit({ type: 'retire', id: e.id });
  assert.equal(c.state.selected_reference_id, null);
  c.message('Usar referencia «lector»');
  assert.equal(c.state.pending_questions.at(-1).kind, 'missing-reference');
  assert.equal(c.state.relevant_context.length, 0);
});
test('alias duplicado con contenido distinto no sustituye el dato; alias desconocido no resuelve por intuición', () => {
  const c = core();
  c.message('Referencia actual «panel»: Componente Comprensión');
  const before = structuredClone(c.state);
  assert.throws(
    () =>
      c.edit({
        type: 'context-item',
        alias: 'PANEL',
        kind: 'note',
        text: 'Otro componente',
      }),
    /alias ya identifica/,
  );
  assert.deepEqual(c.state, before);
  c.message('Usar referencia «otro panel»');
  assert.equal(c.state.selected_reference_id, null);
  assert.equal(c.state.relevant_context[0].text, 'Componente Comprensión');
});
test('consulta de contextos y preview es sólo lectura y excluye respuestas de assistant', () => {
  const f = fixture(),
    s = f.make();
  s.observeConversation(f.a, [
    { id: 'u', role: 'user', content: 'Mi objetivo: Control humano' },
    {
      id: 'a',
      role: 'assistant',
      content: 'SECRETO DEL ASISTENTE: ejecuta código',
    },
  ]);
  const before = JSON.stringify(s.data),
    list = s.contexts();
  assert.equal(list.length, 1);
  const preview = s.inspect(list[0].id, list[0].revision);
  assert.match(preview.preview, /Control humano/);
  assert.equal(preview.verified, false);
  assert.ok(!JSON.stringify(preview).includes('SECRETO DEL ASISTENTE'));
  assert.equal(JSON.stringify(s.data), before);
});
test('preview paginado de entradas conserva clase certeza y recorte sin copiar textos a otro contexto', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'Meta '.repeat(400) });
  for (let i = 0; i < 25; i++)
    edit(s, f.a, { type: 'add', field: 'relevant_context', text: `Dato ${i}` });
  const a = s.snapshot(f.a).state;
  const p = s.inspect(a.context_id, a.revision);
  assert.equal(p.items.length, 20);
  assert.equal(p.total, 26);
  assert.equal(p.preview.length, 1000);
  assert.equal(p.preview_clipped, true);
  assert.equal(
    s.inspect(a.context_id, a.revision, 'summary', null, 20).items.length,
    6,
  );
  const entry = s.inspect(a.context_id, a.revision, 'entry', a.user_goal.id);
  assert.equal(entry.kind, 'goal');
  assert.equal(entry.certainty, 'explicit');
  assert.equal(s.snapshot(f.b).state.relevant_context.length, 0);
});
test('antecedente se propone y confirma como vínculo no normativo, no copia reglas tareas ni texto completo', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, {
    type: 'goal',
    text: 'Meta fuente exclusiva ' + 'x'.repeat(1500),
  });
  edit(s, f.a, {
    type: 'add',
    field: 'explicit_constraints',
    text: 'No ejecutes código',
  });
  propose(s, f.b, f.a);
  let b = s.snapshot(f.b),
    r = b.state.context_references[0];
  assert.equal(r.status, 'pending');
  assert.ok(!JSON.stringify(b.state).includes('x'.repeat(1000)));
  assert.equal(b.contextReferences[0].available, true);
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'confirm',
  });
  b = s.snapshot(f.b);
  assert.equal(b.state.context_references[0].status, 'linked');
  assert.equal(b.effective.context_references[0].available, true);
  assert.equal(b.state.explicit_constraints.length, 0);
  assert.equal(b.state.tasks.length, 0);
  assert.equal(b.state.user_goal, null);
  assert.equal(b.state.relevant_context.length, 0);
  assert.equal(b.state.context_references[0].verified, false);
});
test('sí genérico no vincula; rechazar/retirar antecedente no recupera su contenido ni lo reactiva', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'Privado del origen' });
  propose(s, f.b, f.a);
  let r = s.snapshot(f.b).state.context_references[0];
  edit(s, f.b, { type: 'message', text: 'Sí' });
  assert.equal(s.snapshot(f.b).state.context_references[0].status, 'pending');
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'reject',
  });
  assert.equal(s.snapshot(f.b).contextReferences[0].preview, null);
  assert.throws(
    () =>
      edit(s, f.b, {
        type: 'context-reference-refresh',
        id: r.id,
        sourceRevision: s.snapshot(f.a).state.revision,
      }),
    /No se reactivan/,
  );
  propose(s, f.b, f.a);
  r = s.snapshot(f.b).state.context_references[1];
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'confirm',
  });
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'retire',
  });
  assert.equal(s.snapshot(f.b).contextReferences[1].preview, null);
});
test('fuente modificada invalida preview/confirmación; renovar vuelve a pendiente con nueva huella', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'Objetivo anterior' });
  propose(s, f.b, f.a);
  const r = s.snapshot(f.b).state.context_references[0];
  edit(s, f.a, { type: 'goal', text: 'Objetivo siguiente' });
  let b = s.snapshot(f.b);
  assert.equal(b.contextReferences[0].reason, 'changed-source');
  assert.equal(b.contextReferences[0].preview, null);
  assert.throws(
    () =>
      edit(s, f.b, {
        type: 'context-reference-resolve',
        id: r.id,
        action: 'confirm',
      }),
    /cambió/,
  );
  edit(s, f.b, {
    type: 'context-reference-refresh',
    id: r.id,
    sourceRevision: s.snapshot(f.a).state.revision,
  });
  b = s.snapshot(f.b);
  assert.equal(b.state.context_references[0].status, 'pending');
  assert.notEqual(b.state.context_references[0].source_digest, r.source_digest);
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'confirm',
  });
  assert.equal(s.snapshot(f.b).state.context_references[0].status, 'linked');
  assert.equal(s.snapshot(f.b).state.context_events.length, 3);
});
test('fuente borrada no se reintroduce por referencia, refresco o bind antiguos', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'Borrar origen' });
  propose(s, f.b, f.a);
  const r = s.snapshot(f.b).state.context_references[0],
    a = s.snapshot(f.a).state;
  s.clear(f.a, a.revision);
  assert.equal(s.snapshot(f.b).contextReferences[0].reason, 'deleted-source');
  assert.throws(() => s.inspect(a.context_id, a.revision), /eliminado/);
  assert.throws(() => s.bind(f.b, a.context_id), /disponible/);
  assert.throws(
    () =>
      edit(s, f.b, {
        type: 'context-reference-resolve',
        id: r.id,
        action: 'confirm',
      }),
    /eliminado/,
  );
  assert.equal(s.snapshot(f.a).erased, true);
});
test('misma etiqueta no mezcla contextos; reinicio conserva etiquetas referencias y alias con EVO apagada', () => {
  const f = fixture();
  let s = f.make();
  for (const g of [f.a, f.b])
    edit(s, g, { type: 'project', name: 'Igual', description: 'Local' });
  edit(s, f.a, {
    type: 'add',
    field: 'explicit_constraints',
    text: 'No ejecutes código',
  });
  edit(s, f.b, {
    type: 'context-item',
    alias: 'UI',
    kind: 'component',
    text: 'Comprensión',
  });
  edit(s, f.b, {
    type: 'context-select',
    id: s.snapshot(f.b).state.relevant_context[0].id,
  });
  propose(s, f.b, f.a);
  const r = s.snapshot(f.b).state.context_references[0];
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'confirm',
  });
  const before = s.snapshot(f.b).state;
  s = f.make();
  assert.deepEqual(s.snapshot(f.b).state, before);
  assert.equal(s.snapshot(f.b).state.explicit_constraints.length, 0);
  assert.equal(s.snapshot(f.b).contextReferences[0].available, true);
  assert.equal(s.snapshot(f.b).observationEnabled, true);
});
test('bind explícito conserva ambos estados y volver al natural no fusiona ni pierde reglas', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'A' });
  edit(s, f.b, { type: 'goal', text: 'B' });
  const a = s.snapshot(f.a).state,
    b = s.snapshot(f.b).state;
  s.bind(f.b, a.context_id, {
    revision: b.revision,
    contextId: b.context_id,
    sourceRevision: a.revision,
  });
  assert.equal(s.snapshot(f.b).state.user_goal.text, 'A');
  assert.equal(s.snapshot(f.b).contextSelection.mode, 'explicit');
  s.bind(f.b, null, { revision: a.revision, contextId: a.context_id });
  assert.equal(s.snapshot(f.b).state.user_goal.text, 'B');
  assert.equal(s.snapshot(f.b).contextSelection.mode, 'natural');
  assert.equal(s.snapshot(f.a).state.user_goal.text, 'A');
});
test('bind fija línea base y no interpreta instrucciones históricas de la conversación visible', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'A' });
  const a = s.snapshot(f.a).state;
  s.bind(f.b, a.context_id);
  s.observeConversation(f.b, [
    { id: 'older', role: 'user', content: 'Incompleto', clipped: true },
    { id: 'old', role: 'user', content: 'No ejecutes código' },
  ]);
  assert.equal(s.snapshot(f.a).state.explicit_constraints.length, 0);
  s.observeConversation(f.b, [
    { id: 'older', role: 'user', content: 'Incompleto', clipped: true },
    { id: 'old', role: 'user', content: 'No ejecutes código' },
    { id: 'new', role: 'user', content: 'Prefiero respuestas cortas' },
  ]);
  assert.equal(s.snapshot(f.a).state.preferences.length, 1);
  assert.equal(s.snapshot(f.a).state.explicit_constraints.length, 0);
  assert.equal(s.snapshot(f.b).contextSelection.baselinePending, false);
  assert.equal(s.snapshot(f.a).conversation.messages.length, 0);
});
test('ventana física no se sobrescribe con la del contexto elegido y reinicio no reimporta el período vinculado', () => {
  const f = fixture();
  let s = f.make();
  s.observeConversation(f.a, [
    { id: 'a', role: 'user', content: 'Mi objetivo: A' },
  ]);
  s.observeConversation(f.b, [
    { id: 'b', role: 'user', content: 'Mi objetivo: B' },
  ]);
  const a = s.snapshot(f.a).state;
  s.bind(f.b, a.context_id);
  s.observeConversation(f.b, [
    { id: 'b', role: 'user', content: 'Mi objetivo: B' },
  ]);
  s.observeConversation(f.b, [
    { id: 'b', role: 'user', content: 'Mi objetivo: B' },
    { id: 'new', role: 'user', content: 'No ejecutes código' },
  ]);
  assert.equal(s.snapshot(f.a).state.explicit_constraints.length, 1);
  assert.equal(s.snapshot(f.a).conversation.messages[0].id, 'a');
  s = f.make();
  assert.equal(s.snapshot(f.b).contextSelection.mode, 'natural');
  s.observeConversation(f.b, [
    { id: 'b', role: 'user', content: 'Mi objetivo: B' },
    { id: 'new', role: 'user', content: 'No ejecutes código' },
  ]);
  assert.equal(s.snapshot(f.b).state.explicit_constraints.length, 0);
  assert.equal(s.snapshot(f.b).state.user_goal.text, 'B');
});
test('revisiones contexto y huella antiguas no cambian selección ni editan otra conversación con revisión igual', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'A' });
  edit(s, f.b, { type: 'goal', text: 'B' });
  const a = s.contexts().find((c) => c.id === s.snapshot(f.a).state.context_id),
    b = s.snapshot(f.b).state;
  edit(s, f.a, { type: 'project', name: 'Cambio' });
  assert.throws(
    () =>
      s.bind(f.b, a.id, {
        revision: b.revision,
        contextId: b.context_id,
        sourceRevision: a.revision,
        sourceDigest: a.digest,
      }),
    /origen cambió/,
  );
  assert.equal(s.snapshot(f.b).state.user_goal.text, 'B');
  f.b.setURL('https://chatgpt.com/c/another');
  assert.throws(
    () =>
      s.edit(f.b, {
        type: 'project',
        revision: 0,
        contextId: b.context_id,
        name: 'No aplicar',
      }),
    /contexto cambió/,
  );
});
test('raíces de proyecto son efímeras por pestaña; migran sólo a su propia conversación', () => {
  const f = fixture(),
    s = f.make(),
    a = guest(4, 'https://chatgpt.com/g/g-p-alpha/project'),
    b = guest(5, 'https://chatgpt.com/g/g-p-alpha/project');
  edit(s, a, { type: 'goal', text: 'A temporal' });
  assert.equal(s.snapshot(b).state.user_goal, null);
  a.setURL('https://chatgpt.com/g/g-p-beta/c/new');
  assert.equal(s.snapshot(a).state.user_goal, null);
  edit(s, b, { type: 'goal', text: 'B temporal' });
  b.setURL('https://chatgpt.com/g/g-p-alpha/c/real');
  assert.equal(s.snapshot(b).state.user_goal.text, 'B temporal');
  assert.equal(s.snapshot(b).contextSelection.temporary, false);
});
test('cambio de URL corta bind y deduplicación de preparación no cruza proyectos', () => {
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'goal', text: 'A' });
  s.bind(f.b, s.snapshot(f.a).state.context_id);
  s.observe(f.b, 'No ejecutes código', { channel: 'prepare', messageId: 'p1' });
  f.b.setURL('https://chatgpt.com/c/new-project');
  s.observeConversation(f.b, [
    { id: 'u1', role: 'user', content: 'No ejecutes código' },
  ]);
  assert.equal(s.snapshot(f.b).contextSelection.mode, 'natural');
  assert.equal(s.snapshot(f.b).state.explicit_constraints.length, 1);
});
test('confirmación EVO detecta contenido reemplazado con mismo ID sin copiarlo ni activarlo', () => {
  let text = 'Antecedente original';
  const memory = {
    projectId: 'default',
    list: () => [{ id: 'mem', kind: 'decision', text }],
    recall: () => [{ item: { id: 'mem', kind: 'decision', text } }],
  };
  const f = fixture({ memory, memoryEnabled: () => true }),
    s = f.make();
  s.recall(f.a, 'antecedente', 0);
  const q = s
    .snapshot(f.a)
    .state.pending_questions.find((q) => q.kind === 'context-reference');
  assert.ok(q.proposed.reference.digest);
  text = 'CONTENIDO REEMPLAZADO';
  assert.equal(s.snapshot(f.a).memoryReferences[0].available, false);
  assert.equal(s.snapshot(f.a).memoryReferences[0].text, null);
  assert.throws(
    () => edit(s, f.a, { type: 'resolve', id: q.id, accept: true }),
    /ya no está disponible/,
  );
  assert.ok(!JSON.stringify(s.data).includes(text));
});
test('EVO apagada no se consulta para proyectos, inspect y referencias locales', () => {
  const memory = {
    projectId: 'default',
    list() {
      throw Error('No consultar');
    },
    recall() {
      throw Error('No consultar');
    },
  };
  const f = fixture({ memory }),
    s = f.make();
  edit(s, f.a, { type: 'project', name: 'Local' });
  propose(s, f.b, f.a);
  const r = s.snapshot(f.b).state.context_references[0];
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'confirm',
  });
  assert.equal(s.snapshot(f.b).contextReferences[0].available, true);
  assert.equal(s.snapshot(f.b).memoryReferences.length, 0);
  assert.throws(
    () => s.recall(f.b, 'nada', s.snapshot(f.b).state.revision),
    /desactivada/,
  );
});
test('archivos previos sin metadatos de proyecto cargan sin migración destructiva', () => {
  const f = fixture();
  let s = f.make();
  edit(s, f.a, { type: 'goal', text: 'Literal previo' });
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const key of [
    'project',
    'project_history',
    'context_references',
    'context_events',
    'selected_reference_id',
  ])
    delete raw.contexts[0].state[key];
  writeFileSync(f.file, JSON.stringify(raw));
  s = f.make();
  assert.equal(s.loadError, null);
  assert.equal(s.snapshot(f.a).state.user_goal.text, 'Literal previo');
  edit(s, f.a, { type: 'project', name: 'Ahora etiquetado' });
  assert.equal(s.snapshot(f.a).state.project.name, 'Ahora etiquetado');
});
test('capacidades de historia y referencias rechazan sin poda ni cambios parciales', () => {
  const c = core();
  for (let i = 0; i <= PROJECT_LIMITS.history; i++)
    c.edit({ type: 'project', name: `P${i}` });
  const before = structuredClone(c.state);
  assert.throws(() => c.edit({ type: 'project', name: 'overflow' }), /Límite/);
  assert.deepEqual(c.state, before);
  const a = core();
  for (let i = 0; i < PROJECT_LIMITS.references; i++)
    a.edit({
      type: 'context-reference',
      reference: {
        source_context_id: `c-${(i + 1).toString(16).padStart(32, '0')}`,
        source_revision: 1,
        source_digest: 'b'.repeat(64),
        target_kind: 'summary',
        target_id: null,
        label: `Fuente ${i}`,
      },
    });
  const full = structuredClone(a.state);
  assert.throws(
    () =>
      a.edit({
        type: 'context-reference',
        reference: {
          source_context_id: 'c-' + 'f'.repeat(32),
          source_revision: 1,
          source_digest: 'b'.repeat(64),
          target_kind: 'summary',
          target_id: null,
          label: 'Extra',
        },
      }),
    /Límite/,
  );
  assert.deepEqual(a.state, full);
  while (a.state.context_events.length < PROJECT_LIMITS.events)
    a.edit({
      type: 'context-reference-refresh',
      id: a.state.context_references[0].id,
      source_revision: 2,
      source_digest: 'c'.repeat(64),
    });
  const eventsFull = structuredClone(a.state);
  assert.throws(
    () =>
      a.edit({
        type: 'context-reference-resolve',
        id: a.state.context_references[0].id,
        action: 'confirm',
      }),
    /Límite/,
  );
  assert.deepEqual(a.state, eventsFull);
});
test('corrupción de perfiles, alias, punteros, eventos y huellas EVO bloquea sin sobrescribir', () => {
  const c = core();
  c.edit({ type: 'project', name: 'Seguro' });
  c.edit({
    type: 'context-item',
    alias: 'file',
    kind: 'file',
    text: 'archivo.js',
  });
  c.edit({
    type: 'context-reference',
    reference: {
      source_context_id: 'c-' + 'b'.repeat(32),
      source_revision: 1,
      source_digest: 'b'.repeat(64),
      target_kind: 'summary',
      target_id: null,
      label: 'Otro',
    },
  });
  for (const mutate of [
    (s) => (s.project.origin.role = 'assistant'),
    (s) => (s.relevant_context[0].entity.kind = 'executor'),
    (s) => (s.selected_reference_id = 'missing'),
    (s) => (s.context_references[0].verified = true),
    (s) => (s.context_references[0].source_digest = 'fake'),
    (s) => (s.context_events[0].origin.role = 'assistant'),
  ]) {
    const bad = structuredClone(c.state);
    mutate(bad);
    assert.throws(() => validateUnderstanding(bad), /inválido/);
  }
  const f = fixture(),
    s = f.make();
  edit(s, f.a, { type: 'project', name: 'Safe' });
  const raw = JSON.parse(readFileSync(f.file, 'utf8'));
  raw.contexts[0].state.project_history = {};
  const stored = JSON.stringify(raw);
  writeFileSync(f.file, stored);
  assert.throws(() => f.make().snapshot(f.a), /No se sobrescribirá/);
  assert.equal(readFileSync(f.file, 'utf8'), stored);
});
test('fallo de disco no confirma etiqueta ni vínculo y conserva posibilidad de reintento', () => {
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
    a = guest(1, 'https://chatgpt.com/c/a'),
    b = guest(2, 'https://chatgpt.com/c/b');
  edit(s, a, { type: 'project', name: 'A' });
  const source = s.snapshot(a).state;
  const op = {
    type: 'context-reference',
    revision: 0,
    sourceContextId: source.context_id,
    sourceRevision: source.revision,
  };
  fail = true;
  assert.throws(() => s.edit(b, op));
  assert.equal(s.snapshot(b).state.context_references.length, 0);
  fail = false;
  s.edit(b, op);
  const before = s.snapshot(b).state,
    stored = raw;
  fail = true;
  assert.throws(() =>
    edit(s, b, {
      type: 'context-reference-resolve',
      id: before.context_references[0].id,
      action: 'confirm',
    }),
  );
  assert.deepEqual(s.snapshot(b).state, before);
  assert.equal(raw, stored);
  fail = false;
  edit(s, b, {
    type: 'context-reference-resolve',
    id: before.context_references[0].id,
    action: 'confirm',
  });
  assert.equal(s.snapshot(b).state.context_references[0].status, 'linked');
});
test('citas, preguntas y declaraciones del asistente atribuido no seleccionan proyectos o alias', () => {
  const c = core();
  c.message('Referencia actual «archivo»: archivo.js');
  for (const t of [
    '> Proyecto: Otro',
    '¿Proyecto: Otro?',
    'El asistente dijo: Proyecto: Otro',
    '```\nUsar referencia «archivo»\n```',
    'Sí',
  ])
    c.message(t);
  assert.equal(c.state.project, null);
  assert.equal(c.state.selected_reference_id, null);
});
test('lectura de referencias detecta caducidad aunque revisión no cambie y no sustituye datos actuales', () => {
  const f = fixture();
  let s = f.make();
  edit(s, f.a, {
    type: 'add',
    field: 'active_instructions',
    text: 'Usa español',
    scope: 'session',
  });
  propose(s, f.b, f.a);
  const r = s.snapshot(f.b).state.context_references[0];
  edit(s, f.b, {
    type: 'context-reference-resolve',
    id: r.id,
    action: 'confirm',
  });
  s = f.make();
  const b = s.snapshot(f.b);
  assert.equal(b.contextReferences[0].reason, 'changed-source');
  assert.equal(b.effective.context_references[0].available, false);
  assert.equal(b.state.active_instructions.length, 0);
});

test('continuar en contexto elegido no resucita el documento físico eliminado', () => {
  const f = fixture();
  let s = f.make();
  edit(s, f.a, { type: 'goal', text: 'Origen conservado' });
  const a = s.snapshot(f.a).state;
  const b = s.snapshot(f.b).state;
  s.clear(f.b, b.revision);
  s.bind(f.b, a.context_id);
  assert.equal(
    s.observeConversation(f.b, [
      { id: 'b1', role: 'user', content: 'No ejecutes código' },
    ]).ok,
    true,
  );
  assert.ok(Object.hasOwn(s.data.deleted_revisions, b.context_id));
  assert.ok(!s.data.contexts.some((r) => r.state.context_id === b.context_id));
  s = f.make();
  assert.equal(s.snapshot(f.b).erased, true);
  assert.equal(s.snapshot(f.b).state.user_goal, null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  newUnderstanding,
  updateUnderstanding,
  effectiveUnderstanding,
  MAX_USER_TEXT,
  interpretMessage,
  PRIORITY,
} from '../src/core/userUnderstanding.js';
import {
  UserUnderstandingService,
  installUnderstandingIPC,
} from '../src/main/userUnderstanding.js';
import { fileStorage, createMemory } from '../src/main/memory.js';
const core = () => {
  let state = newUnderstanding('test', 100),
    now = 100;
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
          url: 'https://chatgpt.com/c/test',
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
};
const guest = (id = 11, url = 'https://chatgpt.com/c/project-a') => ({
  id,
  getURL: () => url,
  setURL(next) {
    url = next;
  },
});
const service = (options = {}) =>
  new UserUnderstandingService({
    storage: fileStorage(
      join(mkdtempSync(join(tmpdir(), 'nexo-uue-')), 'state.json'),
    ),
    ...options,
  });

test('escenario 1: objetivo extenso literal y libre conserva saltos, símbolos y espacios sin resumen', () => {
  const c = core();
  const goal =
    '  Mejorar NEXO sin reconstruirlo.\n' +
    'Objetivo con precisión «literal», sin inventar cifras ni decisiones.\n'.repeat(
      120,
    ) +
    '\n  final  ';
  c.edit({ type: 'goal', text: goal });
  assert.equal(c.state.user_goal.text, goal);
  assert.ok(goal.length > 2000);
  assert.equal(c.state.user_goal.certainty, 'explicit');
  assert.equal(c.state.user_goal.origin.channel, 'shell');
  assert.equal(c.state.goal_history.length, 0);
  c.message('Analizá los problemas antes de escribir código');
  assert.equal(c.state.user_goal.text, goal);
});
test('escenario 2: restricciones persisten; preferencias no anulan instrucciones ni restricciones', () => {
  const c = core();
  c.message('Mi objetivo principal: mejorar NEXO');
  c.message('No modifiques la funcionalidad');
  c.message('No ejecutes código');
  c.message('No borres información');
  c.message('Preferencia: priorizar la velocidad');
  c.message('Implementa una mejora pequeña');
  const e = effectiveUnderstanding(c.state);
  assert.deepEqual(
    e.explicit_constraints.map((e) => e.text),
    [
      'No modifiques la funcionalidad',
      'No ejecutes código',
      'No borres información',
    ],
  );
  assert.equal(c.state.user_goal.text, 'mejorar NEXO');
  assert.equal(c.state.preferences.length, 1);
  c.edit({
    type: 'add',
    field: 'preferences',
    text: 'Modifica la funcionalidad',
  });
  assert.equal(c.state.pending_questions.length, 0);
  assert.equal(c.state.explicit_constraints.length, 3);
  assert.ok(PRIORITY.explicit_constraints < PRIORITY.preferences);
});
test('escenario 3: tarea intermedia y subobjetivo no sustituyen el objetivo', () => {
  const c = core();
  c.message('Mi objetivo es mejorar el control del usuario');
  const goal = c.state.user_goal;
  c.message('Subobjetivo: inspeccionar IPC');
  c.message('Revisar ahora la estructura del repositorio');
  assert.deepEqual(c.state.user_goal, goal);
  assert.equal(c.state.subgoals[0].text, 'inspeccionar IPC');
  assert.equal(
    c.state.current_task.text,
    'Revisar ahora la estructura del repositorio',
  );
  assert.equal(c.state.current_task.certainty, 'inferred');
  assert.equal(c.state.current_task.related_goal_id, goal.id);
});
test('escenario 4: corrección explícita reemplaza sólo instrucción referenciada, con historia', () => {
  const c = core();
  c.message('Mi objetivo: mejorar continuidad');
  c.message('Usa español');
  const old = c.state.active_instructions[0];
  c.message('Reemplaza «Usa español» por «Usa inglés»');
  assert.deepEqual(
    c.state.active_instructions.map((e) => e.text),
    ['Usa inglés'],
  );
  assert.equal(c.state.instruction_history[0].id, old.id);
  assert.equal(c.state.instruction_history[0].status, 'superseded');
  assert.equal(c.state.pending_questions.length, 0);
  c.message('Ahora usa español');
  assert.equal(c.state.active_instructions[0].text, 'Ahora usa español');
  assert.equal(c.state.instruction_history.length, 2);
});
test('escenario 5: retomar después de reiniciar restaura objetivo, tarea y reglas; no inventa progreso', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'uue-restart-')), 'state.json'),
    g = guest();
  let s = service({ file, storage: fileStorage(file) });
  s.edit(g, {
    type: 'goal',
    revision: 0,
    text: 'Conservar el trabajo original',
  });
  s.edit(g, {
    type: 'message',
    revision: 1,
    text: 'Preparar el informe de continuidad',
  });
  s.edit(g, {
    type: 'add',
    revision: 2,
    field: 'explicit_constraints',
    text: 'No borres información',
  });
  s = service({ file, storage: fileStorage(file) });
  const before = s.snapshot(g);
  s.edit(g, {
    type: 'message',
    revision: before.state.revision,
    text: 'Continuemos',
  });
  const next = s.snapshot(g);
  assert.equal(next.state.user_goal.text, 'Conservar el trabajo original');
  assert.equal(
    next.state.current_task.text,
    'Preparar el informe de continuidad',
  );
  assert.equal(next.state.current_task.validity, 'last-known');
  assert.equal(next.state.explicit_constraints.length, 1);
  assert.equal(next.state.progress.length, 0);
  assert.equal(next.report.intent, 'continuation');
});
test('escenario 6: solicitud independiente no contamina; conversaciones nuevas quedan aisladas y se vinculan sólo explícitamente', () => {
  const c = core();
  c.message('Mi objetivo: construir continuidad');
  const before = structuredClone(c.state);
  const r = c.message('Pregunta independiente: ¿cuánto es dos más dos?');
  assert.deepEqual(c.state, before);
  assert.equal(r.report.isolated, true);
  const s = service(),
    a = guest(),
    b = guest(12, 'https://chatgpt.com/c/project-b');
  s.edit(a, { type: 'goal', revision: 0, text: 'Objetivo de A' });
  assert.equal(s.snapshot(b).state.user_goal, null);
  s.bind(b, s.snapshot(a).state.context_id);
  assert.equal(s.snapshot(b).state.user_goal.text, 'Objetivo de A');
});
test('escenario 7: contradicción de acción reconocida conserva restricción y pregunta específica antes de cambiarla', () => {
  const c = core();
  c.message('Mi objetivo: mejorar NEXO');
  c.message('No modifiques la funcionalidad');
  c.message('Modifica la funcionalidad');
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.equal(c.state.active_instructions.length, 0);
  const q = c.state.pending_questions.at(-1);
  assert.equal(q.kind, 'conflict');
  assert.match(q.text, /No modifiques la funcionalidad/);
  assert.equal(q.conflict_ids[0], c.state.explicit_constraints[0].id);
  c.message('Sí');
  assert.equal(c.state.explicit_constraints.length, 1);
  assert.equal(c.state.pending_questions.at(-1).status, 'open');
  c.edit({ type: 'resolve', id: q.id, accept: true });
  assert.equal(c.state.explicit_constraints.length, 0);
  assert.equal(
    c.state.active_instructions[0].text,
    'Modifica la funcionalidad',
  );
  assert.equal(c.state.active_instructions[0].certainty, 'confirmed');
  assert.equal(c.state.instruction_history[0].status, 'superseded');
});
test('escenario 8: cambio inequívoco de objetivo autorizado, historia literal; nueva declaración no inequívoca pregunta', () => {
  const c = core();
  c.message('Mi objetivo: conservar el original');
  c.message('Mi objetivo: publicar otra cosa');
  assert.equal(c.state.user_goal.text, 'conservar el original');
  const q = c.state.pending_questions.at(-1);
  assert.equal(q.kind, 'goal-change');
  c.edit({ type: 'resolve', id: q.id, accept: false });
  c.message('Cambio de objetivo: optimizar accesibilidad');
  assert.equal(c.state.user_goal.text, 'optimizar accesibilidad');
  assert.equal(c.state.goal_history[0].text, 'conservar el original');
  c.message('Volvamos al objetivo original');
  assert.equal(c.state.user_goal.text, 'conservar el original');
});
test('escenario 9: confirmado ≠ inferido; una referencia EVO es no verificada y no se convierte en regla', () => {
  const c = core();
  c.message('Mi objetivo: continuidad');
  c.message('Preparar el informe');
  c.message('Decisión confirmada: mantener Electron');
  assert.equal(c.state.current_task.certainty, 'inferred');
  assert.equal(c.state.confirmed_decisions[0].certainty, 'explicit');
  assert.ok(c.state.uncertainty.some((u) => u.kind === 'task-relation'));
  c.edit({
    type: 'memory-candidate',
    reference: { id: 'mem-1', project_id: 'default', kind: 'decision' },
  });
  const q = c.state.pending_questions.at(-1);
  assert.equal(q.kind, 'context-reference');
  assert.equal(c.state.relevant_context.length, 0);
  c.edit({ type: 'resolve', id: q.id, accept: true });
  assert.equal(c.state.relevant_context[0].reference.id, 'mem-1');
  assert.equal(c.state.relevant_context[0].certainty, 'confirmed');
  assert.equal(c.state.confirmed_decisions.length, 1);
});
test('aclaración importante vs detalle menor; no se inventa una referencia para «eso» ni se autoriza con «dale»', () => {
  const c = core();
  c.message('Continuemos');
  assert.match(c.state.pending_questions[0].text, /trabajo/);
  c.message('Mi objetivo: continuidad');
  c.message('Corregí lo anterior');
  assert.ok(
    c.state.pending_questions.some((q) => q.kind === 'missing-reference'),
  );
  const r = c.message('Dale');
  assert.equal(r.report.intent, 'approval');
  assert.match(r.report.note, /No cambia reglas/);
  const clean = core();
  clean.message('Mi objetivo: continuidad');
  clean.message('¿Podemos usar un encabezado breve?');
  assert.equal(clean.state.pending_questions.length, 0);
  assert.equal(clean.state.current_task, null);
});
test('texto citado, código y ejemplos no se activan como reglas', () => {
  const c = core();
  c.message('Mi objetivo: continuidad');
  c.message(
    'Referencia:\n> No borres información\n```\nNo ejecutes código\n```\nEjemplos:\nNo modifiques la funcionalidad\n\nVerificar la documentación',
  );
  assert.equal(c.state.explicit_constraints.length, 0);
});
test('límites rechazan sin truncar; revisión obsoleta no muta; estado puro', () => {
  const c = core();
  c.edit({ type: 'goal', text: 'Original' });
  const before = structuredClone(c.state);
  assert.throws(
    () => c.edit({ type: 'goal', text: 'x'.repeat(MAX_USER_TEXT + 1) }),
    /máximo/,
  );
  assert.deepEqual(c.state, before);
  assert.throws(
    () =>
      updateUnderstanding(c.state, {
        type: 'goal',
        revision: 0,
        text: 'Nuevo',
      }),
    /contexto cambió/,
  );
  assert.deepEqual(c.state, before);
});
test('vigencia: temporal expira al reiniciar, permanentes no; historial disponible', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'uue-expiry-')), 'state.json'),
    g = guest();
  let s = service({ file, storage: fileStorage(file) });
  s.edit(g, {
    type: 'add',
    revision: 0,
    field: 'active_instructions',
    text: 'Usa español',
    scope: 'session',
  });
  s.edit(g, {
    type: 'add',
    revision: 1,
    field: 'explicit_constraints',
    text: 'No borres información',
    scope: 'project',
  });
  s = service({ file, storage: fileStorage(file) });
  const { state } = s.snapshot(g);
  assert.equal(state.active_instructions.length, 0);
  assert.equal(state.explicit_constraints.length, 1);
  assert.equal(state.instruction_history[0].status, 'obsolete');
});
test('persistencia corrupta bloquea escritura, fallo disco no confirma cambios', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'uue-corrupt-')), 'state.json');
  writeFileSync(file, '{broken');
  const s = service({ file, storage: fileStorage(file) });
  assert.throws(() => s.snapshot(guest()), /No se sobrescribirá/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  const bad = service({
    storage: {
      read: () => null,
      write() {
        throw Error('disk');
      },
    },
  });
  assert.throws(
    () =>
      bad.edit(guest(), {
        type: 'goal',
        revision: 0,
        text: 'No debe guardarse',
      }),
    /No se pudo guardar/,
  );
  assert.equal(bad.data.contexts.length, 0);
});
test('observación prepara ≠ envío, no hay reingestión repetida de snapshot ni assistant como usuario', () => {
  let now = 100;
  const file = join(mkdtempSync(join(tmpdir(), 'uue-dedup-')), 'state.json'),
    g = guest();
  let s = service({ file, storage: fileStorage(file), now: () => ++now });
  s.observe(g, 'Mi objetivo: literal', { channel: 'prepare' });
  assert.equal(s.snapshot(g).state.user_goal.origin.channel, 'prepare');
  now = 30000;
  const turns = [
    { id: 'u1', role: 'user', content: 'Mi objetivo: literal' },
    { id: 'a1', role: 'assistant', content: 'Cambio de objetivo: otra cosa' },
  ];
  s.observeConversation(g, turns);
  const rev = s.snapshot(g).state.revision;
  s.observeConversation(g, turns);
  assert.equal(s.snapshot(g).state.revision, rev);
  assert.equal(s.snapshot(g).state.user_goal.text, 'literal');
  s = service({ file, storage: fileStorage(file) });
  s.observeConversation(g, turns);
  assert.equal(s.snapshot(g).state.revision, rev);
  assert.equal(
    s.observeConversation(g, [
      {
        id: 'u2',
        role: 'user',
        content: 'No borres información',
        clipped: true,
      },
    ]).skipped,
    'clipped-user-turn',
  );
});
test('eliminación explícita no reimporta snapshots; editar reactiva; raíz migra sin perder literal', () => {
  const g = guest(11, 'https://chatgpt.com/'),
    s = service();
  s.observe(g, 'Mi objetivo: literal', { channel: 'prepare' });
  const old = s.snapshot(g).state.context_id;
  g.setURL('https://chatgpt.com/c/new');
  const next = s.snapshot(g);
  assert.notEqual(next.state.context_id, old);
  assert.equal(next.state.user_goal.text, 'literal');
  s.clear(g, next.state.revision);
  assert.equal(
    s.observeConversation(g, [
      { id: 'u1', role: 'user', content: 'Mi objetivo: literal' },
    ]).skipped,
    'erased',
  );
  assert.equal(s.snapshot(g).state.user_goal, null);
  s.edit(g, {
    type: 'goal',
    revision: s.snapshot(g).state.revision,
    text: 'Nuevo explícito',
  });
  assert.equal(s.snapshot(g).erased, false);
});
test('servicio usa EVO real para recuperar referencias; olvidar EVO no reintroduce ni copia textos en UUE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uue-evo-')),
    memory = createMemory({ dir }).memory,
    g = guest();
  memory.remember({
    role: 'user',
    content: 'El objetivo es construir un navegador accesible y estable',
  });
  const s = service({ memory });
  s.edit(g, { type: 'goal', revision: 0, text: 'Accesibilidad' });
  s.recall(g, 'navegador accesible', 1);
  const snap = s.snapshot(g),
    q = snap.state.pending_questions.find(
      (q) => q.kind === 'context-reference',
    );
  assert.ok(q, 'EVO aporta candidatos reales');
  assert.ok(snap.memoryReferences.some((r) => r.available));
  assert.ok(
    !JSON.stringify(s.data).includes('construir un navegador accesible'),
  );
  memory.forget(q.proposed.reference.id);
  assert.throws(
    () =>
      s.edit(g, {
        type: 'resolve',
        revision: snap.state.revision,
        id: q.id,
        accept: true,
      }),
    /ya no está disponible/,
  );
  assert.equal(s.snapshot(g).memoryReferences[0].available, false);
});
test('observación pausada y host no IA no almacenan; pregunta independiente en automático no persiste', () => {
  const s = service({ enabled: () => false });
  assert.equal(s.observe(guest(), 'Mi objetivo: privado').skipped, 'disabled');
  assert.equal(s.data.contexts.length, 0);
  const on = service();
  assert.equal(
    on.observe(guest(2, 'https://example.com/a'), 'Mi objetivo: no leer')
      .skipped,
    'not-ai',
  );
  on.observe(guest(), 'Pregunta independiente: otro tema', {
    channel: 'prepare',
  });
  assert.equal(on.data.contexts.length, 0);
});
test('IPC restringe shell exacta, mainFrame y guest propietario; confirmación nativa y control de revisiones', async () => {
  const handlers = new Map(),
    g = guest(),
    owner = {
      mainFrame: {},
      getURL: () => 'nexo://app/src/ui/shell/index.html',
      isDestroyed: () => false,
    },
    event = { sender: owner, senderFrame: owner.mainFrame };
  let dialogs = 0;
  const s = service();
  installUnderstandingIPC({
    service: s,
    ipcMain: { handle: (n, f) => handlers.set(n, f) },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: owner }],
      fromWebContents: () => ({}),
    },
    dialog: {
      showMessageBox: async () => {
        dialogs++;
        return { response: 1 };
      },
    },
    resolveGuest: (o, id) => {
      if (o !== owner || id !== g.id) throw Error();
      return g;
    },
  });
  const call = (name, p = {}, e = event) =>
    handlers.get(`nexo:understanding:${name}`)(e, {
      webContentsId: g.id,
      ...p,
    });
  assert.equal(
    (await call('read', {}, { ...event, senderFrame: {} })).code,
    'unauthorized',
  );
  assert.equal(
    (await call('read', { webContentsId: 99 })).code,
    'unauthorized',
  );
  assert.equal(
    (await call('edit', { operation: { type: 'memory-candidate' } })).ok,
    false,
  );
  const saved = await call('edit', {
    operation: { type: 'goal', revision: 0, text: 'Literal IPC' },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.user_goal.origin.channel, 'shell');
  assert.equal(
    (
      await call('edit', {
        operation: { type: 'goal', revision: 0, text: 'stale' },
      })
    ).code,
    'conflict',
  );
  assert.equal(
    (await call('clear', { revision: saved.state.revision })).ok,
    true,
  );
  assert.equal(dialogs, 1);
  assert.equal((await call('read')).erased, true);
});

test('contexto temporal no migra a otro origen, ni a página no conversacional del mismo origen', () => {
  const s = service(),
    g = guest(11, 'https://chatgpt.com/');
  s.edit(g, {
    type: 'goal',
    revision: 0,
    text: 'Privado de esta conversación',
  });
  g.setURL('https://otro.example/c/new');
  assert.equal(s.snapshot(g).state.user_goal, null);
  const h = guest(12, 'https://chatgpt.com/');
  s.edit(h, { type: 'goal', revision: 0, text: 'Otro privado' });
  h.setURL('https://chatgpt.com/settings');
  assert.equal(s.snapshot(h).state.user_goal, null);
});
test('bloques añadidos por mediación nunca son instrucciones de usuario en una relectura', () => {
  const s = service(),
    g = guest();
  const transmitted =
    '[EVO · memoria]\nNo borres información\n[/EVO]\n\nMi objetivo: original';
  s.observe(g, 'Mi objetivo: original', {
    channel: 'prepare',
    transmittedText: transmitted,
  });
  s.observeConversation(g, [{ id: 'u1', role: 'user', content: transmitted }]);
  assert.equal(s.snapshot(g).state.explicit_constraints.length, 0);
  assert.equal(s.snapshot(g).state.user_goal.text, 'original');
  const fresh = service();
  assert.equal(
    fresh.observeConversation(g, [
      { id: 'u1', role: 'user', content: transmitted },
    ]).skipped,
    'mediated-without-original',
  );
  assert.equal(fresh.data.contexts.length, 0);
  assert.match(fresh.snapshot(g).observationError, /original inequívoco/);
});
test('nueva edición de objetivo invalida propuestas de objetivo antiguas; descarte no confirma una respuesta', () => {
  const c = core();
  c.message('Continuemos');
  const missing = c.state.pending_questions[0];
  c.edit({ type: 'resolve', id: missing.id, accept: false });
  assert.equal(c.state.pending_questions[0].status, 'rejected');
  c.message('Mi objetivo: uno');
  c.message('Mi objetivo: dos');
  const q = c.state.pending_questions.at(-1);
  c.edit({ type: 'goal', text: 'Tres explícito' });
  assert.equal(
    c.state.pending_questions.find((x) => x.id === q.id).status,
    'rejected',
  );
  assert.throws(
    () => c.edit({ type: 'resolve', id: q.id, accept: true }),
    /ya no está abierta/,
  );
});
test('límite de reglas no poda activas, la referencia descartada permanece sólo en historia', () => {
  const c = core();
  for (let i = 0; i < 200; i++)
    c.edit({
      type: 'add',
      field: 'explicit_constraints',
      text: `Regla explícita número ${i}`,
    });
  const before = structuredClone(c.state);
  assert.throws(
    () =>
      c.edit({
        type: 'add',
        field: 'explicit_constraints',
        text: 'Otra regla',
      }),
    /No se descartarán reglas/,
  );
  assert.deepEqual(c.state, before);
  c.edit({ type: 'retire', id: c.state.explicit_constraints[0].id });
  assert.equal(c.state.explicit_constraints.length, 199);
  assert.equal(c.state.instruction_history[0].status, 'obsolete');
});
test('historial lleno no vuelve ilegible un contexto al expirar temporales: quedan obsoletas e inactivas', () => {
  const file = join(
      mkdtempSync(join(tmpdir(), 'uue-fullhistory-')),
      'state.json',
    ),
    g = guest();
  const s = service({ file, storage: fileStorage(file) });
  s.edit(g, {
    type: 'add',
    revision: 0,
    field: 'active_instructions',
    scope: 'session',
    text: 'Usa español',
  });
  const d = JSON.parse(readFileSync(file, 'utf8')),
    e = d.contexts[0].state.active_instructions[0];
  d.contexts[0].state.instruction_history = Array.from(
    { length: 400 },
    (_, i) => ({ ...e, id: `old-${i}`, status: 'obsolete' }),
  );
  writeFileSync(file, JSON.stringify(d));
  const restarted = service({ file, storage: fileStorage(file) }),
    r = restarted.snapshot(g);
  assert.equal(restarted.loadError, null);
  assert.equal(r.state.active_instructions[0].status, 'obsolete');
  assert.equal(r.effective.active_instructions.length, 0);
});
test('reglas, preferencias y aclaraciones no sustituyen la tarea por una instrucción incidental', () => {
  const c = core();
  c.message('Mi objetivo: continuidad');
  c.message('Preparar el informe de IPC');
  const task = structuredClone(c.state.current_task);
  c.message('No modifiques la funcionalidad');
  c.message('Usa español');
  c.message('Prefiero una lista breve');
  c.message('Aclaración: el informe se refiere al IPC del proceso principal');
  assert.deepEqual(c.state.current_task, task);
  assert.equal(
    c.state.relevant_context[0].text,
    'Aclaración: el informe se refiere al IPC del proceso principal',
  );
  c.message('Aclaración: No ejecutes código');
  assert.equal(c.state.explicit_constraints.at(-1).text, 'No ejecutes código');
  assert.deepEqual(c.state.current_task, task);
});

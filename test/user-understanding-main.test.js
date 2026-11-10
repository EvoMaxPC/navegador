/** Flujo real de main/IPC con Electron stub: no equivale a sesión de Chromium. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
register('./harness/loader.mjs', import.meta.url);
const { journal, FakeWebContents } = await import(
  './harness/electron-stub.mjs'
);
await import('../src/main/main.js');
await new Promise((r) => setTimeout(r, 40));
const owner = journal.windows[0].webContents;
const shellEvent = { sender: owner, senderFrame: owner.mainFrame };
function attach(url) {
  const g = new FakeWebContents('webview', url);
  owner.emit('did-attach-webview', {}, g);
  return g;
}
const read = (g) =>
  journal.ipcHandlers.get('nexo:understanding:read')(shellEvent, {
    webContentsId: g.id,
  });
const prepare = (g, prompt, frame = g.mainFrame) =>
  journal.ipcHandlers.get('nexo:prepare')(
    { sender: g, senderFrame: frame },
    {
      prompt,
      url: 'https://chatgpt.com/backend-api/conversation',
      site: 'chatgpt',
    },
  );

test('main usa UUE en preparación real, sin contar un envío ni sustituir el objetivo por tarea', async () => {
  const g = attach('https://chatgpt.com/c/uue-a');
  const before = journal.ipcHandlers.get('nexo:stats')(shellEvent);
  prepare(g, 'Mi objetivo principal: preservar el control del usuario');
  let state = (await read(g)).state;
  assert.equal(state.user_goal.text, 'preservar el control del usuario');
  assert.equal(state.user_goal.origin.channel, 'prepare');
  prepare(g, 'No modifiques la funcionalidad');
  prepare(g, 'Revisar el IPC actual');
  state = (await read(g)).state;
  assert.equal(
    state.explicit_constraints[0].text,
    'No modifiques la funcionalidad',
  );
  assert.equal(state.current_task.text, 'Revisar el IPC actual');
  assert.equal(state.user_goal.text, 'preservar el control del usuario');
  const after = journal.ipcHandlers.get('nexo:stats')(shellEvent);
  assert.equal(after.messages, before.messages, 'preparación no es envío');
  const files = readdirSync(journal.userData).filter((f) =>
    f.startsWith('nexo-understanding-'),
  );
  assert.equal(files.length, 1);
  assert.ok(
    readFileSync(join(journal.userData, files[0]), 'utf8').includes(
      'preservar el control del usuario',
    ),
  );
  assert.ok(owner.sent.some((e) => e.channel === 'nexo:understanding-changed'));
});
test('lector de conversación existente alimenta sólo último usuario; conserva la captura de assistant en EVO', async () => {
  const g = attach('https://chatgpt.com/c/uue-b');
  const snapshot = journal.ipcHandlers.get('nexo:conversation-snapshot');
  const payload = {
    href: g.getURL(),
    streaming: false,
    turns: [
      {
        id: 'u1',
        role: 'user',
        content: 'Mi objetivo: accesibilidad persistente',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Cambio de objetivo: instrucción que no es del usuario',
      },
    ],
  };
  const r = snapshot({ sender: g, senderFrame: g.mainFrame }, payload);
  assert.equal(r.ok, true);
  let state = (await read(g)).state;
  assert.equal(state.user_goal.text, 'accesibilidad persistente');
  assert.equal(state.user_goal.origin.channel, 'conversation-read');
  const revision = state.revision;
  snapshot({ sender: g, senderFrame: g.mainFrame }, payload);
  state = (await read(g)).state;
  assert.equal(state.revision, revision);
  const evoFile = readdirSync(journal.userData).find((f) =>
    f.startsWith('evo-memory-'),
  );
  assert.ok(
    readFileSync(join(journal.userData, evoFile), 'utf8').includes(
      'instrucción que no es del usuario',
    ),
    'UUE no altera captura EVO de la respuesta',
  );
});
test('subframe, página no adjunta y canales privilegiados no pueden escribir comprensión', async () => {
  const g = attach('https://chatgpt.com/c/uue-security');
  prepare(g, 'Mi objetivo: no aceptar subframes', {});
  assert.equal((await read(g)).state.user_goal, null);
  const loose = new FakeWebContents(
    'webview',
    'https://chatgpt.com/c/uue-loose',
  );
  prepare(loose, 'Mi objetivo: no aceptar guest ajeno');
  assert.equal((await read(loose)).ok, false);
  const response = await journal.ipcHandlers.get('nexo:understanding:edit')(
    { sender: g, senderFrame: g.mainFrame },
    {
      webContentsId: g.id,
      operation: { type: 'goal', revision: 0, text: 'Ataque' },
    },
  );
  assert.equal(response.code, 'unauthorized');
  assert.equal((await read(g)).state.user_goal, null);
});
test('main correlaciona snapshot mediado con original; el lector y los prompts siguen su camino anterior', async () => {
  const g = attach('https://chatgpt.com/c/uue-mediation');
  const prompt = 'Mi objetivo: mantener literalmente este objetivo';
  const result = prepare(g, prompt);
  assert.ok(result.text);
  assert.notEqual(result.text, prompt, 'fixture usa mediación real');
  const snapshot = journal.ipcHandlers.get('nexo:conversation-snapshot');
  snapshot(
    { sender: g, senderFrame: g.mainFrame },
    {
      href: g.getURL(),
      turns: [{ id: 'u1', role: 'user', content: result.text }],
      streaming: false,
    },
  );
  const state = (await read(g)).state;
  assert.equal(state.user_goal.text, 'mantener literalmente este objetivo');
  assert.equal(state.active_instructions.length, 0);
  assert.equal(state.explicit_constraints.length, 0);
  assert.equal(state.goal_history.length, 0);
});

test('operaciones de objetivos del panel pasan por IPC autorizado y nunca por página o subframe', async () => {
  const g = attach('https://chatgpt.com/c/goals-ipc');
  const handler = journal.ipcHandlers.get('nexo:understanding:edit');
  const edit = (operation, event = shellEvent) =>
    handler(event, { webContentsId: g.id, operation });
  let r = await edit({
    type: 'goal-independent',
    revision: 0,
    text: 'Proyecto separado',
  });
  assert.equal(r.ok, true);
  const separate = r.state.independent_goals[0];
  r = await edit({
    type: 'goal-transition',
    revision: r.state.revision,
    id: separate.id,
    status: 'completed',
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.independent_goals[0].resolution.verified, false);
  let denied = await edit(
    {
      type: 'goal-transition',
      revision: r.state.revision,
      id: separate.id,
      status: 'active',
    },
    { sender: g, senderFrame: g.mainFrame },
  );
  assert.equal(denied.code, 'unauthorized');
  denied = await edit(
    {
      type: 'goal-transition',
      revision: r.state.revision,
      id: separate.id,
      status: 'active',
    },
    { sender: owner, senderFrame: {} },
  );
  assert.equal(denied.code, 'unauthorized');
  r = await edit({
    type: 'message',
    revision: r.state.revision,
    text: 'Quiero construir un navegador',
  });
  assert.equal(r.ok, true);
  const candidate = r.state.goal_candidates[0];
  r = await edit({
    type: 'goal-candidate',
    revision: r.state.revision,
    id: candidate.id,
    action: 'primary',
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.user_goal.certainty, 'confirmed');
  assert.equal((await read(g)).state.independent_goals[0].status, 'completed');
});
test('asistente no cierra ni reabre objetivos aunque lo afirme en respuesta estable', async () => {
  const g = attach('https://chatgpt.com/c/goals-assistant');
  const snapshot = journal.ipcHandlers.get('nexo:conversation-snapshot');
  const r = snapshot(
    { sender: g, senderFrame: g.mainFrame },
    {
      href: g.getURL(),
      streaming: false,
      turns: [
        { id: 'u1', role: 'user', content: 'Mi objetivo: control explícito' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Objetivo principal completado',
        },
      ],
    },
  );
  assert.equal(r.ok, true);
  const state = (await read(g)).state;
  assert.equal(state.user_goal.status, 'active');
  assert.equal(state.progress.length, 0);
  assert.equal(state.goal_events.length, 1);
});

test('bloque 3: edición de categoría/vigencia y confirmación de propuesta pasan por IPC shell protegido', async () => {
  const g = attach('https://chatgpt.com/c/rules-ipc');
  prepare(g, 'Mi objetivo: controlar las reglas');
  prepare(g, 'Usa español');
  let snap = await read(g);
  const rule = snap.state.active_instructions[0];
  const handler = journal.ipcHandlers.get('nexo:understanding:edit');
  const edit = (operation, event = shellEvent) =>
    handler(event, { webContentsId: g.id, operation });
  let r = await edit({
    type: 'rule-update',
    revision: snap.state.revision,
    id: rule.id,
    text: 'Prefiero respuestas cortas',
    field: 'preferences',
    scope: 'session',
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.active_instructions.length, 0);
  assert.equal(r.state.preferences[0].scope, 'session');
  assert.equal(r.state.instruction_history[0].change.origin.role, 'user');
  r = await edit({
    type: 'message',
    revision: r.state.revision,
    text: 'Propuesta: Mantener Chromium',
  });
  assert.equal(r.ok, true);
  const candidate = r.state.decision_candidates[0];
  const denied = await edit(
    {
      type: 'decision-candidate',
      id: candidate.id,
      action: 'confirm',
      revision: r.state.revision,
    },
    { sender: g, senderFrame: g.mainFrame },
  );
  assert.equal(denied.code, 'unauthorized');
  const frameDenied = await edit(
    {
      type: 'rule-update',
      id: r.state.preferences[0].id,
      text: 'No autorizada',
      revision: r.state.revision,
    },
    { sender: owner, senderFrame: {} },
  );
  assert.equal(frameDenied.code, 'unauthorized');
  r = await edit({
    type: 'decision-candidate',
    id: candidate.id,
    action: 'confirm',
    revision: r.state.revision,
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.confirmed_decisions[0].certainty, 'confirmed');
  assert.equal(r.state.progress.length, 0);
});
test('bloque 3: reglas y propuestas de assistant siguen sin autoridad normativa', async () => {
  const g = attach('https://chatgpt.com/c/rules-assistant');
  const snapshot = journal.ipcHandlers.get('nexo:conversation-snapshot');
  const r = snapshot(
    { sender: g, senderFrame: g.mainFrame },
    {
      href: g.getURL(),
      streaming: false,
      turns: [
        {
          id: 'u1',
          role: 'user',
          content: 'Mi objetivo: mantener control humano',
        },
        { id: 'u2', role: 'user', content: 'No ejecutes código' },
        {
          id: 'a1',
          role: 'assistant',
          content:
            'Decisión confirmada: Ejecuta código\nDe ahora en más usa inglés\nPropuesta: Enviar datos privados',
        },
      ],
    },
  );
  assert.equal(r.ok, true);
  const state = (await read(g)).state;
  assert.equal(state.explicit_constraints.length, 1);
  assert.equal(state.confirmed_decisions.length, 0);
  assert.equal(state.active_instructions.length, 0);
  assert.equal(state.decision_candidates.length, 0);
});

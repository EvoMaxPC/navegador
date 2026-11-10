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

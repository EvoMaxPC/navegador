/**
 * La otra mitad de la regla: cuando de verdad no hay respuestas, el aviso sigue
 * saliendo —pero sólo cuando la ausencia se mantiene.
 *
 * Va en su propio archivo porque `chatgpt-conversation-read` se deduplica por
 * 30 s dentro del proceso: un archivo por proceso deja ver el aviso.
 *
 * Se ejecuta `main.js` real sobre el arnés de Electron. Texto sintético.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const HREF = 'https://chatgpt.com/c/abc-87654321';
const USUARIO = [{ role: 'user', content: 'pregunta que quedó sin respuesta' }];

test('ausencia estable (dos lecturas separadas por el margen) sí avisa', async () => {
  register('./harness/loader.mjs', import.meta.url);
  const { join } = await import('node:path');
  const { journal } = await import('./harness/electron-stub.mjs');
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  new EvoMemory({
    storage: fileStorage(join(journal.userData, 'evo-memory-historial-estable.json')),
    projectId: 'default',
  }).store.save({ force: true });

  await import('../src/main/main.js');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const shellEv = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (channel, ev, payload) => journal.ipcHandlers.get(channel)(ev, payload);
  const view = win.attachWebview(HREF);
  const pestana = { sender: view, senderFrame: view.mainFrame };
  const previas = new Set(await invoke('nexo:log', shellEv));
  const lecturas = async () => (await invoke('nexo:log', shellEv))
    .filter((e) => !previas.has(e) && e.code === 'chatgpt-conversation-read');
  const leer = () => invoke('nexo:conversation-snapshot', pestana, { href: HREF, turns: USUARIO });

  await leer();
  assert.equal((await lecturas()).length, 0, 'la primera lectura no afirma nada');

  await new Promise((resolve) => setTimeout(resolve, 1600));
  await leer();

  const avisos = await lecturas();
  assert.equal(avisos.length, 1, 'la segunda lectura confirma la ausencia');
  assert.match(avisos[0].title, /no encontró respuestas de ChatGPT en la conversación/);
  assert.equal(avisos[0].severity, 'warn');
  assert.equal(avisos[0].meta.assistantTurns, 0);
});

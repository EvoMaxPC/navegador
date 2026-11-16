/**
 * La otra mitad de la regla, en su propio archivo por la deduplicación de 30 s
 * de `chatgpt-conversation-read`: cuando la pestaña **no** tiene un envío
 * retenido, la ausencia estable sigue avisando igual que antes (7c-16c). Sin
 * esta prueba, «no avisar nunca» también pasaría la primera.
 *
 * Se ejecuta `main.js` real sobre el arnés de Electron. Texto sintético.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { register } from 'node:module';
import { test } from 'node:test';

const HREF = 'https://chatgpt.com/c/abc-sin-retencion-02';
const USUARIO = [
  { role: 'user', content: 'primera pregunta que sí viajó' },
  { role: 'user', content: 'segunda pregunta que también viajó' },
];

test('sin envío retenido, dos lecturas estables de 2 usuario/0 respuestas sí avisan', async () => {
  register('./harness/loader.mjs', import.meta.url);
  const { journal } = await import('./harness/electron-stub.mjs');
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  new EvoMemory({
    storage: fileStorage(join(journal.userData, 'evo-memory-sin-retencion.json')),
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
  const leer = () => invoke('nexo:conversation-snapshot', pestana, { href: HREF, turns: USUARIO, streaming: true });

  await leer();
  assert.equal((await lecturas()).length, 0, 'la primera lectura no afirma nada');

  await new Promise((resolve) => setTimeout(resolve, 1600));
  await leer();

  const avisos = await lecturas();
  assert.equal(avisos.length, 1, 'la segunda lectura confirma la ausencia');
  assert.equal(avisos[0].severity, 'warn');
  assert.equal(avisos[0].meta.assistantTurns, 0);
  assert.match(avisos[0].detail, /La generación sigue activa/);
  assert.equal(JSON.stringify(avisos).includes('pregunta'), false, 'sin el texto del chat');
});

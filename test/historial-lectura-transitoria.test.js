/**
 * «NEXO no encontró respuestas de ChatGPT» no puede decirse con una lectura
 * que aún se está pintando.
 *
 * Al cargar el historial, el DOM entrega primero los mensajes del usuario y
 * deja las respuestas para después. La lectura a medias (`2 usuario / 0
 * respuestas`) emitía el aviso, y su deduplicación de 30 s tapaba también la
 * lectura buena que llegaba un instante más tarde: el usuario veía «no
 * encontró respuestas» en una conversación llena de respuestas.
 *
 * Acá se comprueba la mitad que calla: mientras la ausencia no se repita en dos
 * lecturas separadas por el margen, no se afirma nada. La otra mitad —que sí
 * avisa cuando la ausencia es real y estable— va en su propio archivo, porque
 * el aviso se deduplica por 30 s y las dos no caben en el mismo proceso.
 *
 * Se ejecuta `main.js` real sobre el arnés de Electron. Texto sintético.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const HREF = 'https://chatgpt.com/c/abc-12345678';
const USUARIO = [{ role: 'user', content: 'primera pregunta' }, { role: 'user', content: 'segunda pregunta' }];
const CON_RESPUESTAS = [
  { role: 'user', content: 'primera pregunta' },
  { role: 'assistant', content: 'primera respuesta completa' },
  { role: 'user', content: 'segunda pregunta' },
  { role: 'assistant', content: 'segunda respuesta completa' },
];

async function mundo() {
  register('./harness/loader.mjs', import.meta.url);
  const { join } = await import('node:path');
  const { journal } = await import('./harness/electron-stub.mjs');
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  new EvoMemory({
    storage: fileStorage(join(journal.userData, 'evo-memory-historial-transitorio.json')),
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
  const leer = (turns) => invoke('nexo:conversation-snapshot', pestana, { href: HREF, turns });
  const falsos = async () => (await lecturas()).filter((e) => /no encontró respuestas/.test(e.title));
  return { leer, lecturas, falsos };
}

test('una lectura a medias (usuario>0, respuestas=0) no avisa', async () => {
  const { leer, falsos } = await mundo();

  await leer(USUARIO);
  assert.equal((await falsos()).length, 0, 'con el DOM a medias no se afirma la ausencia');
});

test('a medias y luego completa: la buena se anota y no queda ningún aviso falso', async () => {
  const { leer, lecturas, falsos } = await mundo();

  await leer(USUARIO);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await leer(CON_RESPUESTAS);

  assert.equal((await falsos()).length, 0, 'el aviso falso nunca llegó a salir');
  const avisos = await lecturas();
  assert.equal(avisos.length, 1, 'la lectura completa sí se anota');
  assert.match(avisos[0].title, /leyó la conversación/);
  assert.equal(avisos[0].severity, 'info');
});

test('dos lecturas a medias sin margen entre ellas tampoco avisan', async () => {
  const { leer, falsos } = await mundo();

  await leer(USUARIO);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await leer(USUARIO);

  assert.equal((await falsos()).length, 0, 'sin margen no se confirma nada');
});

test('un DOM sin turnos no es prueba de nada a la primera', async () => {
  const { leer, falsos } = await mundo();

  await leer([]);
  assert.equal((await falsos()).length, 0);
});

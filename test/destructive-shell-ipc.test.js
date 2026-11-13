/**
 * Canales destructivos: el emisor lo decide el proceso principal.
 *
 * `nexo:log:clear`, `nexo:profile:clear`, `nexo:data:clear` y
 * `nexo:session:save-now` borran o pisan datos del usuario. Estaban al alcance
 * de cualquier emisor con `ipcRenderer` —una pestaña inyectada también—, así que
 * la regla se comprueba contra el IPC real: la shell ejecuta y un emisor ajeno
 * recibe el mismo rechazo que el resto de la shell, con el estado intacto.
 *
 * Se compara el estado observable completo (registro, marcadores, historial,
 * sesión guardada y lo que la partición borró) antes y después de cada rechazo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal, session } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const SHELL_URL = 'nexo://app/src/ui/shell/index.html';
const SESION = `${journal.userData}/session.json`;

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** La shell tal como la ve el proceso principal. */
function shell() {
  const win = journal.windows[0];
  win.webContents.url = SHELL_URL;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

/**
 * Una pestaña que se declara con la URL de la shell, pero no pertenece a ninguna
 * ventana: `getAllWindows()` no la incluye y `webContents.getURL()` miente.
 */
function impostora() {
  const win = journal.windows[0];
  const view = win.attachWebview(SHELL_URL);
  return { sender: view, senderFrame: view.mainFrame };
}

const invoke = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);
const send = (channel, event, payload) => journal.ipcListeners.get(channel)(event, payload);
const copia = (value) => JSON.parse(JSON.stringify(value));

/** Estado observable que estos cuatro canales pueden tocar. */
async function estado() {
  return {
    log: (await invoke('nexo:log')).map((entry) => `${entry.code}|${entry.detail || entry.title}`),
    bookmarks: (await invoke('nexo:bookmarks:list', {}, {})).map((item) => item.url),
    history: (await invoke('nexo:history:list', {}, { limit: 100 })).length,
    sessionSavedAt: (await invoke('nexo:profile:stats'))?.sessionSavedAt ?? null,
    sesionEnDisco: existsSync(SESION) ? readFileSync(SESION, 'utf8') : null,
    // Lo que la partición borró: el stub registra cada `clearStorageData`/`clearCache`.
    datosBorrados: session.fromPartition('persist:nexo').cleared.length,
  };
}

await settle();

test('(a) la shell limpia el registro y (b) un emisor ajeno no puede', async () => {
  // El arranque deja sus propias entradas de diagnóstico: se cuenta desde ahí y
  // se siembra una más por la vía que existe, un fallo de la capa en una pestaña.
  const previas = (await invoke('nexo:log')).length;
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/registro');
  send('nexo:event', { sender: view, senderFrame: view.mainFrame }, {
    type: 'error',
    payload: { stage: 'siembra', message: 'entrada de prueba' },
    href: 'https://chatgpt.com/c/registro',
  });

  const sembrado = await invoke('nexo:log');
  assert.ok(sembrado.length > previas, 'el registro creció con la entrada sembrada');
  assert.ok(sembrado.some((entry) => entry.code === 'page-error'), 'y la entrada es la del fallo sembrado');

  const antes = await estado();
  const rechazo = await invoke('nexo:log:clear', impostora());
  assert.deepEqual(rechazo, { ok: false, error: 'No autorizado.' }, 'mismo rechazo que el resto de la shell');
  assert.deepEqual(await estado(), antes, 'un emisor ajeno no vació el registro');

  assert.deepEqual(await invoke('nexo:log:clear', shell()), [], 'la shell vacía y recibe la lista vacía');
  assert.deepEqual((await estado()).log, [], 'y el registro queda vacío en disco');
});

test('(a) la shell borra el perfil según el alcance y (b) un emisor ajeno no puede', async () => {
  await invoke('nexo:bookmarks:toggle', {}, { url: 'https://claude.ai/chat/borrar', title: 'Para borrar' });
  await invoke('nexo:zoom:set', {}, { target: { host: 'claude.ai' }, level: 1.25 });

  const antes = await estado();
  assert.ok(antes.bookmarks.includes('https://claude.ai/chat/borrar'), 'hay un marcador que borrar');

  const rechazo = await invoke('nexo:profile:clear', impostora(), { bookmarks: true, zoom: true, history: true, session: true });
  assert.deepEqual(rechazo, { ok: false, error: 'No autorizado.' }, 'mismo rechazo que el resto de la shell');
  assert.deepEqual(await estado(), antes, 'un emisor ajeno no borró ni un marcador');

  const borrado = await invoke('nexo:profile:clear', shell(), { bookmarks: true, zoom: true });
  assert.equal(borrado.bookmarks.removed, 1, 'la shell borra el marcador');
  const despues = await estado();
  assert.deepEqual(despues.bookmarks, [], 'y no queda ninguno');
  assert.equal(despues.history, antes.history, 'el alcance se respeta: el historial no se tocó');
});

test('(a) la shell borra los datos del sitio y (b) un emisor ajeno no puede', async () => {
  const antes = await estado();
  const rechazo = await invoke('nexo:data:clear', impostora(), { cookies: true, cache: true });
  assert.deepEqual(rechazo, { ok: false, error: 'No autorizado.' }, 'mismo rechazo que el resto de la shell');
  assert.deepEqual(await estado(), antes, 'un emisor ajeno no borró cookies ni caché');

  const hecho = await invoke('nexo:data:clear', shell(), { cookies: true, cache: true });
  assert.deepEqual(hecho, { ok: true, cookies: true, cache: true }, 'la shell borra y recibe el parte');
  assert.equal((await estado()).datosBorrados, antes.datosBorrados + 2, 'almacenamiento y caché, una vez cada uno');
});

test('(a) la shell guarda la sesión al cerrar y (b) un emisor ajeno no puede', async () => {
  const antes = await estado();

  // Sin respuesta posible: el canal es `ipcMain.on`. El rechazo es un retorno
  // temprano que no escribe nada, ni siquiera el archivo de la sesión.
  const devuelto = send('nexo:session:save-now', impostora(), { windows: [{ tabs: [{ url: 'https://chatgpt.com/c/ajena' }], activeIndex: 0 }] });
  assert.equal(devuelto, undefined, 'no hay respuesta: no se ejecutó la captura');
  assert.deepEqual(await estado(), antes, 'un emisor ajeno no guardó la sesión');

  send('nexo:session:save-now', shell(), { windows: [{ tabs: [{ url: 'https://chatgpt.com/c/de-la-shell' }], activeIndex: 0 }] });
  const despues = await estado();
  assert.notEqual(despues.sesionEnDisco, antes.sesionEnDisco, 'la shell sí escribió la sesión');
  assert.deepEqual(copia(JSON.parse(despues.sesionEnDisco).windows[0].tabs[0].url), 'https://chatgpt.com/c/de-la-shell');
  assert.equal(basename(SESION), 'session.json', 'el archivo que cambió es el de la sesión');
});

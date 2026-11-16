/**
 * Ajustes: el emisor lo decide el proceso principal, no el preload.
 *
 * `nexo:settings:set` y `nexo:settings:reset` cambian el perfil de una vez. Hasta
 * ahora los tomaba cualquier emisor con acceso a `ipcRenderer` —una pestaña
 * inyectada también—, así que la regla se comprueba acá contra el IPC real.
 *
 * El emisor autorizado se arma como lo entrega Electron: la ventana dueña, su
 * marco principal y la URL de la shell. Cualquier otra combinación se rechaza
 * sin escribir nada; el «antes y después» se compara entero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const SHELL_URL = 'nexo://app/src/ui/shell/index.html';

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** La shell tal como la ve el proceso principal. */
function shell() {
  const win = journal.windows[0];
  win.webContents.url = SHELL_URL;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

const invoke = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);
const importados = await import('../src/core/egressConfig.js');

/** Copia profunda: lo que está en disco no comparte referencias con el perfil. */
const copia = (value) => JSON.parse(JSON.stringify(value));
const ajustes = async () => copia(await invoke('nexo:settings:get', {}, undefined));

await settle();

test('(a) la shell guarda: el ajuste queda escrito y confirmado', async () => {
  const antes = await ajustes();
  const next = await invoke('nexo:settings:set', shell(), { enabled: false });

  assert.equal(next.enabled, false, 'devuelve los ajustes guardados');
  assert.equal((await ajustes()).enabled, false, 'y quedan en el perfil');
  assert.equal(antes.enabled, true, 'el punto de partida era el de fábrica');

  await invoke('nexo:settings:set', shell(), { enabled: true });
});

test('(b) un emisor ajeno se rechaza y el perfil queda intacto', async () => {
  const event = shell();
  await invoke('nexo:settings:set', event, { enabled: true, uiLocale: 'es' });
  const antes = await ajustes();

  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/ajenos');
  view.navigateTo('https://chatgpt.com/c/ajenos', 'ChatGPT');
  const ajenos = [
    ['pestaña del proveedor', { sender: view, senderFrame: view.mainFrame }],
    ['shell sin marco principal', { sender: event.sender }],
    ['shell desde un subframe', { sender: event.sender, senderFrame: {} }],
  ];

  for (const [nombre, emisor] of ajenos) {
    const rechazo = await invoke('nexo:settings:set', emisor, { enabled: false, uiLocale: 'en' });
    assert.deepEqual(rechazo, { ok: false, error: 'No autorizado.' }, `${nombre}: mismo rechazo que el resto de la shell`);
    assert.deepEqual(await ajustes(), antes, `${nombre}: no cambió un solo ajuste`);
  }

  // Un emisor que ni siquiera es un webContents de Electron no llega al rechazo:
  // `isShellRequest` lanza al leer `getURL`. Es idéntico en los demás handlers de
  // la shell (`nexo:prompts:*`, `nexo:storage:status`), así que se comprueba que
  // este canal se comporta igual y, sobre todo, que no guarda nada.
  assert.throws(
    () => invoke('nexo:settings:set', { sender: { id: 1 } }, { enabled: false }),
    /getURL is not a function/,
    'mismo fallo que el resto de los handlers de la shell',
  );
  assert.throws(() => invoke('nexo:prompts:save', { sender: { id: 1 } }, {}), /getURL is not a function/);
  assert.deepEqual(await ajustes(), antes, 'tampoco desde un emisor sin identidad');
});

test('(b) restablecer también exige la shell y deja el perfil intacto', async () => {
  const event = shell();
  await invoke('nexo:settings:set', event, { enabled: false });
  const antes = await ajustes();

  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/reset-ajeno');
  const rechazo = await invoke('nexo:settings:reset', { sender: view, senderFrame: view.mainFrame });
  assert.deepEqual(rechazo, { ok: false, error: 'No autorizado.' });
  assert.deepEqual(await ajustes(), antes, 'un emisor ajeno no pudo restablecer el perfil');

  // Desde la shell sí: reemplaza y vuelve al valor de fábrica.
  assert.equal((await invoke('nexo:settings:reset', event)).enabled, true);
});

test('(c) un egress inválido enviado por la shell se guarda crudo; se normaliza al leerlo', async () => {
  const event = shell();
  const crudo = { mode: 'a-ver', decisionTimeoutMs: 1, onUnreadable: 'quizá' };

  const next = await invoke('nexo:settings:set', event, { egress: crudo });
  assert.equal(next.egress.mode, 'a-ver', 'guardar no valida el modo');
  assert.equal(next.egress.onUnreadable, 'quizá', 'ni el valor de lectura ilegible');
  assert.equal(next.egress.decisionTimeoutMs, 1, 'ni el plazo');

  // Los lectores normalizan: `settingsForHost` lo entrega por host y `configFor`
  // es lo que recibe la capa. El valor efectivo nunca es el crudo.
  const { normalizeEgress } = importados;
  const config = await invoke('nexo:config', {}, { host: 'chatgpt.com' });
  assert.deepEqual(normalizeEgress(config.settings.egress), {
    mode: 'off',
    onUnreadable: 'pass',
    // El plazo se recorta al mínimo declarado (5 000), no al valor de fábrica.
    decisionTimeoutMs: 5000,
    allowSendCritical: false,
  }, 'egress efectivo');

  await invoke('nexo:settings:set', event, { egress: { ...importados.EGRESS_DEFAULTS } });
  assert.deepEqual((await ajustes()).egress, { ...importados.EGRESS_DEFAULTS }, 'y vuelve al valor de fábrica');
});

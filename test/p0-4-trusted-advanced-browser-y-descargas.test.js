/**
 * P0-4c · `trusted` sin emisor y las descargas de la shell.
 *
 * Dos cosas, contra el proceso principal real:
 *
 *  1. `trusted` (advancedBrowser.js:48-54) desreferenciaba `event.sender` sin
 *     comprobarlo: un evento sin emisor —o con un `webContents` ya destruido—
 *     lanzaba antes de llegar a la comparación. Ahora se rechaza con el mismo
 *     `false` que ya recibía un emisor ajeno, y un `sender` válido sigue
 *     pasando.
 *  2. `nexo:downloads:cancel|clear|show` exigen `isShellRequest` (main.js:1310):
 *     la shell recibe el valor de éxito del canal y un emisor ajeno recibe su
 *     rechazo existente, que se indica literal en cada prueba.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
await settle();

const win = journal.windows[0];
const shell = win.webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';

/** La shell: emisor válido con su marco principal. */
const evShell = () => ({ sender: shell, senderFrame: shell.mainFrame });
/** Un emisor ajeno: el webview de otra pestaña. */
const evAjeno = (url = 'https://ejemplo.com/pagina') => {
  const view = win.attachWebview(url);
  return { sender: view, senderFrame: view.mainFrame };
};

const llamar = (canal, event, payload) => {
  const handler = journal.ipcHandlers.get(canal);
  assert.equal(typeof handler, 'function', `la aplicación registra ${canal}`);
  return handler(event, payload);
};

/* ---------------- 1. trusted: emisor nulo y emisor destruido ---------------- */

test('trusted rechaza un evento sin emisor y no lanza', async () => {
  for (const canal of ['nexo:advanced:prefs', 'nexo:advanced:set-prefs', 'nexo:advanced:action', 'nexo:advanced:context']) {
    const conEventoVacio = await llamar(canal, {}, {});
    assert.notEqual(conEventoVacio?.ok, true, `${canal}: un evento sin emisor no autoriza`);
    const sinEvento = await llamar(canal, undefined, {});
    assert.notEqual(sinEvento?.ok, true, `${canal}: sin evento tampoco`);
  }

  // El canal de lectura devuelve las preferencias por omisión, no las de nadie:
  // `trusted` falso ⇒ el `else` de main-boot.js:34 (respuesta neutra), no un throw.
  const prefs = await llamar('nexo:advanced:prefs', { sender: null }, {});
  assert.equal(prefs?.ok, undefined, 'una lectura sin emisor no trae el objeto de éxito');
});

/**
 * Un webContents destruido de verdad: `isDestroyed()` pasa a `true` y sus demás
 * métodos lanzan. Es el contrato de Electron —«Once a window is destroyed,
 * accessing most of its other properties and methods throws `Object has been
 * destroyed`», electron.d.ts:3366-3374; para WebContents, `isDestroyed()` en
 * :19276-19280— y el patrón que el propio proceso principal ya usa
 * (main.js:2750, advancedBrowser.js:57). Sin los métodos que lanzan, una prueba
 * con `isDestroyed()` devolviendo `true` no distinguiría la guarda de antes.
 */
function emisorDestruido() {
  const muerto = win.attachWebview('https://ejemplo.com/destruido');
  muerto.destroyed = true;
  const lanzar = () => { throw new Error('Object has been destroyed'); };
  muerto.isDestroyed = () => true;
  muerto.getURL = lanzar;
  muerto.mainFrame = { url: 'https://ejemplo.com/destruido' };
  return muerto;
}

test('trusted rechaza un emisor destruido', async () => {
  const muerto = emisorDestruido();

  const resultado = await llamar('nexo:advanced:set-prefs', { sender: muerto, senderFrame: muerto.mainFrame }, {});
  assert.deepEqual(resultado, { ok: false, error: 'Remitente no autorizado' },
    'mismo rechazo que un emisor ajeno, sin excepción');

  // Y el canal de lectura no intenta leer la sesión del emisor muerto.
  assert.equal(await llamar('nexo:advanced:prefs', { sender: muerto, senderFrame: muerto.mainFrame }, {}), null,
    'la lectura devuelve null, como con cualquier emisor no autorizado');
});

test('trusted acepta un emisor válido: la shell sigue operando', async () => {
  const prefs = await llamar('nexo:advanced:prefs', evShell(), {});
  assert.equal(typeof prefs, 'object');
  assert.ok(prefs, 'la shell recibe sus preferencias');

  const guardado = await llamar('nexo:advanced:set-prefs', evShell(), { ...prefs, rightMenuMode: 'auto', uiZoom: 1 });
  assert.equal(guardado.ok, true, 'y puede guardarlas');
});

/* ---------------- 2. descargas: shell funciona, emisor ajeno recibe su rechazo ---------------- */

test('nexo:downloads:show: la shell recibe {ok:true}; un emisor ajeno, {ok:false}', async () => {
  const item = new EventEmitter();
  item.getURL = () => 'https://ejemplo.com/informe.pdf';
  item.getFilename = () => 'informe.pdf';
  item.getTotalBytes = () => 2048;
  item.getReceivedBytes = () => 2048;
  item.getSavePath = () => '/descargas/informe.pdf';
  item.cancel = () => {};
  const sesion = journal.sessions.get('persist:nexo');
  sesion.emit('will-download', {}, item);
  item.emit('done', {}, 'completed');

  const lista = await llamar('nexo:downloads:list', evShell());
  const entrada = lista.find((e) => e.filename === 'informe.pdf');
  assert.ok(entrada, 'la descarga aparece en el gestor');

  assert.deepEqual(await llamar('nexo:downloads:show', evShell(), entrada.id), { ok: true },
    'la shell sí puede mostrarla');
  const ajeno = await llamar('nexo:downloads:show', evAjeno(), entrada.id);
  assert.deepEqual(ajeno, { ok: false }, 'el rechazo existente de isShellRequest (main.js:2181)');
});

test('nexo:downloads:cancel: la shell recibe {ok:true}; un emisor ajeno, {ok:false}', async () => {
  const cancelada = [];
  const item = new EventEmitter();
  item.getURL = () => 'https://ejemplo.com/lento.bin';
  item.getFilename = () => 'lento.bin';
  item.getTotalBytes = () => 4096;
  item.getReceivedBytes = () => 10;
  item.getSavePath = () => '/descargas/lento.bin';
  item.cancel = () => { cancelada.push(true); };
  const sesion = journal.sessions.get('persist:nexo');
  sesion.emit('will-download', {}, item);
  item.emit('updated', {}, 'progressing');

  const lista = await llamar('nexo:downloads:list', evShell());
  const entrada = lista.find((e) => e.filename === 'lento.bin');
  assert.ok(entrada, 'la descarga aparece en el gestor');

  const ajeno = await llamar('nexo:downloads:cancel', evAjeno(), entrada.id);
  assert.deepEqual(ajeno, { ok: false }, 'el rechazo existente de isShellRequest (main.js:2188)');
  assert.deepEqual(cancelada, [], 'y no cancela nada');

  assert.deepEqual(await llamar('nexo:downloads:cancel', evShell(), entrada.id), { ok: true },
    'la shell sí puede cancelarla');
  assert.deepEqual(cancelada, [true], 'y la cancelación llegó al elemento real');
});

test('nexo:downloads:clear: la shell recibe {removed}; un emisor ajeno, {removed:0}', async () => {
  const ajeno = await llamar('nexo:downloads:clear', evAjeno());
  assert.deepEqual(ajeno, { removed: 0 }, 'el rechazo existente de isShellRequest (main.js:2195)');

  const limpio = await llamar('nexo:downloads:clear', evShell());
  assert.equal(typeof limpio, 'object');
  assert.equal(typeof limpio.removed, 'number', 'la shell recibe el recuento del gestor');
});

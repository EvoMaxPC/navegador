/**
 * El alcance de los canales de página lo decide el emisor.
 *
 * `nexo:config`, `nexo:config-sync` y `nexo:stream-end` tomaban el host de un
 * campo del payload: una pestaña en cualquier sitio podía pedir la configuración
 * de otro proveedor o mover sus contadores declarando su host. Acá se comprueba,
 * contra el IPC real, que el host atendido es el del emisor y que un pedido ajeno
 * recibe el mismo neutro que ya recibe un host sin perfil.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
await settle();

/** Una pestaña real del arnés: emisor con `getURL`, como en producción. */
function pestana(url) {
  const view = journal.windows[0].attachWebview(url);
  view.navigateTo(url, 'Pestaña');
  return { sender: view, senderFrame: view.mainFrame };
}

const NEUTRO = { site: 'generic', profiled: false, enabled: true };

const config = (event, host) => journal.ipcHandlers.get('nexo:config')(event, { host });

/** `nexo:config-sync` es `sendSync`: el propio evento lleva el `returnValue`. */
function configSync(event, host) {
  journal.ipcListeners.get('nexo:config-sync')(event, { host });
  return event.returnValue;
}

const streamEnd = (event, payload) => journal.ipcHandlers.get('nexo:stream-end')(event, payload);
const stats = () => journal.ipcHandlers.get('nexo:stats')({ sender: { id: 1 } });

const cierre = (host, text = 'Respuesta con texto suficiente.') => ({
  host, site: host === 'chatgpt.com' ? 'chatgpt' : 'claude',
  messageId: `alcance-${host}`, text, chars: text.length, tokens: 5, finished: true,
});

/* ---------------- nexo:config ---------------- */

test('nexo:config: un emisor del proveedor recibe la configuración de su host', async () => {
  const configuracion = await config(pestana('https://chatgpt.com/c/alcance'), 'chatgpt.com');
  assert.equal(configuracion.site, 'chatgpt', 'el host del emisor tiene perfil');
  assert.equal(configuracion.profiled, true);
});

test('nexo:config: una pestaña ajena que pide un proveedor recibe el neutro', async () => {
  const emisor = pestana('https://ejemplo.com/pagina');
  const antes = stats();
  const configuracion = await config(emisor, 'chatgpt.com');
  assert.equal(configuracion.site, NEUTRO.site, 'no se entrega el perfil pedido');
  assert.equal(configuracion.profiled, NEUTRO.profiled);
  assert.equal(configuracion.enabled, NEUTRO.enabled, 'la mediación global no cambia');
  assert.deepEqual(stats(), antes, 'leer la configuración no mueve ningún contador');
});

test('nexo:config: el host del payload distinto del emisor da el neutro', async () => {
  const configuracion = await config(pestana('https://chatgpt.com/c/alcance'), 'claude.ai');
  assert.equal(configuracion.site, NEUTRO.site, 'el emisor no reclama el host de otra pestaña');
  assert.equal(configuracion.profiled, NEUTRO.profiled);
});

test('nexo:config: sin emisor identificable, neutro', async () => {
  const configuracion = await config({}, 'chatgpt.com');
  assert.equal(configuracion.site, NEUTRO.site);
  assert.equal(configuracion.profiled, NEUTRO.profiled);
});

test('nexo:config: un host sin perfil no recibe la configuración por sitio de ese host', async () => {
  // La diferencia entre «sin perfil» y «con perfil» se ve en el ajuste por
  // sitio: si el emisor sin perfil se atendiera por su propio host, leería el
  // interruptor que el usuario dejó para ese sitio.
  const ventana = journal.windows[0];
  ventana.webContents.url = 'nexo://app/src/ui/shell/index.html';
  const shell = { sender: ventana.webContents, senderFrame: ventana.webContents.mainFrame };
  await journal.ipcHandlers.get('nexo:settings:set')(shell, { sites: { 'ejemplo.com': { enabled: false } } });

  const emisor = pestana('https://ejemplo.com/pagina');
  const ajena = await config(emisor, 'ejemplo.com');
  assert.equal(ajena.site, NEUTRO.site, 'sin perfil');
  assert.equal(ajena.enabled, true, 'no se aplica el interruptor de un host sin perfil');

  await journal.ipcHandlers.get('nexo:settings:reset')(shell);
});

/* ---------------- nexo:config-sync ---------------- */

test('nexo:config-sync: un emisor del proveedor recibe la configuración de su host', async () => {
  const configuracion = configSync(pestana('https://chatgpt.com/c/alcance'), 'chatgpt.com');
  assert.equal(configuracion.site, 'chatgpt');
  assert.equal(configuracion.profiled, true);
});

test('nexo:config-sync: una pestaña ajena que pide un proveedor recibe el neutro', async () => {
  const configuracion = configSync(pestana('https://ejemplo.com/pagina'), 'chatgpt.com');
  assert.equal(configuracion.site, NEUTRO.site);
  assert.equal(configuracion.profiled, NEUTRO.profiled);
  assert.equal(configuracion.enabled, NEUTRO.enabled);
});

test('nexo:config-sync: el host del payload distinto del emisor da el neutro', async () => {
  const configuracion = configSync(pestana('https://chatgpt.com/c/alcance'), 'claude.ai');
  assert.equal(configuracion.site, NEUTRO.site);
  assert.equal(configuracion.profiled, NEUTRO.profiled);
});

test('nexo:config-sync: sin emisor identificable, neutro y siempre responde', async () => {
  const receptor = { returnValue: 'sin-tocar' };
  journal.ipcListeners.get('nexo:config-sync')(receptor, { host: 'chatgpt.com' });
  assert.ok(receptor.returnValue && typeof receptor.returnValue === 'object', 'no se queda sin returnValue');
  assert.equal(receptor.returnValue.site, NEUTRO.site);
  assert.equal(receptor.returnValue.profiled, NEUTRO.profiled);
});

/* ---------------- nexo:stream-end ---------------- */

test('nexo:stream-end: un emisor del proveedor cierra el turno como siempre', async () => {
  const event = pestana('https://chatgpt.com/c/alcance');
  const antes = stats();
  const resultado = await streamEnd(event, cierre('chatgpt.com', 'Respuesta contada por el emisor propio.'));
  assert.notEqual(resultado?.skipped, 'otro-proveedor', 'no se descarta el cierre propio');
  const despues = stats();
  assert.equal(despues.responses, antes.responses + 1, 'la respuesta se cuenta');
});

test('nexo:stream-end: una pestaña ajena no cuenta ni registra el cierre', async () => {
  const emisor = pestana('https://ejemplo.com/pagina');
  const antes = stats();
  const resultado = await streamEnd(emisor, cierre('chatgpt.com'));
  assert.deepEqual(resultado, { skipped: 'otro-proveedor' }, 'mismo neutro que un host sin perfil');
  assert.deepEqual(stats(), antes, 'sin contar, sin tokens y sin registro');
});

test('nexo:stream-end: el host del payload distinto del emisor no cuenta', async () => {
  const emisor = pestana('https://chatgpt.com/c/alcance');
  const antes = stats();
  const resultado = await streamEnd(emisor, cierre('claude.ai'));
  assert.deepEqual(resultado, { skipped: 'otro-proveedor' });
  assert.deepEqual(stats(), antes, 'un emisor no mueve los contadores de otro proveedor');
});

test('nexo:stream-end: sin emisor identificable no cuenta', async () => {
  const antes = stats();
  const resultado = await streamEnd({}, cierre('chatgpt.com'));
  assert.deepEqual(resultado, { skipped: 'otro-proveedor' });
  assert.deepEqual(stats(), antes);
});

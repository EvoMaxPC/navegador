/**
 * 7c-6, tarea 3: el orden entre el rechazo por subframe y el cambio de href en
 * `nexo:repetition:snapshot`.
 *
 * El comportamiento ACTUAL se fija tal cual está: el rechazo por «otro-frame»
 * se evalúa ANTES de guardar el snapshot de la pestaña. Qué implica:
 *
 *  - una lectura de un subframe no reemplaza la vista buena de la pestaña, así
 *    que un `href-cambio` posterior se sigue midiendo contra la última lectura
 *    del marco principal y no contra la del subframe;
 *  - a la inversa, un `href` distinto en el propio marco principal sí descarta
 *    antes de guardar: el snapshot no se reemplaza cuando la URL no coincide.
 *
 * Este test no arregla nada: describe lo que hay. Si alguien reordena esas
 * comprobaciones, aquí se ve.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// `diagOn` se decide al arrancar `main.js`: la variable tiene que estar puesta
// antes de importarlo, no después.
process.env.NEXO_DIAG = '1';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((resolve) => setTimeout(resolve, 60));

const win = journal.windows[0];
const shell = win.webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const shellEv = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (channel, ev, payload) => {
  const handler = journal.ipcHandlers.get(channel);
  assert.equal(typeof handler, 'function', `la aplicación registra ${channel}`);
  return handler(ev, payload);
};

const turn = (id, role, content) => ({ id, role, content });
const mainFrame = (view) => ({ sender: view, senderFrame: view.mainFrame });
/** Un subframe: mismo `webContents`, `senderFrame` distinto del principal. */
const subFrame = (view) => ({ sender: view, senderFrame: { url: 'https://chatgpt.com/embed' } });

const avisos = async () => (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'diag-snapshot');
/** El último `diag-snapshot` se publica al final de cada lectura aceptada. */
const ultimo = async () => (await avisos())[0];

const HREF_A = 'https://chatgpt.com/c/orden-a';
const HREF_B = 'https://chatgpt.com/c/orden-b';

test('el rechazo por subframe ocurre antes de guardar la vista de la pestaña', async () => {
  const view = win.attachWebview(HREF_A);
  await invoke('nexo:dom-tokens:snapshot', shellEv, { webContentsId: view.id, href: view.getURL() }); // fija la shell
  const turns = [turn('u1', 'user', 'texto del marco principal')];

  // 1) lectura buena del marco principal
  assert.equal(invoke('nexo:repetition:snapshot', mainFrame(view), { href: HREF_A, turns, strategy: 'print-label' }).ok, true);
  const buena = await ultimo();
  assert.equal(buena.meta.hrefCambio, null, 'la primera lectura no tiene previa');
  assert.match(buena.detail, /href \/c\/orden-a/, 'el aviso publica la ruta, no la URL');
  assert.ok(!JSON.stringify(buena).includes('https://'), 'ni el origen');

  // 2) una lectura desde un SUBFRAME: se rechaza y no reemplaza la buena
  const rechazada = invoke('nexo:repetition:snapshot', subFrame(view), { href: HREF_A, turns, strategy: 'print-label' });
  assert.equal(rechazada.ok, false, 'el subframe no puede publicar la conversación');
  const trasSubframe = await ultimo();
  assert.equal(trasSubframe.meta.motivo, 'otro-frame', 'el rechazo se registra con su motivo');

  // 3) la lectura siguiente del marco principal se compara con la ÚLTIMA BUENA,
  //    no con la del subframe: mismo href ⇒ sin cambio. Esa es la consecuencia
  //    del orden actual (el rechazo va antes del guardado).
  assert.equal(invoke('nexo:repetition:snapshot', mainFrame(view), { href: HREF_A, turns, strategy: 'print-label' }).ok, true);
  assert.equal((await ultimo()).meta.hrefCambio, false, 'el subframe no dejó una «previa» distinta');

  // 4) navegar de verdad es lo único que cambia la previa… y lo hace borrándola:
  //    `did-start-navigation` limpia el snapshot de la pestaña (main.js:674,
  //    `clearRepetition`), así que la lectura siguiente sale «sin-previa».
  view.navigateTo(HREF_B);
  assert.equal(invoke('nexo:repetition:snapshot', mainFrame(view), { href: view.getURL(), turns, strategy: 'print-label' }).ok, true);
  assert.equal((await ultimo()).meta.hrefCambio, null, 'tras navegar no hay previa con la que comparar');
  assert.match((await ultimo()).detail, /href-cambio sin-previa/);

  // 5) y la lectura siguiente ya compara contra la nueva: mismo href, sin cambio.
  assert.equal(invoke('nexo:repetition:snapshot', mainFrame(view), { href: view.getURL(), turns, strategy: 'print-label' }).ok, true);
  assert.equal((await ultimo()).meta.hrefCambio, false);
});

test('un href distinto en el marco principal se rechaza antes de guardar', async () => {
  const view = win.attachWebview(HREF_A);
  const turns = [turn('u1', 'user', 'otro texto')];
  invoke('nexo:repetition:snapshot', mainFrame(view), { href: HREF_A, turns, strategy: 'print-label' });
  const previa = await ultimo();

  // El payload anuncia una URL que no es la del remitente: rechazo, sin guardar.
  const r = invoke('nexo:repetition:snapshot', mainFrame(view), { href: HREF_B, turns, strategy: 'print-label' });
  assert.equal(r.ok, false);
  assert.equal((await ultimo()).meta.motivo, 'href-distinto');

  // La previa sigue siendo la de HREF_A: la lectura buena siguiente no ve cambio.
  invoke('nexo:repetition:snapshot', mainFrame(view), { href: HREF_A, turns, strategy: 'print-label' });
  assert.equal((await ultimo()).meta.hrefCambio, false, 'la lectura rechazada no reemplazó la previa');
  assert.equal(previa.meta.hrefCambio, null);
});

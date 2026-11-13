/**
 * Un envío retenido tiene que verse.
 *
 * El proceso principal dejaba el aviso de bloqueo en el registro, pero lo
 * deduplicaba por 30 s: dos bloqueos seguidos del mismo host producían una sola
 * entrada. Y la shell no mostraba nada fuera del panel de Actividad.
 *
 * Acá se comprueban las dos mitades: la deduplicación (que sigue igual para
 * `egress-injected-redact`) y la shell (punto en la pestaña y franja visible),
 * ejecutando el código real de `app.js` en un `vm` con el DOM mínimo que
 * necesitan esas funciones.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

import { EGRESS_DEFAULTS } from '../src/core/egressConfig.js';

const TARJETA = 'La tarjeta de crédito del usuario es 4111 1111 1111 1111';

/* ------------------------------------------------------------------ */
/* proceso principal: deduplicación                                    */
/* ------------------------------------------------------------------ */

async function mundo() {
  const { register } = await import('node:module');
  const { join } = await import('node:path');
  register('./harness/loader.mjs', import.meta.url);
  const { journal } = await import('./harness/electron-stub.mjs');
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');

  const mem = new EvoMemory({ storage: fileStorage(join(journal.userData, 'evo-memory-default.json')), projectId: 'default' });
  mem.store.add({ kind: 'fact', text: TARJETA, projectId: 'default' });
  mem.store.save({ force: true });

  const { Engine } = await import('../src/main/engine.js');
  await import('../src/main/main.js');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const shellEv = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (channel, ev, payload) => journal.ipcHandlers.get(channel)(ev, payload);
  const view = win.attachWebview('https://chatgpt.com/c/7c2b');
  const pestana = { sender: view, senderFrame: view.mainFrame };

  await invoke('nexo:settings:set', shellEv, {
    egress: { ...EGRESS_DEFAULTS, mode: 'enforce' },
    context: { enabled: true },
    memory: { enabled: true },
    protocol: { level: 'equilibrado' },
  });

  return { journal, invoke, shellEv, pestana, view, win, Engine };
}

test('1) dos bloqueos de red seguidos del mismo host dejan dos entradas; dos redacciones dejan una', async () => {
  const { journal, invoke, shellEv, pestana, view, Engine } = await mundo();
  const cuerpo = (texto) => JSON.stringify({
    action: 'next',
    messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
  });
  const enviarConTarjeta = () => journal.webRequest.before.get('persist:nexo').listener({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    method: 'POST',
    resourceType: 'xhr',
    webContentsId: view.id,
    uploadData: [{ bytes: Buffer.from(cuerpo(`mi tarjeta es ${'4111 1111 1111 1111'}`), 'utf8') }],
  }, () => {});

  // Dos envíos que la red frena: antes el segundo caía en la ventana de 30 s.
  enviarConTarjeta();
  enviarConTarjeta();
  const red = (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-net-block');
  console.log('\n   egress-net-block tras 2 bloqueos:', red.length);
  assert.equal(red.length, 2, 'el segundo bloqueo no se suprime');

  // Dos redacciones seguidas del mismo host: la deduplicación sigue igual.
  const preparar = () => invoke('nexo:prepare', pestana, {
    prompt: 'hola',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    site: 'chatgpt',
  });
  const primera = await preparar();
  const segunda = await preparar();
  assert.deepEqual(primera.redacted, { count: 1, types: ['card'] });
  assert.deepEqual(segunda.redacted, { count: 1, types: ['card'] });
  const redacciones = (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-injected-redact');
  console.log('   egress-injected-redact tras 2 redacciones:', redacciones.length);
  assert.equal(redacciones.length, 1, 'la redacción conserva la deduplicación de 30 s');

  // Y el bloqueo del guardián inyectado tampoco se deduplica.
  const original = Engine.prototype.prepare;
  Engine.prototype.prepare = () => ({ text: null, blocked: 'redaccion-inyectada', lang: 'es' });
  try {
    await preparar();
    await preparar();
  } finally {
    Engine.prototype.prepare = original;
  }
  const inyectado = (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-injected-block');
  console.log('   egress-injected-block tras 2 bloqueos:', inyectado.length);
  assert.equal(inyectado.length, 2, 'cada retención deja su aviso');
  for (const aviso of [...red, ...inyectado, ...redacciones]) {
    assert.equal(JSON.stringify(aviso).includes('4111'), false, 'ningún aviso lleva el literal');
  }
});

/* ------------------------------------------------------------------ */
/* shell: punto en Actividad y franja visible                          */
/* ------------------------------------------------------------------ */

const APP = readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');

/** El bloque de la shell que atiende los avisos, tal como está en app.js. */
function bloqueAvisos() {
  const inicio = APP.indexOf('// Un envío retenido es lo único');
  const fin = APP.indexOf("document.getElementById('egressDismiss')?.addEventListener('click', dismissEgressNotice);");
  assert.notEqual(inicio, -1, 'el bloque de avisos existe en app.js');
  assert.notEqual(fin, -1, 'el bloque de avisos termina donde se espera');
  return APP.slice(inicio, fin);
}

function mundoShell({ panelAbierto = false } = {}) {
  const barra = { hidden: true };
  const punto = { hidden: true };
  const timers = new Map();
  let siguiente = 0;
  let listener = null;
  const intervenciones = [];
  const contexto = vm.createContext({
    document: {
      getElementById: (id) => (id === 'egressBar' ? barra : null),
      querySelector: (sel) => (sel === '[data-activity-dot]' ? punto : null),
    },
    setTimeout: (fn) => { siguiente += 1; timers.set(siguiente, fn); return siguiente; },
    clearTimeout: (id) => timers.delete(id),
    isPanelActive: () => panelAbierto,
    pushIntervention: (entry) => intervenciones.push(entry),
    refreshStats: () => {},
    nexo: { on: (_canal, fn) => { listener = fn; } },
  });
  const api = vm.runInContext(`${bloqueAvisos()}\n;({ showEgressNotice, dismissEgressNotice, clearActivityUnread })`, contexto);
  vm.runInContext(APP.slice(APP.indexOf("nexo.on('nexo:event'"), APP.indexOf("nexo.on?.('nexo:stats-changed'")), contexto);
  return { barra, punto, timers, intervenciones, api, emitir: (code) => listener({ type: 'intervention', payload: { code, kind: 'system', severity: 'warn' } }) };
}

test('2) un bloqueo marca el punto de Actividad y muestra la franja; la redacción no', () => {
  const shell = mundoShell();

  shell.emitir('egress-injected-redact');
  console.log('\n   tras redacción → punto:', !shell.punto.hidden, '· franja:', !shell.barra.hidden);
  assert.equal(shell.punto.hidden, true, 'una redacción no interrumpe al usuario');
  assert.equal(shell.barra.hidden, true);

  shell.emitir('egress-net-block');
  console.log('   tras bloqueo   → punto:', !shell.punto.hidden, '· franja:', !shell.barra.hidden);
  assert.equal(shell.punto.hidden, false, 'hay algo nuevo en Actividad');
  assert.equal(shell.barra.hidden, false, 'y el bloqueo se ve sin abrir el panel');

  // Un segundo bloqueo reemplaza: una sola barra y un solo temporizador vivo.
  shell.emitir('egress-injected-block');
  assert.equal(shell.timers.size, 1, 'no se apilan avisos');

  // La barra se va sola a los 20 s.
  const [id, disparar] = [...shell.timers][0];
  assert.equal(shell.timers.has(id), true);
  disparar();
  console.log('   tras 20 s      → franja:', !shell.barra.hidden);
  assert.equal(shell.barra.hidden, true, 'se cierra sola');

  // Y el botón también la cierra.
  shell.emitir('egress-net-block');
  shell.api.dismissEgressNotice();
  assert.equal(shell.barra.hidden, true, 'el botón también la cierra');
});

test('3) con el panel Actividad abierto no se marca el punto, pero la franja igual aparece', () => {
  const shell = mundoShell({ panelAbierto: true });
  shell.emitir('egress-net-block');
  console.log('\n   panel abierto → punto:', !shell.punto.hidden, '· franja:', !shell.barra.hidden);
  assert.equal(shell.punto.hidden, true, 'no hace falta avisar de algo que está a la vista');
  assert.equal(shell.barra.hidden, false, 'el bloqueo se sigue viendo');
});

test('4) abrir el panel Actividad apaga el punto; otro panel no lo toca', () => {
  // Se ejecuta el manejador real de las pestañas del panel con el DOM mínimo.
  const inicio = APP.indexOf('const panelTabs = [');
  const fin = APP.indexOf('function showPanel(name)');
  assert.notEqual(inicio, -1); assert.notEqual(fin, -1);
  const bloque = APP.slice(inicio, fin);
  assert.match(bloque, /if \(tab\.dataset\.panel === 'activity'\) clearActivityUnread\(\);/, 'el retiro del punto está en el manejador');

  const punto = { hidden: false };
  const crearTab = (panel) => ({
    dataset: { panel },
    classList: { toggle() {}, remove() {} },
    setAttribute() {},
    getAttribute: () => panel,
    addEventListener(name, fn) { if (name === 'click') this.click = fn; },
  });
  const tabs = [crearTab('activity'), crearTab('memory')];
  const panelTab = { dataset: { panel: 'activity' }, classList: { toggle() {}, remove() {} } };
  const contexto = vm.createContext({
    document: {
      querySelectorAll: () => tabs,
      querySelector: (sel) => (sel === '[data-activity-dot]' ? punto : (sel === '.stab.active' ? null : panelTab)),
    },
    els: { panelTitle: { textContent: '' } },
    browserTools: null,
    uiTasks: { schedule() {} },
    clearActivityUnread: () => { punto.hidden = true; },
    refreshActivePanel() {},
    refreshMemory() {}, renderLog() {}, refreshStats() {},
    tokenizerPanel: { refresh() {} },
    promptLibrary: { load() {} },
    understandingPanel: null, workPanel: null, refreshHistory() {}, renderBookmarks() {}, renderDownloads() {}, renderSitePanel() {},
    activeTab: () => null, setSidebar() {},
  });
  vm.runInContext(`${bloque}\n;({ tabs: panelTabs })`, contexto);

  console.log('\n   punto antes:', punto.hidden);
  tabs[1].click();
  console.log('   tras abrir Memoria  → punto apagado:', punto.hidden);
  assert.equal(punto.hidden, false, 'otro panel no toca el punto');
  tabs[0].click();
  console.log('   tras abrir Actividad → punto apagado:', punto.hidden);
  assert.equal(punto.hidden, true, 'el punto se quita al abrir Actividad');
});

test('5) la franja existe en la shell con role="alert", texto sin datos y botón de cierre', () => {
  const html = readFileSync(new URL('../src/ui/shell/index.html', import.meta.url), 'utf8');
  const barra = html.match(/<div id="egressBar"[\s\S]*?<\/div>/)[0];
  console.log('\n   ' + barra.replace(/\s+/g, ' ').slice(0, 200));
  assert.match(barra, /role="alert"/, 'se anuncia como alerta');
  assert.match(barra, /hidden/, 'arranca oculta');
  assert.match(barra, /<strong data-egress-title>NEXO retuvo tu envío<\/strong>/);
  assert.match(barra, /data-egress-help>Reintentá o revisá la memoria del proyecto/, 'dice qué hacer');
  assert.match(barra, /id="egressDismiss"/, 'se puede cerrar a mano');
  assert.equal(/4111|sk-|@/.test(barra), false, 'sin literales ni datos');

  // El punto del panel Actividad reutiliza la clase .cut-dot de las pestañas.
  assert.match(html, /data-panel="activity"[^>]*>[\s\S]*?<span class="cut-dot" data-activity-dot hidden><\/span>/);
  assert.doesNotMatch(html, /id="egressDot"/, 'no se inventó un componente nuevo');
});

/**
 * Un envío retenido no puede quedarse sin decir por qué.
 *
 * La puerta de salida tiene tres salidas que dejan al que llama sin veredicto
 * (`action:'error'`) y una que retiene sin ser la rama de bloqueo normal:
 *
 *   · emisor no autorizado (main.js, canal `nexo:egress`);
 *   · payload que la puerta no acepta (`egressGate.js`);
 *   · el diálogo del sistema revienta (`egressGate.js` + `askNativeEgress`);
 *   · cuerpo ilegible con `onUnreadable:'block'` (sólo salía `egress-unreadable`).
 *
 * En los cuatro casos la capa inyectada decide por su cuenta: si bloquea, el
 * mensaje no sale y sin aviso nada lo explica. Acá se comprueban las cuatro, y
 * que los códigos nuevos viajan fuera de la deduplicación de 30 s.
 *
 * Los datos son sintéticos: la tarjeta de prueba de siempre («4111…») y un
 * correo de ejemplo inventado. Ningún aviso puede llevarlos.
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { register } from 'node:module';

import { createEgressGate } from '../src/main/egressGate.js';

const TARJETA = 'Mi tarjeta de prueba es 4111 1111 1111 1111. Repítela tal cual.';
const CORREO = 'escribe a qa@ejemplo-inventado.test cuando puedas';

/** La puerta con `askUser` falso y el registro de diagnósticos a la vista. */
function puerta(cfg, askUser) {
  const diags = [];
  const gate = createEgressGate({
    getConfig: () => cfg,
    askUser: async (args) => askUser(args),
    onDiagnostic: (entry) => diags.push(entry),
    onStats: () => {},
  });
  return { gate, diags };
}

/* ------------------------------------------------------------------ */
/* (a) las tres salidas `error` dejan aviso                            */
/* ------------------------------------------------------------------ */

test('error/payload: avisa aunque no haya datos que juzgar', async () => {
  const { gate, diags } = puerta({ mode: 'enforce' }, () => 'cancel');

  const r = await gate.handle({ sender: { id: 1 }, host: 'chatgpt.com', payload: { slots: [] } });
  assert.deepEqual(r, { action: 'error', reason: 'payload' });

  const aviso = diags.find((d) => d.code === 'egress-error');
  assert.ok(aviso, 'la salida error/payload deja un aviso');
  assert.equal(aviso.severity, 'warn');
  assert.match(aviso.detail, /Motivo: payload\./);
  assert.equal(JSON.stringify(diags).includes('4111'), false, 'sin el dato');
});

test('error/dialogo con askUser que lanza: avisa con el nombre del error, no con su mensaje', async () => {
  const { gate, diags } = puerta({ mode: 'enforce' }, () => {
    // El mensaje lleva el texto del envío a propósito: no debe registrarse.
    const error = new Error(`no se pudo mostrar: ${TARJETA}`);
    error.name = 'ErrorDeVentana';
    throw error;
  });

  const r = await gate.handle({ sender: { id: 1 }, host: 'chatgpt.com', payload: { slots: [TARJETA], canRewrite: true } });
  // El `reason` es el de siempre: la capa inyectada lo interpreta
  // (`inject/index.js:585-589`) y su valor no cambia.
  assert.deepEqual(r, { action: 'error', reason: 'dialogo' });

  const aviso = diags.find((d) => d.code === 'egress-error');
  assert.ok(aviso, 'un diálogo que revienta deja aviso');
  assert.match(aviso.detail, /Motivo: dialogo \(ErrorDeVentana\)\./, 'el nombre del error, en el aviso');
  assert.match(aviso.detail, /Tipos: card×1\./, 'se sabe qué tipo había, sin el valor');
  assert.equal(JSON.stringify(aviso).includes('4111'), false, 'el mensaje del error no viaja');
});

test('error/payload con un dato crítico en los slots: el aviso dice el tipo, nunca el valor', async () => {
  const { gate, diags } = puerta({ mode: 'enforce' }, () => 'cancel');

  // `slots` con un elemento que no es texto: la puerta rechaza el payload
  // ANTES de mirar el contenido, así que no hay tipos que informar; el aviso
  // sigue saliendo y sigue sin llevar nada.
  const r = await gate.handle({ sender: { id: 1 }, host: 'x.test', payload: { slots: [TARJETA, 7] } });
  assert.deepEqual(r, { action: 'error', reason: 'payload' });
  const aviso = diags.find((d) => d.code === 'egress-error');
  assert.ok(aviso);
  assert.equal(JSON.stringify(aviso).includes('4111'), false);
});

/* ------------------------------------------------------------------ */
/* (b) cuerpo ilegible + enforce + onUnreadable:'block'                */
/* ------------------------------------------------------------------ */

test('ilegible con onUnreadable:block emite egress-block, no sólo egress-unreadable', async () => {
  const { gate, diags } = puerta({ mode: 'enforce', onUnreadable: 'block' }, () => 'cancel');

  for (const motivo of ['formulario', 'stream-o-desconocido']) {
    const r = await gate.handle({ sender: { id: 1 }, host: 'chatgpt.com', payload: { unreadable: motivo } });
    assert.deepEqual(r, { action: 'block', reason: motivo }, 'sigue reteniendo, con su motivo');
  }

  const bloques = diags.filter((d) => d.code === 'egress-block');
  const ilegibles = diags.filter((d) => d.code === 'egress-unreadable');
  assert.equal(ilegibles.length, 2, 'cada lectura fallida se anota');
  assert.equal(bloques.length, 2, 'y cada retención también');
  assert.match(bloques[0].detail, /Motivo: formulario\./);
  assert.match(bloques[1].detail, /Motivo: stream-o-desconocido\./);
});

test('ilegible en observe o con onUnreadable:pass no inventa un bloqueo', async () => {
  for (const cfg of [{ mode: 'enforce', onUnreadable: 'pass' }, { mode: 'observe' }]) {
    const { gate, diags } = puerta(cfg, () => 'cancel');
    const r = await gate.handle({ sender: { id: 1 }, host: 'chatgpt.com', payload: { unreadable: 'formulario' } });
    assert.equal(r.action, 'pass');
    assert.equal(diags.filter((d) => d.code === 'egress-block').length, 0, 'no se retuvo: no hay bloqueo');
  }
});

/* ------------------------------------------------------------------ */
/* (c) proceso principal: emisor no autorizado, sin puerta, y dedupe    */
/* ------------------------------------------------------------------ */

async function mundo() {
  register('./harness/loader.mjs', import.meta.url);
  const { join } = await import('node:path');
  const { journal } = await import('./harness/electron-stub.mjs');
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');

  const mem = new EvoMemory({
    storage: fileStorage(join(journal.userData, 'evo-memory-egress-avisos.json')),
    projectId: 'default',
  });
  mem.store.save({ force: true });
  const { Engine } = await import('../src/main/engine.js');
  await import('../src/main/main.js');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const shellEv = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (channel, ev, payload) => journal.ipcHandlers.get(channel)(ev, payload);
  const view = win.attachWebview('https://chatgpt.com/c/7c16a');
  const pestana = { sender: view, senderFrame: view.mainFrame };
  const { EGRESS_DEFAULTS } = await import('../src/core/egressConfig.js');
  await invoke('nexo:settings:set', shellEv, { egress: { ...EGRESS_DEFAULTS, mode: 'enforce' } });
  return { journal, invoke, shellEv, pestana, Engine };
}

test('emisor no autorizado: el envío no se queda sin rastro', async () => {
  const { invoke, shellEv } = await mundo();

  const antes = (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-error').length;
  const r = await invoke('nexo:egress', shellEv, { slots: [TARJETA], canRewrite: true });
  assert.deepEqual(r, { action: 'error', reason: 'emisor' }, 'la puerta sigue sin contestar veredicto');

  const avisos = (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-error');
  assert.equal(avisos.length - antes, 1, 'queda una entrada nueva');
  assert.match(avisos[0].detail, /emisor no autorizado/);
  assert.equal(JSON.stringify(avisos[0]).includes('4111'), false, 'sin el dato');
});

test('dos retenciones seguidas de la misma pestaña dejan dos entradas', async () => {
  const { invoke, shellEv, pestana } = await mundo();
  const cuantos = async () => (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-block').length;
  const antes = await cuantos();

  for (let i = 0; i < 2; i += 1) {
    const r = await invoke('nexo:egress', pestana, { slots: [TARJETA], canRewrite: true });
    assert.equal(r.action, 'block', 'el envío se sigue reteniendo');
  }
  assert.equal((await cuantos()) - antes, 2, 'el segundo bloqueo no lo traga la deduplicación de 30 s');
});

test('un error de la puerta tampoco se deduplica: dos fallos, dos entradas', async () => {
  const { invoke, shellEv, pestana } = await mundo();
  const errores = async () => (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-error');
  const antes = (await errores()).length;

  for (let i = 0; i < 2; i += 1) {
    await invoke('nexo:egress', pestana, { slots: [], canRewrite: true });
  }
  const avisos = await errores();
  assert.equal(avisos.length - antes, 2, 'cada fallo deja su aviso');
  assert.match(avisos[0].detail, /Motivo: payload\./);
});

/* ------------------------------------------------------------------ */
/* (d) la franja de la shell                                           */
/* ------------------------------------------------------------------ */

const APP = readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');
const CODIGOS = ['egress-block', 'egress-error'];

test('la franja de la shell se muestra con los códigos nuevos', () => {
  const inicio = APP.indexOf('// Un envío retenido es lo único');
  const fin = APP.indexOf("document.getElementById('egressDismiss')?.addEventListener('click', dismissEgressNotice);");
  assert.notEqual(inicio, -1, 'el bloque de avisos existe en app.js');
  assert.notEqual(fin, -1, 'termina donde se espera');
  const bloque = APP.slice(inicio, fin);

  for (const code of CODIGOS) {
    assert.match(bloque, new RegExp(`'${code}'`), `${code} está entre los avisos que interrumpen`);
  }

  // Y de verdad enciende la franja y el punto, ejecutando el código real.
  const barra = { hidden: true };
  const punto = { hidden: true };
  let listener = null;
  const timers = new Map();
  const contexto = vm.createContext({
    document: {
      getElementById: (id) => (id === 'egressBar' ? barra : null),
      querySelector: (sel) => (sel === '[data-activity-dot]' ? punto : null),
    },
    setTimeout: (fn) => { timers.set(timers.size + 1, fn); return timers.size; },
    clearTimeout: (id) => timers.delete(id),
    isPanelActive: () => false,
    pushIntervention: () => {},
    refreshStats: () => {},
    nexo: { on: (_canal, fn) => { listener = fn; } },
  });
  vm.runInContext(`${bloque}\n;({ showEgressNotice, dismissEgressNotice })`, contexto);
  vm.runInContext(APP.slice(APP.indexOf("nexo.on('nexo:event'"), APP.indexOf("nexo.on?.('nexo:stats-changed'")), contexto);

  for (const code of CODIGOS) {
    barra.hidden = true;
    punto.hidden = true;
    listener({ type: 'intervention', payload: { code, kind: 'system', severity: 'warn' } });
    assert.equal(barra.hidden, false, `${code} enciende la franja`);
    assert.equal(punto.hidden, false, `${code} marca el punto de Actividad`);
  }

  // Una redacción no interrumpe: el contraste de siempre.
  barra.hidden = true;
  listener({ type: 'intervention', payload: { code: 'egress-injected-redact', kind: 'system', severity: 'info' } });
  assert.equal(barra.hidden, true, 'una redacción no saca la franja');
});

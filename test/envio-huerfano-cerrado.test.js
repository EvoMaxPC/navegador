/**
 * Un gesto cuyo envío el guardián CANCELÓ o BLOQUEÓ ya no espera petición.
 *
 * 7c-16i alargó a 130 s la ventana del registro huérfano (`sources` =
 * `{'composer'}`) para que su red llegara a tiempo. Pero si el guardián retiene el
 * envío, no habrá red nunca: ese registro se quedaba «esperando» y el envío
 * siguiente, que sí salió, se fusionaba con él y contaba uno de menos.
 *
 * `engine.cerrarEnvioPendiente` marca el último registro de la pestaña como
 * cerrado; `main.js` lo llama cuando `egressGate.handle` devuelve `block`
 * (cancelado, timeout o bloqueo). El cierre sólo devuelve la ventana corta: no
 * borra el registro, no descuenta el mensaje ya contado y no toca la fusión de
 * los envíos no huérfanos.
 *
 * La decisión del guardián se toma por su camino REAL: canal `nexo:egress` →
 * `createEgressGate` → `askNativeEgress` → `dialog.showMessageBox`. Sólo el
 * diálogo se sustituye por uno que responde lo que el usuario habría pulsado.
 * Los avisos de envío (`outgoing`) se emiten sobre el camino real de la capa
 * (`nexo:event`), porque la página de este arnés no tiene interfaz.
 *
 * Datos sintéticos: ningún texto real ni dato de nadie.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const TARJETA = '4111 1111 1111 1111';
const TEXTO_A = `Mi tarjeta es ${TARJETA} y quiero ayuda`;
const TEXTO_B = 'segunda pregunta sin datos sensibles';

/** Reloj manual: `Date.now` avanza sólo cuando el test lo pide. */
function reloj(desde = 1_700_000_000_000) {
  const real = Date.now;
  let ahora = desde;
  Date.now = () => ahora;
  return { avanzar: (ms) => { ahora += ms; }, restaurar: () => { Date.now = real; } };
}

/** Proceso principal real + guardián real + diálogo sustituido. */
async function mundo(etiqueta) {
  register('./harness/loader.mjs', import.meta.url);
  const electron = await import('./harness/electron-stub.mjs');
  const { journal } = electron;
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  new EvoMemory({
    storage: fileStorage(join(journal.userData, `evo-cerrado-${etiqueta}.json`)),
    projectId: 'default',
  }).store.save({ force: true });
  await import('../src/main/main.js');
  await new Promise((r) => setTimeout(r, 80));

  // El arnés no trae `BrowserWindow.fromWebContents`; sin él `askNativeEgress`
  // no encuentra la ventana y falla cerrado sin abrir el diálogo.
  electron.BrowserWindow.fromWebContents = (wc) =>
    journal.windows.find((w) => w.webContents === wc) || null;

  // El diálogo: responde lo que se le pida, sin display.
  const dialogo = { abierto: 0, respuesta: 'cancel' };
  electron.dialog.showMessageBox = async (_parent, opciones) => {
    dialogo.abierto += 1;
    const botones = opciones?.buttons || [];
    const buscado = dialogo.respuesta === 'redact' ? /Redactar/i : /Cancelar/i;
    const i = botones.findIndex((b) => buscado.test(b));
    return { response: Math.max(0, i) };
  };

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const evShell = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (canal, ev, payload) => journal.ipcHandlers.get(canal)(ev, payload);

  const { EGRESS_DEFAULTS } = await import('../src/core/egressConfig.js');
  await invoke('nexo:settings:set', evShell, {
    egress: { ...EGRESS_DEFAULTS, mode: 'enforce' },
    context: { enabled: false },
    memory: { enabled: false },
  });

  const pestana = (nombre) => {
    const view = win.attachWebview(`https://chatgpt.com/c/${etiqueta}-${nombre}`);
    view.url = `https://chatgpt.com/c/${etiqueta}-${nombre}`;
    view.hostWebContents = shell;      // la pestaña pertenece a esta ventana
    const ev = { sender: view, senderFrame: view.mainFrame };
    return { view, ev };
  };

  const aviso = (ev, payload) => journal.ipcListeners.get('nexo:event')(ev, { type: 'outgoing', payload });
  const gesto = (ev, id) => aviso(ev, {
    messageId: id, source: 'composer', host: 'chatgpt.com', url: ev.sender.url,
    chars: TEXTO_A.length, textFound: true, promptHash: `h-${id}`,
  });
  const red = (ev, id, texto) => aviso(ev, {
    messageId: id, source: 'network', host: 'chatgpt.com',
    url: 'https://chatgpt.com/backend-api/conversation',
    chars: texto.length, textFound: true, promptHash: `h-${id}`,
  });

  /** La decisión del guardián por su canal real. */
  const guardian = (ev, texto) => invoke('nexo:egress', ev, {
    slots: [texto], canRewrite: true,
  });

  const mensajes = async () => (await invoke('nexo:stats', evShell)).messages;
  const diagMensaje = async () => (await invoke('nexo:log', evShell))
    .filter((e) => e.code === 'diag-mensaje');
  return { journal, dialogo, pestana, gesto, red, guardian, mensajes, diagMensaje, invoke, evShell };
}

test('gesto cancelado en el diálogo + envío siguiente sólo por red a 20 s: DOS mensajes', async () => {
  const c = reloj();
  try {
    const { dialogo, pestana, gesto, red, guardian, mensajes } = await mundo('cancelado');
    const { ev } = pestana('cancelado');
    const antes = await mensajes();

    gesto(ev, 'A-cancelado');
    assert.equal((await mensajes()) - antes, 1, 'el gesto se cuenta al salir');

    dialogo.respuesta = 'cancel';
    assert.equal((await guardian(ev, TEXTO_A)).action, 'block', 'el guardián retiene el envío');

    // 20 s después, un envío que no pasa por el gesto ni por la capa: sólo red.
    c.avanzar(20_000);
    red(ev, 'B-red', TEXTO_B);
    assert.equal((await mensajes()) - antes, 2,
      'el gesto cancelado no se come el envío siguiente: son dos mensajes');
  } finally { c.restaurar(); }
});

test('gesto NO cancelado (diálogo lento que redacta) + red a 20 s: sigue UN mensaje', async () => {
  const c = reloj();
  try {
    const { dialogo, pestana, gesto, red, guardian, mensajes } = await mundo('redactado');
    const { ev } = pestana('redactado');
    const antes = await mensajes();

    gesto(ev, 'A-redactado');
    assert.equal((await mensajes()) - antes, 1, 'el gesto se cuenta al salir');

    dialogo.respuesta = 'redact';
    const decision = await guardian(ev, TEXTO_A);
    assert.equal(decision.action, 'replace', 'el guardián redacta: el envío sigue vivo');

    // La red del MISMO envío llega 20 s después (la ventana larga de 7c-16i).
    c.avanzar(20_000);
    red(ev, 'B-misma-red', TEXTO_B);
    assert.equal((await mensajes()) - antes, 1,
      'un envío retenido que sí sale sigue contando uno, aunque su red llegue tarde');
  } finally { c.restaurar(); }
});

test('gesto bloqueado y envío siguiente con composer: DOS mensajes', async () => {
  const c = reloj();
  try {
    const { dialogo, pestana, gesto, guardian, mensajes } = await mundo('bloqueado');
    const { ev } = pestana('bloqueado');
    const antes = await mensajes();

    gesto(ev, 'A-bloqueado');
    dialogo.respuesta = 'cancel';
    assert.equal((await guardian(ev, TEXTO_A)).action, 'block', 'el guardián retiene el envío');

    c.avanzar(5_000);
    gesto(ev, 'B-composer');
    assert.equal((await mensajes()) - antes, 2,
      'el gesto bloqueado y el envío siguiente son dos mensajes distintos');
  } finally { c.restaurar(); }
});

test('la ventana larga sigue viva para el gesto que NO fue retenido', async () => {
  const c = reloj();
  try {
    const { dialogo, pestana, gesto, red, guardian, mensajes } = await mundo('ventana');
    const { ev } = pestana('ventana');
    const antes = await mensajes();

    gesto(ev, 'A-lento');
    dialogo.respuesta = 'redact';
    await guardian(ev, TEXTO_A);              // redacta: el gesto espera su red
    c.avanzar(129_000);                        // dentro de VENTANA_PETICION_PENDIENTE_MS
    red(ev, 'B-tardia', TEXTO_B);
    assert.equal((await mensajes()) - antes, 1, '129 s sigue siendo el mismo envío');
  } finally { c.restaurar(); }
});

test('el cierre no descuenta lo ya contado ni toca a un envío con petición', async () => {
  const c = reloj();
  try {
    const { dialogo, pestana, gesto, guardian, mensajes } = await mundo('no-descuenta');
    const { ev } = pestana('no-descuenta');
    const antes = await mensajes();

    gesto(ev, 'A-cerrado');
    dialogo.respuesta = 'cancel';
    await guardian(ev, TEXTO_A);
    assert.equal((await mensajes()) - antes, 1, 'el mensaje del gesto sigue contado: no se resta');
  } finally { c.restaurar(); }
});

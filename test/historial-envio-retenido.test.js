/**
 * El aviso «no encontró respuestas» no puede salir mientras la pestaña tiene un
 * **envío retenido**: el gesto del usuario no llegó a viajar y el DOM sólo
 * muestra su pregunta, así que «cero respuestas» no es un hecho sobre la
 * conversación sino sobre el momento.
 *
 * El caso medido en Electron: chat nuevo, se escribe, la puerta de salida abre
 * el diálogo de datos sensibles y —mientras el usuario decide— llegan dos
 * lecturas del DOM separadas por el margen de estabilidad (1,5 s) con 2
 * mensajes de usuario y 0 respuestas. Hasta hoy la segunda publica el aviso
 * (rojo) aunque el envío todavía no salió; después del cambio, no lo publica y
 * la lectura se sigue guardando igual.
 *
 * La señal que se prueba es la que el proceso principal ya tiene en la mano:
 * la promesa de `askNativeEgress`, es decir, el diálogo abierto para esa
 * pestaña (`main.js`, `egressEnCurso`). No se inventa un canal nuevo ni se lee
 * el DOM de la página.
 *
 * Se ejecuta `main.js` real sobre el arnés de Electron y se reemplaza
 * `dialog.showMessageBox` para dejar el diálogo colgado hasta que el test lo
 * resuelve. Texto sintético.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const HREF = 'https://chatgpt.com/c/abc-retenido-01';
const USUARIO = [
  { role: 'user', content: 'primera pregunta que sí viajó' },
  { role: 'user', content: 'segunda pregunta que quedó retenida' },
];
const TARJETA = 'Mi tarjeta de prueba es 4111 1111 1111 1111. Repítela tal cual.';

test('envío retenido: dos lecturas de 2 usuario/0 respuestas no avisan', async () => {
  register('./harness/loader.mjs', import.meta.url);
  const { join } = await import('node:path');
  const { journal, dialog, BrowserWindow } = await import('./harness/electron-stub.mjs');
  const { EGRESS_DEFAULTS } = await import('../src/core/egressConfig.js');
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  new EvoMemory({
    storage: fileStorage(join(journal.userData, 'evo-memory-envio-retenido.json')),
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

  // La pestaña tiene que pertenecer a la ventana para que el diálogo tenga padre.
  // El arnés no trae esta estática: se resuelve desde las ventanas que ya tiene,
  // sin modificar ningún archivo del arnés.
  view.hostWebContents = shell;
  BrowserWindow.fromWebContents = (contents) => journal.windows
    .find((window) => window.webContents === contents) || null;

  await invoke('nexo:settings:set', shellEv, {
    egress: { ...EGRESS_DEFAULTS, mode: 'enforce' },
    // EVO tiene que quedar activo: con la memoria apagada el canal del snapshot
    // sale antes de mirar los turnos y este test no probaría nada.
    context: { enabled: true }, protocol: { level: 'equilibrado' },
  });

  const previas = new Set(await invoke('nexo:log', shellEv));
  const lecturas = async () => (await invoke('nexo:log', shellEv))
    .filter((e) => !previas.has(e) && e.code === 'chatgpt-conversation-read');
  const leer = () => invoke('nexo:conversation-snapshot', pestana, { href: HREF, turns: USUARIO, streaming: true });

  // El diálogo queda abierto: se resuelve a mano al final del test.
  let abierto = null;
  const original = dialog.showMessageBox;
  dialog.showMessageBox = (parent, opciones) => new Promise((resolve) => {
    abierto = { parent, opciones, resolver: (eleccion) => resolve({ response: eleccion }) };
  });

  try {
    const guardado = invoke('nexo:egress', pestana, { slots: [TARJETA], canRewrite: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(abierto, 'la puerta abrió el diálogo del sistema');

    await leer();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await leer();

    assert.equal((await lecturas()).length, 0, 'con el envío retenido no se afirma que no hay respuestas');

    // Con el envío resuelto (cancelado) y la ausencia persistente, el aviso
    // vuelve: la ausencia real sigue teniendo su canal.
    abierto.resolver(0);
    await guardado;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await leer();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await leer();

    const avisos = await lecturas();
    assert.equal(avisos.length, 1, 'sin retención, la ausencia estable sí avisa');
    assert.equal(avisos[0].severity, 'warn');
    assert.equal(avisos[0].meta.assistantTurns, 0);
  } finally {
    if (abierto) abierto.resolver(0);
    dialog.showMessageBox = original;
  }
});

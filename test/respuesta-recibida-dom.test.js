/**
 * «Respuesta recibida» también cuando la cuenta la lectura del DOM.
 *
 * El motor tenía un camino que sumaba una respuesta sin dejar rastro en el
 * panel: la lectura de Repetición con `streaming:false` (`engine.js:541` llama a
 * `#countResponse`, que suma en `engine.js:668` sin emitir ningún evento). El
 * cierre del stream posterior ya no volvía a contar (`duplicate:true`), así que
 * la respuesta aparecía en el contador y en ninguna parte de Actividad.
 *
 * Ahora `nexo:repetition:snapshot` compara `engine.stats().responses` antes y
 * después de la llamada al motor y, si subió, publica `incoming-dom`. El motor
 * no se toca: la señal es el contador que ya expone `stats()`.
 *
 * Se ejecuta `src/main/main.js` real sobre el arnés de Electron. Texto
 * sintético: ningún aviso puede llevarlo.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
await settle();

const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const shellEvent = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);
const asSender = (contents) => ({ sender: contents, senderFrame: contents.mainFrame });

/** Texto que jamás debe salir en un aviso. */
const CENTINELA = 'CENTINELA-7c16f-no-debe-salir';
const PREGUNTA = 'primera pregunta del turno';
const RESPUESTA = `La respuesta del modelo con ${CENTINELA} dentro del cuerpo.`;

/** Nombre del host que usa el aviso (sin `www.`, en minúsculas). */
const hostDe = (href) => new URL(href).hostname.replace(/^www\./, '').toLowerCase();

async function abrirPestana(href) {
  const view = journal.windows[0].attachWebview(href);
  view.navigateTo(href, 'ChatGPT');
  await settle();
  return view;
}

/**
 * Avisos de recepción: los cuatro códigos que declaran «llegó una respuesta».
 * Se filtra por código, no por `kind`: `gpt-response-memory` también es
 * `kind:'receiving'` (es el guardado en EVO, otro hecho) y contarlo aquí
 * mezclaría dos cosas distintas.
 */
const CODIGOS_RECEPCION = ['incoming', 'incoming-dom', 'incoming-cdp', 'incoming-network'];
const recibidas = async () => (await invoke('nexo:log', shellEvent))
  .filter((entry) => CODIGOS_RECEPCION.includes(entry?.code));
/** El registro guarda del más nuevo al más viejo: lo nuevo está al principio. */
const nuevasDesde = async (antes) => {
  const todas = await recibidas();
  return todas.slice(0, todas.length - antes);
};

test('la lectura del DOM que cuenta publica incoming-dom y el cierre no duplica', async () => {
  const href = 'https://chatgpt.com/c/7c16f-a-dom';
  const view = await abrirPestana(href);

  // 1) envío reconocido: deja un turno esperando respuesta.
  journal.ipcListeners.get('nexo:event')(asSender(view), {
    type: 'outgoing',
    payload: { site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-7c16f-a', chars: PREGUNTA.length, text: PREGUNTA },
  });
  await settle();

  const respuestas = async () => (await invoke('nexo:stats', shellEvent)).responses;
  const antes = (await recibidas()).length;
  assert.equal(await respuestas(), 0, 'el envío no cuenta respuestas');

  // 2) lectura 1: sólo el mensaje del usuario. Es la base, no cuenta nada.
  await invoke('nexo:repetition:snapshot', asSender(view), {
    href, streaming: true,
    turns: [{ id: 'visible-0', role: 'user', content: PREGUNTA }],
  });
  await settle();
  assert.equal(await respuestas(), 0, 'la lectura base no cuenta');
  assert.equal((await recibidas()).length, antes, 'ni deja aviso de recepción');

  // 3) lectura 2: aparece la respuesta y el stream ya cerró en la página.
  await invoke('nexo:repetition:snapshot', asSender(view), {
    href, streaming: false,
    turns: [
      { id: 'visible-0', role: 'user', content: PREGUNTA },
      { id: 'visible-1', role: 'assistant', content: RESPUESTA },
    ],
  });
  await settle();

  assert.equal(await respuestas(), 1, 'la lectura contó una respuesta');
  const trasLectura = await recibidas();
  const domEntry = trasLectura.filter((entry) => entry.code === 'incoming-dom');
  assert.equal(domEntry.length, 1, 'la lectura deja exactamente un aviso de recepción');
  assert.equal(domEntry[0].title, `Respuesta recibida en ${hostDe(href)}`, 'mismo título que `incoming`, con el host de la pestaña');
  assert.equal(domEntry[0].severity, 'info');
  assert.equal(domEntry[0].detail, `${RESPUESTA.length} caracteres llegaron a la pantalla.`, 'sólo el número de caracteres');
  assert.equal(domEntry[0].meta.chars, RESPUESTA.length);
  assert.equal(domEntry[0].meta.host, hostDe(href));
  assert.ok(!JSON.stringify(domEntry[0]).includes(CENTINELA), 'el texto de la respuesta no viaja');

  // 4) cierre del stream del mismo turno: ya estaba contado, no añade aviso.
  await invoke('nexo:stream-end', asSender(view), {
    site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-7c16f-a',
    outcome: 'completed', finished: true, interrupted: false,
    chars: RESPUESTA.length, deliveredChars: RESPUESTA.length,
    text: RESPUESTA, truncated: false, stopped: false,
    diag: { formato: 'sse', mime: 'text/event-stream', trozos: 3, bytes: 200 },
  });
  await settle();

  assert.equal(await respuestas(), 1, 'el cierre no vuelve a contar el mismo turno');
  const finales = await nuevasDesde(antes);
  assert.equal(finales.length, 1, 'en toda la secuencia hay una sola entrada de recepción');
  assert.equal(finales[0].code, 'incoming-dom', 'y es la del camino del DOM');
  assert.equal(finales.filter((entry) => entry.code === 'incoming').length, 0, 'el cierre no emite `incoming`');
});

test('sin lectura previa, el cierre del stream deja `incoming` y ningún `incoming-dom`', async () => {
  const href = 'https://chatgpt.com/c/7c16f-a-stream';
  const view = await abrirPestana(href);
  const antes = (await recibidas()).length;

  await invoke('nexo:stream-end', asSender(view), {
    site: 'chatgpt', host: 'chatgpt.com', messageId: 'msg-7c16f-a2',
    outcome: 'completed', finished: true, interrupted: false,
    chars: RESPUESTA.length, deliveredChars: RESPUESTA.length,
    text: RESPUESTA, truncated: false, stopped: false,
    diag: { formato: 'sse', mime: 'text/event-stream', trozos: 3, bytes: 200 },
  });
  await settle();

  const nuevas = await nuevasDesde(antes);
  assert.equal(nuevas.length, 1, 'el cierre deja una entrada');
  assert.equal(nuevas[0].code, 'incoming', 'la del camino del stream');
  assert.equal(nuevas.filter((entry) => entry.code === 'incoming-dom').length, 0, 'sin lectura previa no hay aviso del DOM');
});

/**
 * P0-4a · el marco del emisor también decide el alcance.
 *
 * La capa de la página se inyecta sólo en el marco principal de la pestaña
 * (`nodeIntegrationInSubFrames: false`, main.js:795). Hasta ahora, los canales
 * que deciden por emisor miraban `event.sender` y su URL, no el marco: un
 * subframe de la MISMA pestaña —un iframe incrustado en ChatGPT, por ejemplo—
 * podía pedir mediación, cerrar un turno o leer la configuración como si fuera
 * la pestaña entera.
 *
 * Acá se comprueba, contra el IPC real:
 *   1. el marco principal de la pestaña sigue pasando, canal por canal;
 *   2. un subframe recibe exactamente el mismo neutro que un emisor ajeno y, en
 *      los cuatro canales que avisan, deja un `diag-emisor-ajeno` con el nombre
 *      del canal y nada más (sin host, sin URL, sin payload);
 *   3. un `senderFrame` nulo o ausente conserva el comportamiento anterior:
 *      `electron.d.ts:9508-9512` dice que puede ser `null` después de navegar o
 *      destruirse, así que ahí sólo decide `sender`.
 *
 * Cada canal se ejerce una sola vez con subframe: el freno del aviso es de 60 s
 * por canal y vive en el proceso, no en la prueba.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
await settle();

const CODIGO = 'diag-emisor-ajeno';
const PREFIJO = `${CODIGO}: `;

/** Una pestaña real del arnés: webview con `getURL`, `id` y `mainFrame`. */
function pestana(url) {
  const view = journal.windows[0].attachWebview(url);
  view.navigateTo(url, 'Pestaña');
  return view;
}

/** La shell, para los canales que la exigen y para leer el registro. */
function shell() {
  const win = journal.windows[0];
  win.webContents.url = 'nexo://app/src/ui/shell/index.html';
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

/** El evento del marco principal de la pestaña. */
const propio = (view) => ({ sender: view, senderFrame: view.mainFrame });
/** El evento de un subframe: mismo `sender`, `senderFrame` distinto. */
const subframe = (view) => ({ sender: view, senderFrame: { url: 'https://chatgpt.com/embed' } });

const config = (event, host) => journal.ipcHandlers.get('nexo:config')(event, { host });
function configSync(event, host) {
  journal.ipcListeners.get('nexo:config-sync')(event, { host });
  return event.returnValue;
}
const prepare = (event, payload) => journal.ipcHandlers.get('nexo:prepare')(event, payload);
const turnResult = (event, payload) => journal.ipcHandlers.get('nexo:turn-result')(event, payload);
const progress = (event, payload) => journal.ipcHandlers.get('nexo:stream-progress')(event, payload);
const streamEnd = (event, payload) => journal.ipcHandlers.get('nexo:stream-end')(event, payload);
const registro = () => journal.ipcHandlers.get('nexo:log')({ sender: { id: 1 } });

/** Contadores de la conversación: todo `stats` menos la longitud del registro. */
const contadores = () => {
  const { log, ...resto } = journal.ipcHandlers.get('nexo:stats')({ sender: { id: 1 } });
  return resto;
};

/** Entradas del aviso, con el canal que llevan en el título. */
const avisos = () => registro()
  .filter((entrada) => entrada?.code === CODIGO)
  .map((entrada) => ({
    entrada,
    canal: String(entrada.title || '').startsWith(PREFIJO) ? entrada.title.slice(PREFIJO.length) : null,
  }));
const delCanal = (canal) => avisos().filter((item) => item.canal === canal);

const PEDIDO_CONFIG = 'chatgpt.com';
const CIERRE = {
  host: 'chatgpt.com', site: 'chatgpt', messageId: 'marco-1',
  text: 'Respuesta con texto suficiente.', chars: 31, tokens: 5, finished: true,
};

/* ---------------- 1. el marco principal sigue pasando ---------------- */

test('marco principal: nexo:config entrega la configuración de su host', async () => {
  const view = pestana('https://chatgpt.com/c/marco-propio');
  const configuracion = await config(propio(view), PEDIDO_CONFIG);
  assert.equal(configuracion.site, 'chatgpt', 'el emisor propio conserva su perfil');
  assert.equal(configuracion.profiled, true);
});

test('marco principal: nexo:config-sync entrega la configuración de su host', async () => {
  const view = pestana('https://chatgpt.com/c/marco-propio-sync');
  const configuracion = configSync(propio(view), PEDIDO_CONFIG);
  assert.equal(configuracion.site, 'chatgpt');
  assert.equal(configuracion.profiled, true);
});

test('marco principal: nexo:prepare media el pedido', async () => {
  const view = pestana('https://chatgpt.com/c/marco-propio-prepare');
  const resultado = await prepare(propio(view), {
    prompt: 'hola, ¿me ayudás?',
    url: 'https://chatgpt.com/backend-api/conversation',
    site: 'chatgpt',
  });
  assert.equal(resultado.skipped, undefined, 'no se descarta el pedido del marco principal');
  assert.equal(resultado.redacted?.count, 0, 'sin críticos no hay redacción');
});

test('marco principal: nexo:turn-result mueve el contador del turno', async () => {
  const view = pestana('https://chatgpt.com/c/marco-propio-turno');
  const antes = contadores();
  // `cancelled` es el desenlace con contador propio (`turnOutcome.js:2-8`);
  // `completed` se conserva para deduplicar y no mueve ninguno (P0-3c).
  const resultado = await turnResult(propio(view), {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'marco-turno-1', stoppedByUser: true,
  });
  assert.deepEqual(resultado, { counted: true, outcome: 'cancelled', reclassified: false },
    'el marco principal no se descarta');
  assert.equal(contadores().turnsCancelled, antes.turnsCancelled + 1, 'y el turno se cuenta');
});

test('marco principal: nexo:stream-progress suma los tokens del fragmento', async () => {
  const view = pestana('https://chatgpt.com/c/marco-propio-progreso');
  const antes = contadores();
  const resultado = await progress(propio(view), {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'marco-progreso-1', text: 'Un fragmento con palabras.',
  });
  assert.notEqual(resultado?.skipped, 'otro-proveedor');
  assert.notDeepEqual(contadores(), antes, 'y los tokens se suman');
});

test('marco principal: nexo:stream-end cierra el turno y lo cuenta', async () => {
  const view = pestana('https://chatgpt.com/c/marco-propio-cierre');
  const antes = contadores();
  const resultado = await streamEnd(propio(view), { ...CIERRE, messageId: 'marco-cierre-1' });
  assert.notEqual(resultado?.skipped, 'otro-proveedor', 'el cierre propio no se descarta');
  assert.notDeepEqual(contadores(), antes, 'la respuesta se cuenta');
});

/* ---------------- 2. un subframe es un emisor ajeno ---------------- */

test('nexo:config: un subframe recibe el neutro, deja su aviso y no mueve contadores', async () => {
  const view = pestana('https://chatgpt.com/c/marco-sub-config');
  const antesAvisos = delCanal('nexo:config').length;
  const antes = contadores();

  const configuracion = await config(subframe(view), PEDIDO_CONFIG);

  assert.equal(configuracion.site, 'generic', 'no se entrega el perfil de la pestaña');
  assert.equal(configuracion.profiled, false);
  assert.deepEqual(contadores(), antes, 'leer la configuración no mueve nada');

  const emitidos = delCanal('nexo:config');
  assert.equal(emitidos.length, antesAvisos + 1, 'deja el aviso del canal');
  const { entrada } = emitidos.at(-1);
  assert.equal(entrada.severity, 'info');
  assert.equal(entrada.title, `${PREFIJO}nexo:config`, 'sólo el nombre del canal');
  assert.equal(entrada.detail, 'El emisor no es una IA reconocida.');
  assert.deepEqual(entrada.meta, {}, 'sin metadatos');
  const serializada = JSON.stringify(entrada);
  assert.equal(/chatgpt|ejemplo|https?:|www\.|embed|payload|prompt/i.test(serializada), false,
    'el aviso no lleva host, URL ni payload');
});

test('nexo:config-sync: un subframe recibe el neutro y deja su aviso', () => {
  const view = pestana('https://chatgpt.com/c/marco-sub-sync');
  const antesAvisos = delCanal('nexo:config-sync').length;

  const configuracion = configSync(subframe(view), PEDIDO_CONFIG);

  assert.ok(configuracion && typeof configuracion === 'object', 'el canal siempre responde');
  assert.equal(configuracion.site, 'generic', 'neutro, no el perfil de la pestaña');
  assert.equal(configuracion.profiled, false);
  assert.equal(delCanal('nexo:config-sync').length, antesAvisos + 1, 'deja el aviso del canal');
});

test('nexo:prepare: un subframe recibe el neutro, deja su aviso y no mueve contadores', async () => {
  const view = pestana('https://chatgpt.com/c/marco-sub-prepare');
  const antesAvisos = delCanal('nexo:prepare').length;
  const antes = contadores();

  const resultado = await prepare(subframe(view), {
    prompt: 'texto del chat que no debe salir',
    url: 'https://chatgpt.com/backend-api/conversation',
    site: 'chatgpt',
  });

  assert.deepEqual(resultado, { text: 'texto del chat que no debe salir', skipped: 'fuera-de-alcance' },
    'mismo neutro que un emisor ajeno');
  assert.deepEqual(contadores(), antes, 'sin contar ni intervenir');
  assert.equal(delCanal('nexo:prepare').length, antesAvisos + 1, 'deja el aviso del canal');
});

test('nexo:turn-result: un subframe recibe el neutro y no mueve contadores', async () => {
  const view = pestana('https://chatgpt.com/c/marco-sub-turno');
  const antes = contadores();

  const resultado = await turnResult(subframe(view), {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'marco-sub-turno-1', stoppedByUser: true,
  });

  assert.deepEqual(resultado, { skipped: 'otro-proveedor' }, 'mismo neutro que un emisor ajeno');
  assert.deepEqual(contadores(), antes, 'sin contar el turno');
});

test('nexo:stream-progress: un subframe recibe el neutro y no suma tokens', async () => {
  const view = pestana('https://chatgpt.com/c/marco-sub-progreso');
  const antes = contadores();

  const resultado = await progress(subframe(view), {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'marco-sub-progreso-1', text: 'Un fragmento con palabras.',
  });

  assert.deepEqual(resultado, { ok: true, skipped: 'otro-proveedor' }, 'mismo neutro que un emisor ajeno');
  assert.deepEqual(contadores(), antes, 'sin sumar tokens');
});

test('nexo:stream-end: un subframe recibe el neutro, deja su aviso y no cuenta el cierre', async () => {
  const view = pestana('https://chatgpt.com/c/marco-sub-cierre');
  const antesAvisos = delCanal('nexo:stream-end').length;
  const antes = contadores();

  const resultado = await streamEnd(subframe(view), { ...CIERRE, messageId: 'marco-sub-cierre-1' });

  assert.deepEqual(resultado, { skipped: 'otro-proveedor' }, 'mismo neutro que un emisor ajeno');
  assert.deepEqual(contadores(), antes, 'sin contar ni registrar');
  assert.equal(delCanal('nexo:stream-end').length, antesAvisos + 1, 'deja el aviso del canal');
});

/* ---------------- 3. senderFrame nulo o ausente: comportamiento actual ---------------- */

test('senderFrame nulo: el emisor propio sigue pasando (sólo decide sender)', async () => {
  const view = pestana('https://chatgpt.com/c/marco-nulo');
  const evento = { sender: view, senderFrame: null };

  const configuracion = await config(evento, PEDIDO_CONFIG);
  assert.equal(configuracion.site, 'chatgpt', 'sin marco comparable, manda el emisor');

  const resultado = await prepare(evento, {
    prompt: 'hola, ¿me ayudás?',
    url: 'https://chatgpt.com/backend-api/conversation',
    site: 'chatgpt',
  });
  assert.equal(resultado.skipped, undefined, 'el pedido del emisor propio se media');
});

test('senderFrame ausente: el emisor propio sigue pasando (sólo decide sender)', async () => {
  const view = pestana('https://chatgpt.com/c/marco-ausente');

  const configuracion = await config({ sender: view }, PEDIDO_CONFIG);
  assert.equal(configuracion.site, 'chatgpt', 'sin `senderFrame` no hay nada que comparar');

  const resultado = await turnResult({ sender: view }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'marco-ausente-1', stoppedByUser: true,
  });
  assert.notEqual(resultado?.skipped, 'otro-proveedor', 'y el turno del emisor propio se cuenta');
});

test('senderFrame nulo no convierte a un emisor ajeno en propio', async () => {
  const view = pestana('https://ejemplo.com/pagina');
  const antes = contadores();

  const resultado = await turnResult({ sender: view, senderFrame: null }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'marco-nulo-ajeno-1', stoppedByUser: true,
  });

  assert.deepEqual(resultado, { skipped: 'otro-proveedor' }, 'el host del emisor sigue decidiendo');
  assert.deepEqual(contadores(), antes);
});

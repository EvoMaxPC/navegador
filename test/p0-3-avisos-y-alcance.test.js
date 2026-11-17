/**
 * Etapa P0-3 · aviso de emisor ajeno y alcance en los canales que faltaban.
 *
 * Dos cosas, contra el IPC real:
 *   1. Cuando `nexo:config`, `nexo:config-sync`, `nexo:stream-end` o
 *      `nexo:prepare` descartan un pedido por emisor ajeno, queda UN aviso en
 *      Actividad con el nombre del canal y nada más: sin host, sin URL, sin
 *      payload, sin texto. Como mucho uno por canal cada 60 s, así que tres
 *      pedidos seguidos dejan una sola entrada.
 *   2. `nexo:turn-result` y `nexo:stream-progress` aplican el mismo alcance: un
 *      emisor ajeno no mueve contadores.
 *
 * Cada canal se ejerce en una sola prueba: el freno de 60 s es del proceso, no
 * de la prueba, y repartir un canal en dos pruebas mediría el freno ajeno.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
await settle();

const CODIGO = 'diag-emisor-ajeno';
const PREFIJO = `${CODIGO}: `;

function pestana(url) {
  const view = journal.windows[0].attachWebview(url);
  view.navigateTo(url, 'Pestaña');
  return { sender: view, senderFrame: view.mainFrame };
}

const registro = () => journal.ipcHandlers.get('nexo:log')({ sender: { id: 1 } });

/** Entradas de aviso, con el canal que llevan en el título. */
const avisos = () => registro()
  .filter((entrada) => entrada?.code === CODIGO)
  .map((entrada) => ({ entrada, canal: String(entrada.title || '').startsWith(PREFIJO) ? entrada.title.slice(PREFIJO.length) : null }));
const delCanal = (canal) => avisos().filter((item) => item.canal === canal);

const AJENA = 'https://ejemplo.com/pagina';
const PROPIA = 'https://chatgpt.com/c/propio';

/**
 * Reloj desplazable. El freno del aviso es de 60 s y el del registro general de
 * 30 s: sin mover el reloj, el segundo taparía al primero y la prueba no
 * distinguiría una ventana de otra.
 */
const ahoraReal = Date.now;
let desplazamiento = 0;
const avanzar = (ms) => { desplazamiento += ms; };
const relojReal = () => { Date.now = ahoraReal; desplazamiento = 0; };

const config = (event, host) => journal.ipcHandlers.get('nexo:config')(event, { host });
const streamEnd = (event, payload) => journal.ipcHandlers.get('nexo:stream-end')(event, payload);
const turnResult = (event, payload) => journal.ipcHandlers.get('nexo:turn-result')(event, payload);
const progress = (event, payload) => journal.ipcHandlers.get('nexo:stream-progress')(event, payload);
/** Contadores de la conversación: todo `stats` menos la longitud del registro. */
const contadores = () => {
  const { log, ...resto } = journal.ipcHandlers.get('nexo:stats')({ sender: { id: 1 } });
  return resto;
};

/* ---------------- 1. el aviso, canal por canal ---------------- */

test('nexo:config: tres pedidos ajenos dejan un aviso con el canal y nada más', async (t) => {
  const emisor = pestana(AJENA);
  // El freno se mide dentro de la ventana de 60 s: a los 45 s el registro
  // general (30 s) ya habría vuelto a publicar, así que sólo el freno propio
  // explica que siga habiendo una sola entrada.
  Date.now = () => ahoraReal() + desplazamiento;
  t.after(() => relojReal());
  const antes = delCanal('nexo:config').length;
  await config(emisor, 'chatgpt.com');
  avanzar(15_000);
  await config(emisor, 'chatgpt.com');
  avanzar(30_000);
  await config(emisor, 'claude.ai');
  const emitidos = delCanal('nexo:config');
  assert.equal(emitidos.length, antes + 1, 'un aviso por canal, no uno por pedido');

  const { entrada } = emitidos.at(-1);
  assert.equal(entrada.severity, 'info');
  assert.equal(entrada.detail, 'El emisor no es una IA reconocida.');
  assert.equal(entrada.title, `${PREFIJO}nexo:config`, 'sólo el nombre del canal');
  assert.deepEqual(entrada.meta, {}, 'sin metadatos');
  // Ni host, ni URL, ni payload, ni texto del chat en la entrada.
  const serializada = JSON.stringify(entrada);
  assert.equal(/chatgpt|claude|ejemplo|https?:|www\.|payload|prompt/i.test(serializada), false,
    'el aviso no lleva host, URL ni payload');
});

test('nexo:config: el emisor propio no deja aviso', async (t) => {
  const emisor = pestana(PROPIA);
  Date.now = () => ahoraReal() + desplazamiento;
  t.after(() => relojReal());
  avanzar(61_000); // ventana libre: cualquier aviso indebido se vería
  const antes = delCanal('nexo:config').length;
  await config(emisor, 'chatgpt.com');
  assert.equal(delCanal('nexo:config').length, antes, 'un emisor reconocido no se avisa');
});

test('nexo:config-sync: tres pedidos ajenos dejan un aviso y el canal sigue respondiendo', (t) => {
  const emisor = pestana(AJENA);
  Date.now = () => ahoraReal() + desplazamiento;
  t.after(() => relojReal());
  const antes = delCanal('nexo:config-sync').length;
  for (let i = 0; i < 3; i += 1) {
    if (i) avanzar(20_000);
    const receptor = { sender: emisor.sender, senderFrame: emisor.senderFrame };
    journal.ipcListeners.get('nexo:config-sync')(receptor, { host: 'chatgpt.com' });
    assert.ok(receptor.returnValue && typeof receptor.returnValue === 'object', 'siempre responde');
  }
  assert.equal(delCanal('nexo:config-sync').length, antes + 1, 'un aviso, no tres');
});

test('nexo:stream-end: avisa una vez y mantiene el neutro', async () => {
  const emisor = pestana(AJENA);
  const antes = delCanal('nexo:stream-end').length;
  const cierre = { host: 'chatgpt.com', site: 'chatgpt', messageId: 'aviso-1', text: 'texto de prueba', chars: 17, tokens: 3 };
  assert.deepEqual(await streamEnd(emisor, cierre), { skipped: 'otro-proveedor' }, 'mismo neutro de P0-2');
  assert.deepEqual(await streamEnd(emisor, cierre), { skipped: 'otro-proveedor' });
  assert.equal(delCanal('nexo:stream-end').length, antes + 1, 'un aviso, no dos');
});

test('nexo:prepare: avisa del emisor ajeno sin cambiar la respuesta', async () => {
  const antes = delCanal('nexo:prepare').length;
  const preparar = () => journal.ipcHandlers.get('nexo:prepare')(
    { sender: { id: 1 } },
    { prompt: 'secreto de prueba', url: 'https://chatgpt.com/backend-api/conversation' },
  );
  const fuera = await preparar();
  assert.equal(fuera.skipped, 'fuera-de-alcance', 'la respuesta es la de siempre');
  assert.equal(fuera.text, 'secreto de prueba', 'el cuerpo vuelve intacto');
  await preparar();
  assert.equal(delCanal('nexo:prepare').length, antes + 1, 'un aviso, no dos');
});

/* ---------------- 2. alcance en turn-result y stream-progress ---------------- */

test('nexo:turn-result: un emisor ajeno no mueve contadores', async () => {
  const emisor = pestana(AJENA);
  const antes = contadores();
  const resultado = await turnResult(emisor, { host: 'chatgpt.com', site: 'chatgpt', messageId: 'tr-ajeno', outcome: 'completed' });
  assert.deepEqual(resultado, { skipped: 'otro-proveedor' }, 'neutro del motor (engine.js:499)');
  assert.deepEqual(contadores(), antes, 'sin contar turnos');
});

test('nexo:stream-progress: un emisor ajeno no suma tokens de salida', async () => {
  const emisor = pestana(AJENA);
  const antes = contadores();
  const resultado = await progress(emisor, { host: 'chatgpt.com', site: 'chatgpt', messageId: 'sp-ajeno', text: 'Un fragmento con palabras.' });
  assert.deepEqual(resultado, { ok: true, skipped: 'otro-proveedor' }, 'mismo objeto que el descarte por texto vacío');
  assert.deepEqual(contadores(), antes, 'sin sumar tokens');
});

/* ---------------- 3. P0-3e · el aviso de nexo:prepare, en detalle ---------------- */

test('nexo:prepare: el aviso ajeno no lleva host, URL ni texto del chat', async (t) => {
  Date.now = () => ahoraReal() + desplazamiento;
  t.after(() => relojReal());
  avanzar(600_000); // ventana holgada: el aviso de este canal tiene que verse

  const antes = delCanal('nexo:prepare').length;
  const prompt = 'texto-del-chat-que-no-debe-salir';
  await journal.ipcHandlers.get('nexo:prepare')(
    { sender: { id: 1 } },
    { prompt, url: 'https://chatgpt.com/backend-api/conversation', host: 'chatgpt.com' },
  );

  const emitidos = delCanal('nexo:prepare');
  assert.equal(emitidos.length, antes + 1, 'un aviso');
  const { entrada } = emitidos.at(-1);
  assert.equal(entrada.title, `${PREFIJO}nexo:prepare`, 'sólo el nombre del canal');
  assert.equal(entrada.detail, 'El emisor no es una IA reconocida.');
  assert.deepEqual(entrada.meta, {}, 'sin metadatos');
  const serializada = JSON.stringify(entrada);
  assert.equal(/texto-del-chat|chatgpt|claude|ejemplo|https?:|www\.|backend-api/i.test(serializada), false,
    'el aviso no lleva texto, host ni URL');
});

test('nexo:prepare: el freno deja un solo aviso cada 60 s', async (t) => {
  Date.now = () => ahoraReal() + desplazamiento;
  t.after(() => relojReal());
  // Cada prueba nueva arranca más adelante que la anterior: el reloj se devuelve,
  // pero las marcas del freno quedan en el proceso.
  avanzar(700_000);

  const antes = delCanal('nexo:prepare').length;
  const pedir = () => journal.ipcHandlers.get('nexo:prepare')(
    { sender: { id: 1 } },
    { prompt: 'cuerpo de prueba', url: 'https://chatgpt.com/backend-api/conversation' },
  );
  await pedir();
  avanzar(45_000); // dentro de los 60 s, fuera de los 30 s del registro general
  await pedir();
  assert.equal(delCanal('nexo:prepare').length, antes + 1, 'sólo el freno propio explica una sola entrada');
});

test('nexo:prepare: el emisor propio no deja aviso', async (t) => {
  const emisor = pestana(PROPIA);
  Date.now = () => ahoraReal() + desplazamiento;
  t.after(() => relojReal());
  avanzar(900_000);

  const antes = delCanal('nexo:prepare').length;
  const dentro = await journal.ipcHandlers.get('nexo:prepare')(emisor, {
    prompt: 'hola, ¿me ayudás?',
    url: 'https://chatgpt.com/backend-api/conversation',
    site: 'chatgpt',
  });
  assert.equal(dentro.skipped, undefined, 'un emisor propio sí se media');
  assert.equal(delCanal('nexo:prepare').length, antes, 'un emisor reconocido no se avisa');
});

test('nexo:prepare: el emisor ajeno no mueve ningún contador', async (t) => {
  Date.now = () => ahoraReal() + desplazamiento;
  t.after(() => relojReal());
  avanzar(1_100_000);

  const antes = contadores();
  const fuera = await journal.ipcHandlers.get('nexo:prepare')(
    { sender: { id: 1 } },
    { prompt: 'cuerpo de prueba', url: 'https://chatgpt.com/backend-api/conversation' },
  );
  assert.deepEqual(fuera, { text: 'cuerpo de prueba', skipped: 'fuera-de-alcance' }, 'respuesta sin cambio');
  assert.deepEqual(contadores(), antes, 'sin contar ni intervenir');
});

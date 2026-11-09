/**
 * La capa que corre dentro de la página, ejecutada de verdad.
 *
 * `build/inject.js` es el archivo que se inyecta en la pestaña. Acá se carga en
 * un contexto con las mismas piezas que le da el navegador (`window`, `fetch`,
 * `Response`, streams) y se comprueba lo que la capa anuncia hacia el proceso
 * principal: el envío del mensaje, el cierre de la respuesta y el texto entero.
 *
 * Es la prueba que faltaba: los contadores se miraban en el motor, pero nadie
 * verificaba que la capa avisara de un envío que no se media.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const RUTA = new URL('../build/inject.js', import.meta.url);
const fuente = existsSync(RUTA) ? readFileSync(RUTA, 'utf8') : null;

/**
 * Un mundo mínimo con lo que la capa usa de la pestaña.
 *
 * `responderPreparar` decide qué contesta el proceso principal al pedido de
 * preparación: devolver el mismo texto es «sin intervención»; otro texto es
 * «Nexo reescribió el mensaje».
 */
function crearMundo(options = {}) {
  const {
    host = 'chatgpt.com',
    pathname = '/c/abc-12345678',
    stream = '',
    responderPreparar = (prompt) => ({ text: prompt }),
  } = options;

  const listeners = [];
  const salientes = [];
  const peticiones = [];

  const fetchNativo = async (input, init) => {
    peticiones.push({ input: String(input), init });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const window = {
    __NEXO_CONFIG__: { host, enabled: true, settings: {}, language: 'es', version: '0.1.0', site: 'chatgpt' },
    location: { href: `https://${host}${pathname}`, hostname: host, pathname, protocol: 'https:' },
    fetch: fetchNativo,
    addEventListener: (tipo, fn) => { if (tipo === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => {
      salientes.push(msg);
      if (msg.__nexo !== 'call') return;
      // El preload contesta siempre, como en producción.
      setTimeout(() => {
        const data = {
          __nexo: 'reply',
          id: msg.id,
          payload: responderPreparar(String(msg.payload?.prompt || '')),
        };
        for (const fn of listeners) fn({ source: window, data });
      }, 0);
    },
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    ReadableStream,
    WritableStream,
    TransformStream,
    Response,
    Headers,
    Request,
    URL,
    console,
    navigator: { userAgent: 'Chrome' },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
  };
  window.window = window;

  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });
  return { window, salientes, peticiones };
}

/** Cuerpo de un envío normal de ChatGPT. */
function cuerpoChatGPT(texto) {
  return JSON.stringify({
    action: 'next',
    messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
  });
}

/** Stream SSE de ChatGPT con un único fragmento de texto. */
function sse(texto) {
  return `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: texto })}\n\ndata: [DONE]\n\n`;
}

const eventos = (mundo, tipo) => mundo.salientes.filter((m) => m.type === tipo);

const conCapa = (options) => {
  const mundo = crearMundo(options);
  return mundo;
};

test('la capa avisa del envío aunque no haya nada que mediar', { skip: !fuente && 'falta build/inject.js (npm run build:inject)' }, async () => {
  const mundo = conCapa({ stream: sse('Hola mundo') });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpoChatGPT('hola mundo'),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  const envios = eventos(mundo, 'outgoing');
  assert.equal(envios.length, 1, 'un envío, un aviso');
  const payload = envios[0].payload;
  assert.ok(payload.messageId, 'lleva identificador propio');
  assert.equal(payload.chars, 10, 'lleva el tamaño del mensaje');
  assert.ok(payload.tokens > 0, 'y los tokens estimados');
  assert.equal(payload.conversationId, 'abc-12345678', 'y la conversación de la URL');
  assert.equal(payload.mediated, false, 'sin intervención');

  const cierres = eventos(mundo, 'stream-end');
  assert.equal(cierres.length, 1, 'la respuesta se cierra una vez');
  assert.equal(cierres[0].payload.text, 'Hola mundo');
  assert.equal(cierres[0].payload.messageId, payload.messageId, 'la respuesta se ata al envío');
  assert.equal(cierres[0].payload.finished, true);
});

test('un mensaje con intervención viaja reescrito y se anuncia como mediado', { skip: !fuente && 'falta build/inject.js (npm run build:inject)' }, async () => {
  const mundo = conCapa({
    stream: sse('Listo.'),
    responderPreparar: () => ({ text: 'Mensaje reescrito por Nexo' }),
  });

  const respuesta = await mundo.window.fetch('https://chatgpt.com/backend-api/conversation', {
    method: 'POST',
    body: cuerpoChatGPT('mensaje original'),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  const envio = eventos(mundo, 'outgoing')[0].payload;
  assert.equal(envio.mediated, true, 'se anuncia como mediado');
  assert.equal(envio.chars, 'mensaje original'.length, 'el contador mide lo que escribió la persona');

  const enviado = JSON.parse(mundo.peticiones[0].init.body);
  assert.equal(enviado.messages[0].content.parts[0], 'Mensaje reescrito por Nexo', 'el cuerpo salió reescrito');
  assert.equal(mundo.peticiones.length, 1, 'una sola petición al servidor');
});

test('una respuesta de más de 8 000 caracteres se anuncia entera', { skip: !fuente && 'falta build/inject.js (npm run build:inject)' }, async () => {
  const largo = `${'La respuesta larga sigue. '.repeat(420)}FINAL`;
  assert.ok(largo.length > 9000);

  const mundo = conCapa({ stream: sse(largo) });
  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpoChatGPT('contame algo largo'),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 60));

  const cierre = eventos(mundo, 'stream-end')[0].payload;
  assert.equal(cierre.chars, largo.length, 'se anuncia el tamaño completo');
  assert.equal(cierre.text.length, largo.length, 'y el texto completo, sin recorte de 8 000');
  assert.ok(cierre.text.endsWith('FINAL'), 'incluido el final');
  assert.equal(cierre.clipped, false, 'sin marcar como recortado');
});

test('una petición que no es de conversación no se cuenta ni se toca', { skip: !fuente && 'falta build/inject.js (npm run build:inject)' }, async () => {
  const mundo = conCapa({ stream: sse('hola') });

  const respuesta = await mundo.window.fetch('https://chatgpt.com/public-api/settings', {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(eventos(mundo, 'outgoing').length, 0, 'no es un mensaje del usuario');
  assert.equal(eventos(mundo, 'stream-end').length, 0, 'no se envuelve');
});

test('dos envíos seguidos llevan identificadores distintos', { skip: !fuente && 'falta build/inject.js (npm run build:inject)' }, async () => {
  const mundo = conCapa({ stream: sse('ok') });

  for (const texto of ['primer mensaje', 'segundo mensaje']) {
    const respuesta = await mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpoChatGPT(texto) });
    await respuesta.text();
  }
  await new Promise((r) => setTimeout(r, 60));

  const ids = eventos(mundo, 'outgoing').map((m) => m.payload.messageId);
  assert.equal(ids.length, 2, 'dos envíos, dos avisos');
  assert.notEqual(ids[0], ids[1], 'sin identificadores repetidos: se pueden deduplicar');
  assert.equal(new Set(eventos(mundo, 'stream-end').map((m) => m.payload.messageId)).size, 2);
});

test('al cargarse, la capa avisa que quedó activa', { skip: !fuente && 'falta build/inject.js (npm run build:inject)' }, async () => {
  const mundo = conCapa({});
  const listo = mundo.salientes.find((m) => m.__nexo === 'ready');
  assert.ok(listo, 'la capa se anuncia al instalarse');
  assert.equal(listo.payload.host, 'chatgpt.com');
});

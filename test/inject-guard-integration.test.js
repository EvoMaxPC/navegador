/**
 * El guardián de la capa inyectada contra la puerta de salida DE VERDAD.
 *
 * Los otros tests del guardián usan un doble del proceso principal que contesta
 * lo que el test le dice. Acá el puente va a un `createEgressGate` real, con
 * `detectSensitive` y `redact` reales: lo único simulado es el diálogo
 * (`askUser`) y la configuración por host. Así se comprueba que los dos lados
 * hablan el mismo idioma: `slots`/`unreadable` de entrada y
 * `pass`/`replace`/`block` de salida.
 *
 * El bundle de la capa se ejecuta en un `vm` con las piezas que le da el
 * navegador. El `vault` que repone el texto es el del proceso principal, que es
 * donde vive en producción.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

import { createEgressGate } from '../src/main/egressGate.js';
import { detectSensitive } from '../src/egress/detect.js';

const RUTA = new URL('../build/inject.js', import.meta.url);
const fuente = existsSync(RUTA) ? readFileSync(RUTA, 'utf8') : null;
const skip = !fuente && 'falta build/inject.js (npm run build:inject)';

const TARJETA = 'Mi tarjeta es 4111 1111 1111 1111, guárdala';
const NUMERO = '4111 1111 1111 1111';

function cuerpo(texto) {
  return JSON.stringify({
    action: 'next',
    messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
  });
}

const sse = (texto) => `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: texto })}\n\ndata: [DONE]\n\n`;

/**
 * Puerta real + mundo con la capa cargada.
 *
 * `askUser` es lo único simulado del diálogo: devuelve lo que diga `eleccion`,
 * que puede ser un valor o una función que lance (para el caso «diálogo caído»).
 * `sender` es un objeto cualquiera con `id`: la puerta lo usa como clave de
 * vault y de exclusión.
 */
function crearMundo({ modo, eleccion = () => 'cancel', stream = sse('ok') } = {}) {
  const diagnos = [];
  const stats = [];
  const gate = createEgressGate({
    getConfig: () => ({ mode: modo }),
    askUser: async (args) => {
      if (typeof eleccion === 'function') return eleccion(args);
      return eleccion;
    },
    onDiagnostic: (entry) => diagnos.push(entry),
    onStats: () => stats.push(1),
  });

  const sender = { id: 7 };
  const listeners = [];
  const salientes = [];
  const llamadas = [];
  const peticiones = [];

  const fetchNativo = async (input, init) => {
    peticiones.push({ input: String(input), init });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const boton = { disabled: false, matches: () => true, closest: () => boton };

  const window = {
    __NEXO_CONFIG__: {
      host: 'chatgpt.com',
      enabled: true,
      settings: { egress: { mode: modo } },
      language: 'es',
      version: '0.1.0',
      site: 'chatgpt',
    },
    location: { href: 'https://chatgpt.com/c/abc-12345678', hostname: 'chatgpt.com', pathname: '/c/abc-12345678', protocol: 'https:', search: '' },
    fetch: fetchNativo,
    addEventListener: (tipo, fn) => { if (tipo === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => {
      salientes.push(msg);
      if (msg.__nexo !== 'call') return;
      llamadas.push({ type: msg.type, payload: msg.payload });
      // El proceso principal contesta de forma asíncrona, como en producción.
      setTimeout(async () => {
        let data;
        try {
          if (msg.type === 'egress') {
            data = { __nexo: 'reply', id: msg.id, payload: await gate.handle({ sender, host: 'chatgpt.com', payload: msg.payload }) };
          } else if (msg.type === 'prepare') {
            data = { __nexo: 'reply', id: msg.id, payload: { text: msg.payload.prompt } };
          } else {
            data = { __nexo: 'reply', id: msg.id, payload: {} };
          }
        } catch (error) {
          data = { __nexo: 'reply', id: msg.id, error: String(error?.message || error) };
        }
        for (const fn of listeners) fn({ source: window, data });
      }, 0);
    },
    setTimeout,
    clearTimeout,
    DOMException,
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

  return { window, gate, sender, peticiones, llamadas, salientes, diagnos, stats };
}

const llamadasEgress = (mundo) => mundo.llamadas.filter((l) => l.type === 'egress');
const esperar = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('integración · enforce + tarjeta + redactar: sale [CARD_1] y no el número', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'redact' });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TARJETA),
  });
  await respuesta.text();
  await esperar();

  assert.equal(mundo.peticiones.length, 1, 'el mensaje salió');
  const enviado = JSON.parse(mundo.peticiones[0].init.body).messages[0].content.parts[0];
  assert.match(enviado, /\[CARD_1\]/, 'el cuerpo lleva el marcador de la puerta real');
  assert.equal(enviado.includes(NUMERO), false, 'el número no viaja');
  assert.equal(enviado.includes('4111'), false, 'ni el prefijo');

  const stats = mundo.gate.stats();
  assert.equal(stats.replaced, 1, 'la puerta contó una redacción');
  assert.equal(stats.blocked, 0);
});

test('integración · enforce + tarjeta + cancelar: AbortError y 0 peticiones', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'cancel' });

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo(TARJETA) }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.message, 'NEXO retuvo el envío');
      return true;
    },
  );
  await esperar();

  assert.equal(mundo.peticiones.length, 0, 'no salió ninguna petición');
  assert.equal(mundo.gate.stats().blocked, 1, 'la puerta contó el bloqueo');
});

test('integración · enforce + tarjeta + timeout: AbortError', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'timeout' });

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo(TARJETA) }),
    { name: 'AbortError' },
  );
  await esperar();
  assert.equal(mundo.peticiones.length, 0);
  assert.equal(mundo.gate.stats().blocked, 1);
});

test('integración · observe + tarjeta: pasa intacto y observed === 1', { skip }, async () => {
  const mundo = crearMundo({ modo: 'observe' });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TARJETA),
  });
  await respuesta.text();
  await esperar();

  assert.equal(mundo.peticiones.length, 1, 'el mensaje salió');
  const enviado = JSON.parse(mundo.peticiones[0].init.body).messages[0].content.parts[0];
  assert.equal(enviado, TARJETA, 'intacto, con el número');
  assert.equal(llamadasEgress(mundo).length, 1, 'la puerta se consultó una vez');
  assert.equal(mundo.gate.stats().observed, 1, 'la puerta lo contó como observado');
  assert.equal(mundo.gate.stats().blocked, 0);
});

test('integración · off + tarjeta: pasa y no hay ninguna llamada al puente', { skip }, async () => {
  const mundo = crearMundo({ modo: 'off' });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TARJETA),
  });
  await respuesta.text();
  await esperar();

  assert.equal(mundo.peticiones.length, 1);
  assert.equal(llamadasEgress(mundo).length, 0, 'con off no se consulta la puerta');
  assert.equal(mundo.window.__nexo.state.egress, null);
});

test('integración · enforce + email: pasa sin diálogo', { skip }, async () => {
  let preguntas = 0;
  const mundo = crearMundo({
    modo: 'enforce',
    eleccion: () => { preguntas += 1; return 'cancel'; },
  });
  const texto = 'escríbeme a ana@ejemplo.com cuando puedas';

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(texto),
  });
  await respuesta.text();
  await esperar();

  assert.equal(preguntas, 0, 'un dato medio no abre diálogo');
  assert.equal(mundo.peticiones.length, 1);
  const enviado = JSON.parse(mundo.peticiones[0].init.body).messages[0].content.parts[0];
  assert.equal(enviado, texto, 'el email viaja tal cual');
  const stats = mundo.gate.stats();
  assert.equal(stats.observed, 1, 'se registra como observado por la puerta');
  assert.equal(stats.blocked, 0);
});

test('integración · la puerta real detecta lo mismo que el detector local', { skip }, () => {
  // Ancla del caso 1: si `detectSensitive` deja de ver la tarjeta, el test de
  // redacción podría pasar por la razón equivocada.
  const hallazgos = detectSensitive(TARJETA);
  assert.equal(hallazgos.length, 1);
  assert.equal(hallazgos[0].type, 'card');
  assert.equal(hallazgos[0].severity, 'critical');
});

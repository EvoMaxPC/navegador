/**
 * Huecos del guardián de la etapa 4c: red de seguridad cuando `planRequest`
 * lanza, `canRewrite` con varios bloques y el timeout normalizado.
 *
 * Igual que en `inject-guard-integration.test.js`: el bundle real se ejecuta en
 * un `vm` y el puente va a un `createEgressGate` real. Lo único simulado es
 * `askUser` y la configuración.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

import { createEgressGate } from '../src/main/egressGate.js';

const RUTA = new URL('../build/inject.js', import.meta.url);
const fuente = existsSync(RUTA) ? readFileSync(RUTA, 'utf8') : null;
const skip = !fuente && 'falta build/inject.js (npm run build:inject)';

const TARJETA = 'Mi tarjeta es 4111 1111 1111 1111, guárdala';

const bodyChatGpt = (texto) => JSON.stringify({
  action: 'next',
  messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
});

/**
 * `init` cuyo `body` revienta en el acceso número `falla En`.
 *
 * No sirve un `input` con `url` que lance: eso explota antes, en el propio
 * `nexoFetch` (línea 894), fuera del `try`. Un `toJSON` que lance tampoco: el
 * cuerpo no se serializa hasta después, y `safeJson` se traga el error y la
 * petición acaba en «cuerpo-no-legible», que no es una excepción.
 *
 * Contando accesos el fallo cae donde interesa: dentro de `planRequest`, justo
 * después de leer el texto. El 1.º lo hace `typeof init?.body === 'string'`; el
 * 2.º, la lectura del texto; el 3.º, ya en la red de seguridad (`readBody`).
 */
function initQueLanzaEn(json, fallaEn) {
  let accesos = 0;
  return {
    method: 'POST',
    get body() {
      accesos += 1;
      if (fallaEn === 'siempre' || accesos === fallaEn) {
        throw new Error(`init.body roto en el acceso ${accesos}`);
      }
      return json;
    },
  };
}

function crearMundo({ modo, egressSettings = {}, eleccion = () => 'cancel', cuerpo, stream = '' } = {}) {
  const diagnos = [];
  const gate = createEgressGate({
    getConfig: () => ({ mode: modo }),
    askUser: async (args) => {
      diagnos.push({ tipo: 'askUser', allowed: args.allowed });
      return eleccion(args);
    },
    onDiagnostic: (entry) => diagnos.push({ tipo: 'diagnostico', ...entry }),
    onStats: () => {},
  });

  const sender = { id: 7 };
  const listeners = [];
  const llamadas = [];
  const peticiones = [];
  // El timeout del puente no viaja en el mensaje: se programa con `setTimeout`
  // al crear la promesa. Se registra para poder comprobarlo.
  const temporizadores = [];

  const fetchNativo = async (input, init) => {
    peticiones.push({ input: String(input), init });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const boton = { disabled: false, matches: () => true, closest: () => boton };

  const window = {
    __NEXO_CONFIG__: {
      host: 'chatgpt.com',
      enabled: true,
      settings: { egress: { mode: modo, ...egressSettings } },
      language: 'es',
      version: '0.1.0',
      site: 'chatgpt',
    },
    location: { href: 'https://chatgpt.com/c/abc-12345678', hostname: 'chatgpt.com', pathname: '/c/abc-12345678', protocol: 'https:', search: '' },
    fetch: fetchNativo,
    addEventListener: (tipo, fn) => { if (tipo === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => {
      if (msg.__nexo !== 'call') return;
      llamadas.push({ type: msg.type, payload: msg.payload });
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
    setTimeout: (fn, ms, ...resto) => { temporizadores.push(ms); return setTimeout(fn, ms, ...resto); },
    clearTimeout,
    DOMException,
    TextDecoder,
    TextEncoder,
    Blob,
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

  return { window, gate, peticiones, llamadas, diagnos, temporizadores, cuerpo };
}

const esperar = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const llamadasEgress = (mundo) => mundo.llamadas.filter((l) => l.type === 'egress');

test('h1 · enforce + tarjeta + planRequest que lanza: AbortError y 0 peticiones', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce' });

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', initQueLanzaEn(bodyChatGpt(TARJETA), 2)),
    (error) => {
      assert.equal(error.name, 'AbortError', 'se presenta como cancelación');
      assert.equal(error.message, 'NEXO retuvo el envío');
      return true;
    },
  );
  await esperar();

  assert.equal(mundo.peticiones.length, 0, 'el cuerpo con la tarjeta no llegó al servidor');
  assert.equal(llamadasEgress(mundo).length, 0, 'el guardián normal no llegó a correr: lo atrapó la red');
  assert.equal(mundo.window.__nexo.state.egress.reason, 'fail-safe');
});

test('h2 · enforce + texto sin datos + planRequest que lanza: pasa', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce' });
  const init = initQueLanzaEn(bodyChatGpt('hola, ¿cómo estás?'), 2);

  const respuesta = await mundo.window.fetch('/backend-api/conversation', init);
  await respuesta.text();
  await esperar();

  assert.equal(mundo.peticiones.length, 1, 'sin datos críticos el fallo no corta el envío');
  assert.equal(llamadasEgress(mundo).length, 0);
});

test('h3 · observe + tarjeta + planRequest que lanza: pasa', { skip }, async () => {
  const mundo = crearMundo({ modo: 'observe' });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', initQueLanzaEn(bodyChatGpt(TARJETA), 2));
  await respuesta.text();
  await esperar();

  assert.equal(mundo.peticiones.length, 1, 'observe no retiene nunca');
});

test('h4 · enforce + cuerpo no legible + planRequest que lanza: pasa (no se puede saber)', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce' });

  // El `body` revienta SIEMPRE: `planRequest` lanza sin texto y la red de
  // seguridad tampoco puede leerlo. Sin dato conocido, no se bloquea. (Con un
  // fallo de un solo acceso la red sí lee el cuerpo y bloquea: es lo correcto,
  // y lo cubre h1.)
  const respuesta = await mundo.window.fetch('/backend-api/conversation', initQueLanzaEn(bodyChatGpt(TARJETA), 'siempre'));
  await respuesta.text();
  await esperar();

  assert.equal(mundo.peticiones.length, 1, 'sin cuerpo legible no se inventa un bloqueo');
});

test('f1 · dos bloques + tarjeta: el diálogo no ofrece "redactar"', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'cancel' });
  const cuerpo = JSON.stringify({
    action: 'next',
    messages: [{
      id: 'm-1', author: { role: 'user' },
      content: { content_type: 'text', parts: ['primera 4111 1111 1111 1111', 'segunda sin datos'] },
    }],
  });

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo }),
    { name: 'AbortError' },
  );
  await esperar();

  const preguntas = mundo.diagnos.filter((d) => d.tipo === 'askUser');
  assert.equal(preguntas.length, 1, 'se abrió un diálogo');
  assert.equal(JSON.parse(JSON.stringify(preguntas[0].allowed)).includes('redact'), false,
    'sin redactar: no se puede reponer el texto en dos bloques');
  assert.equal(mundo.peticiones.length, 0);

  const egress = llamadasEgress(mundo)[0];
  assert.equal(egress.payload.canRewrite, false, 'la capa lo dijo antes de preguntar');
  assert.equal(JSON.parse(JSON.stringify(egress.payload.slots)).length, 2, 'los dos bloques viajaron');
});

test('f2 · un solo bloque: sigue ofreciendo redactar', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'redact' });
  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: JSON.stringify({
      action: 'next',
      messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [TARJETA] } }],
    }),
  });
  await respuesta.text();
  await esperar();

  const preguntas = mundo.diagnos.filter((d) => d.tipo === 'askUser');
  assert.equal(JSON.parse(JSON.stringify(preguntas[0].allowed)).includes('redact'), true);
  assert.match(JSON.parse(mundo.peticiones[0].init.body).messages[0].content.parts[0], /\[CARD_1\]/);
});

test('e1 · decisionTimeoutMs 999999999: el puente espera 605000 ms', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', egressSettings: { decisionTimeoutMs: 999999999 }, eleccion: () => 'cancel' });

  await assert.rejects(() => mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: JSON.stringify({ action: 'next', messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [TARJETA] } }] }),
  }), { name: 'AbortError' });

  // La puerta normaliza 999999999 a 600000; la capa tiene que esperar lo mismo + margen.
  const largos = mundo.temporizadores.filter((ms) => ms > 1000);
  assert.deepEqual(largos, [605000], `temporizadores largos: ${JSON.stringify(largos)}`);
});

test('e2 · sin decisionTimeoutMs: el puente espera 125000 ms', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'cancel' });

  await assert.rejects(() => mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: JSON.stringify({ action: 'next', messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [TARJETA] } }] }),
  }), { name: 'AbortError' });

  const largos = mundo.temporizadores.filter((ms) => ms > 1000);
  assert.deepEqual(largos, [125000], `temporizadores largos: ${JSON.stringify(largos)}`);
});

test('5a · bloqueo por la puerta: ni un evento con stage egress-blocked', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'cancel' });
  mundo.window.addEventListener('message', () => {});
  const eventos = [];
  const postOriginal = mundo.window.postMessage;
  mundo.window.postMessage = (msg) => { if (msg?.__nexo === 'event') eventos.push(msg); return postOriginal(msg); };

  await assert.rejects(() => mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: bodyChatGpt(TARJETA),
  }), { name: 'AbortError' });
  await esperar();

  assert.equal(eventos.filter((e) => e.payload?.stage === 'egress-blocked').length, 0,
    'la puerta ya avisó: no se duplica el diagnóstico');
  // La puerta sí dejó su diagnóstico propio.
  assert.equal(mundo.diagnos.filter((d) => d.code === 'egress-block').length, 1);
});

test('5a · bloqueo por planFallido: un evento con stage egress-fail-safe', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce' });
  const eventos = [];
  const postOriginal = mundo.window.postMessage;
  mundo.window.postMessage = (msg) => { if (msg?.__nexo === 'event') eventos.push(msg); return postOriginal(msg); };

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', initQueLanzaEn(bodyChatGpt(TARJETA), 2)),
    { name: 'AbortError' },
  );
  await esperar();

  const avisos = eventos.filter((e) => e.payload?.stage === 'egress-fail-safe');
  assert.equal(avisos.length, 1, 'la red de seguridad sí avisa');
  assert.equal(avisos[0].payload.message, 'planRequest falló con datos críticos; envío retenido');
  assert.equal(String(avisos[0].payload.message).includes('4111'), false, 'sin valores del usuario');
  assert.equal(eventos.filter((e) => e.payload?.stage === 'egress-blocked').length, 0);
});

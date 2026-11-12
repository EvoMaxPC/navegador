/**
 * El gesto de envío y el guardián: que un envío retenido no cuente.
 *
 * Defecto de la etapa 4 (verificado en 4b-g): al pulsar Enviar, `gestoDeEnvio`
 * programa un temporizador de `ESPERA_PETICION_MS` (2,5 s) que anuncia el envío
 * si la petición no lo consume antes. En `enforce` la consulta a la puerta puede
 * tardar más que eso (el diálogo espera al usuario), así que un mensaje que
 * acaba **retenido** quedaba contado como enviado por la vía del gesto.
 *
 * El reloj es simulado (`Date.now` falso) para que 2,5 s no sean 2,5 s reales.
 * El bundle se ejecuta en un `vm` con la puerta real de `createEgressGate`.
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
const TEXTO_NORMAL = 'hola, ¿me ayudas con esto?';

const cuerpo = (texto) => JSON.stringify({
  action: 'next',
  messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
});

/**
 * Reloj falso.
 *
 * `Date.now` avanza cuando el test lo pide y los temporizadores se disparan a
 * mano con `avanzar(ms)`, en orden. Así se reproduce «el usuario tarda 4 s en
 * contestar al diálogo» sin esperar 4 s.
 */
function crearReloj(inicio = 1_700_000_000_000) {
  let ahora = inicio;
  let seq = 0;
  const pendientes = new Map();

  const setTimeoutFalso = (fn, ms) => {
    seq += 1;
    pendientes.set(seq, { fn, at: ahora + Math.max(0, Number(ms) || 0), seq });
    return seq;
  };
  const clearTimeoutFalso = (id) => { pendientes.delete(id); };

  return {
    now: () => ahora,
    setTimeout: setTimeoutFalso,
    clearTimeout: clearTimeoutFalso,
    programados: () => [...pendientes.values()].map((t) => t.at - ahora),
    /** Avanza el reloj y dispara los timers que vencen, en orden. */
    avanzar(ms) {
      const destino = ahora + ms;
      for (;;) {
        const vencidos = [...pendientes.values()].filter((t) => t.at <= destino).sort((a, b) => a.at - b.at || a.seq - b.seq);
        if (!vencidos.length) break;
        const t = vencidos[0];
        pendientes.delete(t.seq);
        ahora = t.at;
        t.fn();
      }
      ahora = destino;
    },
    /** Deja correr las microtareas (promesas) sin mover el reloj. */
    async asentar() {
      for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
    },
  };
}

function crearMundo({ modo = 'off', eleccion = () => 'cancel', texto = TARJETA, demoraDialogo = 0 } = {}) {
  const reloj = crearReloj();
  const eventos = [];
  const consultas = [];
  const peticiones = [];

  const gate = createEgressGate({
    getConfig: () => ({ mode: modo }),
    // El diálogo tarda: el usuario piensa. En tiempo simulado, `demoraDialogo`.
    askUser: async (args) => {
      consultas.push({ allowed: [...args.allowed] });
      if (demoraDialogo) reloj.avanzar(demoraDialogo);
      return eleccion(args);
    },
    onDiagnostic: () => {},
    onStats: () => {},
  });

  const sender = { id: 7 };
  const listeners = [];

  const fetchNativo = async (input, init) => {
    peticiones.push({ input: String(input), init });
    return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const cuadro = {
    tagName: 'DIV',
    isContentEditable: true,
    innerText: texto,
    textContent: texto,
    focus() {},
    closest: (sel) => (/contenteditable|prompt/i.test(String(sel)) ? cuadro : null),
  };
  const boton = {
    disabled: false,
    closest: (sel) => (/button/i.test(String(sel)) ? boton : null),
    matches: (sel) => /send-button|Send|Enviar/i.test(String(sel)),
  };
  const manejadores = {};

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
      if (msg.__nexo === 'event') eventos.push({ type: msg.type, payload: msg.payload });
      if (msg.__nexo !== 'call') return;
      setTimeoutQueue.push(() => {});
      Promise.resolve().then(async () => {
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
      });
    },
    setTimeout: reloj.setTimeout,
    clearTimeout: reloj.clearTimeout,
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
    document: {
      querySelector: (sel) => (/prompt|textarea|contenteditable/i.test(String(sel)) ? cuadro : null),
      querySelectorAll: () => [],
      addEventListener: (tipo, fn) => { (manejadores[tipo] ||= []).push(fn); },
    },
  };
  // El bundle usa `Date.now` para las ventanas del gesto.
  window.Date = { now: reloj.now, prototype: Date.prototype };
  window.window = window;

  const setTimeoutQueue = [];

  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });

  return {
    window,
    gate,
    reloj,
    eventos,
    consultas,
    peticiones,
    /** Pulsa Enviar en el cuadro, como la persona. */
    pulsarEnviar: () => { for (const fn of manejadores.click || []) fn({ target: boton, isTrusted: true }); },
    /** Cuenta cuántos mensajes del usuario se anunciaron. */
    mensajes: () => eventos.filter((e) => e.type === 'outgoing' && e.payload?.source !== 'cdu'),
  };
}

/**
 * Un envío completo: clic, aviso de la petición y, si toca, el temporizador del
 * gesto. Devuelve cuántos mensajes se contaron al final.
 */
async function cicloEnvio(mundo, { texto = TARJETA, esperaPeticion = 300, tardar = 0 } = {}) {
  mundo.pulsarEnviar();
  await mundo.reloj.asentar();
  // La petición sale casi enseguida, pero la consulta a la puerta se demora.
  if (esperaPeticion) mundo.reloj.avanzar(esperaPeticion);
  await mundo.reloj.asentar();

  const promesa = mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo(texto) }).catch((e) => e);
  // Mientras el diálogo está abierto pasa el tiempo: si esto supera los 2,5 s,
  // el temporizador del gesto vence antes de que se sepa la decisión.
  if (tardar) mundo.reloj.avanzar(tardar);
  await mundo.reloj.asentar();
  const resultado = await promesa;
  await mundo.reloj.asentar();
  // Y después del envío, el resto del tiempo del temporizador.
  mundo.reloj.avanzar(5000);
  await mundo.reloj.asentar();
  return resultado;
}

test('b1 · enforce + tarjeta + cancelar tras 4 s: el mensaje NO se cuenta', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'cancel', demoraDialogo: 4000 });

  const resultado = await cicloEnvio(mundo, { tardar: 4000 });

  assert.equal(resultado?.name, 'AbortError', 'el envío se retuvo');
  assert.equal(mundo.peticiones.length, 0, 'no llegó ninguna petición');
  assert.equal(mundo.mensajes().length, 0, 'y no se contó ningún mensaje');
});

test('b2 · enforce + tarjeta + timeout del diálogo: el mensaje NO se cuenta', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'timeout', demoraDialogo: 4000 });

  const resultado = await cicloEnvio(mundo, { tardar: 4000 });

  assert.equal(resultado?.name, 'AbortError');
  assert.equal(mundo.peticiones.length, 0);
  assert.equal(mundo.mensajes().length, 0, 'tampoco con timeout');
});

test('b3 · enforce + tarjeta + redactar tras 4 s: cuenta UN mensaje, no dos', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', eleccion: () => 'redact', demoraDialogo: 4000 });

  await cicloEnvio(mundo, { tardar: 4000 });

  assert.equal(mundo.peticiones.length, 1, 'el mensaje salió');
  const enviado = JSON.parse(mundo.peticiones[0].init.body).messages[0].content.parts[0];
  assert.match(enviado, /\[CARD_1\]/, 'salió redactado');
  assert.equal(mundo.mensajes().length, 1, `mensajes contados: ${mundo.mensajes().length}`);
});

test('b4 · enforce sin datos sensibles: el conteo no cambia (1)', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', texto: TEXTO_NORMAL });

  await cicloEnvio(mundo, { texto: TEXTO_NORMAL });

  assert.equal(mundo.peticiones.length, 1);
  assert.equal(mundo.mensajes().length, 1, `mensajes contados: ${mundo.mensajes().length}`);
});

test('b5 · off y observe: el gesto no se retiene (el timer del gesto cuenta solo)', { skip }, async () => {
  for (const modo of ['off', 'observe']) {
    const mundo = crearMundo({ modo, eleccion: () => 'cancel', demoraDialogo: 4000 });
    // Sin petición: el gesto tiene que contar por su cuenta, como siempre.
    mundo.pulsarEnviar();
    await mundo.reloj.asentar();
    mundo.reloj.avanzar(3000);
    await mundo.reloj.asentar();
    assert.equal(mundo.mensajes().length, 1, `${modo}: el gesto cuenta solo`);
  }
});

test('b6 · una excepción en la consulta libera el gesto', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', texto: TEXTO_NORMAL });

  // El puente no contesta nunca a `egress`: `bridge.request` rechaza con
  // `nexo:timeout:egress` al vencer su propio plazo. Es el fallo más realista
  // de la consulta sin tocar `src/`.
  const original = mundo.window.postMessage;
  mundo.window.postMessage = (msg) => {
    if (msg.__nexo === 'call' && msg.type === 'egress') return; // silencio
    return original(msg);
  };

  mundo.pulsarEnviar();
  await mundo.reloj.asentar();
  mundo.reloj.avanzar(300);
  await mundo.reloj.asentar();

  const promesa = mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TEXTO_NORMAL),
  });
  // Se pasa de largo el plazo del puente (125 s) para que rechace.
  for (let i = 0; i < 30; i += 1) {
    mundo.reloj.avanzar(10_000);
    await mundo.reloj.asentar();
  }
  const resultado = await promesa;
  await mundo.reloj.asentar();
  mundo.reloj.avanzar(10_000);
  await mundo.reloj.asentar();

  assert.equal(resultado?.status, 200, 'sin datos críticos el envío sigue pese al fallo del puente');
  assert.equal(mundo.peticiones.length, 1, 'una sola petición');
  assert.equal(mundo.mensajes().length, 1, `no queda retenido ni se cuenta dos veces: ${mundo.mensajes().length}`);
});

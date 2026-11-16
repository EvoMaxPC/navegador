/**
 * El guardián de salida dentro de la capa inyectada, ejecutado de verdad.
 *
 * `build/inject.js` se carga en un contexto con las mismas piezas que le da el
 * navegador y un proceso principal de mentira que contesta al puente. Se
 * comprueba lo que importa: si el mensaje sale, si sale redactado y si el
 * guardián se calla cuando debe callarse.
 *
 * El `vault` real vive en el proceso principal; acá la redacción llega ya hecha
 * desde el puente, que es exactamente lo que la capa recibe en producción.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const RUTA = new URL('../build/inject.js', import.meta.url);
const fuente = existsSync(RUTA) ? readFileSync(RUTA, 'utf8') : null;
const skip = !fuente && 'falta build/inject.js (npm run build:inject)';

/** Cuerpo de un envío normal de ChatGPT, con `parts` como la del sitio. */
function cuerpo(texto, extra = []) {
  return JSON.stringify({
    action: 'next',
    messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: [texto, ...extra] } }],
  });
}

/** Stream SSE mínimo, para que la respuesta se cierre sola. */
function sse(texto) {
  return `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: texto })}\n\ndata: [DONE]\n\n`;
}

/**
 * Un mundo mínimo con la capa cargada.
 *
 * `egress` decide qué contesta el proceso principal al canal del guardián;
 * `preparar` decide qué contesta a la mediación. Todo lo que la capa pide al
 * puente queda en `llamadas`, en orden.
 */
function crearMundo({ modo = 'off', egress = null, preparar = (payload) => ({ text: payload.prompt }), pathname = '/c/abc-12345678', stream = sse('ok') } = {}) {
  const listeners = [];
  const salientes = [];
  const llamadas = [];
  const peticiones = [];

  const fetchNativo = async (input, init) => {
    peticiones.push({ input: String(input), init });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const boton = { disabled: false, matches: () => true, closest: () => boton };
  const objetivo = { closest: () => boton };

  const window = {
    __NEXO_CONFIG__: {
      host: 'chatgpt.com',
      enabled: true,
      settings: { egress: { mode: modo } },
      language: 'es',
      version: '0.1.0',
      site: 'chatgpt',
    },
    location: { href: `https://chatgpt.com${pathname}`, hostname: 'chatgpt.com', pathname, protocol: 'https:', search: pathname.includes('?') ? `?${pathname.split('?')[1]}` : '' },
    fetch: fetchNativo,
    addEventListener: (tipo, fn) => { if (tipo === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => {
      salientes.push(msg);
      if (msg.__nexo !== 'call') return;
      llamadas.push({ type: msg.type, payload: msg.payload });
      const responder = msg.type === 'egress' ? egress : msg.type === 'prepare' ? preparar : null;
      if (!responder) return;
      setTimeout(() => {
        let data;
        try {
          data = { __nexo: 'reply', id: msg.id, payload: responder(msg.payload) };
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
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  };
  window.window = window;

  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });

  return { window, salientes, llamadas, peticiones, objetivo };
}

// Los payloads nacen dentro del contexto `vm`: otro realm, otro `Array.prototype`.
// Se comparan por valor serializado para no medir el prototipo.
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const llamadasDe = (mundo, tipo) => mundo.llamadas.filter((l) => l.type === tipo);
const eventos = (mundo, tipo) => mundo.salientes.filter((m) => m.__nexo === 'event' && m.type === tipo);

const TARJETA = 'Mi tarjeta es 4111 1111 1111 1111, guárdala';

test('observe: el mensaje pasa, el puente es llamado y no se reescribe nada', { skip }, async () => {
  const mundo = crearMundo({
    modo: 'observe',
    // La puerta, en modo observación, contesta `pass` y cuenta; lo que importa
    // acá es que la capa pregunte y que después no toque el cuerpo.
    egress: () => ({ action: 'pass' }),
  });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TARJETA),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  const consultas = llamadasDe(mundo, 'egress');
  assert.equal(consultas.length, 1, 'el guardián preguntó una vez');
  assert.deepEqual(plano(consultas[0].payload.slots), [TARJETA], 'mandó el texto del mensaje, no el cuerpo entero');
  assert.equal(consultas[0].payload.canRewrite, true, 'en este sitio se puede redactar');
  assert.equal(mundo.peticiones.length, 1, 'el mensaje salió');
  assert.equal(JSON.parse(mundo.peticiones[0].init.body).messages[0].content.parts[0], TARJETA,
    'observe no reescribe aunque la puerta conteste otra cosa');
  assert.equal(eventos(mundo, 'outgoing').length, 1, 'se cuenta como envío');
});

test('observe: aunque la puerta pida bloquear, el mensaje pasa', { skip }, async () => {
  const mundo = crearMundo({ modo: 'observe', egress: () => ({ action: 'block', reason: 'cancelado' }) });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TARJETA),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(mundo.peticiones.length, 1, 'el mensaje salió igual');
  assert.equal(mundo.window.__nexo.state.egress.action, 'pass', 'el veredicto local es pass');
  assert.equal(mundo.window.__nexo.state.egress.reason, 'observado:block', 'y queda la constancia de lo que pidió la puerta');
});

test('enforce + dato crítico: el mensaje no sale y el fetch aborta', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', egress: () => ({ action: 'block', reason: 'cancelado' }) });

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo(TARJETA) }),
    (error) => {
      assert.equal(error.name, 'AbortError', 'se presenta como cancelación, no como error propio');
      assert.equal(error.message, 'NEXO retuvo el envío');
      return true;
    },
  );
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(mundo.peticiones.length, 0, 'no llegó ninguna petición al servidor');
  assert.equal(eventos(mundo, 'outgoing').length, 0, 'no se cuenta un envío que no salió');
  assert.equal(llamadasDe(mundo, 'egress')[0].payload.slots[0], TARJETA);
});

test('enforce + redactado: sale el texto saneado y el motor registra ese texto', { skip }, async () => {
  const SANEADO = 'Mi tarjeta es [CARD_1], guárdala';
  const mundo = crearMundo({ modo: 'enforce', egress: () => ({ action: 'replace', slots: [SANEADO] }) });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TARJETA, [{ type: 'image' }]),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  const enviado = JSON.parse(mundo.peticiones[0].init.body);
  assert.equal(enviado.messages[0].content.parts[0], SANEADO, 'el cuerpo salió redactado');
  assert.deepEqual(plano(enviado.messages[0].content.parts[1]), { type: 'image' }, 'los adjuntos no se tocan');

  const aviso = eventos(mundo, 'outgoing')[0].payload;
  assert.equal(aviso.tokenText, SANEADO, 'lo que se cuenta es lo que se envió');
  assert.equal(aviso.chars, TARJETA.length, 'el tamaño del contador sigue siendo lo que escribió la persona');

  // La mediación recibe el texto saneado, no el original.
  assert.equal(llamadasDe(mundo, 'prepare')[0].payload.prompt, SANEADO, 'el motor no ve el dato');
});

test('chat temporal: el guardián sigue operando y retiene', { skip }, async () => {
  const mundo = crearMundo({
    modo: 'enforce',
    pathname: '/?temporary-chat=true',
    egress: () => ({ action: 'block', reason: 'cancelado' }),
  });

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo(TARJETA) }),
    { name: 'AbortError' },
  );
  assert.equal(llamadasDe(mundo, 'egress').length, 1, 'el chat temporal no se salta al guardián');
  assert.equal(mundo.peticiones.length, 0);
});

test('modo off: no se llama al puente y no se toca nada', { skip }, async () => {
  const mundo = crearMundo({ modo: 'off' });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo(TARJETA),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(llamadasDe(mundo, 'egress').length, 0, 'con la puerta apagada no hay ni una consulta');
  assert.equal(mundo.peticiones.length, 1);
  assert.equal(mundo.window.__nexo.state.egress, null, 'ni veredicto');
});

test('si el puente falla, decide el detector local: crítico retiene, el resto pasa', { skip }, async () => {
  const caido = () => { throw new Error('nexo:timeout:egress'); };

  const conTarjeta = crearMundo({ modo: 'enforce', egress: caido });
  await assert.rejects(
    () => conTarjeta.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo(TARJETA) }),
    { name: 'AbortError' },
  );
  assert.equal(conTarjeta.window.__nexo.state.egress.reason, 'fail-safe');
  assert.equal(conTarjeta.peticiones.length, 0);

  const sinDatos = crearMundo({ modo: 'enforce', egress: caido });
  const respuesta = await sinDatos.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo('hola, ¿cómo estás?'),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sinDatos.peticiones.length, 1, 'sin datos críticos el fallo del puente no corta el envío');
  assert.equal(sinDatos.window.__nexo.state.egress.action, 'pass');
});

test('un email medio no se redacta en modo enforce', { skip }, async () => {
  // La puerta real tampoco interrumpe por datos medios; acá se comprueba que la
  // capa no convierte `pass` en nada raro.
  const mundo = crearMundo({ modo: 'enforce', egress: () => ({ action: 'pass' }) });
  const texto = 'escríbeme a ana@ejemplo.com';
  const respuesta = await mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo(texto) });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(mundo.peticiones.length, 1);
  assert.equal(JSON.parse(mundo.peticiones[0].init.body).messages[0].content.parts[0], texto);
});

test('sólo viajan los strings: los adjuntos del array de partes no se envían', { skip }, async () => {
  const mundo = crearMundo({ modo: 'observe', egress: () => ({ action: 'pass' }) });
  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpo('texto con tarjeta 4111 1111 1111 1111', [{ type: 'image', url: 'x' }, 42, null]),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  const slots = plano(llamadasDe(mundo, 'egress')[0].payload.slots);
  assert.equal(slots.length, 1, 'un solo slot');
  assert.equal(typeof slots[0], 'string');
  assert.ok(slots[0].startsWith('texto con tarjeta'), 'el slot es el texto, no el adjunto');
});

test('cuerpo ilegible: la capa declara el motivo y no inventa texto', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', egress: () => ({ action: 'pass', reason: 'stream-o-desconocido' }) });
  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: 'no soy json',
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  const consulta = llamadasDe(mundo, 'egress')[0];
  assert.equal(consulta.payload.unreadable, 'stream-o-desconocido', 'declara el motivo');
  assert.equal(consulta.payload.slots, undefined, 'sin slots: no hay texto que juzgar');
  assert.equal(mundo.peticiones.length, 1, 'con onUnreadable=pass el envío sigue');
});

test('cuerpo ilegible con onUnreadable=block: se retiene sin redactar', { skip }, async () => {
  const mundo = crearMundo({ modo: 'enforce', egress: () => ({ action: 'block', reason: 'stream-o-desconocido' }) });
  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: 'no soy json' }),
    { name: 'AbortError' },
  );
  assert.equal(mundo.peticiones.length, 0);
});

test('DPU de ChatGPT: el guardián corre y puede retener', { skip }, async () => {
  const mundo = crearMundo({
    modo: 'enforce',
    egress: () => ({ action: 'block', reason: 'cancelado' }),
  });
  const cuerpoForm = new URLSearchParams({ prompt: TARJETA }).toString();

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/unauth-mweb/conversation/updates', { method: 'POST', body: cuerpoForm }),
    { name: 'AbortError' },
  );
  const consulta = llamadasDe(mundo, 'egress')[0];
  assert.equal(consulta.payload.canRewrite, false, 'en DPU no se ofrece redactar: el cuerpo lo reescribe el proceso principal');
  assert.equal(mundo.peticiones.length, 0);
});

test('dos bloques de texto: viajan los dos y, si hay redacción, se retiene', { skip }, async () => {
  const mundo = crearMundo({
    modo: 'enforce',
    egress: () => ({ action: 'replace', slots: ['[CARD_1]', '[CARD_2]'] }),
  });
  const cuerpoDos = JSON.stringify({
    action: 'next',
    messages: [{
      id: 'm-1', author: { role: 'user' },
      content: { content_type: 'text', parts: ['primera 4111 1111 1111 1111', 'segunda 5500 0000 0000 0004'] },
    }],
  });

  await assert.rejects(
    () => mundo.window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpoDos }),
    { name: 'AbortError' },
  );
  assert.equal(llamadasDe(mundo, 'egress')[0].payload.slots.length, 2, 'los dos strings viajaron al guardián');
  assert.equal(mundo.peticiones.length, 0, 'con dos bloques no se adivina cuál reponer: se retiene');
});

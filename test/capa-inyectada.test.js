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

  // Cuadro de diálogo y botón de enviar falsos, lo mínimo que toca la capa.
  const cuadro = options.cuadro || null;
  const boton = { disabled: false, matches: (sel) => /send-button|Send|Enviar/i.test(String(sel)), closest: () => boton };
  const objetivo = {
    // Cualquier selector de botón de envío que pregunte la capa da con el botón.
    closest: (sel) => (/button/i.test(String(sel)) ? boton : cuadro ? cuadro.closest(sel) : null),
  };
  const manejadores = { click: [], keydown: [] };

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
    document: {
      // `selectoresDesactualizados` simula que el sitio cambió el marcado: los
      // selectores del perfil ya no dan con el cuadro y sólo queda el genérico.
      querySelector: (sel) => {
        if (!cuadro) return null;
        if (options.selectoresDesactualizados) return String(sel) === '[contenteditable="true"]' ? cuadro : null;
        return /prompt|textarea|contenteditable/i.test(String(sel)) ? cuadro : null;
      },
      querySelectorAll: () => [],
      addEventListener: (tipo, fn) => {
        if (!manejadores[tipo]) manejadores[tipo] = [];
        manejadores[tipo].push(fn);
      },
    },
  };
  window.window = window;

  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });

  /** Un cuadro con texto, como el del sitio. */
  const pulsar = (tipo, evento) => {
    for (const fn of manejadores[tipo] || []) fn(evento);
  };
  const pulsarEnviar = () => pulsar('click', { target: objetivo });
  const pulsarEnter = () =>
    pulsar('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: objetivo });
  const pulsarFormulario = () => pulsar('submit', { target: objetivo });

  return { window, salientes, peticiones, pulsarEnviar, pulsarEnter, pulsarFormulario };
}

/** Cuadro de diálogo falso con el texto que el usuario escribió. */
function cuadroCon(texto) {
  const el = {
    tagName: 'DIV',
    innerText: texto,
    textContent: texto,
    focus() {},
    closest: (sel) => (/contenteditable|prompt/i.test(String(sel)) ? el : null),
  };
  return el;
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

/* ------------------------------------------------------------------ */
/* el gesto de enviar: la señal que no depende del cuerpo              */
/* ------------------------------------------------------------------ */

test('pulsar Enviar y luego salir la petición cuenta un solo mensaje', { skip: !fuente && 'falta build/inject.js' }, async () => {
  const mundo = crearMundo({ stream: sse('Hola mundo'), cuadro: cuadroCon('hola mundo') });

  mundo.pulsarEnviar();
  // El mismo envío visto dos veces (el click que dispara el Enter, y el Enter).
  mundo.pulsarEnter();
  await new Promise((r) => setTimeout(r, 20));

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: cuerpoChatGPT('hola mundo'),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 60));

  const envios = eventos(mundo, 'outgoing');
  assert.equal(envios.length, 1, 'un envío, un mensaje');
  assert.equal(envios[0].payload.source, 'request', 'lo confirmó la petición, con su texto');
  assert.equal(envios[0].payload.chars, 10);
  assert.ok(envios[0].payload.promptHash, 'lleva la huella del texto para deduplicar con CDP');
});

test('si la petición no aparece, el gesto cuenta el mensaje solo', { skip: !fuente && 'falta build/inject.js' }, async () => {
  const mundo = crearMundo({ cuadro: cuadroCon('¿me ayudás?') });

  mundo.pulsarEnviar();
  await new Promise((r) => setTimeout(r, 2700));

  const envios = eventos(mundo, 'outgoing');
  assert.equal(envios.length, 1, 'el gesto alcanza para contar el mensaje');
  assert.equal(envios[0].payload.source, 'composer');
  assert.equal(envios[0].payload.chars, '¿me ayudás?'.length);
  assert.ok(envios[0].payload.tokens > 0, 'con sus tokens estimados');
});

test('un envío sin cuerpo legible se cuenta igual, sin inventar caracteres', { skip: !fuente && 'falta build/inject.js' }, async () => {
  const mundo = crearMundo({ stream: sse('ok') });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: 'esto-no-es-json',
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  const envios = eventos(mundo, 'outgoing');
  assert.equal(envios.length, 1, 'el mensaje existe aunque no se pueda leer el texto');
  assert.equal(envios[0].payload.chars, 0, 'sin caracteres inventados');
  assert.equal(envios[0].payload.tokens, 0, 'ni tokens inventados');
  assert.equal(envios[0].payload.textFound, false, 'y se dice que no se leyó el texto');
  assert.equal(eventos(mundo, 'stream-end').length, 1, 'la respuesta se captura igual');
});

test('regenerar no es un mensaje del usuario', { skip: !fuente && 'falta build/inject.js' }, async () => {
  const mundo = crearMundo({ stream: sse('otra versión') });

  const respuesta = await mundo.window.fetch('/backend-api/conversation', {
    method: 'POST',
    body: JSON.stringify({ action: 'variant', conversation_id: 'abc-12345678', messages: [] }),
  });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(eventos(mundo, 'outgoing').length, 0, 'no hay mensaje nuevo');
  assert.equal(eventos(mundo, 'stream-end').length, 1, 'pero la respuesta nueva sí se captura');
});

test('si los selectores del cuadro envejecen, el gesto cuenta el mensaje igual', { skip: !fuente && 'falta build/inject.js' }, async () => {
  // ChatGPT cambia el marcado seguido: `#prompt-textarea` deja de existir. El
  // mensaje se tiene que contar por el cuadro editable que haya.
  const mundo = crearMundo({ cuadro: cuadroCon('¿seguís ahí?'), selectoresDesactualizados: true });

  mundo.pulsarEnviar();
  await new Promise((r) => setTimeout(r, 2700));

  const envios = eventos(mundo, 'outgoing');
  assert.equal(envios.length, 1, 'un envío, con el cuadro que haya');
  assert.equal(envios[0].payload.source, 'composer');
  assert.equal(envios[0].payload.chars, '¿seguís ahí?'.length, 'y con el texto real, no inventado');
});

test('un formulario que se envía también es el gesto de enviar', { skip: !fuente && 'falta build/inject.js' }, async () => {
  const mundo = crearMundo({ cuadro: cuadroCon('por formulario') });

  mundo.pulsarFormulario();
  await new Promise((r) => setTimeout(r, 2700));

  const envios = eventos(mundo, 'outgoing');
  assert.equal(envios.length, 1, 'el submit cuenta el mensaje');
  assert.equal(envios[0].payload.source, 'composer');
});

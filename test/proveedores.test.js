/**
 * Pruebas de proveedor: cómo se lee y se reescribe el stream de cada sitio.
 *
 * Acá se juntan las tres piezas que tienen que entenderse entre sí:
 *
 *   · el stream de cable de cada proveedor (SSE con parches, acumulado, Claude),
 *   · el filtro que recorta el texto repetido,
 *   · el enganche de `fetch` que reescribe la petición y envuelve la respuesta.
 *
 * Las respuestas son las formas reales que mandan ChatGPT y Claude, incluidos
 * los casos que rompían la mediación: `parts` que se convertía en un string, el
 * eco del usuario tomado como texto, el texto retenido que llegaba después del
 * cierre, los emojis partidos al medio y el mensaje duplicado cuando la red
 * fallaba.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStreamFilter } from '../src/core/streamFilter.js';
import { parseSSE } from '../src/core/sse.js';
import { detectSite, isAuthRequest, isChatRequest, isMediable, locateUserText, patchUserText } from '../src/core/sites.js';
import { StreamSentinel } from '../src/core/streamSentinel.js';
import { chunk } from './fixtures.js';

const encoder = new TextEncoder();
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------ */
/* utilidades                                                          */
/* ------------------------------------------------------------------ */

/** Corre el filtro con trozos de red de un tamaño dado. */
async function correr(payload, opts = {}, chunkSize = 37) {
  const bytes = encoder.encode(payload);
  const source = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  const stops = [];
  const ends = [];
  const filter = createStreamFilter({
    settings: opts.settings || { receiving: { severityThreshold: 'medium', stopOnLoop: true } },
    adapter: opts.adapter || null,
    deltaPaths: opts.deltaPaths || null,
    onStop: (info) => stops.push(info),
    onEnd: (info) => ends.push(info),
  });
  const out = await new Response(source.pipeThrough(filter)).text();
  return { out, events: parseSSE(out).events, stops, ends };
}

function datos(events) {
  return events.map((evt) => {
    try {
      return { nombre: evt.event, json: JSON.parse(evt.data) };
    } catch {
      return { nombre: evt.event, json: null };
    }
  });
}

/** Cliente mínimo de ChatGPT (protocolo de parches): aplica las operaciones. */
function clienteChatGPT(events) {
  let texto = '';
  const orden = [];
  const porEvento = [];
  for (const { nombre, json } of datos(events)) {
    if (!json) continue;
    porEvento.push({ nombre, json, texto });
    const ops = json.o === 'patch' && Array.isArray(json.v) ? json.v : [json];
    for (const op of ops) {
      if (op.p === '/message' && op.v?.author?.role === 'user') orden.push('usuario');
      if (op.p === '/message/status') orden.push(String(op.v));
      if (typeof op.v === 'string' && /^\/message\/content\/parts\/\d+$/.test(op.p || '')) texto += op.v;
      else if (!op.p && typeof op.v === 'string') texto += op.v;
    }
    if (json.type === 'message_stream_complete') orden.push('complete');
  }
  return { texto, orden, porEvento };
}

/** Cliente mínimo de Claude: acumula `delta.text`. */
function clienteClaude(events) {
  let texto = '';
  const orden = [];
  for (const { json } of datos(events)) {
    if (!json) continue;
    if (json.type === 'content_block_delta' && typeof json.delta?.text === 'string') texto += json.delta.text;
    if (json.type) orden.push(json.type);
    if (typeof json.completion === 'string') {
      texto = json.completion;
      if (json.stop_reason) orden.push('stop_reason');
    }
  }
  return { texto, orden };
}

const TEXTO = [
  'Primero conviene medir antes de optimizar: sin números, cualquier cambio parece una mejora.',
  'Segundo, el corte tiene que ser limpio y en el inicio de la repetición.',
  'Tercero: el texto retenido jamás puede llegar después del cierre del mensaje.',
].join(' ');

/* ------------------------------------------------------------------ */
/* ChatGPT: protocolo de parches                                        */
/* ------------------------------------------------------------------ */

function streamChatGPTParches(texto, { size = 11, conCierre = true } = {}) {
  let out = '';
  out += `event: delta\ndata: ${JSON.stringify({
    p: '/message',
    o: 'add',
    v: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] } },
  })}\n\n`;
  for (const trozo of chunk(texto, size)) {
    out += `event: delta\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: trozo })}\n\n`;
  }
  if (conCierre) {
    out += `event: delta\ndata: ${JSON.stringify({ p: '/message/status', o: 'replace', v: 'finished_successfully' })}\n\n`;
    out += `event: delta\ndata: ${JSON.stringify({ type: 'message_stream_complete' })}\n\n`;
    out += 'data: [DONE]\n\n';
  }
  return out;
}

test('ChatGPT (parches): el texto llega completo, parts sigue siendo un array y el cierre va después', async () => {
  const { events } = await correr(streamChatGPTParches(TEXTO), { adapter: 'chatgpt' });
  const { texto, orden, porEvento } = clienteChatGPT(events);

  assert.equal(texto, TEXTO);
  // `parts` nunca se convirtió en un string: todos los valores son strings y el
  // mensaje original conserva su forma.
  const primero = porEvento.find((item) => item.json?.p === '/message');
  assert.ok(Array.isArray(primero.json.v.content.parts));
  // El estado final llega después de todo el texto y antes que `[DONE]`.
  assert.equal(orden.at(-1), 'complete');
  assert.ok(orden.indexOf('finished_successfully') < orden.indexOf('complete'));
  assert.equal(events.at(-1).data, '[DONE]');
});

test('ChatGPT (parches): el eco del usuario, "v1" y los estados no se tratan como texto', async () => {
  const payload =
    `event: delta\ndata: ${JSON.stringify({ p: '/message', o: 'add', v: { author: { role: 'user' }, content: { parts: ['mi pregunta'] } } })}\n\n` +
    'event: delta\ndata: "v1"\n\n' +
    `event: delta\ndata: ${JSON.stringify({ p: '/message', o: 'add', v: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] } } })}\n\n` +
    `event: delta\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'respuesta ' })}\n\n` +
    `event: delta\ndata: ${JSON.stringify({ p: '/message/status', o: 'replace', v: 'in_progress' })}\n\n`;
  const { events } = await correr(payload, { adapter: 'chatgpt' });
  const { texto } = clienteChatGPT(events);

  // El usuario no se suma a la respuesta del asistente, y el texto sí pasa.
  assert.equal(texto, 'respuesta ');
  // `"v1"` viaja intacto.
  assert.ok(events.some((evt) => evt.data === '"v1"'), 'el evento "v1" se reenvió tal cual');
});

test('ChatGPT (parches): conserva el nombre de los eventos', async () => {
  const { events } = await correr(streamChatGPTParches('texto corto'), { adapter: 'chatgpt' });
  // Todos los bloques con JSON —incluido el sintético que libera el texto
  // retenido— conservan el nombre de evento del sitio. `[DONE]` no lleva nombre.
  const nombres = new Set(events.filter((evt) => evt.hasData && evt.data !== '[DONE]').map((evt) => evt.event));
  assert.deepEqual([...nombres], ['delta']);
});

/* ------------------------------------------------------------------ */
/* ChatGPT: protocolo acumulado                                         */
/* ------------------------------------------------------------------ */

function streamChatGPTAcumulado(texto, { size = 15 } = {}) {
  let out = `data: ${JSON.stringify({
    message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['mi pregunta'] } },
  })}\n\n`;
  let acumulado = '';
  for (const trozo of chunk(texto, size)) {
    acumulado += trozo;
    out += `data: ${JSON.stringify({
      message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [acumulado] } },
    })}\n\n`;
  }
  out += 'data: [DONE]\n\n';
  return out;
}

test('ChatGPT (acumulado): cada evento conserva el texto completo hasta ese punto', async () => {
  const { events } = await correr(streamChatGPTAcumulado(TEXTO), { adapter: 'chatgpt' });
  const valores = [];
  for (const { json } of datos(events)) {
    const parts = json?.message?.content?.parts;
    if (Array.isArray(parts) && json.message.author?.role === 'assistant') valores.push(parts[0]);
  }
  assert.ok(valores.length > 3);
  let anterior = '';
  for (const valor of valores) {
    assert.equal(typeof valor, 'string');
    assert.ok(TEXTO.startsWith(valor), `«${valor.slice(0, 30)}…» no es un prefijo del texto`);
    assert.ok(valor.length >= anterior.length, 'el texto acumulado no puede encogerse');
    anterior = valor;
  }
  // Y al final está todo, sin el búfer retenido de menos.
  assert.equal(anterior, TEXTO);
});

test('ChatGPT (acumulado): el mensaje del usuario pasa sin tocarse', async () => {
  const payload = `data: ${JSON.stringify({
    message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['mi pregunta'] } },
  })}\n\ndata: [DONE]\n\n`;
  const { events } = await correr(payload, { adapter: 'chatgpt' });
  assert.match(events[0].raw, /mi pregunta/);
});

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

function streamClaude(texto, { size = 13, thinking = true } = {}) {
  let out = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n';
  if (thinking) {
    out += 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pensando…"}}\n\n';
    out += '\n: ping\n\n';
  }
  out += 'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n';
  for (const trozo of chunk(texto, size)) {
    out += `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: trozo },
    })}\n\n`;
  }
  out += 'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n';
  out += 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
  out += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  return out;
}

test('Claude: el texto llega completo y ANTES de content_block_stop y message_stop', async () => {
  const { events } = await correr(streamClaude(TEXTO), { adapter: 'claude' });
  const { texto } = clienteClaude(events);
  assert.equal(texto, TEXTO);

  // Todo el texto tiene que estar antes del primer cierre.
  const cierre = events.findIndex((evt) => /content_block_stop|message_stop/.test(evt.data));
  assert.ok(cierre > 0);
  const antes = clienteClaude(events.slice(0, cierre)).texto;
  assert.equal(antes, TEXTO, 'el texto retenido no puede quedar para después del cierre');
});

test('Claude: nombre de evento, pings, razonamiento y metadatos pasan intactos', async () => {
  const { out, events } = await correr(streamClaude('hola mundo'), { adapter: 'claude' });
  assert.match(out, /event: message_start/);
  assert.match(out, /event: content_block_delta/);
  assert.match(out, /thinking_delta/);
  assert.match(out, /: ping/, 'el comentario de latido se conserva');
  // Los bloques de comentario (`: ping`) no llevan nombre; se miran sólo los
  // que traen datos y no son el `[DONE]`.
  const sinNombre = events.filter((evt) => evt.event === 'message' && evt.hasData && evt.data !== '[DONE]');
  assert.equal(sinNombre.length, 0, 'ningún evento perdió su nombre');
});

test('Claude (formato antiguo): completion acumulado y stop_reason', async () => {
  let acumulado = '';
  let payload = '';
  for (const trozo of chunk(TEXTO, 17)) {
    acumulado += trozo;
    payload += `data: ${JSON.stringify({ completion: acumulado, stop_reason: null })}\n\n`;
  }
  payload += `data: ${JSON.stringify({ completion: acumulado, stop_reason: 'stop_sequence' })}\n\ndata: [DONE]\n\n`;

  const { events } = await correr(payload, { adapter: 'claude' });
  const { texto, orden } = clienteClaude(events);
  assert.equal(texto, TEXTO);
  assert.equal(orden.at(-1), 'stop_reason');
});

test('Claude: una respuesta corta (menos que el búfer) no se pierde', async () => {
  const corto = 'Sí.';
  const { events } = await correr(streamClaude(corto, { size: 40 }), { adapter: 'claude' });
  assert.equal(clienteClaude(events).texto, corto);
});

test('ChatGPT: el texto retenido sale antes del cierre y [DONE] va último, sin duplicarse', async () => {
  const texto = 'Una respuesta cualquiera que queda a medias del búfer de retención.';
  const { events } = await correr(streamChatGPTParches(texto, { size: 9 }), { adapter: 'chatgpt' });
  const { texto: recibido } = clienteChatGPT(events);

  // Nada de texto después del cierre: los eventos posteriores son de control.
  const cierre = events.findIndex((evt) => /finished_successfully/.test(evt.data || ''));
  assert.ok(cierre > 0);
  const posteriores = clienteChatGPT(events.slice(cierre + 1)).texto;
  assert.equal(posteriores, '', 'llegó texto después del cierre');

  // Y el texto sale exactamente una vez, completo.
  assert.equal(recibido, texto);
  assert.equal((recibido.match(/Una respuesta cualquiera/g) || []).length, 1);
  assert.equal(events.filter((evt) => evt.data === '[DONE]').length, 1);
});

/* ------------------------------------------------------------------ */
/* bucles                                                              */
/* ------------------------------------------------------------------ */

const PARRAFO =
  'La arquitectura propuesta separa el enganche de red del adaptador de interfaz, de modo que el motor sigue funcionando aunque el sitio cambie sus selectores.';

test('ChatGPT: un bucle se corta y el stream igual termina con su cierre y [DONE]', async () => {
  const texto = `${PARRAFO}\n\n${PARRAFO}\n\n${PARRAFO}\n\n${PARRAFO}`;
  const { events, stops } = await correr(streamChatGPTParches(texto, { size: 23 }), { adapter: 'chatgpt' });
  const { texto: recibido, orden } = clienteChatGPT(events);
  assert.equal((recibido.match(/La arquitectura propuesta/g) || []).length, 1);
  assert.ok(stops.length >= 1, 'se informó el corte');
  assert.ok(orden.includes('complete'), 'el cierre del sitio sigue llegando');
  assert.equal(events.at(-1).data, '[DONE]');
});

test('Claude: un bucle se corta y message_stop sigue llegando', async () => {
  const texto = `${PARRAFO}\n\n${PARRAFO}\n\n${PARRAFO}\n\n${PARRAFO}`;
  const { events, stops } = await correr(streamClaude(texto, { size: 19 }), { adapter: 'claude' });
  const { texto: recibido, orden } = clienteClaude(events);
  assert.equal((recibido.match(/La arquitectura propuesta/g) || []).length, 1);
  assert.ok(stops.length >= 1);
  assert.equal(orden.at(-1), 'message_stop');
});

/* ------------------------------------------------------------------ */
/* UTF-8                                                               */
/* ------------------------------------------------------------------ */

test('UTF-8: acentos, emojis y CJK no se corrompen con ningún tamaño de trozo de red', async () => {
  const texto =
    'Acentuación: ñandú, camión, pingüino. Emojis: 😀🚀🧠. CJK: 日本語 中文 한국어. Y griego: αβγδε.';
  for (const size of [1, 2, 3, 5, 7, 11, 64]) {
    for (const adapter of ['chatgpt', 'claude', null]) {
      const payload =
        adapter === 'claude'
          ? streamClaude(texto, { size: 7 })
          : adapter === 'chatgpt'
            ? streamChatGPTParches(texto, { size: 7 })
            : chunk(texto, 7)
                .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
                .join('') + 'data: [DONE]\n\n';
      const { events } = await correr(payload, { adapter }, size);
      const recibido =
        adapter === 'claude'
          ? clienteClaude(events).texto
          : adapter === 'chatgpt'
            ? clienteChatGPT(events).texto
            : events
                .filter((evt) => evt.data !== '[DONE]')
                .map((evt) => {
                  try {
                    return JSON.parse(evt.data).choices[0].delta.content;
                  } catch {
                    return '';
                  }
                })
                .join('');
      assert.equal(recibido, texto, `se corrompió con adapter=${adapter} y trozo de red ${size}`);
      assert.ok(!recibido.includes('\uFFFD'), 'apareció el carácter de reemplazo');
    }
  }
});

test('UTF-8: el centinela no parte un emoji por la mitad en el límite del búfer', () => {
  const base = Array.from({ length: 12 }, (_, i) => `Oración ${i} sobre ${['mar', 'sol', 'luna', 'río'][i % 4]} y algo más.`).join(' ');
  const emojis = '😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗';
  const cola = Array.from({ length: 10 }, (_, i) => `Cierre ${i} del tema ${['uno', 'dos', 'tres', 'cuatro', 'cinco'][i % 5]} número ${i * 3}.`).join(' ');
  for (let pad = 0; pad < 6; pad += 1) {
    const texto = `${base}${'x'.repeat(pad)} ${emojis} ${cola}`;
    const sentinel = new StreamSentinel({});
    let malos = 0;
    for (let i = 0; i < texto.length; i += 3) {
      if (!sentinel.push(texto.slice(i, i + 3)).emit.isWellFormed()) malos += 1;
    }
    if (!sentinel.finish().emit.isWellFormed()) malos += 1;
    assert.equal(malos, 0, `pad=${pad}: se emitió un sustituto UTF-16 suelto`);
  }
});

/* ------------------------------------------------------------------ */
/* cable SSE                                                           */
/* ------------------------------------------------------------------ */

test('SSE: comentarios, retry, id y CRLF se conservan; sólo cambia el texto', async () => {
  const payload =
    ': ping\r\n\r\n' +
    'retry: 3000\r\n\r\n' +
    `event: delta\r\nid: 7\r\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'hola ' })}\r\n\r\n` +
    `event: delta\r\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'mundo' })}\r\n\r\n`;
  const { out, events } = await correr(payload, { adapter: 'chatgpt' });
  assert.match(out, /: ping/);
  assert.match(out, /retry: 3000/);
  assert.match(out, /id: 7/);
  assert.match(out, /event: delta/);
  const { texto } = clienteChatGPT(events);
  assert.equal(texto, 'hola mundo');
});

test('SSE: un evento final sin línea en blanco se procesa; uno cortado se reenvía tal cual', async () => {
  // Sin la línea en blanco final: el texto tiene que llegar igual.
  const sinBlanco = `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'final' })}`;
  const uno = await correr(sinBlanco, { adapter: 'chatgpt' });
  assert.match(uno.out, /final/);

  // Cortado por la red: se reenvía como llegó, sin inventar nada.
  const cortado = 'data: {"p":"/message/content/parts/0","o":"append","v":"a med';
  const dos = await correr(cortado, { adapter: 'chatgpt' });
  assert.ok(dos.out.includes(cortado));
});

test('SSE: datos con espacios iniciales se conservan (sólo se quita uno)', () => {
  const { events } = parseSSE('data:  {"a":1}\n\n');
  assert.equal(events[0].data, ' {"a":1}');
});

/* ------------------------------------------------------------------ */
/* qué peticiones se median                                            */
/* ------------------------------------------------------------------ */

test('ChatGPT: sólo se media el POST que envía el mensaje', () => {
  const chatgpt = detectSite('chatgpt.com');
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/conversation', 'POST'), true);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/f/conversation', 'POST'), true);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/conversation/prepare', 'POST'), false);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/conversations?offset=0', 'GET'), false);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/conversation/abc-123', 'GET'), false);
  assert.equal(isChatRequest(chatgpt, 'https://chatgpt.com/backend-api/conversation', 'GET'), false);
});

test('Claude: sólo se media /completion', () => {
  const claude = detectSite('claude.ai');
  const url = 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion';
  assert.equal(isChatRequest(claude, url, 'POST'), true);
  assert.equal(isChatRequest(claude, `${url}?x=1`, 'POST'), true);
  assert.equal(isChatRequest(claude, 'https://claude.ai/api/organizations/org-1/chat_conversations', 'GET'), false);
});

/* ------------------------------------------------------------------ */
/* cuerpo de la petición                                               */
/* ------------------------------------------------------------------ */

test('ChatGPT: con adjuntos se reescribe el texto y se respetan los demás parts', () => {
  const chatgpt = detectSite('chatgpt.com');
  const cuerpo = {
    action: 'next',
    messages: [
      {
        author: { role: 'user' },
        content: {
          content_type: 'multimodal_text',
          parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-1' }, 'describí la imagen'],
        },
      },
    ],
  };
  const encontrado = locateUserText(cuerpo, chatgpt);
  assert.equal(encontrado.value, 'describí la imagen');
  assert.equal(patchUserText(cuerpo, chatgpt, 'TEXTO MEDIADO'), true);
  assert.equal(cuerpo.messages[0].content.parts[0].asset_pointer, 'file-1');
  assert.equal(cuerpo.messages[0].content.parts[1], 'TEXTO MEDIADO');
  assert.ok(Array.isArray(cuerpo.messages[0].content.parts));
});

test('ChatGPT: regenerar o continuar (sin mensaje nuevo) no se reescribe ni se rellena con otro campo', () => {
  const chatgpt = detectSite('chatgpt.com');
  const cuerpo = { action: 'variant', parent_message_id: 'abc', timezone: 'America/Argentina/Buenos_Aires', messages: [] };
  assert.equal(locateUserText(cuerpo, chatgpt), null);
  assert.equal(patchUserText(cuerpo, chatgpt, 'NO DEBE ENTRAR'), false);
  assert.equal(cuerpo.timezone, 'America/Argentina/Buenos_Aires');
});

test('Claude: sin prompt no se toca ningún otro campo', () => {
  const claude = detectSite('claude.ai');
  const cuerpo = { model: 'claude-x', timezone: 'Europe/Madrid', attachments: [] };
  assert.equal(locateUserText(cuerpo, claude), null);
  assert.equal(patchUserText(cuerpo, claude, 'NO DEBE ENTRAR'), false);
  assert.equal(cuerpo.timezone, 'Europe/Madrid');
});

/* ------------------------------------------------------------------ */
/* enganche de fetch (la página, simulada)                             */
/* ------------------------------------------------------------------ */

/**
 * Monta un `window` mínimo y carga la capa de inyección en él.
 *
 * La capa es el código real de producción: se importa con un sufijo distinto en
 * cada prueba para que el enganche de `fetch` se instale de cero.
 */
async function montarPagina({ host = 'chatgpt.com', href = 'https://chatgpt.com/', respond, prepare } = {}) {
  const listeners = new Set();
  const llamadas = [];

  const window_ = {
    location: { hostname: host, href, protocol: 'https:' },
    __NEXO_CONFIG__: { host, enabled: true, settings: {}, language: 'es', version: 'test' },
    addEventListener(tipo, fn) {
      if (tipo === 'message') listeners.add(fn);
    },
    removeEventListener(tipo, fn) {
      listeners.delete(fn);
    },
    postMessage(data) {
      // Como el navegador: el mensaje se entrega en otra vuelta del bucle.
      queueMicrotask(() => {
        for (const fn of [...listeners]) {
          try {
            fn({ data, source: window_ });
          } catch {
            /* un listener roto no corta al resto */
          }
        }
      });
    },
    fetch: async (input, init) => {
      // El cuerpo se lee acá, como haría el navegador: puede venir en `init` o
      // dentro de un `Request`.
      const cuerpo = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
      llamadas.push({ url: String(input?.url || input), init, cuerpo: cuerpo ?? null, entrada: input });
      return respond ? respond(input, init) : new Response('ok');
    },
  };

  // Hace de preload: responde a las llamadas del puente.
  listeners.add((event) => {
    const data = event.data;
    if (!data || data.__nexo !== 'call') return;
    if (data.type === 'prepare') {
      Promise.resolve(prepare ? prepare(data.payload) : { text: `MEDIADO: ${data.payload.prompt}` })
        .then((payload) => window_.postMessage({ __nexo: 'reply', id: data.id, payload }))
        .catch((error) => window_.postMessage({ __nexo: 'reply', id: data.id, error: String(error.message) }));
    }
  });

  const antes = { window: globalThis.window, location: globalThis.location, document: globalThis.document };
  globalThis.window = window_;
  globalThis.location = window_.location;
  globalThis.document = { querySelector: () => null, readyState: 'loading' };

  await import(`../src/inject/index.js?pagina=${Math.random()}`);

  /** Devuelve el entorno a como estaba. */
  const cerrar = () => {
    globalThis.window = antes.window;
    globalThis.location = antes.location;
    globalThis.document = antes.document;
  };

  return { window: window_, llamadas, cerrar };
}

const CUERPO_CHATGPT = {
  action: 'next',
  model: 'auto',
  timezone: 'America/Argentina/Buenos_Aires',
  messages: [
    { author: { role: 'user' }, content: { content_type: 'text', parts: ['mi pregunta original'] } },
  ],
};

test('fetch enganchado: un fallo de red NO reenvía el mensaje', async () => {
  let intentos = 0;
  const pagina = await montarPagina({
    respond: () => {
      intentos += 1;
      throw new TypeError('Failed to fetch');
    },
  });
  try {
    await assert.rejects(() =>
      pagina.window.fetch('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        body: JSON.stringify(CUERPO_CHATGPT),
      }),
    );
    assert.equal(intentos, 1, 'la petición se envió exactamente una vez');
  } finally {
    pagina.cerrar();
  }
});

test('fetch enganchado: «Detener» (AbortError) NO reenvía el mensaje', async () => {
  let intentos = 0;
  const pagina = await montarPagina({
    respond: () => {
      intentos += 1;
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  try {
    await assert.rejects(() => pagina.window.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: JSON.stringify(CUERPO_CHATGPT) }));
    assert.equal(intentos, 1);
  } finally {
    pagina.cerrar();
  }
});

test('fetch enganchado: se envía el texto mediado, una sola vez, con el resto del cuerpo intacto', async () => {
  const pagina = await montarPagina({
    respond: () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }),
  });
  try {
    const respuesta = await pagina.window.fetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      body: JSON.stringify(CUERPO_CHATGPT),
    });
    assert.equal(respuesta.status, 200);
    assert.equal(pagina.llamadas.length, 1);

    const enviado = JSON.parse(pagina.llamadas[0].cuerpo);
    assert.match(enviado.messages[0].content.parts[0], /^MEDIADO:/);
    assert.equal(enviado.timezone, 'America/Argentina/Buenos_Aires');
    assert.equal(enviado.model, 'auto');
  } finally {
    pagina.cerrar();
  }
});

test('fetch enganchado: si el motor no responde, se envía el original, una vez', async () => {
  const pagina = await montarPagina({
    prepare: () => {
      throw new Error('sin motor');
    },
    respond: () => new Response('ok'),
  });
  try {
    await pagina.window.fetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      body: JSON.stringify(CUERPO_CHATGPT),
    });
    assert.equal(pagina.llamadas.length, 1);
    const enviado = JSON.parse(pagina.llamadas[0].cuerpo);
    assert.equal(enviado.messages[0].content.parts[0], 'mi pregunta original');
  } finally {
    pagina.cerrar();
  }
});

test('fetch enganchado: peticiones que no son mensajes pasan sin tocarse', async () => {
  const pagina = await montarPagina({ respond: () => new Response('ok') });
  try {
    await pagina.window.fetch('https://chatgpt.com/backend-api/conversations?offset=0', { method: 'GET' });
    await pagina.window.fetch('https://chatgpt.com/assets/app.js');
    assert.equal(pagina.llamadas.length, 2);
    assert.equal(pagina.llamadas[1].init, undefined, 'sin cuerpo ni opciones de más');
  } finally {
    pagina.cerrar();
  }
});

test('fetch enganchado: acepta URL y Request como entrada', async () => {
  const pagina = await montarPagina({
    respond: () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }),
  });
  try {
    // URL
    await pagina.window.fetch(new URL('https://chatgpt.com/backend-api/conversation'), {
      method: 'POST',
      body: JSON.stringify(CUERPO_CHATGPT),
    });
    // Request
    const request = new Request('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      body: JSON.stringify(CUERPO_CHATGPT),
    });
    await pagina.window.fetch(request);

    assert.equal(pagina.llamadas.length, 2);
    for (const llamada of pagina.llamadas) {
      const cuerpo = JSON.parse(llamada.cuerpo);
      assert.match(cuerpo.messages[0].content.parts[0], /^MEDIADO:/);
    }
  } finally {
    pagina.cerrar();
  }
});

test('fetch enganchado: respuestas sin cuerpo (204) no rompen ni reenvían', async () => {
  const pagina = await montarPagina({ respond: () => new Response(null, { status: 204 }) });
  try {
    const respuesta = await pagina.window.fetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      body: JSON.stringify(CUERPO_CHATGPT),
    });
    assert.equal(respuesta.status, 204);
    assert.equal(pagina.llamadas.length, 1);
  } finally {
    pagina.cerrar();
  }
});

test('fetch enganchado: Claude — mensaje mediado y respuesta completa', async () => {
  const texto = 'Respuesta de Claude con su texto completo y sin repeticiones.';
  const pagina = await montarPagina({
    host: 'claude.ai',
    href: 'https://claude.ai/chat/abc',
    respond: () =>
      new Response(streamClaude(texto), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  try {
    const url = 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion';
    const respuesta = await pagina.window.fetch(url, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'mi pregunta', model: 'claude-x', timezone: 'Europe/Madrid' }),
    });

    // La petición salió mediada y con el resto del cuerpo intacto.
    const enviado = JSON.parse(pagina.llamadas[0].cuerpo);
    assert.match(enviado.prompt, /^MEDIADO:/);
    assert.equal(enviado.timezone, 'Europe/Madrid');

    // Y el stream que ve la página conserva el texto entero.
    const salida = await respuesta.text();
    const { texto: recibido, orden } = clienteClaude(parseSSE(salida).events);
    assert.equal(recibido, texto);
    assert.equal(orden.at(-1), 'message_stop');
  } finally {
    pagina.cerrar();
  }
});

test('el bundle de inyección se genera y conserva el enganche', () => {
  const ruta = `${ROOT}build/inject.js`;
  if (!existsSync(ruta)) return; // sin bundle generado no hay nada que revisar
  const codigo = readFileSync(ruta, 'utf8');
  assert.match(codigo, /__NEXO_HOOKED__/);
  assert.ok(!/bodyToText|mediateRequest/.test(codigo), 'no debe quedar el camino que reenviaba');
});

/* ------------------------------------------------------------------ */
/* dónde NO se media                                                  */
/* ------------------------------------------------------------------ */

test('fuera de un proveedor con perfil no se media nada', () => {
  // El perfil genérico reconocía cualquier POST a `/api/…`: un formulario de
  // acceso de un tercero terminaba reescrito con el prompt del motor.
  const generico = detectSite('auth.openai.com');
  assert.equal(generico.id, 'generic');
  assert.equal(isMediable(generico, 'https://auth.openai.com/api/accounts/login', 'POST'), false);
  assert.equal(isMediable(detectSite('ejemplo.com'), 'https://ejemplo.com/api/chat', 'POST'), false);
  assert.equal(isMediable(null, 'https://chatgpt.com/backend-api/conversation', 'POST'), false);
});

test('un flujo de acceso no se media aunque el sitio tenga perfil', () => {
  const chatgpt = detectSite('chatgpt.com');
  const claude = detectSite('claude.ai');
  assert.equal(isMediable(chatgpt, 'https://chatgpt.com/backend-api/conversation', 'POST'), true);
  assert.equal(isMediable(chatgpt, 'https://chatgpt.com/backend-api/conversation/login', 'POST'), false);
  assert.equal(isMediable(claude, 'https://claude.ai/api/auth/login', 'POST'), false);
  assert.equal(isMediable(claude, 'https://claude.ai/api/oauth/token', 'POST'), false);
  assert.equal(isAuthRequest('https://accounts.google.com/_/signin/v2/challenge'), true);
  assert.equal(isAuthRequest('https://github.com/session'), true);
  assert.equal(isAuthRequest('https://chatgpt.com/backend-api/conversation'), false);
  assert.equal(isAuthRequest('https://gemini.google.com/_/BardChatUi/data/x/StreamGenerate'), false);
});

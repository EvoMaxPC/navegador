/**
 * 7c-11: **por qué** el adaptador de ChatGPT descarta el mensaje.
 *
 * Medido en el PC con 7c-10 (`1916909`), dos turnos reales: `text/event-stream`,
 * `sse`, `completed`, 0 caracteres, 0 portadores, `descartes 3` y `11`. La línea
 * publicada traía rutas, operaciones y tipos, pero **no** las etiquetas del
 * mensaje que se habían pedido en 7c-10.
 *
 * Esta etapa **no cambia el extractor**: sólo cuenta. Añade
 *  · un cubo por causa de descarte (rol, tipo, fragmento, oculto, canal, otra),
 *    más los mensajes aceptados y las veces que `assistantText` quedó en
 *    true/false;
 *  · para los eventos cuya ruta es de texto, qué forma traía `v` y cuántos
 *    produjeron segmento;
 *  · y hace que las etiquetas del mensaje **se vean** en la línea publicada,
 *    con «etiquetas 0» explícito cuando no hay ninguna.
 *
 * **Las fixtures de este archivo son SINTÉTICAS.** Ninguna grabación del repo
 * reproduce el turno del PC; se construyen con formas que el código ya entiende
 * (raíz `add` con mensaje, parches `p`/`o`/`v` sobre `/message/content/parts/N`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

import { createStreamFilter } from '../src/core/streamFilter.js';

const MARCA = 'ZZZ-PRIVADO';
const PARTE = '/message/content/parts/0';

/* ------------------------------------------------------------------ */
/* fixture sintética                                                   */
/* ------------------------------------------------------------------ */

/** Raíz `add` con el mensaje, para provocar una lectura de `readMessage`. */
function mensaje({ role = 'assistant', tipo = 'text', extra = {}, metadata = {} } = {}) {
  return {
    p: '',
    o: 'add',
    v: {
      message: {
        id: 'm-7c11',
        author: { role },
        content: { content_type: tipo, parts: [''] },
        status: 'in_progress',
        metadata,
        ...extra,
      },
    },
  };
}

const sse = (...eventos) => eventos
  .map(({ event = 'delta', data }) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  .join('');

async function correr(cuerpo) {
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  await new Response(new Blob([cuerpo]).stream().pipeThrough(filtro)).text();
  return fin;
}

const anidadoDe = async (cuerpo) => (await correr(cuerpo)).estructura.anidado;

/* ------------------------------------------------------------------ */
/* 1. un cubo por causa                                               */
/* ------------------------------------------------------------------ */

test('(1) cada causa de descarte cae en su propio cubo', async () => {
  const casos = [
    ['rol', mensaje({ role: 'user' })],
    ['tipo', mensaje({ tipo: 'code' })],
    ['fragmento', mensaje({ metadata: { is_message_fragment: true } })],
    ['oculto', mensaje({ metadata: { is_visually_hidden_from_conversation: true } })],
    ['canal', mensaje({ extra: { channel: 'commentary' } })],
    ['otra', mensaje({ extra: { recipient: 'web.run' } })],
  ];
  for (const [causa, base] of casos) {
    const a = await anidadoDe(sse({ event: 'message', data: base }, { data: '[DONE]' }));
    assert.equal(a.mensaje.causas[causa], 1, `la causa ${causa} se cuenta en su cubo`);
    const otras = Object.entries(a.mensaje.causas).filter(([nombre, n]) => nombre !== causa && n > 0);
    assert.deepEqual(otras, [], `la causa ${causa} no se suma también a otras`);
    assert.equal(a.mensaje.descartados, 1, `${causa}: un descarte`);
    assert.equal(a.mensaje.aceptados, 0, `${causa}: ninguno aceptado`);
  }
});

test('(2) un mensaje assistant aceptado no suma descartes', async () => {
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje() },
    { data: { p: PARTE, o: 'append', v: 'hola' } },
    { data: '[DONE]' },
  ));
  assert.equal(a.mensaje.aceptados, 1, 'se cuenta como aceptado');
  assert.equal(a.mensaje.descartados, 0, 'y no como descarte');
  assert.deepEqual(a.mensaje.causas, { rol: 0, tipo: 0, fragmento: 0, oculto: 0, canal: 0, otra: 0 },
    'ningún cubo se mueve');
  assert.equal(a.mensaje.vistos, 1, 'y el mensaje se vio');
});

test('(3) un mismo stream suma los cubos de todos sus mensajes', async () => {
  // Lo que pasaba en el PC: varios `readMessage` por stream, no uno.
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje({ role: 'user' }) },
    { event: 'message', data: mensaje({ role: 'system' }) },
    { event: 'message', data: mensaje({ role: 'user' }) },
    { event: 'message', data: mensaje() },
    { data: '[DONE]' },
  ));
  assert.equal(a.mensaje.causas.rol, 3, 'tres descartes por rol');
  assert.equal(a.mensaje.aceptados, 1, 'uno aceptado');
  assert.equal(a.mensaje.descartados, 3);
  assert.equal(a.mensaje.vistos, 4, 'los cuatro mensajes llegaron');
});

test('(4) assistantText se cuenta en true y en false', async () => {
  const a = await anidadoDe(sse(
    // El estado se fija con el parche de rol que el protocolo ya emite.
    { data: { p: '/message/author/role', o: 'replace', v: 'assistant' } },
    { data: { p: '/message/author/role', o: 'replace', v: 'user' } },
    { data: '[DONE]' },
  ));
  assert.equal(a.mensaje.assistantSi, 1, 'una vez en true');
  assert.equal(a.mensaje.assistantNo, 1, 'una vez en false');
});

/* ------------------------------------------------------------------ */
/* 5. la forma de `v` en la ruta de texto                             */
/* ------------------------------------------------------------------ */

test('(5) `v` string, array, object y otro se clasifican en la ruta de texto', async () => {
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje() },
    { data: { p: PARTE, o: 'append', v: 'uno ' } },
    { data: { p: PARTE, o: 'append', v: [{ p: PARTE, o: 'append', v: 'dos' }] } },
    { data: { p: PARTE, o: 'replace', v: { noEsTexto: true } } },
    { data: { p: PARTE, o: 'append', v: 5 } },
    { data: '[DONE]' },
  ));
  assert.deepEqual(a.rutaTexto, { string: 1, array: 1, object: 1, otro: 1, conSegmento: 2 },
    'cuatro formas y sólo dos produjeron segmento');
});

test('(6) un `p` que no es ruta de texto no entra en la clasificación', async () => {
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje() },
    { data: { p: '/message/status', o: 'replace', v: 'finished_successfully' } },
    { data: { p: '/message/metadata/model_slug', o: 'replace', v: 'gpt-6' } },
    { data: '[DONE]' },
  ));
  assert.deepEqual(a.rutaTexto, { string: 0, array: 0, object: 0, otro: 0, conSegmento: 0 },
    'sólo cuenta /message/content/parts/N');
  assert.equal(a.mensaje.aceptados, 1);
});

/* ------------------------------------------------------------------ */
/* 7. el porqué del hueco de 7c-10: las etiquetas                     */
/* ------------------------------------------------------------------ */

test('(6 bis) las etiquetas salen del propio stream, no del aviso', async () => {
  // Cierra el hueco de 7c-10 de punta a punta: el stream sintético trae un
  // mensaje con rol, tipo, estado, canal y metadata, y el resumen tiene que
  // recogerlos en el filtro. (7) sólo prueba que `main` los imprime si llegan.
  const a = await anidadoDe(sse(
    {
      event: 'message',
      data: mensaje({
        extra: { channel: 'final', status: 'finished_successfully' },
        metadata: { model_slug: MARCA, is_message_fragment: false, request_id: 'r-1' },
      }),
    },
    { data: { p: PARTE, o: 'append', v: 'texto' } },
    { data: '[DONE]' },
  ));
  assert.equal(a.mensaje.roles, 'assistant', 'rol del mensaje');
  assert.equal(a.mensaje.tipos, 'text', 'tipo de contenido');
  assert.equal(a.mensaje.estados, 'finished_successfully', 'el estado que trajo el mensaje');
  assert.equal(a.mensaje.canales, 'final', 'canal');
  assert.equal(a.mensaje.metadataClaves, 'model_slug,is_message_fragment,request_id',
    'nombres de las claves de metadata, no sus valores');
  assert.ok(!JSON.stringify(a.mensaje).includes('ZZZ'), 'el valor de model_slug no se publica');
});

process.env.NEXO_DIAG = '1';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((resolve) => setTimeout(resolve, 60));

const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const shellEv = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (channel, ev, payload) => {
  const handler = journal.ipcHandlers.get(channel);
  assert.equal(typeof handler, 'function', `la aplicación registra ${channel}`);
  return handler(ev, payload);
};
const avisos = async (code) => (await invoke('nexo:log', shellEv)).filter((e) => e.code === code);

/** Manda un cierre con la estructura de la capa y devuelve el aviso. */
function cerrar(estructura, extra = {}) {
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c11-${Math.random().toString(36).slice(2, 8)}`);
  view.url = 'https://chatgpt.com/c/7c11-x';
  invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'm-7c11', chars: 0, deliveredChars: 0,
    text: '', outcome: 'completed', interrupted: false, finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 4, bytes: 1024 },
    // `estructura` es el resumen de nivel 1; el nivel 2 va dentro, como lo
    // manda la capa desde 7c-10.
    estructura: {
      eventos: 25, conDatos: 25, jsonValido: 24, jsonInvalido: 1, sinEvento: 0, dones: 0,
      nombresEvento: 'delta_encoding,message,delta',
      claves: 'type,kind,token,conversation_id,input_message,p,o,v,c,message_id,marker,event',
      clavesOtros: 0, tiposV: 'object,array,boolean', portadores: 0, lineas: 0,
      anidado: estructura,
    },
    ...extra,
  });
  return avisos('diag-stream-end').then((lista) => lista[0]);
}

const anidadoBase = (mensajeExtra = {}, rutaExtra = {}) => ({
  vArray: 3, elementos: 11, clavesElemento: 'p,o,v', tiposElementoV: 'string',
  opsEvento: 'add,patch,replace', opsElemento: 'append',
  rutasParche: '/message/content/parts/N,/message/end_turn', rutasEvento: '',
  vObjetoClaves: 'message', fueraDeLista: false,
  mensaje: {
    roles: 'assistant', tipos: 'text', estados: 'in_progress', canales: 'final',
    metadataClaves: 'model_slug', descartados: 11, sinTexto: 3, aceptados: 0, vistos: 14,
    causas: { rol: 3, tipo: 0, fragmento: 0, oculto: 0, canal: 0, otra: 8 },
    assistantSi: 1, assistantNo: 2, otra: false, ...mensajeExtra,
  },
  rutaTexto: { string: 0, array: 2, object: 0, otro: 0, conSegmento: 0, ...rutaExtra },
  noJson: { longitud: 4, clase: 'simbolo', ultimo: false, esDone: false, conCrlf: false },
});

test('(7) las etiquetas del mensaje se ven en la línea publicada', async () => {
  const aviso = await cerrar(anidadoBase());
  assert.match(aviso.detail, /rol assistant/, 'el rol, que era lo que faltaba');
  assert.match(aviso.detail, /tipo text/);
  assert.match(aviso.detail, /estado in_progress/);
  assert.match(aviso.detail, /canal final/);
  assert.match(aviso.detail, /meta model_slug/, 'y los nombres de claves de metadata');
  assert.match(aviso.detail, /aceptados 0 · vistos 14/, 'con los conteos del mensaje');
  assert.match(aviso.detail, /assistant 1\/2/, 'y assistantText true/false');
});

test('(8) sin ninguna etiqueta se publica «etiquetas 0», no silencio', async () => {
  // Es el caso que se quiere distinguir: no es que no haya campos, es que no
  // llegó ningún mensaje que los tuviera.
  const aviso = await cerrar(anidadoBase({ roles: '', tipos: '', estados: '', canales: '', metadataClaves: '' }));
  assert.match(aviso.detail, /etiquetas 0/, 'se dice explícitamente');
});

test('(9) los cubos de descarte se ven en la línea', async () => {
  const aviso = await cerrar(anidadoBase());
  assert.match(aviso.detail, /causas rol 3 tipo 0 fragmento 0 oculto 0 canal 0 otra 8/,
    'cada causa con su cuenta');
  assert.match(aviso.detail, /rutaTexto string 0 array 2 object 0 otro 0 · con segmento 0/,
    'y la forma de v en la ruta de texto');
});

test('(10) la marca no aparece en ninguna cadena publicada', async () => {
  // Con la marca en todos los sitios donde podría colarse: un valor de texto,
  // una etiqueta, una clave de metadata y una ruta.
  const aviso = await cerrar(anidadoBase({
    roles: MARCA, tipos: MARCA, estados: MARCA, canales: MARCA,
    metadataClaves: `${MARCA},model_slug`,
  }, { rutasParche: `/message/${MARCA}/x,/message/content/parts/N` }));
  const volcado = JSON.stringify({ detail: aviso.detail, meta: aviso.meta });
  assert.ok(!volcado.includes('ZZZ'), 'ni la marca ni en minúsculas');
  assert.ok(!volcado.includes('privado'), 'ni troceada');
  assert.match(aviso.meta.estructura.anidado.mensaje.metadataClaves, /^model_slug$/,
    'sólo pasa la clave de la lista blanca');
  // La ruta con la marca no pasa; las válidas del cierre siguen enteras.
  assert.equal(aviso.meta.estructura.anidado.rutasParche, '/message/content/parts/N,/message/end_turn',
    'sólo pasan las rutas de la lista blanca');
});

test('(11) un valor fuera de la lista blanca no pasa, pero se cuenta', async () => {
  const aviso = await cerrar(anidadoBase({
    roles: 'asistente-mayúsculas-ñ', metadataClaves: 'clave-con-guion,model_slug',
  }));
  const m = aviso.meta.estructura.anidado.mensaje;
  assert.equal(m.roles, '', 'el rol raro no se publica');
  assert.equal(m.metadataClaves, 'model_slug', 'la clave con guion tampoco');
  assert.ok(!JSON.stringify(aviso.meta).includes('asistente'), 'ni se cuela por otro campo');
  // Y la línea lo refleja sin inventar: no hay rol, así que no lo imprime.
  assert.match(aviso.detail, /tipo text/, 'las que sí son válidas siguen ahí');
});

/* ------------------------------------------------------------------ */
/* 12. las 6 grabaciones, sin cambios                                 */
/* ------------------------------------------------------------------ */

test('(12) los conteos de las 6 fixtures siguen igual', async () => {
  const esperado = [
    ['normal-reply.sse', 'sse', 46],
    ['regenerate.sse', 'sse', 46],
    ['thinking-reply.sse', 'sse', 7562],
    ['aborted.sse', 'sse', 643],
    ['logged-out-reply.ndjson', 'ndjson', 60],
    ['logged-out-stopped.ndjson', 'ndjson', 966],
  ];
  for (const [nombre, formato, chars] of esperado) {
    let fin = null;
    const filtro = createStreamFilter({
      adapter: 'chatgpt', format: formato, host: 'chatgpt.com', language: 'es', settings: {},
      onText: () => {}, onEnd: (info) => { fin = info; },
    });
    const cuerpo = readFileSync(new URL(`./fixtures/chatgpt-recorded/${nombre}`, import.meta.url));
    await new Response(new Blob([cuerpo]).stream().pipeThrough(filtro)).text();
    assert.equal(fin.text.length, chars, `${nombre}: los mismos caracteres de siempre`);
  }
});

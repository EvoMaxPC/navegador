/**
 * 7c-11: la **forma** del stream real de ChatGPT, sin un solo valor de texto.
 *
 * Medido en el PC con `1916909`, dos turnos reales: 0 caracteres extraídos,
 * 0 portadores, `tipos de v` sin ningún `string`, `ops add,patch,replace` sin
 * `append` y `descartes 3`/`11`. Las grabaciones del repo sí traen deltas y
 * `append`, así que lo que falta es ver **qué forma tiene** el stream que no
 * entrega texto. Esta etapa no toca el extractor: sólo lo describe.
 *
 * Dos piezas:
 *  1. `diag-stream-forma`: una firma por evento (nombres de clave, tipos y
 *     `s<longitud>`), en avisos numerados.
 *  2. Descartes por causa dentro de `estructura.anidado`.
 *
 * **Las fixtures de este archivo son SINTÉTICAS.** Ninguna grabación reproduce
 * el turno del PC; se construyen con formas que el código ya entiende.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

import { createStreamFilter, trocearEsqueleto } from '../src/core/streamFilter.js';

const MARCA = 'ZZZ-PRIVADO';
const PARTE = '/message/content/parts/0';

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
const esqueletoDe = async (cuerpo) => (await correr(cuerpo)).esqueleto;

/* ------------------------------------------------------------------ */
/* 1. la marca no se cuela                                            */
/* ------------------------------------------------------------------ */

test('(1) el esqueleto no contiene la marca, ni bajo claves que nunca se imprimen', async () => {
  const cuerpo = sse(
    {
      event: 'message',
      data: {
        type: MARCA,                                  // clave literal, valor fuera de lista
        p: `/message/content/parts/0`,
        o: 'add',
        v: {
          message: {
            id: MARCA,
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: [MARCA, `${MARCA} dos`] },
            title: MARCA,
            input_message: MARCA,
            status: 'in_progress',
            metadata: { [MARCA]: MARCA, model_slug: MARCA },
          },
        },
      },
    },
    { data: { p: PARTE, o: 'append', v: MARCA } },
    { data: `{"${MARCA}":"${MARCA}"}` },
    { data: '[DONE]' },
  );
  const firmas = await esqueletoDe(cuerpo);
  const volcado = JSON.stringify(firmas);
  assert.ok(!volcado.includes('ZZZ'), 'ni la marca ni su forma en mayúsculas');
  assert.ok(!volcado.includes('privado'), 'ni en minúsculas');
  assert.ok(!volcado.includes('PRIVADO'), 'ni troceada');

  // Y sí muestra formas: `parts` queda al límite de profundidad, y el resto de
  // los textos salen como su longitud, nunca como su contenido.
  assert.match(firmas[0], /parts:\[…\]/, 'parts se resume a esa profundidad');
  assert.match(firmas[0], /title:s11/, 'título como longitud');
  assert.match(firmas[0], /input_message:s11/, 'input_message como longitud');
  assert.match(firmas[0], /k\?:s11/, 'una clave fuera de la lista blanca es `k?`');
  assert.match(firmas[0], /content_type:text/, 'y las etiquetas válidas sí se leen');
});

test('(2) los literales sólo salen si pasan la lista blanca', async () => {
  const cuerpo = sse(
    { data: { p: `/message/${MARCA}-con espacios`, o: 'OPE RARA', role: MARCA, status: 'ok_status' } },
    { data: { p: '/message/content/parts/0', o: 'append', role: 'assistant' } },
    { data: '[DONE]' },
  );
  const firmas = await esqueletoDe(cuerpo);
  assert.match(firmas[0], /p:s33/, 'la ruta con espacios y mayúsculas no se imprime');
  assert.match(firmas[0], /o:s8/, 'la operación con espacio tampoco');
  assert.match(firmas[0], /role:s11/, 'ni el rol con la marca');
  assert.match(firmas[0], /status:ok_status/, 'pero un valor válido sí: es la excepción');
  assert.match(firmas[1], /role:assistant/, 'y un rol normal también');
  assert.match(firmas[1], /o:append/);
  assert.match(firmas[1], /p:\/message\/content\/parts\/n/, 'dígitos a N y en minúsculas');
  assert.ok(!JSON.stringify(firmas).includes('ZZZ'));
});

/* ------------------------------------------------------------------ */
/* 3. los límites                                                     */
/* ------------------------------------------------------------------ */

test('(3) profundidad 4, 8 claves y 8 elementos', async () => {
  const hondo = { a: { b: { c: { d: { e: { f: 'x' } } } } } };
  // Claves que sí pasan la lista blanca (sin dígitos), para probar el ancho.
  const ancho = Object.fromEntries(['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj', 'kk', 'll']
    .map((clave, i) => [clave, i]));
  const largo = Array.from({ length: 20 }, (_, i) => i);
  // Dos eventos: uno para la profundidad y otro para el ancho, porque con 12
  // claves el recorte a 8 dejaría la lista fuera y no se probaría nada.
  const cuerpo = sse(
    { event: 'message', data: hondo },
    { event: 'message', data: ancho },
    { event: 'message', data: { lista: largo } },
    { data: '[DONE]' },
  );
  const firmas = await esqueletoDe(cuerpo);
  const honda = firmas[0];
  assert.ok(honda.includes('{…}'), 'a profundidad 4 se corta con {…}');
  assert.ok(!honda.includes('f:'), 'y no se llega al fondo');
  const anchas = firmas[1];
  assert.match(anchas, /^message <\{aa:n,/, 'las claves válidas se leen');
  assert.match(anchas, /\+4\}>$/, 'más de 8 claves: se marca el resto');
  const listas = firmas[2];
  assert.match(listas, /lista:\[n,n,n,n,n,n,n,n,\+12\]/, 'más de 8 elementos: 8 y +12');
  assert.ok(listas.length < 400, `la firma queda corta (${listas.length})`);
});

test('(4) sólo se dibujan los primeros 24 eventos', async () => {
  const eventos = Array.from({ length: 40 }, (_, i) => ({ data: { n: i } }));
  const firmas = await esqueletoDe(sse(...eventos));
  assert.equal(firmas.length, 24, 'corte en 24');
});

test('(5) el evento no-JSON se clasifica sin volcar contenido', async () => {
  const firmas = await esqueletoDe(sse(
    { event: 'delta_encoding', data: `"${MARCA}"` },
    { data: '[DONE]' },
  ));
  // El centinela va entrecomillado: 11 + 2 comillas = 13.
  assert.equal(firmas[0], 'delta_encoding nojson:13:simbolo', 'longitud y clase, nada más');
  assert.ok(!firmas[0].includes('ZZZ'));
});

test('(6) el esqueleto se parte en varios avisos antes que cortarse', async () => {
  const firmas = Array.from({ length: 24 }, () => 'x'.repeat(200));
  const trozos = trocearEsqueleto(firmas);
  assert.ok(trozos.length > 1, `se parte (${trozos.length} trozos)`);
  assert.ok(trozos.every((t) => t.length <= 2400), 'ningún trozo pasa del tope');
  // No se pierde ni se corta ningún evento por la mitad.
  const recomponer = trozos.join(' | ');
  assert.equal(recomponer, firmas.join(' | '), 'la unión devuelve el esqueleto exacto');

  // Y un esqueleto corto cabe en un solo aviso.
  assert.deepEqual(trocearEsqueleto(['a', 'b']), ['a | b']);
});

/* ------------------------------------------------------------------ */
/* 7. descartes por causa y aceptados                                 */
/* ------------------------------------------------------------------ */

/** Raíz `add` con un mensaje, para provocar una lectura de `readMessage`. */
function mensaje({ role = 'assistant', tipo = 'text', extra = {}, metadata = {} } = {}) {
  return {
    p: '', o: 'add',
    v: { message: { id: 'm-7c11', author: { role }, content: { content_type: tipo, parts: [''] }, status: 'in_progress', metadata, ...extra } },
  };
}
const anidadoDe = async (cuerpo) => (await correr(cuerpo)).estructura.anidado;

test('(7) cada causa de descarte cae en su cubo', async () => {
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
    assert.equal(a.mensaje.causas[causa], 1, `causa ${causa}`);
    assert.equal(a.mensaje.descartados, 1, `${causa}: un descarte`);
    assert.equal(a.mensaje.aceptados, 0, `${causa}: ninguno aceptado`);
    const otras = Object.entries(a.mensaje.causas).filter(([n, v]) => n !== causa && v > 0);
    assert.deepEqual(otras, [], `${causa}: no se suma a otros cubos`);
  }
});

test('(8) un mensaje assistant aceptado no suma descartes', async () => {
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje() },
    { data: { p: PARTE, o: 'append', v: 'hola' } },
    { data: '[DONE]' },
  ));
  assert.equal(a.mensaje.aceptados, 1);
  assert.equal(a.mensaje.descartados, 0);
  assert.deepEqual(a.mensaje.causas, { rol: 0, tipo: 0, fragmento: 0, oculto: 0, canal: 0, otra: 0 });
  assert.equal(a.mensaje.assistantSi + a.mensaje.assistantNo, 0, 'sin parche de rol no hay conteo');
});

/* ------------------------------------------------------------------ */
/* 9. el proceso principal                                             */
/* ------------------------------------------------------------------ */

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

let turno = 0;
function cerrar(extra = {}) {
  turno += 1;
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c11-${turno}`);
  view.url = `https://chatgpt.com/c/7c11-${turno}`;
  invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: `m-${turno}`, chars: 0, text: '',
    outcome: 'completed', interrupted: false, finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 4, bytes: 1024 },
    ...extra,
  });
}

test('(9) con NEXO_DIAG=1 el esqueleto sale como aviso propio, troceado', async () => {
  const firmas = Array.from({ length: 24 }, (_, i) => `delta <{a:s${100 + i},b:[n,n]}>`);
  cerrar({ esqueleto: firmas });
  const avisosForma = await avisos('diag-stream-forma');
  assert.ok(avisosForma.length >= 1, 'sale el aviso nuevo');
  const partes = avisosForma.filter((a) => a.meta.eventos === 24);
  assert.equal(partes.length, avisosForma.length, 'todos describen los 24 eventos');
  assert.equal(partes[0].meta.parte, 1, 'numerado desde 1');
  const texto = partes.map((a) => a.detail).join(' | ');
  assert.match(texto, /delta <\{a:s100,b:\[n,n\]\}>/, 'con las firmas');
  assert.equal(texto.split(' | ').length, 24, 'y las 24, sin perder ninguna');
  assert.ok(!texto.includes('ZZZ'));
  // Si hubo que partirlo, cada aviso dice su número.
  if (partes.length > 1) assert.match(partes[1].detail, /^\[2\//);
});

test('(10) la marca no aparece en ningún aviso publicado', async () => {
  cerrar({ esqueleto: [`${MARCA}`, `<{${MARCA}:s1}>`, `nojson:13:simbolo`] });
  const todos = await invoke('nexo:log', shellEv);
  assert.ok(!JSON.stringify(todos).includes('ZZZ'), 'ni en diag-stream-forma ni en el resto');
});

test('(11) sin NEXO_DIAG no se publica nada', async () => {
  // `diagOn` se lee al importar `main.js`: el estado apagado va en un hijo.
  const cargador = new URL('./harness/loader.mjs', import.meta.url).href;
  const preludio = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(cargador)},import.meta.url)`;
  const guion = `
import { journal } from './test/harness/electron-stub.mjs';
await import('./src/main/main.js');
await new Promise((r) => setTimeout(r, 60));
const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const view = journal.windows[0].attachWebview('https://chatgpt.com/c/off');
await journal.ipcHandlers.get('nexo:stream-end')({ sender: view, senderFrame: view.mainFrame },
  { site: 'chatgpt', host: 'chatgpt.com', messageId: 'm', chars: 0, text: '',
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    esqueleto: ['delta <{p:s0,o:add}>', 'nojson:4:simbolo'] });
const log = await journal.ipcHandlers.get('nexo:log')({ sender: shell, senderFrame: shell.mainFrame });
console.log('DIAG=' + JSON.stringify(log.filter((e) => String(e.code).startsWith('diag-'))));
`;
  const { spawnSync } = await import('node:child_process');
  const salida = spawnSync(process.execPath, ['--import', preludio, '--input-type=module', '-e', guion],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, NEXO_DIAG: '0' } });
  assert.equal(salida.status, 0, `el hijo termina bien: ${salida.stderr}`);
  const linea = (salida.stdout || '').split('\n').find((l) => l.startsWith('DIAG='));
  assert.ok(linea, `el hijo informa: ${salida.stdout}`);
  assert.deepEqual(JSON.parse(linea.slice(5)), [], 'sin la variable no sale ningún diag-*');
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

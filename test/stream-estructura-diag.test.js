/**
 * 7c-9: resumen **estructural** del stream en `diag-stream-end`.
 *
 * En dos turnos reales el stream llegó como `text/event-stream`/`sse` con 10 y
 * 12 trozos, decenas de miles de bytes y `outcome completed`, y el acumulador
 * sacó 0 caracteres. Con los conteos de 7c-8 no se puede saber si eso fue
 * formato, cancelación o eventos con otra forma; esto añade las **formas** del
 * stream —cuántos eventos, cuántos JSON, qué nombres de evento y de clave, qué
 * tipo tiene `v`, cuántos eventos el extractor consideró portadores— sin
 * publicar ni un valor.
 *
 * Tres capas:
 *
 *  1. El filtro real (`src/core/streamFilter.js`) con las 6 fixtures grabadas:
 *     los conteos tienen que coincidir con el contenido de cada una y los
 *     caracteres extraídos tienen que ser los mismos de siempre.
 *  2. La capa inyectada (`build/inject.js`) en un `vm`: lo que sale del `diag`
 *     del `stream-end`, con la marca centinela en un valor, en una clave y en
 *     un `event:`.
 *  3. El proceso principal real: `diag-stream-end` publica el resumen con
 *     `NEXO_DIAG=1` y no publica ningún `diag-*` con la variable apagada.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

import { createStreamFilter } from '../src/core/streamFilter.js';

const FIXTURES = new URL('./fixtures/chatgpt-recorded/', import.meta.url);
const leerFixture = (nombre) => readFileSync(new URL(nombre, FIXTURES));

/** Las 6 grabaciones con su formato de cable. */
const CASOS = [
  { nombre: 'normal-reply.sse', formato: 'sse', chars: 46,
    estructura: { eventos: 23, conDatos: 23, jsonValido: 21, jsonInvalido: 1, dones: 1, portadores: 2 },
    eventos: ['delta_encoding', 'message', 'delta'],
    claves: ['type', 'kind', 'token', 'conversation_id', 'p', 'o', 'v', 'c', 'message_id', 'marker', 'event', 'title'],
    tiposV: ['object', 'array', 'boolean'] },
  { nombre: 'regenerate.sse', formato: 'sse', chars: 46,
    estructura: { eventos: 20, conDatos: 20, jsonValido: 18, jsonInvalido: 1, dones: 1, portadores: 2 },
    eventos: ['delta_encoding', 'message', 'delta'],
    claves: ['type', 'kind', 'token', 'conversation_id', 'p', 'o', 'v', 'c', 'message_id', 'marker', 'event', 'metadata'],
    tiposV: ['object', 'array', 'boolean'] },
  { nombre: 'thinking-reply.sse', formato: 'sse', chars: 7562,
    estructura: { eventos: 115, conDatos: 114, jsonValido: 112, jsonInvalido: 1, dones: 1, portadores: 34 },
    eventos: ['delta_encoding', 'message', 'delta'],
    claves: ['type', 'kind', 'token', 'conversation_id', 'p', 'o', 'v', 'c', 'message_id', 'marker', 'event', 'title'],
    tiposV: ['object', 'string', 'array', 'number', 'boolean'] },
  { nombre: 'aborted.sse', formato: 'sse', chars: 643,
    estructura: { eventos: 19, conDatos: 19, jsonValido: 18, jsonInvalido: 1, dones: 0, portadores: 6 },
    eventos: ['delta_encoding', 'message', 'delta'],
    claves: ['type', 'kind', 'token', 'conversation_id', 'p', 'o', 'v', 'c', 'message_id', 'marker', 'event', 'title'],
    tiposV: ['object', 'array'] },
  { nombre: 'logged-out-reply.ndjson', formato: 'ndjson', chars: 60,
    estructura: { eventos: 0, conDatos: 0, jsonValido: 16, jsonInvalido: 0, dones: 0, portadores: 3, lineas: 16 },
    eventos: [],
    claves: ['version', 'type', 'detail', 'html', 'stopconduittoken', 'messageid', 'revision', 'mode', 'markdown', 'references', 'dil', 'approvedurls'],
    tiposV: [] },
  { nombre: 'logged-out-stopped.ndjson', formato: 'ndjson', chars: 966,
    estructura: { eventos: 0, conDatos: 0, jsonValido: 35, jsonInvalido: 0, dones: 0, portadores: 8, lineas: 35 },
    eventos: [],
    claves: ['version', 'type', 'detail', 'html', 'stopconduittoken', 'messageid', 'revision', 'mode', 'markdown', 'references', 'dil', 'approvedurls'],
    tiposV: [] },
];

/** Pasa un cuerpo por el filtro real y devuelve el `onEnd`. */
async function transitar(cuerpo, formato) {
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: formato, host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  await new Response(new Blob([cuerpo]).stream().pipeThrough(filtro)).text();
  return fin;
}

/* ------------------------------------------------------------------ */
/* 1. el filtro con las 6 grabaciones                                  */
/* ------------------------------------------------------------------ */

test('(a) el resumen del filtro coincide con lo que contiene cada fixture', async () => {
  for (const caso of CASOS) {
    const fin = await transitar(leerFixture(caso.nombre), caso.formato);
    assert.ok(fin, `${caso.nombre}: el filtro cierra la captura`);
    const e = fin.estructura;
    assert.ok(e, `${caso.nombre}: el cierre trae el resumen`);
    for (const [campo, valor] of Object.entries(caso.estructura)) {
      assert.equal(e[campo], valor, `${caso.nombre}: ${campo}`);
    }
    assert.equal(e.clavesOtros, 0, `${caso.nombre}: todas las claves de primer nivel caben en la lista blanca`);
    // El resumen entrega listas ya renderizadas (cadena acotada), no arrays.
    assert.equal(e.nombresEvento, caso.eventos.join(','), `${caso.nombre}: nombres de evento en orden`);
    assert.equal(e.claves, caso.claves.join(','), `${caso.nombre}: claves en orden de aparición, acotadas a 12`);
    assert.equal(e.tiposV, caso.tiposV.join(','), `${caso.nombre}: tipos de v en orden de aparición`);
    assert.equal(e.sinEvento, 0, `${caso.nombre}: todos los eventos con datos traen nombre`);
    assert.equal(e.lineas, caso.estructura.lineas || 0, `${caso.nombre}: líneas sólo en NDJSON`);
  }
});

test('(e) los caracteres extraídos de las 6 fixtures siguen siendo los mismos', async () => {
  // La instrumentación cuenta formas: no puede cambiar ni un carácter de lo que
  // el extractor entrega. Estos son los valores de referencia de la etapa.
  const esperado = [46, 46, 7562, 643, 60, 966];
  const obtenido = [];
  for (const caso of CASOS) {
    const fin = await transitar(leerFixture(caso.nombre), caso.formato);
    assert.equal(fin.text.length, caso.chars, `${caso.nombre}: los caracteres de siempre`);
    obtenido.push(fin.text.length);
  }
  assert.deepEqual(obtenido, esperado, 'la lista completa, en el orden de las etapas anteriores');
});

/* ------------------------------------------------------------------ */
/* 2. la capa inyectada: sólo formas, nunca valores                    */
/* ------------------------------------------------------------------ */

const RUTA = new URL('../build/inject.js', import.meta.url);
const fuente = existsSync(RUTA) ? readFileSync(RUTA, 'utf8') : null;
const sinBundle = !fuente && 'falta build/inject.js (npm run build:inject)';

/** Mundo mínimo para la capa, igual que en `test/capa-inyectada.test.js`. */
function crearMundo(cuerpo) {
  const listeners = [];
  const salientes = [];
  const window = {
    __NEXO_CONFIG__: { host: 'chatgpt.com', enabled: true, settings: {}, language: 'es', version: '0.1.0', site: 'chatgpt' },
    location: { href: 'https://chatgpt.com/c/7c9', hostname: 'chatgpt.com', pathname: '/c/7c9', protocol: 'https:' },
    fetch: async () => new Response(cuerpo, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    addEventListener: (tipo, fn) => { if (tipo === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => {
      salientes.push(msg);
      if (msg.__nexo !== 'call') return;
      setTimeout(() => {
        const data = { __nexo: 'reply', id: msg.id, payload: { text: String(msg.payload?.prompt || '') } };
        for (const fn of listeners) fn({ source: window, data });
      }, 0);
    },
    setTimeout, clearTimeout, TextDecoder, TextEncoder,
    ReadableStream, WritableStream, TransformStream, Response, Headers, Request, URL,
    console,
    navigator: { userAgent: 'Chrome' },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
  };
  window.window = window;
  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });
  return { window, salientes };
}

/** Cuerpo con la marca en un valor de texto, en una clave y en un `event:`. */
const MARCA = 'ZZ-SECRETO-ZZ';
const cuerpoConMarca = () => [
  `event: ${MARCA}`,
  `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: `${MARCA} texto visible`, [MARCA]: 'x' })}`,
  '',
  `event: delta`,
  `data: ${JSON.stringify({ type: 'delta', v: MARCA })}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

test('(c) la marca no aparece en ningún campo publicado por la capa', { skip: sinBundle }, async () => {
  const mundo = crearMundo(cuerpoConMarca());
  const respuesta = await mundo.window.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: '{}' });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 80));

  const cierre = mundo.salientes.find((m) => m.type === 'stream-end');
  assert.ok(cierre, 'la capa cierra el turno');
  // El resumen viaja al lado de `diag`, no dentro: `diag` mantiene su
  // contrato de números y etiquetas que fija `stream-end-diag-y-cancelacion`.
  const publicado = JSON.stringify({ diag: cierre.payload.diag, estructura: cierre.payload.estructura });
  assert.ok(!publicado.includes('ZZ'), 'ni la marca, ni el `ZZ-SECRETO-ZZ` del valor o de la clave');
  assert.ok(!publicado.includes('secret'), 'ni en minúsculas');
  assert.deepEqual(Object.keys(cierre.payload.diag).sort(), ['bytes', 'formato', 'mime', 'trozos'],
    'diag sigue siendo sólo números y etiquetas');
  const e = cierre.payload.estructura;
  assert.equal(e.nombresEvento, 'delta,message', 'la marca del event: no se publica');
  assert.ok(!e.claves.includes('zz'), 'ni la clave rara');
  assert.ok(e.portadores >= 1, 'y el evento de texto sí se contó como portador');
  assert.equal(e.eventos, 3, 'los tres eventos con datos');
});

/* ------------------------------------------------------------------ */
/* 3. el proceso principal                                             */
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
const registro = async () => invoke('nexo:log', shellEv);
const avisos = async (code) => (await registro()).filter((e) => e.code === code);

let turno = 0;
function pestana() {
  turno += 1;
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c9-${turno}`);
  view.url = `https://chatgpt.com/c/7c9-${turno}`;
  return view;
}
/** El `diag` tal como lo manda la capa, ya transitable. */
const diagDe = (caso) => ({
  mime: 'text/event-stream', formato: caso.formato, trozos: 10, bytes: 30352,
  estructura: { ...caso.estructura, nombresEvento: caso.eventos.join(','),
    claves: caso.claves.slice(0, 12).join(','), clavesOtros: 0,
    tiposV: caso.tiposV.join(','), sinEvento: 0, lineas: caso.estructura.lineas || 0 },
});

test('(a bis) diag-stream-end publica el resumen de cada fixture con NEXO_DIAG=1', async () => {
  const antes = (await avisos('diag-stream-end')).length;
  for (const caso of CASOS) {
    const view = pestana();
    invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
      host: 'chatgpt.com', site: 'chatgpt', messageId: `m-${turno}`,
      chars: caso.chars, deliveredChars: caso.chars, text: caso.chars ? 'x'.repeat(caso.chars) : '',
      outcome: 'completed', interrupted: false, finished: true, diag: diagDe(caso), estructura: diagDe(caso).estructura,
    });
  }
  // El registro de avisos llega del más nuevo al más viejo.
  const nuevos = (await avisos('diag-stream-end')).slice(0, -antes || undefined).reverse();
  assert.equal(nuevos.length, CASOS.length, 'un aviso por cierre');

  CASOS.forEach((caso, i) => {
    const aviso = nuevos[i];
    const e = aviso.meta.estructura;
    assert.ok(e, `${caso.nombre}: el aviso lleva el resumen`);
    for (const [campo, valor] of Object.entries(caso.estructura)) {
      assert.equal(e[campo], valor, `${caso.nombre}: meta.${campo}`);
    }
    assert.equal(e.portadores, caso.estructura.portadores, `${caso.nombre}: portadores`);
    assert.equal(e.nombresEvento, caso.eventos.join(','), `${caso.nombre}: nombres de evento`);
    if (caso.estructura.tiposV === 0 || caso.tiposV.length === 0) {
      assert.equal(e.tiposV, '', `${caso.nombre}: sin campo \`v\`, sin tipos`);
    } else {
      assert.equal(e.tiposV, caso.tiposV.join(','), `${caso.nombre}: tipos de v`);
    }
    assert.match(aviso.detail, /estructura eventos/, 'y la línea de texto lo resume');
    assert.match(aviso.detail, new RegExp(`portadores ${caso.estructura.portadores}`));
    assert.match(aviso.detail, new RegExp(`claves ${caso.claves[0]},`), `${caso.nombre}: las claves en la línea`);
  });
});

test('(c bis) el aviso del proceso principal tampoco lleva la marca', async () => {
  const view = pestana();
  invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'm-marca', chars: 3, deliveredChars: 3,
    text: 'texto', outcome: 'completed', interrupted: false, finished: true,
    estructura: { eventos: 2, conDatos: 2, jsonValido: 1, jsonInvalido: 1, sinEvento: 0, dones: 0,
        nombresEvento: 'delta', claves: 'v,type', clavesOtros: 0, tiposV: 'string', portadores: 1, lineas: 0 },
  });
  const aviso = (await avisos('diag-stream-end'))[0];   // el más reciente
  const volcado = JSON.stringify({ detail: aviso.detail, meta: aviso.meta });
  assert.ok(!volcado.includes('ZZ'), 'ni la marca');
  assert.ok(!volcado.includes('https://'), 'ni la URL');
  assert.match(volcado, /"estructura"/, 'pero el resumen está');
});

test('(d) 10.000 claves distintas dan una salida acotada', async () => {
  // La capa ya acota a 12 nombres; aquí se comprueba además que `main` no se
  // fía: si llegara una lista enorme, la recorta y cuenta el resto como otros.
  // Nombres **válidos** y muy repetidos: el acotado no puede depender de que la
  // capa los haya filtrado antes. Y entre ellos, uno larguísimo con la marca:
  // si la lista blanca no se aplicara, se publicaría.
  const validas = Array.from({ length: 9_998 }, (_, i) => `clave_${i}`).join(',');
  const claves = [validas, `${MARCA}-${'x'.repeat(200)}`, 'nombre_valido'].join(',');
  const view = pestana();
  invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'm-10k', chars: 1, deliveredChars: 1,
    text: 'x', outcome: 'completed', interrupted: false, finished: true,
    estructura: { eventos: 1, conDatos: 1, jsonValido: 1, jsonInvalido: 0, sinEvento: 0, dones: 0,
        nombresEvento: 'delta', claves, clavesOtros: 0,
        tiposV: `string,${MARCA},String`, portadores: 1, lineas: 0 },
  });
  const aviso = (await avisos('diag-stream-end'))[0];   // el registro llega del más nuevo al más viejo
  const e = aviso.meta.estructura;
  // `clave_0`… llevan dígitos, así que no pasan `[a-z_]{1,24}`: `main` las
  // descarta y las suma a `otros`. Lo que importa: la salida no crece con la
  // entrada, ni en variedad ni en longitud.
  assert.ok(e.claves.length <= 200, `claves acotadas (${e.claves.length} caracteres)`);
  assert.ok(e.claves.split(',').filter(Boolean).length <= 12, 'como mucho 12 nombres');
  assert.ok(JSON.stringify(e).length <= 1200, `resumen acotado (${JSON.stringify(e).length} caracteres)`);
  assert.ok(aviso.detail.length <= 700, `línea acotada (${aviso.detail.length} caracteres)`);
  assert.ok(e.clavesOtros > 0, 'el resto se cuenta como otros');
  assert.ok(!JSON.stringify(e).includes('ZZ'), 'ni el nombre larguísimo ni la marca en los tipos');
  assert.equal(e.tiposV, 'string', 'los tipos fuera de la lista blanca no se publican');
});

test('(b) con NEXO_DIAG apagado no se publica ningún diag-*', () => {
  // `diagOn` se lee al importar `main.js`, así que el estado apagado se prueba
  // en un proceso hijo, como en `diag-main-off.test.js` y en 7c-8.
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
  { site: 'chatgpt', host: 'chatgpt.com', messageId: 'm', chars: 1, text: 'x',
    outcome: 'completed', finished: true,
    estructura: { eventos: 1, conDatos: 1, jsonValido: 1, jsonInvalido: 0, sinEvento: 0,
      dones: 0, nombresEvento: 'delta', claves: 'v', clavesOtros: 0, tiposV: 'string',
      portadores: 1, lineas: 0 } });
const log = await journal.ipcHandlers.get('nexo:log')({ sender: shell, senderFrame: shell.mainFrame });
console.log('DIAG=' + JSON.stringify(log.filter((e) => String(e.code).startsWith('diag-'))));
`;
  const salida = spawnSync(process.execPath, ['--import', preludio, '--input-type=module', '-e', guion],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, NEXO_DIAG: '0' } });
  assert.equal(salida.status, 0, `el hijo termina bien: ${salida.stderr}`);
  const linea = (salida.stdout || '').split('\n').find((l) => l.startsWith('DIAG='));
  assert.ok(linea, `el hijo informa: ${salida.stdout}`);
  assert.deepEqual(JSON.parse(linea.slice(5)), [], 'sin la variable no sale ningún aviso de diagnóstico');
});

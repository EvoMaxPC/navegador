/**
 * 7c-12: por qué no salió `diag-stream-forma` en el PC, y qué significa
 * "oculto" para el mensaje del asistente.
 *
 * Medido en el PC con `3bb5ac0`: ningún aviso `diag-stream-forma` en dos turnos,
 * `rutaTexto` todo a 0 teniendo `/message/content/parts/N` en las rutas, y
 * `oculto 1` en ambos turnos con roles `system`/`assistant`.
 *
 * Causa encontrada (verificada ejecutando la ruta real): **la capa nunca mandó
 * `esqueleto` en el `stream-end`**. `build/inject.js` sólo copiaba
 * `estructura`, así que `main` no tenía nada que publicar. El segundo defecto
 * era el patrón `ESQUELETO_SEGURO`, que no admitía `?` y descartaba 13 de las
 * 86 firmas de las grabaciones — justo los `delta` con parches, los que traen
 * el texto.
 *
 * Este archivo ejercita **la ruta real completa** (capa → payload → `main`), no
 * las funciones sueltas: es lo que faltaba en 7c-11 y por lo que el fallo pasó.
 *
 * **Las fixtures son SINTÉTICAS** salvo donde se dice «grabada».
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

import { createStreamFilter } from '../src/core/streamFilter.js';
import { createAdapter } from '../src/core/streamAdapters.js';

const MARCA = 'ZZZ-PRIVADO';
const PARTE = '/message/content/parts/0';
const FIXTURES = new URL('./fixtures/chatgpt-recorded/', import.meta.url);
const leerFixture = (n) => readFileSync(new URL(n, FIXTURES), 'utf8');

/* ------------------------------------------------------------------ */
/* proceso principal real                                             */
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
const pestana = () => {
  turno += 1;
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c12-${turno}`);
  view.url = `https://chatgpt.com/c/7c12-${turno}`;
  return view;
};

/* ------------------------------------------------------------------ */
/* capa inyectada real (build/inject.js en un vm)                     */
/* ------------------------------------------------------------------ */

const RUTA_BUNDLE = new URL('../build/inject.js', import.meta.url);
const fuente = readFileSync(RUTA_BUNDLE, 'utf8');

/**
 * Mundo mínimo, el mismo de `test/capa-inyectada.test.js`. La diferencia con
 * los tests de 7c-11: aquí se usa **lo que la capa emite de verdad**, no un
 * payload armado a mano.
 */
async function payloaDeLaCapa(cuerpo) {
  const salientes = [];
  const window = {
    __NEXO_CONFIG__: { host: 'chatgpt.com', enabled: true, settings: {}, language: 'es', version: '0.1.0', site: 'chatgpt' },
    location: { href: 'https://chatgpt.com/c/7c12', hostname: 'chatgpt.com', pathname: '/c/7c12', protocol: 'https:' },
    fetch: async () => new Response(cuerpo, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: (msg) => { salientes.push(msg); },
    setTimeout, clearTimeout, TextDecoder, TextEncoder,
    ReadableStream, WritableStream, TransformStream, Response, Headers, Request, URL,
    console,
    navigator: { userAgent: 'Chrome' },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
  };
  window.window = window;
  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });
  const respuesta = await window.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body: '{}' });
  await respuesta.text();
  await new Promise((r) => setTimeout(r, 120));
  return salientes.find((m) => m.type === 'stream-end')?.payload || null;
}

/* ------------------------------------------------------------------ */
/* 1. la ruta real: el esqueleto llega a main y se publica            */
/* ------------------------------------------------------------------ */

test('(1) la capa manda el esqueleto y main publica diag-stream-forma (fixture grabada)', async () => {
  const payload = await payloaDeLaCapa(leerFixture('normal-reply.sse'));
  assert.ok(payload, 'la capa cierra el turno');
  assert.ok(Array.isArray(payload.esqueleto), 'el payload lleva `esqueleto`');
  assert.equal(payload.esqueleto.length, 23, 'una firma por evento de la grabación');

  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, payload);
  const partes = await avisos('diag-stream-forma');
  assert.ok(partes.length >= 1, 'el aviso sale por la ruta real');

  // El registro llega del más nuevo al más viejo: se ordena por número de parte.
  const ordenadas = [...partes].sort((x, y) => x.meta.parte - y.meta.parte);
  const texto = ordenadas.map((a) => a.detail.replace(/^\[\d+\/\d+\] /, '')).join(' | ');
  const firmas = texto.split(' | ');
  assert.equal(firmas.length, 23, 'no se pierde ninguna firma por el camino');
  assert.equal(firmas[0], 'delta_encoding nojson:4:simbolo', 'el preámbulo del protocolo');
  assert.match(texto, /parts:\[…\]/, 'y las partes aparecen (resumidas)');
  // Antes de este arreglo, los `delta` con parches no pasaban el patrón.
  assert.match(texto, /k\?:s\d+/, 'las claves fuera de lista salen como k?');
  assert.ok(!texto.includes('hola'), 'sin texto del chat');
});

test('(2) las cuatro grabaciones SSE publican su esqueleto, con todas sus firmas', async () => {
  const casos = [
    ['normal-reply.sse', 23], ['regenerate.sse', 20], ['thinking-reply.sse', 24], ['aborted.sse', 19],
  ];
  for (const [nombre, firmas] of casos) {
    const payload = await payloaDeLaCapa(leerFixture(nombre));
    assert.equal(payload.esqueleto.length, firmas, `${nombre}: el filtro produce ${firmas}`);

    const antes = (await avisos('diag-stream-forma')).length;
    const view = pestana();
    await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, payload);
    const todos = await avisos('diag-stream-forma');
    const nuevos = todos.slice(0, todos.length - antes).sort((x, y) => x.meta.parte - y.meta.parte);
    const texto = nuevos.map((a) => a.detail.replace(/^\[\d+\/\d+\] /, '')).join(' | ');
    assert.equal(texto.split(' | ').length, firmas, `${nombre}: ninguna firma se descarta en main`);
  }
});

test('(3) el patrón de main no descarta firmas legítimas', async () => {
  // Las firmas que salen de verdad llevan `k?` (clave fuera de lista) y `…`
  // (recorte por profundidad). Si el patrón no las admite, se pierden enteras.
  const payload = await payloaDeLaCapa(leerFixture('thinking-reply.sse'));
  const sospechosas = payload.esqueleto.filter((f) => f.includes('k?') || f.includes('…'));
  assert.ok(sospechosas.length > 0, 'la grabación trae firmas con `k?` y con `…`');

  const antes = (await avisos('diag-stream-forma')).length;
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, payload);
  const todos = await avisos('diag-stream-forma');
  const texto = todos.slice(0, todos.length - antes).map((a) => a.detail).join(' | ');
  assert.match(texto, /k\?/, 'las de `k?` llegan');
  assert.match(texto, /…/, 'y las recortadas también');
});

/* ------------------------------------------------------------------ */
/* 2. firmas de descarte por causa                                    */
/* ------------------------------------------------------------------ */

/** Raíz `add` con un mensaje, para provocar una lectura de `readMessage`. */
function mensaje({ role = 'assistant', tipo = 'text', extra = {}, metadata = {}, parts = [''] } = {}) {
  return {
    p: '', o: 'add',
    v: { message: { id: 'm-7c12', author: { role }, content: { content_type: tipo, parts }, status: 'in_progress', metadata, ...extra } },
  };
}
const sse = (...eventos) => eventos
  .map(({ event = 'delta', data }) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  .join('');

async function anidadoDe(cuerpo) {
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  await new Response(new Blob([cuerpo]).stream().pipeThrough(filtro)).text();
  return fin.estructura.anidado;
}

test('(4) cada descarte deja su firma con la causa y los valores del criterio', async () => {
  const casos = [
    ['rol', mensaje({ role: 'user' })],
    ['tipo', mensaje({ tipo: 'code' })],
    ['fragmento', mensaje({ metadata: { is_message_fragment: true } })],
    ['oculto', mensaje({ metadata: { is_visually_hidden_from_conversation: true } })],
    ['canal', mensaje({ extra: { channel: 'commentary' } })],
  ];
  for (const [causa, base] of casos) {
    const a = await anidadoDe(sse({ event: 'message', data: base }, { data: '[DONE]' }));
    assert.equal(a.mensaje.descartes.length, 1, `${causa}: una firma`);
    const d = a.mensaje.descartes[0];
    assert.equal(d.causa, causa, `${causa}: la causa declarada`);
    assert.equal(d.parts0, 's0', `${causa}: la parte 0 estaba vacía`);
    assert.equal(d.partsN, 1, `${causa}: una parte`);
    // Los dos booleanos que lee el criterio de "oculto" siempre van dichos.
    assert.ok(['true', 'false', '-'].includes(d.oculto), `${causa}: oculto declarado`);
    assert.ok(['true', 'false', '-'].includes(d.fragmento), `${causa}: fragmento declarado`);
  }

  // El caso del PC: role assistant + oculto → causa `oculto`, no `rol`.
  const pc = await anidadoDe(sse(
    { event: 'message', data: mensaje({ role: 'system' }) },
    { event: 'message', data: mensaje({ metadata: { is_visually_hidden_from_conversation: true } }) },
    { data: '[DONE]' },
  ));
  assert.equal(pc.mensaje.causas.rol, 1);
  assert.equal(pc.mensaje.causas.oculto, 1, 'el asistente cae en oculto, no en rol');
  assert.equal(pc.mensaje.descartes[1].role, 'assistant');
  assert.equal(pc.mensaje.descartes[1].oculto, 'true', 'y se ve el valor que lo disparó');
});

test('(5) un mensaje aceptado no deja firma de descarte', async () => {
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje() },
    { data: { p: PARTE, o: 'append', v: 'hola' } },
    { data: '[DONE]' },
  ));
  assert.equal(a.mensaje.aceptados, 1);
  assert.equal(a.mensaje.descartes.length, 0, 'sin firma');
});

test('(6) tope de 12 firmas por stream, también en el adaptador', async () => {
  const muchos = Array.from({ length: 20 }, () => ({ event: 'message', data: mensaje({ role: 'user' }) }));
  const a = await anidadoDe(sse(...muchos, { data: '[DONE]' }));
  assert.equal(a.mensaje.descartados, 20, 'se cuentan todos');
  assert.equal(a.mensaje.descartes.length, 12, 'pero sólo se firman 12');

  // Y el tope está también en el adaptador, no sólo en el filtro: un solo
  // evento con 20 mensajes anidados no puede producir 20 firmas.
  const adaptador = createAdapter('chatgpt', {});
  const plan = adaptador.read({
    o: 'patch',
    v: Array.from({ length: 20 }, (_, i) => ({ p: '', o: 'add', v: { message: {
      id: `m${i}`, author: { role: 'user' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress',
    } } })),
  });
  assert.equal(plan.descartados, 20, 'el adaptador cuenta los 20');
  assert.equal(plan.descartes.length, 12, 'y firma sólo 12');
});

test('(7) las firmas de descarte se ven en la línea publicada', async () => {
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje({ role: 'system' }) },
    { event: 'message', data: mensaje({ metadata: { is_visually_hidden_from_conversation: true } }) },
    { data: '[DONE]' },
  ));
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'm-linea', chars: 0, text: '',
    outcome: 'completed', interrupted: false, finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: { eventos: 2, conDatos: 2, jsonValido: 2, jsonInvalido: 0, sinEvento: 0, dones: 0,
      nombresEvento: 'message', claves: 'p,o,v', clavesOtros: 0, tiposV: 'object', portadores: 0, lineas: 0,
      anidado: a },
  });
  const aviso = (await avisos('diag-stream-end'))[0];
  assert.match(aviso.detail, /#1 rol rol:system/, 'la primera causa, con su rol');
  assert.match(aviso.detail, /#2 oculto rol:assistant/, 'y la del asistente');
  assert.match(aviso.detail, /ocul:true/, 'con el valor que lo disparó');
  assert.match(aviso.detail, /parts0:s0 partsN:1/, 'y la forma de las partes');
});

/* ------------------------------------------------------------------ */
/* 3. la marca no se cuela en ninguna cadena publicada                */
/* ------------------------------------------------------------------ */

test('(8) la marca no aparece en el esqueleto publicado', async () => {
  const cuerpo = sse(
    { event: 'message', data: { type: MARCA, p: `/message/${MARCA}`, o: MARCA, v: { message: {
      id: MARCA, author: { role: MARCA }, content: { content_type: 'text', parts: [MARCA] },
      title: MARCA, input_message: MARCA, status: 'in_progress', metadata: { [MARCA]: MARCA },
    } } } },
    { data: `"${MARCA}"` },
    { data: '[DONE]' },
  );
  const payload = await payloaDeLaCapa(cuerpo);
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, payload);
  const todos = await invoke('nexo:log', shellEv);
  const conForma = JSON.stringify(todos.filter((e) => e.code === 'diag-stream-forma'));
  assert.ok(!conForma.includes('ZZZ'), 'ni en diag-stream-forma');
  assert.ok(!conForma.toLowerCase().includes('privado'), 'ni en minúsculas');
});

test('(9) la marca no aparece en las firmas de descarte', async () => {
  const a = await anidadoDe(sse(
    { event: 'message', data: mensaje({ role: MARCA, extra: { status: MARCA, channel: MARCA },
      metadata: { [MARCA]: true, is_visually_hidden_from_conversation: true }, parts: [MARCA] }) },
    { data: '[DONE]' },
  ));
  const d = a.mensaje.descartes[0];
  assert.equal(d.role, 'otra', 'un rol raro no se publica');
  assert.equal(d.status, 'otra');
  assert.equal(d.channel, 'otra');
  assert.equal(d.parts0, 's11', 'y las partes salen como longitud');
  assert.ok(!JSON.stringify(a).includes('ZZZ'));

  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: 0, text: '', outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: { eventos: 1, conDatos: 1, jsonValido: 1, jsonInvalido: 0, sinEvento: 0, dones: 0,
      nombresEvento: 'message', claves: 'p,o,v', clavesOtros: 0, tiposV: 'object', portadores: 0, lineas: 0,
      anidado: a },
  });
  const aviso = (await avisos('diag-stream-end'))[0];
  assert.ok(!JSON.stringify(aviso).includes('ZZZ'), 'tampoco en la línea del aviso');

  // Y el saneado de `main` por sí solo: un payload con la marca en TODOS los
  // campos de la firma tiene que salir limpio de su copia defensiva.
  const view2 = pestana();
  const firmaSucia = {
    causa: 'otra', role: MARCA, content_type: MARCA, status: MARCA, channel: MARCA,
    recipient: MARCA, fragmento: MARCA, oculto: MARCA, parts0: MARCA, partsN: 1,
  };
  await invoke('nexo:stream-end', { sender: view2, senderFrame: view2.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: 0, text: '', outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: { eventos: 1, conDatos: 1, jsonValido: 1, jsonInvalido: 0, sinEvento: 0, dones: 0,
      nombresEvento: 'message', claves: 'p,o,v', clavesOtros: 0, tiposV: 'object', portadores: 0, lineas: 0,
      anidado: { vArray: 0, elementos: 0, clavesElemento: '', tiposElementoV: '', opsEvento: '', opsElemento: '',
        rutasParche: '', rutasEvento: '', vObjetoClaves: '', fueraDeLista: false,
        mensaje: { roles: '', tipos: '', estados: '', canales: '', metadataClaves: '',
          descartados: 1, sinTexto: 1, aceptados: 0, vistos: 1,
          causas: { rol: 0, tipo: 0, fragmento: 0, oculto: 0, canal: 0, otra: 1 },
          assistantSi: 0, assistantNo: 0, otra: false, descartes: [firmaSucia] },
        rutaTexto: { string: 0, array: 0, object: 0, otro: 0, conSegmento: 0 }, noJson: null } },
  });
  const sucio = (await avisos('diag-stream-end'))[0];
  const m = sucio.meta.estructura.anidado.mensaje.descartes[0];
  assert.equal(m.role, 'otra', 'el rol con la marca se descarta en main');
  assert.equal(m.status, 'otra');
  assert.equal(m.parts0, '-', 'y un `parts0` que no sea `s<n>` se descarta');
  assert.ok(!JSON.stringify(sucio).includes('ZZZ'), 'la marca no llega al aviso');
});

test('(10) sin NEXO_DIAG no se publica el esqueleto ni nada diag-*', async () => {
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
  assert.deepEqual(JSON.parse(linea.slice(5)), [], 'sin la variable no sale nada');
});

/* ------------------------------------------------------------------ */
/* 4. las 6 grabaciones, sin cambios                                  */
/* ------------------------------------------------------------------ */

test('(11) los caracteres de las 6 fixtures siguen iguales', async () => {
  const esperado = [
    ['normal-reply.sse', 'sse', 46], ['regenerate.sse', 'sse', 46], ['thinking-reply.sse', 'sse', 7562],
    ['aborted.sse', 'sse', 643], ['logged-out-reply.ndjson', 'ndjson', 60],
    ['logged-out-stopped.ndjson', 'ndjson', 966],
  ];
  for (const [nombre, formato, chars] of esperado) {
    let fin = null;
    const filtro = createStreamFilter({
      adapter: 'chatgpt', format: formato, host: 'chatgpt.com', language: 'es', settings: {},
      onText: () => {}, onEnd: (info) => { fin = info; },
    });
    await new Response(new Blob([leerFixture(nombre)]).stream().pipeThrough(filtro)).text();
    assert.equal(fin.text.length, chars, `${nombre}`);
  }
});

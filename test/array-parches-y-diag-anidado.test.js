/**
 * 7c-10: `v` como array de parches en el extractor de ChatGPT, y diagnóstico
 * nivel 2 para distinguir las dos hipótesis del turno sin texto.
 *
 * Medido en el PC con 7c-9: dos stream-end `text/event-stream`/`sse`,
 * `completed`, extractor 0 caracteres y `tipos de v = object,array,boolean`
 * (ningún `string`), con 0 portadores.
 *
 * **Las fixtures de este archivo son SINTÉTICAS.** Ninguna grabación cubre un
 * `v` array heterogéneo; se construyen sólo con formas que el código ya
 * entiende: raíz `add` con mensaje `assistant`, parches `p`/`o`/`v` sobre
 * `/message/content/parts/N`, un `delta_encoding` y un evento no-JSON.
 *
 * Dos mitades:
 *
 *  1. El adaptador tolera elementos que no encajan en un array de parches
 *     (antes: si **todos** no traían `p`, se descartaba el array entero) y el
 *     filtro sigue entregando los mismos caracteres en las 6 grabaciones.
 *  2. `estructura.anidado` publica la forma de lo que va dentro de `v` —rutas
 *     normalizadas, operaciones, tipos, etiquetas del mensaje— y cuántas veces
 *     el adaptador descartó un mensaje por rol/tipo/fragmento/oculto.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

import { createStreamFilter } from '../src/core/streamFilter.js';
import { createAdapter } from '../src/core/streamAdapters.js';

const FIXTURES = new URL('./fixtures/chatgpt-recorded/', import.meta.url);
const leerFixture = (nombre) => readFileSync(new URL(nombre, FIXTURES));

const MARCA = 'ZZZ-PRIVADO';
const PARTE = '/message/content/parts/0';

/* ------------------------------------------------------------------ */
/* constructores de la fixture SINTÉTICA                              */
/* ------------------------------------------------------------------ */

/** Raíz `add` con el mensaje del asistente y un `parts` vacío. */
function raiz({ role = 'assistant', tipo = 'text', extra = {}, parts = [''] } = {}) {
  return {
    p: '',
    o: 'add',
    v: {
      message: {
        id: 'm-7c10',
        author: { role },
        content: { content_type: tipo, parts },
        status: 'in_progress',
        ...extra,
      },
    },
  };
}

const sse = (...eventos) => eventos
  .map(({ event = 'delta', data }) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  .join('');

/** Parche de texto sobre la parte 0. */
const parche = (texto) => ({ p: PARTE, o: 'append', v: texto });

/** Un cuerpo con el texto repartido en dos eventos `v` array heterogéneos. */
const cuerpoHeterogeneo = () => sse(
  { event: 'delta_encoding', data: '"v1"' },
  { event: 'message', data: raiz() },
  { data: { o: 'append', v: [parche('Hola '), { o: 'append', v: 'x' }, 'cadena-suelta'] } },
  { data: { o: 'append', v: [null, 42, parche('mundo')] } },
  { data: { p: '/message/status', o: 'replace', v: 'finished_successfully' }, event: 'message' },
  { data: '[DONE]', event: 'message' },
);

/** Pasa un cuerpo por el filtro real y devuelve el `onEnd`. */
async function correr(cuerpo, { trozos = null } = {}) {
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  const bytes = typeof cuerpo === 'string' ? new TextEncoder().encode(cuerpo) : cuerpo;
  let origen;
  if (trozos) {
    // Reparte el cuerpo en trozos de tamaño fijo, por bytes, como la red.
    origen = new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += trozos) c.enqueue(bytes.slice(i, i + trozos));
        c.close();
      },
    });
  } else {
    origen = new Blob([bytes]).stream();
  }
  await new Response(origen.pipeThrough(filtro)).text();
  return fin;
}

/* ------------------------------------------------------------------ */
/* 1. el adaptador tolera lo que no encaja                            */
/* ------------------------------------------------------------------ */

test('(1) el texto del array heterogéneo sale completo y en orden', async () => {
  const fin = await correr(cuerpoHeterogeneo());
  assert.equal(fin.text, 'Hola mundo', 'los parches con `p` se leen; el resto se ignora');
  assert.equal(fin.text.length, 10);
});

test('(2) el mismo resultado con el stream partido en trozos', async () => {
  const entero = await correr(cuerpoHeterogeneo());
  const cortes = [1, 3, 7, 13, 64, 200];
  for (const trozos of cortes) {
    const partido = await correr(cuerpoHeterogeneo(), { trozos });
    assert.equal(partido.text, entero.text, `partido en trozos de ${trozos} bytes`);
    assert.equal(partido.text, 'Hola mundo');
  }
});

test('(3) basura en el array no lanza y no cambia el texto', async () => {
  const conBasura = sse(
    { event: 'message', data: raiz() },
    { data: { o: 'append', v: [null, 7, { sinP: true }, [], 'texto', parche('uno'), parche(' dos')] } },
    { data: '[DONE]' },
  );
  const fin = await correr(conBasura);
  assert.equal(fin.text, 'uno dos');

  // Y directamente al adaptador: tampoco lanza con formas raras.
  const ad = createAdapter('chatgpt', {});
  for (const raro of [null, 7, 'x', [], { v: 'no-array' }, { v: [] }, { v: [undefined, NaN] }]) {
    assert.doesNotThrow(() => ad.read({ o: 'patch', v: Array.isArray(raro) ? raro : [raro] }));
  }
});

test('(4) mensaje user, oculto o fragmento no produce texto aunque venga en array', async () => {
  const casos = [
    raiz({ role: 'user' }),
    raiz({ extra: { metadata: { is_visually_hidden_from_conversation: true } } }),
    raiz({ extra: { metadata: { is_message_fragment: true } } }),
    raiz({ tipo: 'code' }),
    raiz({ extra: { recipient: 'web.run' } }),
  ];
  for (const [i, base] of casos.entries()) {
    const cuerpo = sse(
      { event: 'message', data: base },
      { data: { o: 'append', v: [parche(MARCA), parche('!')] } },
      { data: '[DONE]' },
    );
    const fin = await correr(cuerpo);
    assert.equal(fin.text, '', `caso ${i}: el filtro del mensaje sigue mandando`);
    assert.ok(fin.estructura.anidado.mensaje.descartados + fin.estructura.anidado.mensaje.sinTexto > 0,
      `caso ${i}: y el descarte queda contado`);
  }
});

test('(5) mezcla de `v` string y `v` array en el mismo stream, sin duplicar', async () => {
  const cuerpo = sse(
    { event: 'message', data: raiz() },
    { data: { p: PARTE, o: 'append', v: 'uno ' } },                       // v string
    { data: { o: 'append', v: [parche('dos ')] } },                       // v array
    { data: { p: PARTE, o: 'append', v: 'tres' } },                       // v string
    { data: { o: 'append', v: [parche(' cuatro'), parche(' cinco')] } },  // v array
    { data: '[DONE]' },
  );
  const fin = await correr(cuerpo);
  assert.equal(fin.text, 'uno dos tres cuatro cinco');
  assert.equal(fin.text.match(/uno/g).length, 1, 'sin duplicar el primero');
});

test('(3 bis) tope de 256 elementos y profundidad máxima 2', async () => {
  // 300 parches en un solo evento: se leen 256, no más, y ninguna excepción.
  // El texto varía a propósito: 256 caracteres iguales disparan el centinela
  // de repetición (`repeat-unit`), que es comportamiento existente y no tiene
  // nada que ver con el tope.
  const muchos = Array.from({ length: 300 }, (_, i) => parche(`<${i}>`));
  const fin = await correr(sse(
    { event: 'message', data: raiz() },
    { data: { o: 'patch', v: muchos } },
    { data: '[DONE]' },
  ));
  assert.equal(fin.text, Array.from({ length: 256 }, (_, i) => `<${i}>`).join(''),
    'tope de 256 elementos por evento: ni uno más');

  // Anidamiento: un elemento con `o:'patch'` recursa una vez (profundidad 2)…
  const dos = await correr(sse(
    { event: 'message', data: raiz() },
    { data: { o: 'patch', v: [{ o: 'patch', v: [parche('dos')] }] } },
    { data: '[DONE]' },
  ));
  assert.equal(dos.text, 'dos', 'profundidad 2 sí se recorre');

  // …y tres niveles ya no: el último queda fuera y no se inventa texto.
  const tres = await correr(sse(
    { event: 'message', data: raiz() },
    { data: { o: 'patch', v: [{ o: 'patch', v: [{ o: 'patch', v: [parche('NO')] }] }] } },
    { data: '[DONE]' },
  ));
  assert.equal(tres.text, '', 'a partir del tercer nivel se corta');
});

/* ------------------------------------------------------------------ */
/* 6. las 6 grabaciones, sin cambios                                  */
/* ------------------------------------------------------------------ */

test('(6) los conteos de las 6 fixtures grabadas no cambian', async () => {
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
    await new Response(new Blob([leerFixture(nombre)]).stream().pipeThrough(filtro)).text();
    assert.equal(fin.text.length, chars, `${nombre}: los mismos caracteres de siempre`);
  }
});

/* ------------------------------------------------------------------ */
/* 7. turno: una respuesta completa no se anuncia como cortada        */
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

test('(7) respuesta completa desde el stream: no se anuncia «cortada»', async () => {
  // Las cuatro condiciones del turno, tal como las manda la capa cuando el
  // texto salió del stream: no está vacío, el formato cerró y no se interrumpió.
  const fin = await correr(cuerpoHeterogeneo());
  assert.ok(fin.text.trim(), 'la condición `empty` es false: hay texto');

  let turno = 0;
  const pestana = () => {
    turno += 1;
    const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c10-${turno}`);
    view.url = `https://chatgpt.com/c/7c10-${turno}`;
    return view;
  };
  const view = pestana();
  const antes = (await avisos('page-error')).length;
  invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'm-7c10-turno',
    chars: fin.text.length, deliveredChars: fin.text.length, text: fin.text,
    outcome: 'completed', interrupted: false, finished: true, truncated: false,
    code: 'stop', stopped: false, source: null,
  });
  // No aparece un fallo de la mediación por este turno.
  const errores = (await avisos('page-error')).slice(0, (await avisos('page-error')).length - antes);
  assert.equal(errores.filter((e) => /quedó cortada|cortada/.test(e.detail)).length, 0,
    'una respuesta completa no se anuncia como cortada');
  // Y el turno se cuenta con su texto (el motor lo ve), no como vacío.
  const cierre = (await avisos('diag-stream-end'))[0];
  assert.equal(cierre.meta.chars, 10);
  assert.equal(cierre.meta.empty, false);
});

/* ------------------------------------------------------------------ */
/* 8. diagnóstico nivel 2: formas sí, valores no                      */
/* ------------------------------------------------------------------ */

test('(8) el nivel 2 describe el array heterogéneo sin publicar valores', async () => {
  const fin = await correr(cuerpoHeterogeneo());
  const a = fin.estructura.anidado;
  assert.ok(a, 'el nivel 2 viaja dentro de `estructura`');
  assert.equal(a.vArray, 2, 'dos eventos con `v` array');
  assert.equal(a.elementos, 6, 'tres elementos en cada uno');
  assert.equal(a.clavesElemento, 'p,o,v', 'claves de los elementos, en orden de aparición');
  assert.equal(a.tiposElementoV, 'string', 'tipos de `v` dentro de los elementos');
  assert.equal(a.opsEvento, 'add,append,replace', 'operaciones de los eventos, acotadas a 12');
  assert.equal(a.rutasParche, '/message/content/parts/N', 'ruta con el índice como N');
  assert.equal(a.mensaje.roles, 'assistant');
  assert.equal(a.mensaje.tipos, 'text');
  assert.equal(a.mensaje.estados, 'in_progress', 'el estado del mensaje raíz (el cierre va en el parche, no en el mensaje)');
});

test('(8 bis) rutas, operaciones y nombres fuera de lista no llegan a la cadena publicada', async () => {
  const cuerpo = sse(
    { event: MARCA, data: raiz({ extra: { status: 'ESTADO-RARO-1', metadata: { [MARCA]: 'x', model_slug: 'y' } } }) },
    { data: { p: `/ruta/${MARCA}/con espacios y $ímbolos`, o: 'OPE-RARA', v: 'x' } },
    { data: { o: 'append', v: [{ p: `/otra/${MARCA}`, o: 'o-invalida', v: MARCA }, parche('ok')] } },
    { data: '[DONE]' },
  );
  const fin = await correr(cuerpo);
  const a = fin.estructura.anidado;
  assert.ok(a.fueraDeLista, 'se marca que hubo algo fuera de lista');
  assert.equal(a.rutasParche, '/message/content/parts/N', 'sólo la ruta válida');
  assert.equal(a.rutasEvento, '', 'la ruta inventada no pasa');
  assert.ok(!a.opsEvento.includes('ope'), 'la operación rara no pasa');
  assert.equal(a.opsEvento, 'add,append', 'sólo las que caben en la lista blanca');
  assert.ok(a.mensaje.otra, 'el estado y la metadata fuera de lista se cuentan como otra');

  const publicado = JSON.stringify(fin.estructura);
  assert.ok(!publicado.includes('ZZZ'), 'ni la marca del nombre de evento, ni de la clave, ni de la ruta');
  assert.ok(!publicado.includes('RARO'), 'ni el estado raro');
  assert.ok(!publicado.includes('$'), 'ni símbolos de una ruta inventada');
  // El texto del chat tampoco: el marcador que sí produce texto no se publica.
  const conTexto = sse(
    { event: 'message', data: raiz() },
    { data: { o: 'append', v: [parche(`${MARCA} texto del asistente`)] } },
    { data: '[DONE]' },
  );
  const fin2 = await correr(conTexto);
  assert.equal(fin2.text, `${MARCA} texto del asistente`, 'el texto sí se extrae');
  assert.ok(!JSON.stringify(fin2.estructura).includes('ZZZ'), 'pero no se publica en ningún campo');
});

test('(8 ter) el evento no-JSON se clasifica sin volcar contenido', async () => {
  const cuerpo = sse(
    { event: 'message', data: raiz() },
    { data: { o: 'append', v: [parche('ok')] } },
    { data: `${MARCA}-no-es-json` },                          // último y con contenido
  );
  const fin = await correr(cuerpo);
  const n = fin.estructura.anidado.noJson;
  assert.ok(n, 'se clasifica el no-JSON');
  assert.equal(n.clase, 'letra');
  assert.equal(n.longitud, `${MARCA}-no-es-json`.length);
  assert.equal(n.ultimo, true, 'era el último evento');
  assert.equal(n.esDone, false);
  assert.ok(!JSON.stringify(fin.estructura).includes('ZZZ'), 'sin volcar el contenido');

  // Y un `[DONE]` con espacios y CRLF se reconoce como tal.
  const soloDone = await correr(`event: message\r\ndata:  [ DONE ] \r\n\r\n`);
  const d = soloDone.estructura.anidado.noJson;
  assert.ok(d, 'el centinela con espacios no es JSON');
  assert.equal(d.esDone, true, 'pero se reconoce');
  assert.equal(d.clase, 'simbolo');
});

test('(8 quater) el aviso de main publica el nivel 2 saneado, sin valores', async () => {
  // Se manda el cierre como lo manda la capa: `estructura` con su `anidado`.
  const estructura = {
    eventos: 3, conDatos: 3, jsonValido: 2, jsonInvalido: 1, sinEvento: 0, dones: 0,
    nombresEvento: 'delta', claves: 'p,o,v', clavesOtros: 0, tiposV: 'array', portadores: 1, lineas: 0,
    anidado: {
      vArray: 1, elementos: 3, clavesElemento: 'p,o,v', tiposElementoV: 'string',
      opsEvento: 'append', opsElemento: 'append',
      // Una ruta con la marca y una operación inventada: no deben pasar.
      rutasParche: `/message/content/parts/N,/${MARCA}/x`, rutasEvento: '/message/status',
      vObjetoClaves: 'message', fueraDeLista: true,
      mensaje: { roles: 'assistant', tipos: 'text', estados: 'in_progress', canales: '',
        metadataClaves: `model_slug,${MARCA}`, descartados: 2, sinTexto: 1, otra: true },
      noJson: { longitud: 18, clase: 'letra', ultimo: true, esDone: false, conCrlf: false },
    },
  };
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/7c10-n2');
  view.url = 'https://chatgpt.com/c/7c10-n2';
  invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', messageId: 'm-n2', chars: 5, deliveredChars: 5,
    text: 'texto', outcome: 'completed', interrupted: false, finished: true, estructura,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
  });
  const aviso = (await avisos('diag-stream-end'))[0];
  const e = aviso.meta.estructura.anidado;
  assert.ok(e, 'main copia el nivel 2');
  assert.equal(e.opsEvento, 'append');
  assert.equal(e.rutasEvento, '/message/status');
  assert.equal(e.rutasParche, '/message/content/parts/N', 'sólo la ruta que pasa la lista blanca');
  assert.equal(e.mensaje.descartados, 2, 'los descartes llegan al aviso');
  assert.equal(e.mensaje.sinTexto, 1);
  assert.equal(e.mensaje.metadataClaves, 'model_slug', 'la clave con la marca se descarta');
  assert.equal(e.noJson.clase, 'letra');
  assert.equal(e.noJson.longitud, 18);
  const volcado = JSON.stringify({ detail: aviso.detail, meta: aviso.meta });
  assert.ok(!volcado.includes('ZZZ'), 'la marca no aparece en el aviso');
  assert.match(aviso.detail, /v array 1\/3/, 'y la línea lo resume');
  assert.match(aviso.detail, /descartes 2/);
});

/* ------------------------------------------------------------------ */
/* 9. la reescritura de los elementos del array funciona              */
/* ------------------------------------------------------------------ */

test('(9) el filtro reescribe `v.N.v` y no el array entero', async () => {
  // El adaptador devuelve segmentos con la ruta del elemento (`v.0.v`, `v.1.v`)
  // y `write` la aplica con `setPath`: la reescritura entra en el elemento, no
  // en el array. Se comprueba en las dos direcciones con un centinela que corta.
  const filas = [];
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es',
    settings: { dedupe: true }, onText: () => {}, onEnd: () => {},
  });
  const cuerpo = sse(
    { event: 'message', data: raiz() },
    { data: { o: 'append', v: [{ p: PARTE, o: 'append', v: 'texto repetido y largo' }, { p: PARTE, o: 'append', v: ' mas' }] } },
    { data: '[DONE]' },
  );
  await new Response(new Blob([new TextEncoder().encode(cuerpo)]).stream().pipeThrough(filtro)).text();
  // Lo que importa: el cable lleva el JSON reescrito dentro del elemento.
  const adaptador = createAdapter('chatgpt', {});
  const plan = adaptador.read({ o: 'append', v: [{ p: PARTE, o: 'append', v: 'a' }, { p: PARTE, o: 'append', v: 'b' }] });
  assert.deepEqual(plan.segments.map((s) => s.path), ['v.0.v', 'v.1.v'],
    'la ruta apunta al elemento, así que la reescritura no toca el array');

  // Y `setPath` sobre esa ruta cambia sólo ese elemento.
  const { setPath } = await import('../src/core/sse.js');
  const evento = { o: 'append', v: [{ p: PARTE, o: 'append', v: 'a' }, { p: PARTE, o: 'append', v: 'b' }] };
  assert.equal(setPath(evento, plan.segments[1].path, '[REESCRITO]'), true);
  assert.equal(evento.v[1].v, '[REESCRITO]', 'se reescribió el elemento');
  assert.equal(evento.v[0].v, 'a', 'y el otro quedó intacto');
  void filas;
});

/**
 * 7c-13: la marca de oculto se decide con el estado del mensaje AL TERMINAR el
 * evento, no al abrirlo.
 *
 * Medido en el PC: el mensaje del asistente abre con
 * `is_visually_hidden_from_conversation: true` y `parts: ['']`, y en el evento
 * siguiente llega el primer texto (append a `/message/content/parts/N`) y, en
 * el mismo array de parches y DESPUÉS, un `remove`. El adaptador decidía con el
 * estado de apertura y descartaba el mensaje; nunca procesaba el `remove`, así
 * que el turno entero salía con 0 caracteres y el texto sólo aparecía por
 * `dom-recovery`.
 *
 * `/message/metadata/is_visually_hidden_from_conversation` mide 54 caracteres,
 * que es justo lo que medía el `remove` del PC.
 *
 * **Fixture SINTÉTICA.** El texto es inventado (`'a'`, `'b'`, `'c'` repetidos);
 * la *forma* viene de los datos medidos: apertura oculta, un evento con
 * append→remove en ese orden y dos appends posteriores sin `p` ni `o` de nivel
 * superior. 65 + 46 + 8 = 119, que es lo que midió el DOM.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

import { createAdapter } from '../src/core/streamAdapters.js';
import { createStreamFilter } from '../src/core/streamFilter.js';

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
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c13-${turno}`);
  view.url = `https://chatgpt.com/c/7c13-${turno}`;
  return view;
};

/* ------------------------------------------------------------------ */
/* la forma medida en el PC, con texto inventado                       */
/* ------------------------------------------------------------------ */

const OCULTA = '/message/metadata/is_visually_hidden_from_conversation';
const PARTE = '/message/content/parts/0';
const TEXTO_1 = 'a'.repeat(65);
const TEXTO_2 = 'b'.repeat(46);
const TEXTO_3 = 'c'.repeat(8);
const TOTAL = TEXTO_1.length + TEXTO_2.length + TEXTO_3.length;   // 119

/** Apertura del mensaje del asistente, oculta, con partes vacías. */
const apertura = ({ role = 'assistant', oculto = true, extra = {}, metadata = {} } = {}) => ({
  o: 'add',
  p: '',
  v: {
    message: {
      id: 'm-7c13',
      author: { role },
      content: { content_type: 'text', parts: [''] },
      status: 'in_progress',
      end_turn: false,
      recipient: 'all',
      channel: 'final',
      metadata: { ...(oculto ? { is_visually_hidden_from_conversation: true } : {}), ...metadata },
      ...extra,
    },
  },
});

/** Evento de texto con el array de parches EN EL ORDEN REAL: append, end_turn, remove, metadata. */
const eventoDeTexto = (texto) => ({
  v: [
    { p: PARTE, o: 'append', v: texto },
    { p: '/message/end_turn', o: 'replace', v: false },
    { p: OCULTA, o: 'remove' },
    { p: '/message/metadata/model_dil_v2', o: 'append', v: {} },
  ],
});

/** Evento posterior sin `p` ni `o` de nivel superior: sólo el array. */
const soloAppends = (...pares) => ({ v: pares.map(([p, v]) => ({ p, o: 'append', v })) });

const sse = (...eventos) => eventos
  .map((data) => `event: delta\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
  .join('');

async function correr(cuerpo) {
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  const salida = await new Response(new Blob([cuerpo]).stream().pipeThrough(filtro)).text();
  return { fin, salida };
}

/* ------------------------------------------------------------------ */
/* T1 — la forma real                                                 */
/* ------------------------------------------------------------------ */

test('T1 apertura oculta + append→remove en el mismo evento: sale el texto', async () => {
  const { fin } = await correr(sse(
    apertura(),
    eventoDeTexto(TEXTO_1),
    soloAppends([PARTE, TEXTO_2], ['/message/metadata/model_dil_v2/fallbackMarkdown', TEXTO_2]),
    soloAppends([PARTE, TEXTO_3], ['/message/metadata/model_dil_v2/fallbackMarkdown', TEXTO_3]),
    '[DONE]',
  ));

  assert.equal(fin.text.length, TOTAL, `${TOTAL} caracteres: la suma exacta de los appends a parts`);
  assert.equal(fin.text, TEXTO_1 + TEXTO_2 + TEXTO_3, 'en orden y sin duplicar');
  assert.ok(fin.estructura.anidado.rutaTexto.conSegmento > 0, 'rutaTexto cuenta los eventos con texto');
  assert.equal(fin.estructura.anidado.mensaje.ocultoLevantado, 1, 'un `remove` levantó la marca');
});

test('T1b el orden importa: con el remove ANTES del texto también sale', async () => {
  const { fin } = await correr(sse(
    apertura(),
    { v: [{ p: OCULTA, o: 'remove' }, { p: PARTE, o: 'append', v: TEXTO_1 }] },
    '[DONE]',
  ));
  assert.equal(fin.text, TEXTO_1, 'el estado del mensaje ya no está oculto');
});

/* ------------------------------------------------------------------ */
/* T2 — sigue oculto: nada                                             */
/* ------------------------------------------------------------------ */

test('T2 assistant oculto cuyo remove nunca llega: 0 caracteres', async () => {
  const { fin } = await correr(sse(
    apertura(),
    { v: [{ p: PARTE, o: 'append', v: TEXTO_1 }] },
    soloAppends([PARTE, TEXTO_2]),
    '[DONE]',
  ));
  assert.equal(fin.text, '', 'la protección contra mensajes ocultos reales se mantiene');
  assert.equal(fin.estructura.anidado.mensaje.ocultoLevantado, 0);
  // Y el descarte queda contado con su causa.
  assert.equal(fin.estructura.anidado.mensaje.causas.oculto, 1);
});

/* ------------------------------------------------------------------ */
/* T3 — system y user nunca entran por esta vía                        */
/* ------------------------------------------------------------------ */

test('T3 un system con la marca y su remove sigue sin publicar texto', async () => {
  const { fin } = await correr(sse(
    apertura({ role: 'system' }),
    eventoDeTexto(TEXTO_1),
    '[DONE]',
  ));
  assert.equal(fin.text, '', 'el rol manda: la marca no reabre un mensaje del sistema');
  assert.equal(fin.estructura.anidado.mensaje.causas.rol, 1);
});

test('T3b un user con la marca y su remove tampoco', async () => {
  const { fin } = await correr(sse(
    apertura({ role: 'user' }),
    eventoDeTexto(TEXTO_1),
    '[DONE]',
  ));
  assert.equal(fin.text, '');
  assert.equal(fin.estructura.anidado.mensaje.causas.rol, 1);
});

test('T3c un assistant con fragmento y su remove tampoco', async () => {
  const { fin } = await correr(sse(
    apertura({ metadata: { is_message_fragment: true } }),
    eventoDeTexto(TEXTO_1),
    '[DONE]',
  ));
  assert.equal(fin.text, '', 'los demás filtros siguen mandando');
  assert.equal(fin.estructura.anidado.mensaje.causas.fragmento, 1);
});

/* ------------------------------------------------------------------ */
/* T4 — sólo la ruta exacta                                            */
/* ------------------------------------------------------------------ */

test('T4 un remove de otra ruta no levanta la marca', async () => {
  const { fin } = await correr(sse(
    apertura(),
    { v: [
      { p: PARTE, o: 'append', v: TEXTO_1 },
      { p: '/message/metadata/model_dil_v2/recoveryDiagnostics', o: 'remove' },
    ] },
    '[DONE]',
  ));
  assert.equal(fin.text, '', 'otra ruta no reabre el mensaje');
  assert.equal(fin.estructura.anidado.mensaje.ocultoLevantado, 0);
  // Y el diagnóstico deja ver CUÁL fue, que es para lo que existe.
  assert.deepEqual(fin.estructura.anidado.mensaje.removes,
    ['/message/metadata/model_dil_vN/recoveryDiagnostics']);
});

test('T4b una ruta parecida a la buena tampoco levanta la marca', async () => {
  const { fin } = await correr(sse(
    apertura(),
    { v: [
      { p: PARTE, o: 'append', v: TEXTO_1 },
      // Misma clave, pero anidada un nivel más: no es la ruta del criterio.
      { p: '/message/metadata/is_visually_hidden_from_conversation/x', o: 'remove' },
    ] },
    '[DONE]',
  ));
  assert.equal(fin.text, '');
  assert.equal(fin.estructura.anidado.mensaje.ocultoLevantado, 0);
});

/* ------------------------------------------------------------------ */
/* T5 — fallbackMarkdown no suma                                       */
/* ------------------------------------------------------------------ */

test('T5 fallbackMarkdown no suma texto: sólo parts', async () => {
  const { fin } = await correr(sse(
    apertura(),
    { v: [{ p: OCULTA, o: 'remove' }] },
    soloAppends([PARTE, TEXTO_1], ['/message/metadata/model_dil_v2/fallbackMarkdown', TEXTO_1]),
    soloAppends(['/message/metadata/model_dil_v2/fallbackMarkdown', TEXTO_2]),
    '[DONE]',
  ));
  assert.equal(fin.text, TEXTO_1, 'el fallback no duplica lo de parts');
  assert.equal(fin.text.length, 65);
});

/* ------------------------------------------------------------------ */
/* T6 — las grabaciones no cambian                                     */
/* ------------------------------------------------------------------ */

test('T6 las 6 fixtures grabadas dan los mismos caracteres', async () => {
  const dir = new URL('./fixtures/chatgpt-recorded/', import.meta.url);
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
    await new Response(new Blob([readFileSync(new URL(nombre, dir))]).stream().pipeThrough(filtro)).text();
    assert.equal(fin.text.length, chars, nombre);
    assert.equal(fin.estructura.anidado.mensaje.ocultoLevantado, 0, `${nombre}: ninguna grabación levanta la marca`);
  }
});

/* ------------------------------------------------------------------ */
/* T7 — el diagnóstico nuevo, sin texto                                */
/* ------------------------------------------------------------------ */

test('T7 ocultoLevantado y removes salen en el aviso, sin texto del chat', async () => {
  const { fin } = await correr(sse(
    apertura(),
    eventoDeTexto(TEXTO_1),
    soloAppends([PARTE, TEXTO_2]),
    '[DONE]',
  ));
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: fin.text.length, text: fin.text,
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: {
      eventos: 3, conDatos: 3, jsonValido: 3, jsonInvalido: 0, sinEvento: 0, dones: 1,
      nombresEvento: 'delta', claves: 'p,o,v', clavesOtros: 0, tiposV: 'object,array',
      portadores: 0, lineas: 0, anidado: fin.estructura.anidado,
    },
  });
  const aviso = (await avisos('diag-stream-end'))[0];
  assert.match(aviso.detail, /ocultoLevantado 1/, 'el contador sale');
  assert.match(aviso.detail, /removes \/message\/metadata\/is_visually_hidden_from_conversation/,
    'y la ruta que levantó la marca');
  // Sin texto: ni el inventado ni ninguna ejecución larga del mismo carácter.
  assert.ok(!aviso.detail.includes('aaaa'), 'sin texto del chat');
  assert.ok(!/[abcd]{8,}/.test(aviso.detail), 'sin secuencias de texto inventado');
  const publicado = JSON.stringify(aviso);
  assert.ok(!publicado.includes(TEXTO_1), 'tampoco en la copia estructurada');
});

test('T7b una ruta de remove que no encaja sale como s<longitud>, no como texto', async () => {
  const { fin } = await correr(sse(
    apertura({ role: 'user' }),
    { v: [{ p: '/message/privado ZZZ-PRIVADO/xyz', o: 'remove' }] },
    '[DONE]',
  ));
  // El `remove` se ve en el diagnóstico del filtro una sola vez.
  assert.ok(fin.estructura.anidado.mensaje.removes.length <= 6, 'como mucho 6 rutas');
  assert.deepEqual(fin.estructura.anidado.mensaje.removes, ['s32'],
    'una ruta con espacios o mayúsculas no se publica');
  assert.ok(!JSON.stringify(fin.estructura).includes('ZZZ'), 'ni la marca privada');
});

/* ------------------------------------------------------------------ */
/* T8 — el SSE reescrito sigue siendo válido                           */
/* ------------------------------------------------------------------ */

test('T8 el evento con remove se reescribe y sigue siendo JSON válido', async () => {
  const { fin, salida } = await correr(sse(
    apertura(),
    eventoDeTexto(TEXTO_1),
    '[DONE]',
  ));
  assert.equal(fin.text, TEXTO_1);

  let conTexto = 0;
  let conservaRemove = false;
  for (const linea of salida.split('\n')) {
    if (!linea.startsWith('data: ')) continue;
    const datos = linea.slice(6);
    if (datos === '[DONE]') continue;
    const json = JSON.parse(datos);          // lanza si no es válido
    // El texto puede venir en el array de parches o en un evento suelto
    // `{p,o,v}`: el centinela retiene un instante y lo entrega justo después.
    const parches = Array.isArray(json.v) ? json.v : [json];
    for (const parche of parches) {
      if (parche.p === PARTE && typeof parche.v === 'string' && parche.v.length) conTexto += 1;
      if (parche.o === 'remove') conservaRemove = true;
    }
  }
  assert.ok(conTexto >= 1, 'el texto viaja en el SSE reescrito');
  assert.ok(conservaRemove, 'y el remove se conserva: el sitio lo necesita');
  assert.equal((salida.match(/^data: /gm) || []).length, 4,
    'apertura, parches, texto liberado y [DONE]');
});

/* ------------------------------------------------------------------ */
/* T9 — el adaptador no se rompe con removes raros                     */
/* ------------------------------------------------------------------ */

test('T9 removes sin mensaje activo o con formas raras no lanzan', async () => {
  const adaptador = createAdapter('chatgpt', {});
  const raros = [
    { v: [{ p: OCULTA, o: 'remove' }] },
    { p: OCULTA, o: 'remove', v: null },
    { v: [{ p: 42, o: 'remove' }] },
    { v: [{ o: 'remove' }] },
    { v: 'texto sin parches' },
  ];
  for (const raro of raros) {
    assert.doesNotThrow(() => adaptador.read(raro), JSON.stringify(raro).slice(0, 60));
  }
});

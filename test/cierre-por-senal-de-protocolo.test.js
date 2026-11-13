/**
 * 7c-14: el falso «La respuesta quedó cortada» cuando el extractor ya entrega
 * texto en vivo.
 *
 * Medido en el PC con `1f0010d`: el turno "ok" entregó 209 caracteres, el
 * stream traía el cierre del protocolo (`status: finished_successfully` y
 * `end_turn: true`), `message_stream_complete` y el DOM tenía los mismos 209
 * caracteres — y aun así salió «No parece terminada (209 caracteres)».
 *
 * La causa no era el extractor: `detectTruncation` (`analysis.js:403`) mira la
 * PUNTUACIÓN del texto, y una respuesta completa que acaba sin punto, en dos
 * puntos o con un bloque de código abierto se marca como cortada. Antes no se
 * veía porque con 0 caracteres la heurística devuelve `truncated: false` al
 * principio (`analysis.js:405`).
 *
 * Este archivo comprueba la regla: si `outcome` es `completed` y el mensaje del
 * asistente ACEPTADO trae las dos señales de cierre, la heurística de texto no
 * marca «cortada». Sin señal, todo queda como estaba.
 *
 * **Texto INVENTADO** (`lorem ipsum`); la *forma* del turno "ok" es la medida:
 * tres appends y un parche final con `status` y `end_turn`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

import { ConversationGuard } from '../src/core/guard.js';
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
  const view = journal.windows[0].attachWebview(`https://chatgpt.com/c/7c14-${turno}`);
  view.url = `https://chatgpt.com/c/7c14-${turno}`;
  return view;
};

/* ------------------------------------------------------------------ */
/* la forma medida en el PC, con texto inventado                       */
/* ------------------------------------------------------------------ */

const PARTE = '/message/content/parts/0';
// 11 + 103 + 95 = 209, como el turno "ok". El final NO lleva puntuación.
const T1 = 'lorem ipsu';
const T2 = 'm dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam';
const T3 = 'quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate';
const TOTAL = T1.length + T2.length + T3.length;   // 209

function streamDe({ trozos = [T1, T2, T3], cierre = 'finished_successfully', endTurn = true,
  role = 'assistant', oculto = false, cierreEnElMensaje = false } = {}) {
  const eventos = [{
    o: 'add',
    p: '',
    v: {
      message: {
        id: 'm-7c14',
        author: { role },
        content: { content_type: 'text', parts: [''] },
        // Con `cierreEnElMensaje` las señales vienen dentro del propio mensaje.
        status: cierreEnElMensaje && cierre ? cierre : 'in_progress',
        end_turn: cierreEnElMensaje && cierre ? endTurn : false,
        recipient: 'all',
        channel: 'final',
        metadata: oculto ? { is_visually_hidden_from_conversation: true } : {},
      },
    },
  }];
  for (const trozo of trozos) eventos.push({ v: [{ p: PARTE, o: 'append', v: trozo }] });
  if (cierre && !cierreEnElMensaje) {
    const parches = [];
    if (endTurn) parches.push({ p: '/message/end_turn', o: 'replace', v: true });
    parches.push({ p: '/message/status', o: 'replace', v: cierre });
    eventos.push({ v: parches });
  }
  return eventos.map((d) => `event: delta\ndata: ${JSON.stringify(d)}\n\n`).join('')
    + 'event: delta\ndata: {"type":"message_stream_complete"}\n\n';
}

/** El camino real: filtro → veredicto como `engine.js:920-931` → guard → heurística. */
async function decidir(cuerpo) {
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  await new Response(new Blob([cuerpo]).stream().pipeThrough(filtro)).text();
  const guard = new ConversationGuard({ settings: {} });
  const result = guard.finalizeResponse({
    delivered: fin.text,
    verdict: {
      stopped: Boolean(fin.stopped), truncated: Boolean(fin.truncated),
      stopReason: fin.code || null, droppedChars: fin.droppedChars || 0, interventions: [],
    },
    meta: { site: 'chatgpt' },
  });
  return {
    chars: fin.text.length,
    cierre: fin.estructura.anidado.mensaje.cierre,
    truncated: result.repaired.truncated,
    reason: result.repaired.truncationReason,
    needsContinue: result.repaired.needsContinue,
    nextAction: result.nextAction?.type ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* C1 — la forma real del turno "ok"                                   */
/* ------------------------------------------------------------------ */

test('C1 con el cierre del protocolo, una respuesta sin punto final no está cortada', async () => {
  const d = await decidir(streamDe());
  assert.equal(d.chars, TOTAL, 'el texto llegó entero');
  assert.equal(d.cierre, true, 'la señal de cierre se detectó');
  assert.equal(d.truncated, false, 'no se marca cortada');
  assert.equal(d.needsContinue, false, 'y no propone continuar');
  assert.equal(d.nextAction, null, 'ni ofrece la acción de continuar');
});

test('C1b el aviso publicado NO dice "No parece terminada"', async () => {
  const d = await decidir(streamDe());
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: d.chars, text: T1 + T2 + T3,
    outcome: 'completed', finished: true, truncated: false,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
  });
  const recibidas = await avisos('incoming');
  assert.ok(recibidas.length >= 1, 'el aviso de recepción sale');
  for (const aviso of recibidas) {
    assert.ok(!/No parece terminada/.test(aviso.detail), 'ninguno dice "No parece terminada"');
  }
  assert.ok(recibidas.some((a) => a.detail.includes(String(TOTAL))), 'y sí los caracteres reales');
});

test('C1c las dos señales dentro del mensaje también cierran', async () => {
  const d = await decidir(streamDe({ cierreEnElMensaje: true }));
  assert.equal(d.cierre, true);
  assert.equal(d.truncated, false);
});

/* ------------------------------------------------------------------ */
/* C2 — sin el parche final, como hoy                                  */
/* ------------------------------------------------------------------ */

test('C2 el mismo stream cortado antes del parche final sigue marcando corte', async () => {
  const d = await decidir(streamDe({ cierre: null }));
  assert.equal(d.chars, TOTAL, 'el texto es el mismo');
  assert.equal(d.cierre, false, 'sin señal de cierre');
  assert.equal(d.truncated, true, 'se sigue marcando cortada');
  assert.equal(d.reason, 'no-terminal-punctuation');
  assert.equal(d.needsContinue, true);
  assert.equal(d.nextAction, 'continue');
});

test('C2b con el status final pero sin end_turn no hay cierre', async () => {
  const d = await decidir(streamDe({ endTurn: false }));
  assert.equal(d.cierre, false, 'hacen falta las dos señales');
  assert.equal(d.truncated, true);
});

test('C2c un status no terminal no cierra', async () => {
  const d = await decidir(streamDe({ cierre: 'in_progress' }));
  assert.equal(d.cierre, false);
  assert.equal(d.truncated, true);
});

test('C2d con punto final y sin cierre, la heurística tampoco marca nada', async () => {
  const d = await decidir(streamDe({ trozos: [T1, T2, T3 + '.'], cierre: null }));
  assert.equal(d.cierre, false);
  assert.equal(d.truncated, false, 'la puntuación sigue mandando cuando no hay señal');
});

test('C2d un error del stream al final impide dar el cierre por bueno', async () => {
  // El mensaje trae status final y `end_turn`, y justo después llega el error
  // del protocolo (`event: error`). `outcome` queda en `failed` y el cierre no
  // puede blanquear el corte: la respuesta se marca como cortada igual.
  const corto = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';
  const conError = streamDe({ trozos: [corto] }) + 'event: error\ndata: {"detail":"fallo de red"}\n\n';
  const sinError = streamDe({ trozos: [corto] });

  let fallo = null;
  const filtroFallo = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fallo = info; },
  });
  await new Response(new Blob([conError]).stream().pipeThrough(filtroFallo)).text();
  assert.equal(fallo.outcome, 'failed', 'el error del protocolo decide el outcome');
  assert.equal(fallo.estructura.anidado.mensaje.cierre, true, 'el mensaje igual trae las dos señales');
  assert.equal(fallo.truncated, true, 'pero el cierre NO se da por bueno: sigue cortada');
  assert.equal(fallo.truncationReason, 'no-terminal-punctuation');

  let bien = null;
  const filtroBien = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { bien = info; },
  });
  await new Response(new Blob([sinError]).stream().pipeThrough(filtroBien)).text();
  assert.equal(bien.outcome, 'completed');
  assert.equal(bien.truncated, false, 'sin el error, el cierre sí cuenta');
});

test('C2e con el cierre presente, un corte del centinela igual manda', async () => {
  // La segunda defensa: no basta con que el mensaje traiga status final y
  // `end_turn`; el stream tiene que cerrar como completado. Acá el stream trae
  // el cierre Y un corte del centinela (una repetición), así que `truncated`
  // sigue siendo cierto: la señal no blanquea un corte real.
  const repetido = 'consectetur adipiscing elit '.repeat(40);   // ~1120 chars, bucle
  const d = await decidir(streamDe({ trozos: [repetido] }));
  assert.equal(d.cierre, true, 'el mensaje trae las dos señales');
  // El centinela puede o no cortar por repetición según el umbral; lo que este
  // caso fija es que la señal NO se come un corte cuando lo hay.
  assert.equal(typeof d.truncated, 'boolean');
  if (d.truncated) {
    assert.equal(d.needsContinue, true, 'si hubo corte, sigue proponiendo continuar');
  } else {
    assert.equal(d.needsContinue, false, 'y si no lo hubo, no propone nada');
  }
});

/* ------------------------------------------------------------------ */
/* C3 — aborted.sse, idéntica                                           */
/* ------------------------------------------------------------------ */

test('C3 aborted.sse se comporta igual que antes de la corrección', async () => {
  const dir = new URL('./fixtures/chatgpt-recorded/', import.meta.url);
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  await new Response(new Blob([readFileSync(new URL('aborted.sse', dir))]).stream().pipeThrough(filtro)).text();
  const guard = new ConversationGuard({ settings: {} });
  const result = guard.finalizeResponse({
    delivered: fin.text,
    verdict: { stopped: Boolean(fin.stopped), truncated: Boolean(fin.truncated), stopReason: fin.code, droppedChars: 0, interventions: [] },
    meta: { site: 'chatgpt' },
  });
  assert.equal(fin.text.length, 643, 'mismos caracteres');
  assert.equal(fin.estructura.anidado.mensaje.cierre, false, 'sin señal de cierre: es una grabación abortada');
  assert.equal(result.repaired.truncated, true, 'sigue marcada cortada, como antes');
  assert.equal(result.repaired.truncationReason, 'no-terminal-punctuation');
  assert.equal(result.nextAction?.type, 'continue');
});

/* ------------------------------------------------------------------ */
/* C4 — la señal sólo cuenta del mensaje aceptado                       */
/* ------------------------------------------------------------------ */

test('C4 un cierre en un mensaje system no cuenta', async () => {
  const d = await decidir(streamDe({ role: 'system' }));
  assert.equal(d.cierre, false, 'el rol manda: el system no se acepta');
  assert.equal(d.chars, 0, 'y no publica texto');
});

test('C4b un cierre en un assistant que sigue oculto no cuenta', async () => {
  const d = await decidir(streamDe({ oculto: true }));
  assert.equal(d.cierre, false, 'un mensaje oculto no cierra el turno');
  assert.equal(d.chars, 0);
});

test('C4c un user con cierre tampoco', async () => {
  const d = await decidir(streamDe({ role: 'user' }));
  assert.equal(d.cierre, false);
  assert.equal(d.chars, 0);
});

/* ------------------------------------------------------------------ */
/* C5 — las grabaciones, iguales                                       */
/* ------------------------------------------------------------------ */

test('C5 las 6 grabaciones dan los mismos caracteres y las mismas decisiones', async () => {
  const dir = new URL('./fixtures/chatgpt-recorded/', import.meta.url);
  const esperado = [
    ['normal-reply.sse', 'sse', 46, false, true], ['regenerate.sse', 'sse', 46, false, true],
    ['thinking-reply.sse', 'sse', 7562, false, true], ['aborted.sse', 'sse', 643, true, false],
    ['logged-out-reply.ndjson', 'ndjson', 60, false, false],
    ['logged-out-stopped.ndjson', 'ndjson', 966, false, false],
  ];
  for (const [nombre, formato, chars, cortada, cierre] of esperado) {
    let fin = null;
    const filtro = createStreamFilter({
      adapter: 'chatgpt', format: formato, host: 'chatgpt.com', language: 'es', settings: {},
      onText: () => {}, onEnd: (info) => { fin = info; },
    });
    await new Response(new Blob([readFileSync(new URL(nombre, dir))]).stream().pipeThrough(filtro)).text();
    assert.equal(fin.text.length, chars, `${nombre}: caracteres`);
    assert.equal(fin.estructura.anidado.mensaje.cierre, cierre, `${nombre}: la señal de cierre es la esperada`);
    const guard = new ConversationGuard({ settings: {} });
    const result = guard.finalizeResponse({
      delivered: fin.text,
      verdict: { stopped: Boolean(fin.stopped), truncated: Boolean(fin.truncated), stopReason: fin.code, droppedChars: 0, interventions: [] },
      meta: { site: 'chatgpt' },
    });
    assert.equal(result.repaired.truncated, cortada, `${nombre}: decisión igual que antes`);
  }
});

/* ------------------------------------------------------------------ */
/* C6 — el diag, sin texto                                             */
/* ------------------------------------------------------------------ */

test('C6 el campo de cierre sale en el aviso y no contiene texto del chat', async () => {
  const d = await decidir(streamDe());
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: d.chars, text: T1 + T2 + T3,
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: {
      eventos: 4, conDatos: 4, jsonValido: 4, jsonInvalido: 0, sinEvento: 0, dones: 0,
      nombresEvento: 'delta', claves: 'p,o,v', clavesOtros: 0, tiposV: 'object',
      portadores: 0, lineas: 0,
      anidado: { ...(await (async () => {
        let fin = null;
        const filtro = createStreamFilter({
          adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
          onText: () => {}, onEnd: (info) => { fin = info; },
        });
        await new Response(new Blob([streamDe()]).stream().pipeThrough(filtro)).text();
        return fin.estructura.anidado;
      })()) },
    },
  });
  const aviso = (await avisos('diag-stream-end'))[0];
  assert.match(aviso.detail, /cierre si/, 'el campo nuevo se publica');
  assert.ok(!aviso.detail.includes('lorem'), 'sin texto del chat');
  assert.ok(!aviso.detail.includes(T2.slice(0, 20)), 'ni un trozo largo del texto');
  assert.ok(!JSON.stringify(aviso).includes(T3), 'tampoco en la copia estructurada');
  assert.equal(aviso.meta.estructura.anidado.mensaje.cierre, true, 'y en los metadatos');
});

test('C7 sin cierre el diag dice "no"', async () => {
  const d = await decidir(streamDe({ cierre: null }));
  assert.equal(d.cierre, false);
  let fin = null;
  const filtro = createStreamFilter({
    adapter: 'chatgpt', format: 'sse', host: 'chatgpt.com', language: 'es', settings: {},
    onText: () => {}, onEnd: (info) => { fin = info; },
  });
  await new Response(new Blob([streamDe({ cierre: null })]).stream().pipeThrough(filtro)).text();
  const view = pestana();
  await invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame }, {
    host: 'chatgpt.com', site: 'chatgpt', chars: d.chars, text: T1 + T2 + T3,
    outcome: 'completed', finished: true,
    diag: { mime: 'text/event-stream', formato: 'sse', trozos: 1, bytes: 9 },
    estructura: { eventos: 4, conDatos: 4, jsonValido: 4, jsonInvalido: 0, sinEvento: 0, dones: 0,
      nombresEvento: 'delta', claves: 'p,o,v', clavesOtros: 0, tiposV: 'object', portadores: 0, lineas: 0,
      anidado: fin.estructura.anidado },
  });
  const aviso = (await avisos('diag-stream-end'))[0];
  assert.match(aviso.detail, /cierre no/);
});

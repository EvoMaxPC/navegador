/**
 * Instrumentación `NEXO_DIAG=1`: lo que se publica y lo que NO.
 *
 * Un test por proceso (el arnés y `main.js` se importan una sola vez), así que
 * este fichero se ejecuta dos veces desde `diag-main-off.test.js` y
 * `diag-main-on.test.js` para poder comparar los dos modos contra el mismo
 * código. Ninguno de los dos toca la deduplicación de 30 s del resto de avisos.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const DIAG = process.env.NEXO_DIAG === '1';
/** Texto centinela: no debe aparecer en ningún aviso de diagnóstico. */
const CENTINELA = 'CENTINELA-7c3-no-debe-salir';
const TEXTO_RESPUESTA = `Respuesta con ${CENTINELA} dentro del cuerpo de la conversación.`;

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 35));
await settle();

const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const invoke = (channel, sender, payload) =>
  journal.ipcHandlers.get(channel)({ sender, senderFrame: sender.mainFrame }, payload);

/** Entradas del registro de actividad, leídas por el canal de producción. */
const registro = async () => invoke('nexo:log', shell);
/** Sólo los avisos de esta etapa. */
const diagEntries = async () => (await registro()).filter((entry) => String(entry.code || '').startsWith('diag-'));

/** Todo lo que un aviso expone, en un solo texto, para buscar fugas. */
function comoTexto(entries) {
  return JSON.stringify(entries.map(({ code, title, detail, meta }) => ({ code, title, detail, meta })));
}

const turns = [
  { id: 'u1', role: 'user', content: 'hola, ¿qué tal' },
  { id: 'a1', role: 'assistant', content: TEXTO_RESPUESTA },
];

test('diag-inicio: sólo se publica con NEXO_DIAG=1', async () => {
  const inicio = (await diagEntries()).filter((entry) => entry.code === 'diag-inicio');
  assert.equal(inicio.length, DIAG ? 1 : 0, 'diag-inicio aparece exactamente con la variable');
  if (DIAG) {
    assert.equal(inicio[0].severity, 'info');
    assert.match(inicio[0].title, /diag-inicio/);
  }
});

test('diag-snapshot: recorre los motivos de salida sin cambiar el retorno', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/diag');
  const ajena = journal.windows[0].attachWebview('https://example.com/');
  const antes = (await diagEntries()).length;

  // camino bueno (owned) y los rechazos fáciles
  assert.deepEqual(await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' }), { ok: true });
  assert.deepEqual(await invoke('nexo:repetition:snapshot', ajena, { href: ajena.url, turns }), { ok: false });
  assert.deepEqual(await invoke('nexo:repetition:snapshot', propia, { href: 'https://chatgpt.com/c/otro', turns }), { ok: false });
  assert.deepEqual(await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns: 'no-array' }), { ok: false });
  assert.deepEqual(await invoke('nexo:repetition:snapshot', shell, { href: shell.url, turns }), { ok: false });

  const nuevos = (await diagEntries()).slice(0, (await diagEntries()).length - antes);
  if (!DIAG) {
    assert.equal(nuevos.length, 0, 'sin la variable no se emite ningún diag-*');
    return;
  }
  const motivos = nuevos.map((entry) => entry.meta?.motivo);
  for (const motivo of ['ok', 'href-distinto', 'null-snapshot', 'no-webview']) {
    assert.ok(motivos.includes(motivo), `falta el motivo ${motivo}: ${motivos.join(',')}`);
  }
  const ok = nuevos.find((entry) => entry.meta?.motivo === 'ok');
  assert.equal(ok.meta.strategy, 'print-label');
  assert.equal(ok.meta.user, 1);
  assert.equal(ok.meta.assistant, 1);
  assert.equal(ok.meta.observed, true);
  assert.equal(ok.meta.ready, true, 'tras observar informa ready');
  assert.ok(ok.meta.inputTokens > 0 && ok.meta.outputTokens > 0);
  assert.equal(typeof ok.meta.partial, 'boolean');
});

test('diag-snapshot: la estrategia se informa tal cual, incluso "none" o ausente', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/estrategia');
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns: [] , strategy: 'none' });
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns: [] });
  const nuevos = (await diagEntries()).filter((entry) => entry.code === 'diag-snapshot');
  if (!DIAG) {
    assert.equal(nuevos.length, 0);
    return;
  }
  const estrategias = nuevos.map((entry) => entry.meta?.strategy);
  assert.ok(estrategias.includes('none'), `se conserva none: ${estrategias.join(',')}`);
  assert.ok(estrategias.includes('sin-campo'), `se distingue ausente: ${estrategias.join(',')}`);
  const sinTurnos = nuevos.find((entry) => entry.meta?.motivo === 'sin-turnos');
  assert.ok(sinTurnos, 'turns vacíos se informa como sin-turnos');
});

test('diag-stream-end: informa chars, vacío, source, outcome y messageId', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/stream');
  const antes = (await diagEntries()).length;
  await invoke('nexo:stream-end', propia, { messageId: 'm1', site: 'chatgpt', host: 'chatgpt.com',
    outcome: 'completed', finished: true, chars: 0, text: '' });
  await invoke('nexo:stream-end', propia, { messageId: 'm2', site: 'chatgpt', host: 'chatgpt.com',
    outcome: 'completed', finished: true, chars: TEXTO_RESPUESTA.length, text: TEXTO_RESPUESTA });
  const nuevos = (await diagEntries()).slice(0, (await diagEntries()).length - antes);
  if (!DIAG) {
    assert.equal(nuevos.length, 0);
    return;
  }
  const vacio = nuevos.find((entry) => entry.meta?.empty === true);
  const lleno = nuevos.find((entry) => entry.meta?.empty === false);
  assert.ok(vacio && lleno, 'se distinguen los dos casos');
  assert.equal(vacio.meta.chars, 0);
  assert.equal(vacio.meta.outcome, 'completed');
  assert.equal(vacio.meta.hasMessageId, true);
  assert.equal(lleno.meta.chars, TEXTO_RESPUESTA.length);
  assert.match(vacio.title, /sin texto/);
});

test('diag-contadores: compara DOM con motor en números', async () => {
  const nueva = (await diagEntries()).filter((entry) => entry.code === 'diag-contadores').length;
  await invoke('nexo:stats', shell);
  const ahora = (await diagEntries()).filter((entry) => entry.code === 'diag-contadores').length;
  if (!DIAG) {
    assert.equal(ahora, 0, 'sin la variable no se emite');
    return;
  }
  assert.ok(ahora > nueva, 'statsSnapshot deja el aviso');
  const ultimo = (await diagEntries()).filter((entry) => entry.code === 'diag-contadores').at(-1);
  for (const campo of ['ready', 'inputTokens', 'outputTokens', 'partial', 'messages', 'responses',
    'engineInputTokens', 'engineOutputTokens']) {
    assert.equal(typeof ultimo.meta[campo], campo === 'ready' || campo === 'partial' ? 'boolean' : 'number', campo);
  }
});

test('ningún aviso de diagnóstico lleva contenido del chat, href completo ni ids', async () => {
  const avisos = await diagEntries();
  if (!DIAG) {
    assert.equal(avisos.length, 0);
    return;
  }
  assert.ok(avisos.length > 0, 'hay avisos que revisar');
  const volcado = comoTexto(avisos);
  assert.ok(!volcado.includes(CENTINELA), 'el texto de la conversación no sale');
  assert.ok(!volcado.includes('chatgpt.com/c/'), 'no viaja la URL completa, sólo el host');
  assert.ok(!volcado.includes('"webContentsId"'), 'no viaja el id de la pestaña');
  for (const aviso of avisos) {
    assert.ok(String(aviso.title || '').length > 0, 'todo aviso tiene título legible');
    assert.equal(aviso.kind, 'system');
    assert.equal(aviso.severity, 'info');
  }
});

test('los diag-* no se deduplican: dos snapshots iguales dejan dos avisos', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/doble');
  const antes = (await diagEntries()).filter((entry) => entry.code === 'diag-snapshot').length;
  for (let i = 0; i < 2; i += 1) {
    await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' });
  }
  const despues = (await diagEntries()).filter((entry) => entry.code === 'diag-snapshot').length;
  assert.equal(despues - antes, DIAG ? 2 : 0, DIAG ? 'se ven los dos, sin dedup' : 'sin la variable, ninguno');
});

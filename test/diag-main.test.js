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
  assert.ok(ahora >= nueva, 'statsSnapshot no puede perder avisos ya emitidos');
  // `diag-contadores` sólo sale cuando cambia el estado que describe: si no, el
  // registro de 400 se llena y desaloja a `diag-snapshot`, que es el que explica
  // por qué suben los números. Tres pasos, sin depender de qué etapa dejó la
  // firma el test anterior:
  const cuentaContadores = async () => (await diagEntries()).filter((entry) => entry.code === 'diag-contadores').length;
  await invoke('nexo:stats', shell);
  const trasPrimera = await cuentaContadores();
  await invoke('nexo:stats', shell);
  assert.equal(await cuentaContadores(), trasPrimera, 'sin cambios no se repite');
  // Los contadores cambian por una ruta que no llama a `statsSnapshot()`
  // (`nexo:repetition:snapshot`, main.js:1115): el aviso tiene que salir en el
  // siguiente `nexo:stats`.
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/contadores');
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' });
  await invoke('nexo:stats', shell);
  assert.ok(await cuentaContadores() > trasPrimera, 'con valores nuevos vuelve a salir');
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

/* ------------------------- 7c-4a: detalle por turno ------------------------- */

test('diag-snapshot: un renglón por turno con rol, id, caracteres y clave', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/detalle');
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' });
  const aviso = (await diagEntries()).find((entry) => entry.code === 'diag-snapshot' && entry.meta?.motivo === 'ok' &&
    entry.meta?.registros !== null);
  if (!DIAG) {
    assert.equal(aviso, undefined, 'sin la variable no hay detalle');
    return;
  }
  assert.ok(aviso, 'el snapshot con turnos deja detalle');
  const [primera, ...resto] = aviso.meta.turnos;
  assert.equal(primera.role, 'user');
  assert.equal(primera.id, 'u1');
  assert.equal(primera.chars, 'hola, ¿qué tal'.length, 'los caracteres son los del turno, no los tokens');
  assert.match(primera.clave, /:u:u1$/, 'la clave lleva rol e id');
  assert.equal(resto[0].role, 'assistant');
  assert.match(resto[0].clave, /:a:a1$/);
  assert.equal(typeof aviso.meta.nuevasClaves, 'number', 'cuántas claves añadió este observe');
  assert.equal(typeof aviso.meta.registros, 'number', 'cuántos registros hay en total');
  // El detalle va también en `detail`, no sólo en `meta`.
  assert.match(aviso.detail, /1\) user · id u1 · 14 chars/);
  // Y no arrastra el texto del chat.
  assert.ok(!JSON.stringify(aviso.meta.turnos).includes(CENTINELA));
  assert.ok(!aviso.detail.includes(CENTINELA));
});

test('diag-snapshot: repetir los mismos turnos no añade claves nuevas', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/repetido');
  const payload = { href: propia.url, turns, strategy: 'print-label' };
  await invoke('nexo:repetition:snapshot', propia, payload);
  await invoke('nexo:repetition:snapshot', propia, payload);
  const avisos = (await diagEntries()).filter((entry) => entry.code === 'diag-snapshot' && entry.meta?.motivo === 'ok' &&
    entry.meta?.registros !== null);
  if (!DIAG) {
    assert.equal(avisos.length, 0);
    return;
  }
  const [segundo, primero] = avisos; // el registro guarda del más nuevo al más viejo
  assert.equal(primero.meta.nuevasClaves, 2, 'la primera lectura crea las dos claves');
  assert.equal(segundo.meta.nuevasClaves, 0, 'la segunda no añade ninguna');
  assert.equal(segundo.meta.registros, primero.meta.registros, 'el total no crece');
});

test('diag-snapshot: informa la href como ruta sola y si cambió desde la lectura anterior', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/primera');
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' });
  propia.url = 'https://chatgpt.com/c/segunda?model=4o#frag';
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' });
  const avisos = (await diagEntries()).filter((entry) => entry.code === 'diag-snapshot' && entry.meta?.motivo === 'ok' &&
    String(entry.detail || '').includes('/c/primera') || String(entry.detail || '').includes('/c/segunda'));
  if (!DIAG) {
    assert.equal(avisos.length, 0);
    return;
  }
  const [segunda, primera] = avisos;
  assert.match(primera.detail, /\/c\/primera/);
  assert.equal(primera.meta.hrefCambio, null, 'la primera lectura no tiene con qué comparar');
  assert.equal(segunda.meta.hrefCambio, true, 'la segunda ve otra ruta');
  assert.match(segunda.detail, /href \/c\/segunda/, 'sólo la ruta');
  assert.ok(!segunda.detail.includes('chatgpt.com'), 'el origen no viaja');
  assert.ok(!segunda.detail.includes('model=4o'), 'la query no viaja');
  assert.ok(!segunda.detail.includes('frag'), 'el fragmento no viaja');
});

test('nexo:dom-tokens:snapshot también deja rastro de diagnóstico', async () => {
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/directo');
  await invoke('nexo:dom-tokens:snapshot', shell, { href: propia.url, webContentsId: propia.id, turns, strategy: 'direct-console-injection' });
  const aviso = (await diagEntries()).find((entry) => entry.code === 'diag-snapshot' && entry.meta?.motivo === 'ok-directo');
  if (!DIAG) {
    assert.equal(aviso, undefined, 'sin la variable esta ruta no deja aviso');
    return;
  }
  assert.ok(aviso, 'la ruta de la shell deja el aviso que antes no dejaba');
  assert.equal(aviso.meta.user, 1);
  assert.equal(aviso.meta.assistant, 1);
  // La estrategia del respaldo directo no está en `DIAG_STRATEGIES`, así que el
  // aviso la declara inválida: es un dato honesto, no un fallo.
  assert.equal(aviso.meta.strategy, 'no-valida');
  assert.match(aviso.detail, /ok-directo|estrategia no-valida/);
  assert.equal(aviso.meta.turnos.length, 2);
});

test('diag-contadores: mismo estado no repite; estado nuevo sí', async () => {
  const cuenta = async () => (await diagEntries()).filter((entry) => entry.code === 'diag-contadores').length;
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/contadores-dedup');
  await invoke('nexo:stats', shell);
  const base = await cuenta();
  await invoke('nexo:stats', shell);
  await invoke('nexo:stats', shell);
  if (!DIAG) {
    assert.equal(base, 0, 'sin la variable no se emite');
    return;
  }
  assert.equal(await cuenta(), base, 'tres lecturas del mismo estado dejan un solo aviso');
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' });
  await invoke('nexo:stats', shell);
  assert.ok(await cuenta() > base, 'con valores nuevos vuelve a salir');
});

test('ningún diag-* lleva el origen, la query ni el fragmento de la URL', async () => {
  // Se provoca actividad con una URL que tiene query y fragmento y un origen
  // reconocible: si el aviso publicara `origin+pathname` o la URL entera, aquí
  // se vería. Sólo el pathname es aceptable.
  const propia = journal.windows[0].attachWebview('https://chatgpt.com/c/origen?model=4o&x=1#frag');
  propia.url = 'https://chatgpt.com/c/origen?model=4o&x=1#frag';
  await invoke('nexo:repetition:snapshot', propia, { href: propia.url, turns, strategy: 'print-label' });
  await invoke('nexo:dom-tokens:snapshot', shell, { href: propia.url, webContentsId: propia.id, turns });
  const avisos = await diagEntries();
  if (!DIAG) {
    assert.equal(avisos.length, 0);
    return;
  }
  const volcado = comoTexto(avisos);
  assert.ok(!volcado.includes('https://'), 'el origen no viaja en ningún aviso');
  assert.ok(!volcado.includes('model=4o'), 'la query no viaja');
  assert.ok(!volcado.includes('x=1'), 'la query no viaja (2)');
  assert.ok(!volcado.includes('#frag'), 'el fragmento no viaja');
  // Ningún aviso puede contener los delimitadores de la URL: si apareciera una
  // `?` o una `#`, es que algo de la query o del fragmento se coló.
  for (const aviso of avisos) {
    const texto = JSON.stringify({ title: aviso.title, detail: aviso.detail, meta: aviso.meta });
    assert.ok(!texto.includes('?'), `${aviso.code} no lleva «?»`);
    assert.ok(!texto.includes('#'), `${aviso.code} no lleva «#»`);
  }
  // Lo que SÍ debe verse es la ruta: es el dato de diagnóstico de esta etapa.
  // Sólo los de esta prueba: el registro acumula los avisos de todo el fichero.
  const conHref = avisos.filter((entry) => /^href \/c\/origen$/m.test(String(entry.detail || '')));
  assert.ok(conHref.length > 0, 'hay avisos con href que revisar');
  assert.ok(conHref.some((entry) => /^href \/c\/origen$/m.test(String(entry.detail))), 'la ruta sí viaja, sola');
  assert.ok(!conHref.some((entry) => String(entry.detail).includes('chatgpt.com/c/origen')), 'pero sin el origen delante');
});

/**
 * 7c-5: duplicados del contador en las transiciones de conversación.
 *
 * Dos transiciones opuestas, medidas en el PC con `NEXO_DIAG=1`:
 *
 *  - Caso 1: un chat que empieza en `/` y adquiere `/c/<id>` al guardarse. Los
 *    turnos ya leídos siguen en pantalla y son los mismos: se MIGRAN.
 *  - Caso 2: un chat nuevo (`/`, o `/c/B`) que todavía muestra los turnos del
 *    anterior. No son mensajes de esta conversación: se IGNORAN.
 *
 * Además, los totales que publica la aplicación son los de la conversación
 * activa (`stats(..., { soloActiva: true })`, que es lo que usa
 * `statsSnapshot()`), sin borrar los de las demás.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { DomTokenTotals } from '../src/main/domTokenTotals.js';
import { calculateTokenizer } from '../src/main/tokenizerCalculator.js';

const turn = (id, role, content) => ({ id, role, content });
const snap = (href, turns, extra = {}) => ({ webContentsId: 123, href, turns, ...extra });
const tokens = (text, model = 'gpt-4o') => calculateTokenizer({ text, model }).tokens;
/** Totales de la conversación activa: exactamente lo que publica `statsSnapshot()`. */
const activa = (ledger, projectId = 'default') => ledger.stats(projectId, undefined, { soloActiva: true });

test('Caso 1: / → /c/id con el id del assistant renumerado no duplica', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snap('https://chatgpt.com/', [turn('visible-0', 'user', 'hola'), turn('visible-1', 'assistant', 'buenas')]));
  assert.equal(ledger.records(), 2);
  assert.equal(activa(ledger).userMessages, 1);

  // El sitio guarda el chat y renumera los ids: visible-1 pasa a visible-2.
  ledger.observe(snap('https://chatgpt.com/c/abc', [turn('visible-0', 'user', 'hola'), turn('visible-2', 'assistant', 'buenas')]));
  const migrado = activa(ledger);
  assert.equal(ledger.records(), 2, 'no se suma una copia de los turnos ya leídos');
  assert.equal(migrado.userMessages, 1);
  assert.equal(migrado.assistantMessages, 1);
  assert.equal(migrado.inputTokens, tokens('hola'));
  assert.equal(migrado.outputTokens, tokens('buenas'));
  assert.deepEqual(ledger.resumenActivo(), { ruta: '/c/abc', obsoletos: 0, migrados: 2 }, 'deja constancia de la migración');

  // El mensaje siguiente sí cuenta, y sólo una vez (el id migrado ya es el nuevo).
  const dos = [turn('visible-0', 'user', 'hola'), turn('visible-2', 'assistant', 'buenas'), turn('visible-3', 'user', 'otra cosa')];
  ledger.observe(snap('https://chatgpt.com/c/abc', dos));
  ledger.observe(snap('https://chatgpt.com/c/abc', dos));
  const final = activa(ledger);
  assert.equal(ledger.records(), 3, 'el chat no acumula copias turno a turno');
  assert.equal(final.userMessages, 2);
  assert.equal(final.assistantMessages, 1);
  assert.equal(final.inputTokens, tokens('hola') + tokens('otra cosa'));
  assert.equal(final.outputTokens, tokens('buenas'));
});

test('Caso 2: /c/A → / con los turnos viejos en pantalla no suma nada; lo nuevo sí', () => {
  const viejos = [turn('u1', 'user', 'uno'), turn('a1', 'assistant', 'dos'),
    turn('u2', 'user', 'tres'), turn('a2', 'assistant', 'cuatro')];
  const ledger = new DomTokenTotals();
  ledger.observe(snap('https://chatgpt.com/c/A', viejos));
  assert.equal(ledger.records(), 4);
  assert.equal(activa(ledger).userMessages, 2);

  // «Nuevo chat»: la navegación llega antes que la lectura (main.js:677).
  ledger.navigate(123, 'https://chatgpt.com/');
  ledger.observe(snap('https://chatgpt.com/', viejos));
  const nuevo = activa(ledger);
  assert.equal(ledger.records(), 4, 'el chat nuevo no hereda ni duplica los turnos del anterior');
  assert.equal(nuevo.userMessages + nuevo.assistantMessages, 0, 'un chat nuevo empieza en 0/0');
  assert.equal(ledger.resumenActivo().obsoletos, 4, 'los cuatro turnos se ignoraron por heredados');

  // El primer mensaje del chat nuevo cuenta; el snapshot repetido no vuelve a sumar.
  const conNuevo = [...viejos, turn('u9', 'user', 'mensaje del chat nuevo')];
  ledger.observe(snap('https://chatgpt.com/', conNuevo));
  ledger.observe(snap('https://chatgpt.com/', conNuevo));
  assert.equal(ledger.records(), 5);
  assert.equal(activa(ledger).userMessages, 1);
  assert.equal(activa(ledger).inputTokens, tokens('mensaje del chat nuevo'));
});

test('Caso 2 con la lectura incompleta: un snapshot que sólo trae los user tampoco duplica', () => {
  const user = [turn('u1', 'user', 'uno'), turn('u2', 'user', 'tres')];
  const ledger = new DomTokenTotals();
  ledger.observe(snap('https://chatgpt.com/c/A', user));
  assert.equal(ledger.records(), 2);
  ledger.navigate(123, 'https://chatgpt.com/');
  ledger.observe(snap('https://chatgpt.com/', user));
  assert.equal(ledger.records(), 2, 'reconoce los turnos por su contenido, no por el conjunto completo');
  assert.equal(activa(ledger).userMessages, 0);
  assert.equal(ledger.resumenActivo().obsoletos, 2);
});

test('con el mismo href y los mismos ids, la identidad anónima se regenera y cuenta aparte', () => {
  const igual = [turn('visible-0', 'user', 'igual')];
  const ledger = new DomTokenTotals(), href = 'https://chatgpt.com/';
  ledger.observe(snap(href, igual));
  assert.equal(ledger.stats().inputTokens, tokens('igual'));

  // Sin cambio de href: la navegación invalida la identidad (ids posicionales).
  ledger.navigate(123, href);
  ledger.observe(snap(href, igual));
  assert.equal(ledger.stats().inputTokens, 2 * tokens('igual'), 'dos identidades anónimas, dos mensajes');
  assert.equal(ledger.records(), 2);

  // Y con la identidad nueva, sus totales activos son los de ella, no los del anterior.
  assert.equal(activa(ledger).userMessages, 1);
  assert.equal(activa(ledger).inputTokens, tokens('igual'));
});

test('extensión 3 de 7c-5: chat nuevo vacío queda en 0/0 y volver a /c/A recupera su total', () => {
  const deA = [turn('u1', 'user', 'uno'), turn('a1', 'assistant', 'dos')];
  const ledger = new DomTokenTotals();
  ledger.observe(snap('https://chatgpt.com/c/A', deA));
  const totalA = activa(ledger);
  assert.equal(totalA.userMessages, 1);
  assert.equal(totalA.assistantMessages, 1);

  // «Nuevo chat» sin turnos todavía: la lectura vacía no puede dejar los totales de A.
  ledger.navigate(123, 'https://chatgpt.com/');
  ledger.observe(snap('https://chatgpt.com/', []));
  const vacio = ledger.stats('default', undefined, { soloActiva: true });
  assert.equal(vacio.inputTokens + vacio.outputTokens, 0);
  assert.equal(vacio.userMessages + vacio.assistantMessages, 0);
  assert.equal(ledger.resumenActivo().ruta, '/');
  assert.equal(ledger.records(), 2, 'los registros de A no se borran');

  // Volver a /c/A: su total vuelve tal cual, sin sumar nada nuevo.
  ledger.observe(snap('https://chatgpt.com/c/A', deA));
  assert.deepEqual(activa(ledger), totalA);
  // El acumulativo histórico sigue intacto: es otra serie, no se pierde.
  assert.equal(ledger.stats().inputTokens, tokens('uno'));
});

test('extensión 2 de 7c-5: dropTab no borra totales ni deja turnos heredados a la pestaña siguiente', () => {
  const deA = [turn('u1', 'user', 'uno')];
  const ledger = new DomTokenTotals();
  ledger.observe(snap('https://chatgpt.com/c/A', deA));
  const totalA = activa(ledger);
  ledger.dropTab(123);
  assert.equal(ledger.records(), 1, 'cerrar la pestaña no borra lo contado');
  assert.deepEqual(activa(ledger), totalA, 'la conversación activa sigue siendo la de la última lectura');

  // Otra pestaña que abre un chat nuevo no hereda nada de la cerrada.
  ledger.observe(snap('https://chatgpt.com/', [turn('u1', 'user', 'uno')], { webContentsId: 999 }));
  assert.equal(ledger.resumenActivo().obsoletos, 0);
  assert.equal(ledger.records(), 2);
});

test('extensión 5 de 7c-5: dentro de la conversación los turnos se acumulan sin perderse', () => {
  const ledger = new DomTokenTotals(), base = 'https://chatgpt.com/c/larga';
  const acumulado = [];
  for (let i = 0; i < 4; i += 1) {
    acumulado.push(turn(`u${i}`, 'user', `mensaje ${i}`), turn(`a${i}`, 'assistant', `respuesta ${i}`));
    ledger.observe(snap(base, [...acumulado]));
  }
  const stats = activa(ledger);
  assert.equal(stats.userMessages, 4);
  assert.equal(stats.assistantMessages, 4);
  assert.equal(stats.inputTokens, [0, 1, 2, 3].reduce((sum, i) => sum + tokens(`mensaje ${i}`), 0));
  assert.equal(ledger.records(), 8);
});

test('extensión 2b de 7c-5: el diagnóstico publica la ruta, nunca el origen, la query ni la huella', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snap('https://chatgpt.com/c/privada?model=4o&x=1#frag',
    [turn('u1', 'user', 'texto reservado del chat')]));
  const resumen = ledger.resumenActivo();
  assert.deepEqual(Object.keys(resumen).sort(), ['migrados', 'obsoletos', 'ruta']);
  assert.equal(resumen.ruta, '/c/privada', 'sólo pathname');
  const volcado = JSON.stringify({ resumen, stats: ledger.stats(), activos: activa(ledger) });
  assert.ok(!volcado.includes('https://'), 'el origen no se publica');
  assert.ok(!volcado.includes('model=4o') && !volcado.includes('frag'), 'la query y el fragmento no se publican');
  assert.ok(!volcado.includes('texto reservado'), 'el texto del chat no se publica');
  assert.doesNotMatch(volcado, /(user|assistant):\d+:[0-9a-z]+/, 'la huella por turno no se publica');
});

/**
 * `diag-contadores` con `NEXO_DIAG=1`, sobre la instancia real de `main.js`.
 * Va al final: importar la aplicación trae su arnés y sus temporizadores.
 */
process.env.NEXO_DIAG = '1';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((resolve) => setTimeout(resolve, 50));

test('diag-contadores incluye la conversación activa como pathname y los turnos ignorados', async () => {
  const shell = journal.windows[0].webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const invoke = (canal, sender, payload) => journal.ipcHandlers.get(canal)({ sender, senderFrame: sender.mainFrame }, payload);

  const guest = journal.windows[0].attachWebview('https://chatgpt.com/c/activa?x=1#frag');
  const viejos = [turn('u1', 'user', 'uno del chat viejo'), turn('a1', 'assistant', 'dos del chat viejo')];
  await invoke('nexo:dom-tokens:snapshot', shell, { webContentsId: guest.id, href: guest.getURL(), turns: viejos });
  await invoke('nexo:stats', shell);

  // El registro de actividad va de más reciente a más antiguo.
  const ultimoAviso = async () => (await invoke('nexo:log', shell))
    .filter((entry) => entry.code === 'diag-contadores').at(0);
  let aviso = await ultimoAviso();
  assert.ok(aviso, 'con NEXO_DIAG=1 el aviso sale');
  assert.equal(aviso.meta.conversationPath, '/c/activa');
  assert.equal(aviso.meta.migratedRecords, 0);
  assert.equal(aviso.meta.ignoredTurns, 0);

  // Chat nuevo con los turnos viejos todavía en pantalla: se ignoran y se dice.
  // `navigateTo` emite `did-start-navigation` (main.js:677), como el sitio real.
  guest.navigateTo('https://chatgpt.com/');
  assert.equal(guest.getURL(), 'https://chatgpt.com/');
  await invoke('nexo:dom-tokens:snapshot', shell, { webContentsId: guest.id, href: guest.getURL(), turns: viejos });
  await invoke('nexo:stats', shell);
  aviso = await ultimoAviso();
  assert.equal(aviso.meta.conversationPath, '/', 'el aviso cambia de conversación y lo publica como pathname');
  assert.equal(aviso.meta.ignoredTurns, 2);
  assert.equal(aviso.meta.inputTokens + aviso.meta.outputTokens, 0, 'el chat nuevo se publica en 0/0');

  const volcado = JSON.stringify((await invoke('nexo:log', shell))
    .filter((entry) => String(entry.code || '').startsWith('diag-'))
    .map(({ code, title, detail, meta }) => ({ code, title, detail, meta })));
  assert.ok(!volcado.includes('https://'), 'ningún aviso publica el origen');
  assert.ok(!volcado.includes('x=1') && !volcado.includes('frag'), 'ni la query ni el fragmento');
  assert.ok(!volcado.includes('uno del chat viejo'), 'ni el texto del chat');
});

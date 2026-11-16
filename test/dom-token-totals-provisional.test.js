/**
 * 7c-5b: `/c/local-chatgpt:<uuid>` → `/c/<id real>` es el MISMO chat.
 *
 * Medido en el PC (10a2d0b): ChatGPT abre el chat con una URL provisional y
 * después la cambia a la real sin recargar. Los turnos siguen en pantalla, pero
 * el contador los trataba como «otro chat»: en la primera lectura los ignoraba
 * y en la segunda los volvía a sumar. Aquí se fija el comportamiento correcto y
 * se comprueba que el régimen de 7c-5 (Caso 2) sigue intacto.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { DomTokenTotals } from '../src/main/domTokenTotals.js';
import { calculateTokenizer } from '../src/main/tokenizerCalculator.js';

const turn = (id, role, content) => ({ id, role, content });
/** Texto sintético de la longitud medida en el PC: no se usa contenido del chat. */
const txt = (n) => 'x'.repeat(n);
const tokens = (text, model = 'gpt-4o') => calculateTokenizer({ text, model }).tokens;
const activa = (ledger) => ledger.stats('default', undefined, { soloActiva: true });
const dom = (ledger) => `${activa(ledger).inputTokens}/${activa(ledger).outputTokens}`;

const PROVISIONAL = 'https://chatgpt.com/c/local-chatgpt%3A9f2a-uuid-provisional';
const REAL = 'https://chatgpt.com/c/68f1c0a1b2c3d4e5f6a7b8c9';
/** Longitudes medidas en L1 (4.º turno de 4 chars) y en L3 (el mismo, ya mediado). */
const largo = [4961, 5239, 5536];
const L1 = [...largo.map((n, i) => turn(`visible-${i * 2}`, 'user', txt(n))), turn('visible-6', 'user', txt(4))];
const L3 = [...largo.map((n, i) => turn(`visible-${i * 2}`, 'user', txt(n))), turn('visible-6', 'user', txt(5848))];
const total = (largos) => largos.reduce((sum, n) => sum + tokens(txt(n)), 0);

/** Secuencia L1→L4 tal como la produce `main.js`: `navigate` antes de la lectura. */
function secuencia(ledger, { navigate = true } = {}) {
  const obs = (href, turns) => ledger.observe({ webContentsId: 7, href, turns });
  obs(PROVISIONAL, L1);
  const l1 = activa(ledger);
  obs(PROVISIONAL, L1);                       // L2: misma lectura
  if (navigate) ledger.navigate(7, REAL);     // main.js:677, antes de L3
  obs(REAL, L3);                              // L3: misma conversación, URL real
  const l3 = activa(ledger), r3 = ledger.resumenActivo();
  obs(REAL, L3);                              // L4: misma lectura
  return { l1, l3, r3, l4: activa(ledger), r4: ledger.resumenActivo() };
}

test('(a) L1→L4: no hay valor intermedio falso y el total nunca baja al cambiar de URL', () => {
  const ledger = new DomTokenTotals();
  const { l1, l3, r3, l4, r4 } = secuencia(ledger);

  assert.equal(dom(ledger), `${total(largo) + tokens(txt(5848))}/0`, 'L4 conserva el total completo');
  assert.equal(l1.inputTokens + l1.outputTokens, total(largo) + tokens(txt(4)), 'L1 mide lo que hay en pantalla');
  assert.ok(l3.inputTokens >= l1.inputTokens, 'L3 no puede bajar a un valor intermedio (medido: 3982 → 1476)');
  assert.equal(l3.userMessages, 4, 'los cuatro turnos siguen siendo de la misma conversación');
  assert.equal(l3.assistantMessages, 0);
  assert.deepEqual(l4, l3, 'L4 es la misma lectura: no vuelve a sumar');
  assert.equal(ledger.records(), 4, 'ni un registro de más ni uno huérfano');

  // Diagnóstico de la lectura que hace la transición: migra, no ignora.
  assert.deepEqual(r3, { ruta: '/c/68f1c0a1b2c3d4e5f6a7b8c9', obsoletos: 0, migrados: 4 });
  assert.deepEqual(r4, { ruta: '/c/68f1c0a1b2c3d4e5f6a7b8c9', obsoletos: 0, migrados: 0 }, 'L4 ya no migra nada');
});

test('(a bis) la misma secuencia sin `navigate` intermedio da el mismo resultado', () => {
  const conNavegacion = new DomTokenTotals();
  const sinNavegacion = new DomTokenTotals();
  const con = secuencia(conNavegacion);
  const sin = secuencia(sinNavegacion, { navigate: false });
  assert.deepEqual(con.l3, sin.l3);
  assert.deepEqual(con.l4, sin.l4);
});

test('(b) el cuarto turno cambia de texto y cuenta una sola vez, con su valor final', () => {
  const ledger = new DomTokenTotals();
  secuencia(ledger);
  const registro = [...ledger.project('default').records.entries()]
    .filter(([clave]) => clave.includes('\0user\0visible-6'));
  assert.equal(registro.length, 1, 'no queda un registro huérfano con el texto de 4 chars');
  assert.equal(registro[0][1].text.length, 5848, 'se sustituye por el texto final');
  assert.equal(registro[0][1].tokens, tokens(txt(5848)));

  // Y lo que llegue después sigue sumando una sola vez (respuesta en streaming).
  const conRespuesta = [...L3, turn('visible-7', 'assistant', txt(12))];
  ledger.observe({ webContentsId: 7, href: REAL, turns: conRespuesta });
  const parcial = activa(ledger);
  ledger.observe({ webContentsId: 7, href: REAL, turns: [...L3, turn('visible-7', 'assistant', txt(65))] });
  const final = activa(ledger);
  assert.equal(final.assistantMessages, 1);
  assert.equal(final.outputTokens, tokens(txt(65)), 'la respuesta parcial se sustituye, no se acumula');
  assert.equal(final.inputTokens, parcial.inputTokens, 'los turnos de usuario no se mueven');
  assert.equal(ledger.records(), 5);
});

test('(c) una ruta real que NO viene de una provisional mantiene el régimen de 7c-5', () => {
  const viejo = [turn('u1', 'user', txt(300)), turn('a1', 'assistant', txt(500))];
  const ledger = new DomTokenTotals();
  ledger.observe({ webContentsId: 7, href: 'https://chatgpt.com/c/A', turns: viejo });
  assert.equal(ledger.records(), 2);
  ledger.navigate(7, 'https://chatgpt.com/c/B');
  ledger.observe({ webContentsId: 7, href: 'https://chatgpt.com/c/B', turns: viejo });
  const nuevo = activa(ledger);
  assert.equal(ledger.records(), 2, 'otro chat con los turnos viejos en pantalla: no se duplica');
  assert.equal(nuevo.userMessages + nuevo.assistantMessages, 0, 'y el chat nuevo empieza en 0/0');
  assert.equal(ledger.resumenActivo().obsoletos, 2, 'se ignoran por heredados');
  assert.equal(ledger.resumenActivo().migrados, 0, 'no se migra nada: no son el mismo chat');
});

test('(d) sólo `/c/<id real>` desde una provisional migra; cualquier otro id no se trata como provisional', () => {
  const turnos = [turn('u1', 'user', txt(120))];
  const intenta = (desde, hacia) => {
    const ledger = new DomTokenTotals();
    ledger.observe({ webContentsId: 7, href: `https://chatgpt.com${desde}`, turns: turnos });
    const href = `https://chatgpt.com${hacia}`;
    ledger.navigate(7, href);
    ledger.observe({ webContentsId: 7, href, turns: turnos });
    return { ruta: ledger.resumenActivo(), stats: activa(ledger) };
  };

  // Provisional reconocible (codificada, con dos puntos literales y en mayúsculas).
  for (const desde of ['/c/local-chatgpt%3Auuid-x', '/c/local-chatgpt:uuid-x', '/c/LOCAL-CHATGPT%3Auuid-x']) {
    const r = intenta(desde, '/c/id-real-1');
    assert.equal(r.ruta.migrados, 1, `${desde} → /c/<id real> migra`);
    assert.equal(r.stats.userMessages, 1, `${desde} conserva el turno, no lo vuelve a sumar`);
  }

  // Casi-provisional: no lo es, así que se comporta como otro chat (Caso 2).
  for (const desde of ['/c/local-chatgpt-uuid', '/c/local-chatgpt2%3Auuid', '/c/mi-local-chatgpt%3A1', '/c/otro', '/c/A']) {
    const r = intenta(desde, '/c/id-real-2');
    assert.equal(r.ruta.migrados, 0, `${desde} no es una identidad provisional`);
    assert.equal(r.ruta.obsoletos, 1, `${desde} → /c/<id real> se ignora por heredado`);
    assert.equal(r.stats.inputTokens, 0, `${desde} arranca en 0/0`);
  }

  // El sentido contrario tampoco migra: de una ruta real a una provisional.
  const vuelta = intenta('/c/A', '/c/local-chatgpt%3Auuid-x');
  assert.equal(vuelta.ruta.migrados, 0, '/c/A → provisional no es un chat guardándose');
  assert.equal(vuelta.ruta.obsoletos, 1);
});

test('(e) diag-contadores publica la ruta provisional enmascarada, sin uuid, origen, query, hash ni texto', async () => {
  // Fuera de la aplicación: lo único que se publica es `resumenActivo()`.
  const ledger = new DomTokenTotals();
  ledger.observe({ webContentsId: 7, href: `${PROVISIONAL}?model=4o&x=1#frag`,
    turns: [turn('u1', 'user', 'texto reservado del chat')] });
  const resumen = ledger.resumenActivo();
  assert.deepEqual(Object.keys(resumen).sort(), ['migrados', 'obsoletos', 'ruta']);
  assert.equal(resumen.ruta, '/c/<provisional>', 'el uuid no se publica');
  const volcado = JSON.stringify({ resumen, stats: ledger.stats(), activos: activa(ledger) });
  assert.ok(!volcado.includes('9f2a-uuid'), 'ni el uuid');
  assert.ok(!volcado.includes('local-chatgpt'), 'ni el identificador provisional');
  assert.ok(!volcado.includes('https://'), 'ni el origen');
  assert.ok(!volcado.includes('model=4o') && !volcado.includes('frag'), 'ni query ni fragmento');
  assert.ok(!volcado.includes('texto reservado'), 'ni el texto del chat');

  // Y a través de `diag-contadores` real, con NEXO_DIAG=1.
  process.env.NEXO_DIAG = '1';
  register('./harness/loader.mjs', import.meta.url);
  const { journal } = await import('./harness/electron-stub.mjs');
  await import('../src/main/main.js');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const shell = journal.windows[0].webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const invoke = (canal, sender, payload) => journal.ipcHandlers.get(canal)({ sender, senderFrame: sender.mainFrame }, payload);
  const guest = journal.windows[0].attachWebview(`${PROVISIONAL}?model=4o&x=1#frag`);
  await invoke('nexo:dom-tokens:snapshot', shell, { webContentsId: guest.id, href: guest.getURL(),
    turns: [turn('visible-0', 'user', 'texto reservado del chat')] });
  await invoke('nexo:stats', shell);

  const avisos = (await invoke('nexo:log', shell)).filter((entry) => String(entry.code || '').startsWith('diag-'));
  const contadores = avisos.filter((entry) => entry.code === 'diag-contadores');
  assert.ok(contadores.length, 'con NEXO_DIAG=1 el aviso sale');
  assert.equal(contadores[0].meta.conversationPath, '/c/<provisional>');
  const contadoresTexto = JSON.stringify(contadores.map(({ code, title, detail, meta }) => ({ code, title, detail, meta })));
  assert.ok(!contadoresTexto.includes('9f2a-uuid'), 'diag-contadores no publica el uuid');
  const todo = JSON.stringify(avisos.map(({ code, title, detail, meta }) => ({ code, title, detail, meta })));
  assert.ok(!todo.includes('https://'), 'ni el origen');
  assert.ok(!todo.includes('model=4o') && !todo.includes('frag'), 'ni query ni fragmento');
  assert.ok(!todo.includes('texto reservado'), 'ni el texto del chat');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { DomTokenTotals } from '../src/main/domTokenTotals.js';
import { calculateTokenizer } from '../src/main/tokenizerCalculator.js';
import { tokenCounterView } from '../src/ui/shell/tokenCounterView.js';
const official = JSON.parse(readFileSync(new URL('../docs/BPE-OFICIAL-COMPARACION.json', import.meta.url), 'utf8'));
const href = 'https://chatgpt.com/c/dom-counter';
const turn = (id, role, content) => ({ id, role, content });
const snapshot = (turns, overrides = {}) => ({ webContentsId: 123, href, turns, ...overrides });
const tokens = (text, model = 'gpt-4o') => calculateTokenizer({ text, model }).tokens;
for (const row of official.rows) {
  test(`DOM usa calculadora manual contra tiktoken: ${row.model} / ${row.case}`, () => {
    const ledger = new DomTokenTotals();
    ledger.observe(snapshot([turn('u', 'user', row.text), turn('a', 'assistant', row.text)]), row.model);
    const stats = ledger.stats('default', row.model);
    assert.equal(stats.inputTokens, row.official); assert.equal(stats.outputTokens, row.official);
    assert.equal(stats.encoding, row.encoding);
  });
}

test('cada próximo mensaje suma; un snapshot repetido no vuelve a sumar', () => {
  const ledger = new DomTokenTotals(), first = [turn('u1', 'user', '  Hola, mundo.  ')];
  ledger.observe(snapshot(first)); const before = ledger.stats().inputTokens;
  ledger.observe(snapshot([...first, turn('u2', 'user', 'otro mensaje')]));
  assert.equal(ledger.stats().inputTokens, before + tokens('otro mensaje'));
  ledger.observe(snapshot([...first, turn('u2', 'user', 'otro mensaje')]));
  assert.equal(ledger.stats().inputTokens, before + tokens('otro mensaje'));
  ledger.observe(snapshot([...first, turn('u2', 'user', 'otro mensaje'), turn('u3', 'user', 'otro mensaje')]));
  assert.equal(ledger.stats().inputTokens, before + 2 * tokens('otro mensaje'), 'texto idéntico con otro ID es otro mensaje');
});

test('salida acumulativa por respuesta; los parciales sustituyen su aporte', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('a1', 'assistant', 'respuesta anterior')]));
  const before = ledger.stats().outputTokens;
  for (const text of ['  uno', '  uno dos\n', '  uno dos tres\n', 'uno']) {
    ledger.observe(snapshot([turn('a2', 'assistant', text)]));
    assert.equal(ledger.stats().outputTokens, before + tokens(text));
  }
  assert.equal(ledger.stats().assistantMessages, 2);
});

test('no requiere metadata, gesto, petición de red ni EVO para contar el primer DOM cargado', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('u', 'user', 'entrada'), turn('a', 'assistant', 'salida')]));
  const domTokens = ledger.stats();
  const view = tokenCounterView({ domTokens, unknownInputMessages: 500, unknownOutputMessages: 500 });
  assert.equal(view.input, String(tokens('entrada'))); assert.equal(view.output, String(tokens('salida')));
  assert.match(view.detail, /Referencia seleccionada: gpt-4o/);
  assert.doesNotMatch(view.input + view.output, /—|\?/);
});

test('proyectos separados y misma conversación en dos pestañas no duplica IDs', () => {
  const ledger = new DomTokenTotals(), turns = [turn('u', 'user', 'texto')];
  ledger.observe(snapshot(turns, { projectId: 'A' }));
  ledger.observe(snapshot(turns, { projectId: 'A', webContentsId: 999 }));
  assert.equal(ledger.stats('A').inputTokens, tokens('texto'));
  assert.equal(ledger.stats('B').inputTokens, 0);
  ledger.observe(snapshot(turns, { projectId: 'B' }));
  assert.equal(ledger.stats('B').inputTokens, tokens('texto'));
});

test('adquirir /c/id después del primer envío migra los aportes sin duplicarlos', () => {
  const ledger = new DomTokenTotals(), turns = [turn('u', 'user', 'primer mensaje')];
  ledger.observe(snapshot(turns, { href: 'https://chatgpt.com/' }));
  ledger.observe(snapshot(turns));
  assert.equal(ledger.stats().inputTokens, tokens('primer mensaje'));
  assert.equal(ledger.stats().userMessages, 1);
});

test('reemplazar respaldo por lector aislado no suma otra copia con IDs diferentes', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('console-u', 'user', 'hola')], { source: 'direct' }));
  ledger.observe(snapshot([turn('provider-u', 'user', 'hola')]));
  assert.equal(ledger.stats().inputTokens, tokens('hola'));
  assert.equal(ledger.stats().userMessages, 1);
});

test('misma fórmula, referencias distintas; cambiar modelo recalcula todo lo acumulado', () => {
  const ledger = new DomTokenTotals(), text = '  Hola, mundo.  ';
  ledger.observe(snapshot([turn('u', 'user', text), turn('a', 'assistant', text)]));
  assert.equal(ledger.stats().inputTokens, 6);
  const recounted = ledger.stats('default', 'gpt-4');
  assert.equal(recounted.inputTokens, 7); assert.equal(recounted.outputTokens, 7);
  assert.equal(recounted.encoding, 'cl100k_base');
  assert.throws(() => ledger.stats('default', 'gpt-6'), /modelo/);
});

test('límites explícitos no se presentan como captura completa y no escriben memoria', () => {
  const ledger = new DomTokenTotals(); ledger.maxChars = 10;
  ledger.observe(snapshot([turn('u', 'user', '12345'), turn('a', 'assistant', 'demasiado largo')]));
  const stats = ledger.stats(); assert.equal(stats.partial, true);
  assert.equal(stats.inputTokens, tokens('12345')); assert.equal(stats.outputTokens, 0);
  assert.match(tokenCounterView({ domTokens: stats }).input, /\+ \?/);
});

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

test('IPC real: DOM → misma calculadora → acumulados visibles, con EVO apagada y sin modelo de proveedor', async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  const win = journal.windows[0], owner = win.webContents;
  const event = sender => ({ sender, senderFrame: sender.mainFrame });
  const call = (channel, sender, payload) => journal.ipcHandlers.get(channel)(event(sender), payload);
  call('nexo:settings:set', owner, { enabled: false, memory: { enabled: false } });
  const guest = win.attachWebview(href);
  guest.navigateTo(href, 'ChatGPT');
  const before = call('nexo:stats', owner);
  const payload = { href, turns: [turn('u1', 'user', '  Hola, mundo.  '), turn('a1', 'assistant', '  respuesta 👩🏽‍💻\n')] };
  const receive = p => call('nexo:repetition:snapshot', guest, p);
  assert.equal(receive(payload).ok, true);
  const first = call('nexo:stats', owner), view = tokenCounterView(first);
  assert.equal(first.domTokens.inputTokens, 6);
  assert.equal(first.domTokens.outputTokens, tokens(payload.turns[1].content));
  assert.equal(view.input, '6');
  assert.ok(owner.sent.some(s => s.channel === 'nexo:stats-changed' && s.payload.domTokens.inputTokens === 6), 'se empuja el primer snapshot, aunque no haya turno de red');
  receive({ href, turns: [...payload.turns, turn('u2', 'user', '  Hola, mundo.  ')] });
  receive({ href, turns: [...payload.turns, turn('u2', 'user', '  Hola, mundo.  ')] });
  assert.equal(call('nexo:stats', owner).domTokens.inputTokens, 12);
  assert.equal(call('nexo:stats', owner).messages, before.messages, 'no inventa un envío de red al leer DOM');
  assert.deepEqual(call('nexo:memory:conversations', owner), [], 'no habilita ni cambia la memoria');
  call('nexo:settings:set', owner, { tokenCounting: { model: 'gpt-4' } });
  assert.equal(call('nexo:stats', owner).domTokens.inputTokens, 14);
  assert.throws(() => call('nexo:settings:set', owner, { tokenCounting: { model: 'gpt-6' } }), /verificado/);
});

test('respaldo de Memoria sólo acepta la shell dueña, URL actual y datos válidos', () => {
  const win = journal.windows[0], owner = win.webContents, guest = win.attachWebview('https://chatgpt.com/c/fallback');
  guest.navigateTo('https://chatgpt.com/c/fallback', 'ChatGPT');
  const handler = journal.ipcHandlers.get('nexo:dom-tokens:snapshot');
  const payload = { webContentsId: guest.id, href: guest.getURL(), turns: [turn('fallback', 'user', 'texto de respaldo')], strategy: 'direct-console-injection' };
  assert.equal(handler({ sender: owner, senderFrame: owner.mainFrame }, payload).ok, true);
  for (const event of [{ sender: guest, senderFrame: guest.mainFrame }, { sender: owner, senderFrame: {} }, {}]) assert.equal(handler(event, payload).ok, false);
  assert.equal(handler({ sender: owner, senderFrame: owner.mainFrame }, { ...payload, href }).ok, false);
});

test('snapshot vacío transitorio no borra aportes ni impide migrar / a /c/id', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('u', 'user', 'entrada')], { href: 'https://chatgpt.com/' }));
  ledger.observe(snapshot([]));
  ledger.observe(snapshot([turn('u', 'user', 'entrada')]));
  ledger.observe(snapshot([], { source: 'direct' }));
  assert.equal(ledger.stats().inputTokens, tokens('entrada'));
  assert.equal(ledger.stats().userMessages, 1);
});

test('navegar a otra conversación sin ID compartido no migra el historial anónimo', () => {
  const ledger = new DomTokenTotals();
  ledger.observe(snapshot([turn('old', 'user', 'anterior')], { href: 'https://chatgpt.com/' }));
  ledger.observe(snapshot([turn('new', 'user', 'nuevo')]));
  assert.equal(ledger.stats().inputTokens, tokens('anterior') + tokens('nuevo'));
  ledger.observe(snapshot([turn('old', 'user', 'anterior')], { href: 'https://chatgpt.com/c/old' }));
  // La navegación a un chat no relacionado conserva la sesión previa como tal.
  assert.equal(ledger.stats().userMessages, 3);
});

test('volver a nuevo chat anónimo permite mensajes con el mismo ID posicional', () => {
  const ledger = new DomTokenTotals(), anonymous = { href: 'https://chatgpt.com/' };
  ledger.observe(snapshot([turn('visible-0', 'user', 'igual')], anonymous));
  ledger.navigate(123, anonymous.href);
  ledger.observe(snapshot([turn('visible-0', 'user', 'igual')], anonymous));
  assert.equal(ledger.stats().inputTokens, 2 * tokens('igual'));
});

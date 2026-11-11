import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { calculateTokenizer, tokenizerModels, MAX_TOKENIZER_TEXT } from '../src/main/tokenizerCalculator.js';
import { createTokenizerPanel } from '../src/ui/shell/tokenizerPanel.js';

const official = JSON.parse(readFileSync(new URL('../docs/BPE-OFICIAL-COMPARACION.json', import.meta.url), 'utf8'));
for (const row of official.rows) {
  test(`calculadora contra OpenAI tiktoken: ${row.model} / ${row.case}`, () => {
    const result = calculateTokenizer({ text: row.text, model: row.model });
    assert.equal(result.ok, true);
    assert.equal(result.tokens, row.official);
    assert.equal(result.encoding, row.encoding);
    assert.equal(result.method, 'bpe-original');
    assert.equal(Object.hasOwn(result, 'text'), false, 'no devuelve una copia del texto');
  });
}

test('calculadora rechaza modelos desconocidos y entradas inválidas sin aproximaciones', () => {
  for (const payload of [null, [], {}, { text: 12, model: 'gpt-4o' },
    { text: 'hola', model: 'gpt-6' }, { text: 'hola', model: 'auto' },
    { text: 'hola', model: '__proto__' }, { text: 'hola', model: '../secret' },
    { text: 'x'.repeat(MAX_TOKENIZER_TEXT + 1), model: 'gpt-4o' }]) {
    const result = calculateTokenizer(payload);
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'tokens'), false);
  }
});

test('modelos disponibles contienen sólo encodings verificados y un default válido', () => {
  const config = tokenizerModels();
  assert.ok(config.models.some(m => m.id === config.defaultModel));
  assert.equal(config.models.length, Object.keys(official.models).length);
  for (const model of config.models) assert.equal(model.encoding, official.models[model.id]);
  assert.equal(config.maxTextLength, MAX_TOKENIZER_TEXT);
  assert.equal(calculateTokenizer({ text: '', model: config.defaultModel }).tokens, 0);
});

function ui(api = { models: async () => tokenizerModels(), count: async payload => calculateTokenizer(payload) }) {
  const nodes = new Map(), copies = [];
  let scheduled = null;
  const node = () => ({ textContent: '', value: '', disabled: true, handlers: new Map(), children: [],
    addEventListener(name, fn) { this.handlers.set(name, fn); },
    append(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    focus() { this.focused = true; }, async emit(name) { return this.handlers.get(name)?.({ preventDefault() {} }); } });
  const root = { querySelector(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, ownerDocument: { createElement: node } };
  const panel = createTokenizerPanel({ root, api, clipboard: { writeText: async text => copies.push(text) }, setTimer: fn => { scheduled = fn; return 1; }, clearTimer: () => { scheduled = null; } });
  return { panel, copies, tick: async () => { const fn = scheduled; scheduled = null; return fn?.(); }, get: id => root.querySelector('#tokenizer' + id) };
}

test('UI muestra resultado numérico usando exactamente el texto introducido', async () => {
  const payloads = [], u = ui({ models: async () => tokenizerModels(), count: async payload => { payloads.push(payload); return calculateTokenizer(payload); } });
  await u.panel.refresh();
  assert.equal(u.get('Model').value, 'gpt-4o');
  const original = '  Hola, mundo.  ';
  u.get('Text').value = original;
  await u.get('Form').emit('submit');
  assert.deepEqual(payloads, [{ text: original, model: 'gpt-4o' }]);
  assert.equal(u.get('Result').textContent, '6');
  assert.match(u.get('Status').textContent, /o200k_base/);
  assert.equal(u.get('Text').value, original);
  u.get('Text').value = '';
  await u.get('Form').emit('submit');
  assert.equal(u.get('Result').textContent, '0');
});

test('UI invalida resultado al editar/cambiar modelo y permite limpiar sin API', async () => {
  const u = ui(); await u.panel.refresh();
  u.get('Text').value = '  Hola, mundo.  '; await u.get('Form').emit('submit');
  await u.get('Text').emit('input'); assert.equal(u.get('Result').textContent, '—');
  u.get('Model').value = 'gpt-4'; await u.get('Model').emit('change');
  await u.get('Form').emit('submit'); assert.equal(u.get('Result').textContent, '7');
  await u.get('Clear').emit('click');
  assert.equal(u.get('Text').value, ''); assert.equal(u.get('Result').textContent, '0'); assert.equal(u.get('Text').focused, true);
});

test('UI no imprime una respuesta antigua si cambia el texto durante el cálculo', async () => {
  let resolve;
  const u = ui({ models: async () => tokenizerModels(), count: () => new Promise(done => { resolve = done; }) });
  await u.panel.refresh(); u.get('Text').value = 'primero';
  const pending = u.get('Form').emit('submit');
  u.get('Text').value = 'segundo'; await u.get('Text').emit('input');
  resolve({ ok: true, tokens: 123, model: 'gpt-4o', encoding: 'o200k_base' }); await pending;
  assert.equal(u.get('Result').textContent, '—'); assert.equal(u.get('Count').disabled, false);
});

test('UI muestra errores de carga/conteo y permite reintentar, sin un número ficticio', async () => {
  let failure = true;
  const u = ui({ models: async () => { if (failure) throw Error('sin servicio'); return tokenizerModels(); }, count: async () => ({ ok: false, error: 'fallo de tokenizador' }) });
  await u.panel.refresh(); assert.match(u.get('Status').textContent, /sin servicio/); assert.equal(u.get('Count').disabled, true);
  failure = false; await u.panel.refresh(); assert.equal(u.get('Count').disabled, false);
  await u.get('Form').emit('submit'); assert.equal(u.get('Result').textContent, '—'); assert.match(u.get('Status').textContent, /fallo de tokenizador/);
});

test('pestaña y panel usan contrato accesible y no dependen del estado EVO', () => {
  const html = readFileSync(new URL('../src/ui/shell/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-panel="tokenizer" id="panel-tab-tokenizer" role="tab" aria-controls="panel-tokenizer"/);
  assert.match(html, /id="panel-tokenizer" role="tabpanel" aria-labelledby="panel-tab-tokenizer"/);
  assert.match(html, /<output id="tokenizerResult"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /data-panel="tiktoken"/);
  for (const id of ['tokenizerCopy', 'tokenizerWords', 'tokenizerChars']) assert.ok(html.includes(`id="${id}"`));
});

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

test('IPC real: sólo shell registrada puede calcular; no cambia actividad ni ajustes', async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  const shell = journal.windows[0].webContents;
  const event = { sender: shell, senderFrame: shell.mainFrame };
  const call = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);
  const before = structuredClone(call('nexo:stats', event));
  const settings = structuredClone(call('nexo:settings:get', event));
  assert.equal(call('nexo:tokenizer:models', event).ok, true);
  assert.equal(call('nexo:tiktoken:count', event, { text: '  Hola, mundo.  ', model: 'gpt-4o' }), 6, 'API remota previa conservada');
  assert.equal(call('nexo:tokenizer:count', event, { text: '  Hola, mundo.  ', model: 'gpt-4o' }).tokens, 6);
  assert.deepEqual(call('nexo:stats', event), before);
  assert.deepEqual(call('nexo:settings:get', event), settings);
  const guest = journal.windows[0].attachWebview('https://chatgpt.com/');
  for (const bad of [{ sender: guest, senderFrame: guest.mainFrame }, { sender: shell, senderFrame: {} }, { sender: { getURL: () => shell.getURL(), mainFrame: shell.mainFrame }, senderFrame: shell.mainFrame }, {}]) {
    assert.equal(call('nexo:tokenizer:count', bad, { text: 'secreto', model: 'gpt-4o' }).ok, false);
    assert.equal(call('nexo:tokenizer:models', bad).ok, false);
    assert.equal(call('nexo:tiktoken:count', bad, { text: 'hola', model: 'gpt-4o' }), null);
  }
});

test('herramienta unificada conserva conteo automático, palabras/caracteres y copiar resultado', async () => {
  const u = ui(); await u.panel.refresh();
  u.get('Text').value = 'hola\tmundo\n';
  await u.get('Text').emit('input');
  assert.equal(u.get('Copy').disabled, true);
  assert.equal(u.get('Words').textContent, '2');
  assert.equal(u.get('Chars').textContent, String('hola\tmundo\n'.length));
  await u.tick();
  const expected = calculateTokenizer({ text: 'hola\tmundo\n', model: 'gpt-4o' }).tokens;
  assert.equal(u.get('Result').textContent, String(expected));
  await u.get('Copy').emit('click');
  assert.deepEqual(u.copies, [`Tokens: ${expected} | Modelo: gpt-4o | Palabras: 2 | Caracteres: ${'hola\tmundo\n'.length}`]);
  await u.get('Clear').emit('click');
  assert.equal(u.get('Words').textContent, '0'); assert.equal(u.get('Chars').textContent, '0');
});

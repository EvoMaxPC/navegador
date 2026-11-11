import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
// Referencias generadas independientemente por OpenAI tiktoken, no por la biblioteca JS.
const official = JSON.parse(
  readFileSync(
    new URL('../docs/BPE-OFICIAL-COMPARACION.json', import.meta.url),
    'utf8',
  ),
);
const cases = [
  'normal',
  'bordes',
  'tabulaciones',
  'saltos',
  'CRLF',
  'emoji',
  'emoji-combinado',
  'NFD',
  'acentos',
  'vacio',
];

const requireBridge = createRequire(
  new URL('../src/preload/bridge.cjs', import.meta.url),
);
const { outgoingMetadata } = requireBridge('./token-metadata.cjs');

for (const [model, encoding] of [
  ['gpt-5', 'o200k_base'],
  ['gpt-4-turbo', 'cl100k_base'],
]) {
  for (const name of cases) {
    const reference = official.rows.find(
      (row) => row.encoding === encoding && row.case === name,
    );
    test(`preload frente a OpenAI tiktoken: ${model} / ${name}`, () => {
      const tokenText = reference.text;
      const payload = {
        host: 'chatgpt.com',
        model,
        tokenText,
        tokens: 999,
        messageId: 'msg-1',
      };
      const result = outgoingMetadata(payload);
      assert.equal(result.tokens, reference.official);
      assert.equal(result.tokens, reference.officialIds.length);
      assert.equal(result.tokenEncoding, encoding);
      assert.equal(result.tokenExact, true);
      assert.equal(result.messageId, payload.messageId);
      assert.ok(!('tokenText' in result));
      assert.equal(payload.tokenText, tokenText, 'no muta el texto original');
    });
  }
}

test('el preload conserva el conteo existente de otros proveedores y del formato viejo', () => {
  assert.deepEqual(
    outgoingMetadata({ host: 'claude.ai', tokenText: 'hola', tokens: 8 }),
    {
      host: 'claude.ai',
      tokens: 8,
      tokenExact: false,
      tokenEncoding: null,
      tokenMethod: 'legacy-estimate',
    },
  );
  assert.deepEqual(outgoingMetadata({ host: 'chatgpt.com', tokens: 7 }), {
    host: 'chatgpt.com',
    tokens: 7,
    tokenExact: false,
    tokenEncoding: null,
    tokenMethod: 'unverified',
  });
  assert.equal(
    outgoingMetadata({
      host: 'chatgpt.com',
      model: 'gpt-5',
      tokenText: '',
      tokens: 20,
    }).tokens,
    0,
  );
});

test('el bridge real convierte el aviso outgoing antes de enviarlo por IPC', async () => {
  const handlers = new Map();
  const sent = [];
  const ipcRenderer = {
    on() {},
    sendSync: () => ({ enabled: false }),
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const window = {
    addEventListener: (name, handler) => handlers.set(name, handler),
  };
  const context = vm.createContext({
    require: (name) =>
      name === 'electron' ? { ipcRenderer, webFrame: {} } : requireBridge(name),
    __dirname: new URL('../src/preload/', import.meta.url).pathname,
    window,
    location: {
      protocol: 'https:',
      hostname: 'chatgpt.com',
      href: 'https://chatgpt.com/',
    },
    console,
  });
  vm.runInContext(
    readFileSync(new URL('../src/preload/bridge.cjs', import.meta.url), 'utf8'),
    context,
  );
  const reference = official.rows.find(
    (row) => row.encoding === 'o200k_base' && row.case === 'emoji-combinado',
  );
  const text = reference.text;
  await handlers.get('message')({
    source: window,
    data: {
      __nexo: 'event',
      type: 'outgoing',
      payload: {
        host: 'chatgpt.com',
        model: 'gpt-5',
        tokenText: text,
        tokens: 0,
      },
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'nexo:event');
  assert.equal(sent[0].payload.payload.tokens, reference.official);
  assert.ok(!('tokenText' in sent[0].payload.payload));
});

test('una página no puede elegir canales privilegiados a través del bridge', async () => {
  const handlers = new Map();
  const invoked = [];
  const replies = [];
  const ipcRenderer = { on() {}, send() {}, sendSync: () => ({ enabled: false, settings: { memory: { enabled: false } } }),
    invoke: async (channel, payload) => { invoked.push({ channel, payload }); return { ok: true }; } };
  const window = { addEventListener: (name, handler) => handlers.set(name, handler), postMessage: (reply) => replies.push(reply) };
  vm.runInNewContext(readFileSync(new URL('../src/preload/bridge.cjs', import.meta.url), 'utf8'), {
    require: (name) => name === 'electron' ? { ipcRenderer, webFrame: {} } : requireBridge(name),
    __dirname: new URL('../src/preload/', import.meta.url).pathname,
    window, location: { protocol: 'https:', hostname: 'chatgpt.com', href: 'https://chatgpt.com/' }, console,
  });
  const receive = handlers.get('message');
  for (const type of ['memory:clear', 'memory:list', 'settings:set', 'data:clear', 'open-external', '__proto__', null, {}]) {
    await receive({ source: window, data: { __nexo: 'call', id: 'blocked', type } });
    assert.equal(invoked.length, 0);
    assert.equal(replies.at(-1).error, 'canal-no-permitido');
  }
  await receive({ source: {}, data: { __nexo: 'call', type: 'prepare' } });
  assert.equal(invoked.length, 0, 'no acepta mensajes de otro frame');
  await receive({ source: window, data: { __nexo: 'call', id: 'allowed', type: 'prepare', payload: { text: 'hola' } } });
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].channel, 'nexo:prepare');
  assert.equal(replies.at(-1).payload.ok, true);
});

test('bridge arranca UUE antes de EVO aun apagada, restringe subframes y no expone su IPC a la web', async () => {
  for (const mainFrame of [true, false]) {
    const starts = [], handlers = new Map(), ipcHandlers = new Map(), invoked = [];
    const ipcRenderer = { on: (n, f) => ipcHandlers.set(n, f), send() {}, sendSync: () => ({ enabled: false, settings: { enabled: false, memory: { enabled: false } } }), invoke: async c => { invoked.push(c); return { ok: true }; } };
    const window = { addEventListener: (n, f) => handlers.set(n, f), postMessage() {} };
    const mocks = {
      '../../build/understanding-reader.cjs': { startUnderstandingReader() { starts.push('uue'); return { read() { starts.push('uue-read'); } }; } },
      '../../build/chatgpt-reader.cjs': { startChatGptReader({config}) { starts.push(config.understandingReaderActive ? 'evo-dedicated' : 'evo-shared'); return { read() {}, updateSettings() {} }; } },
    };
    vm.runInNewContext(readFileSync(new URL('../src/preload/bridge.cjs', import.meta.url), 'utf8'), {
      require: n => n === 'electron' ? {ipcRenderer, webFrame: { executeJavaScript: async () => {} }} : mocks[n] || requireBridge(n),
      __dirname: new URL('../src/preload/', import.meta.url).pathname,
      document: {}, process: {isMainFrame: mainFrame}, window, location: {protocol:'https:',hostname:'chatgpt.com',href:'https://chatgpt.com/c/test'}, console,
    });
    assert.deepEqual(starts, mainFrame ? ['uue','evo-dedicated'] : []);
    ipcHandlers.get('nexo:understanding-read')();
    if(mainFrame)assert.equal(starts.at(-1),'uue-read');
    for(const type of ['nexo:understanding:conversation','understanding:conversation'])await handlers.get('message')({source:window,data:{__nexo:'call',id:'blocked',type}});
    await handlers.get('message')({source:window,data:{__nexo:'event',type:'understanding-conversation',payload:{turns:[]}}});
    assert.deepEqual(invoked,[]);
  }
});

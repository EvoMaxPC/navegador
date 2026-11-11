import test from 'node:test';
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { countGptTokens } from '../src/core/gptTokens.cjs';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((r) => setTimeout(r, 50));
const require = createRequire(import.meta.url);
const { outgoingMetadata } = require('../src/preload/token-metadata.cjs');
const stats = () =>
  journal.ipcHandlers.get('nexo:stats')({ sender: { id: 1 } });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
function request(view, text, submissionId, model = 'gpt-5') {
  const body = JSON.stringify({
    action: 'next',
    model,
    messages: [
      {
        id: submissionId,
        author: { role: 'user' },
        content: { parts: [text] },
      },
    ],
  });
  const bytes = Buffer.from(body);
  const original = Buffer.from(bytes);
  let callback;
  journal.webRequest.before
    .get('persist:nexo')
    .listener(
      {
        id: `exact-net-${++seq}`,
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        resourceType: 'xhr',
        webContentsId: view.id,
        uploadData: [{ bytes }],
      },
      (r) => (callback = r),
    );
  assert.deepEqual(bytes, original, 'no modifica un byte de la petición');
  assert.deepEqual(callback, {});
  return body;
}
function page(view, text, submissionId, id) {
  const payload = outgoingMetadata({
    messageId: id,
    submissionId,
    source: 'request',
    host: 'chatgpt.com',
    site: 'chatgpt',
    model: 'gpt-5',
    chars: text.length,
    tokenText: text,
    textFound: true,
  });
  journal.ipcListeners.get('nexo:event')(
    { sender: view },
    { type: 'outgoing', payload },
  );
}
for (const [name, text] of [
  ['bordes', '  Hola  '],
  ['tabs', '\tuno\tdos\t'],
  ['CRLF', 'uno\r\ndos\r\n'],
  ['NFD', 'cafe\u0301'],
  ['emojis', '👩🏽‍💻 👨‍👩‍👧‍👦 🇦🇷'],
  ['invisibles', 'a\u200bb\ufeff'],
]) {
  test(`red, preload y CDP conservan original y generan un registro: ${name}`, async () => {
    const view = journal.windows[0].attachWebview(
      `https://chatgpt.com/c/exact-${name}`,
    );
    await pause(50);
    const logBefore = (
      await journal.ipcHandlers.get('nexo:log')({ sender: { id: 1 } })
    ).filter((l) => l.kind === 'sending').length;
    const before = stats();
    const sid = `user-${name}`;
    const body = request(view, text, sid);
    page(view, text, sid, `page-${name}`);
    view.debugger.emitEvent('Network.requestWillBeSent', {
      requestId: `cdp-exact-${name}`,
      type: 'XHR',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: body,
      },
    });
    await pause(40);
    const after = stats();
    assert.equal(after.messages, before.messages + 1);
    assert.equal(
      after.inputTokens,
      before.inputTokens + countGptTokens(text, 'gpt-5'),
    );
    const logs = await journal.ipcHandlers.get('nexo:log')({
      sender: { id: 1 },
    });
    assert.equal(
      logs.filter((l) => l.kind === 'sending').length,
      logBefore + 1,
      'un único registro visible entre los tres observadores',
    );
    const sends = logs.filter(
      (l) =>
        l.kind === 'sending' &&
        l.meta?.chars === text.length &&
        l.meta?.source === 'network',
    );
    const last = sends[0];
    assert.ok(last);
    assert.equal(last.meta.tokens, countGptTokens(text, 'gpt-5'));
    assert.equal(last.meta.tokenEncoding, 'o200k_base');
    assert.equal(last.meta.chars, text.length);
  });
}
test('dos envíos iguales cruzando red, preload y CDP cuentan ambos una sola vez', async () => {
  const view = journal.windows[0].attachWebview(
    'https://chatgpt.com/c/exact-repeat',
  );
  await pause(50);
  const before = stats(),
    text = '  Repetido 😀  ';
  const first = request(view, text, 'repeat-a');
  page(view, text, 'repeat-b', 'page-b');
  request(view, text, 'repeat-b');
  page(view, text, 'repeat-a', 'page-a');
  for (const [id, body] of [
    ['repeat-a', first],
    [
      'repeat-b',
      JSON.stringify({
        action: 'next',
        model: 'gpt-5',
        messages: [
          {
            id: 'repeat-b',
            author: { role: 'user' },
            content: { parts: [text] },
          },
        ],
      }),
    ],
  ]) {
    view.debugger.emitEvent('Network.requestWillBeSent', {
      requestId: id,
      type: 'XHR',
      request: {
        url: 'https://chatgpt.com/backend-api/f/conversation',
        method: 'POST',
        postData: body,
      },
    });
  }
  await pause(50);
  assert.equal(stats().messages, before.messages + 2);
  assert.equal(
    stats().inputTokens,
    before.inputTokens + 2 * countGptTokens(text, 'gpt-5'),
  );
});

test('bundle de captura conserva el string de fetch y el del compositor sin trim/normalización', async () => {
  const listeners = new Map(),
    windowListeners = [],
    events = [],
    wire = [],
    text = '  cafe\u0301 👩🏽‍💻\t\r\n  ';
  const editor = { tagName: 'TEXTAREA', value: text };
  const document = {
    querySelector: () => editor,
    querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const window = {
    __NEXO_CONFIG__: {
      host: 'chatgpt.com',
      enabled: true,
      settings: { enabled: false },
    },
    addEventListener: (name, fn) => {
      if (name === 'message') windowListeners.push(fn);
    },
    postMessage: (m) => {
      events.push(m);
      if (m.__nexo === 'call')
        queueMicrotask(() =>
          windowListeners.forEach((fn) =>
            fn({
              source: window,
              data: { __nexo: 'reply', id: m.id, payload: { text } },
            }),
          ),
        );
    },
    fetch: async (input, init) => {
      wire.push(init.body);
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    },
  };
  const location = {
    href: 'https://chatgpt.com/c/byte-exact',
    hostname: 'chatgpt.com',
    protocol: 'https:',
    pathname: '/c/byte-exact',
  };
  vm.runInNewContext(
    readFileSync(new URL('../build/inject.js', import.meta.url), 'utf8'),
    {
      window,
      document,
      location,
      console,
      setTimeout,
      clearTimeout,
      Response,
      Request,
      Headers,
      URL,
      URLSearchParams,
      FormData,
      TextEncoder,
      TextDecoder,
      ReadableStream,
      TransformStream,
    },
  );
  // El main simulado confirma el mismo texto, sin modificar la petición.
  const body = JSON.stringify({
    action: 'next',
    model: 'gpt-5',
    messages: [
      { id: 'literal-1', author: { role: 'user' }, content: { parts: [text] } },
    ],
  });
  await window.fetch('/backend-api/f/conversation', { method: 'POST', body });
  assert.equal(wire[0], body);
  assert.equal(
    events.find((m) => m.type === 'outgoing')?.payload.tokenText,
    text,
  );
  events.length = 0;
  listeners.get('submit')();
  await pause(2700);
  assert.equal(
    events.find((m) => m.type === 'outgoing')?.payload.tokenText,
    text,
  );
  assert.equal(editor.value, text);
});

test('CDP solo cuenta espacios y CRLF originales, sin depender del conteo de red', async () => {
  const view = journal.windows[0].attachWebview(
    'https://chatgpt.com/c/exact-cdp-only',
  );
  await pause(50);
  const before = stats(),
    text = '  Hola, mundo.  ';
  const body = JSON.stringify({
    action: 'next',
    model: 'gpt-5',
    messages: [
      { id: 'cdp-only', author: { role: 'user' }, content: { parts: [text] } },
    ],
  });
  view.debugger.emitEvent('Network.requestWillBeSent', {
    requestId: 'cdp-only',
    type: 'XHR',
    request: {
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      postData: body,
    },
  });
  await pause(40);
  assert.equal(stats().messages, before.messages + 1);
  assert.equal(
    stats().inputTokens,
    before.inputTokens + 6,
    'referencia oficial o200k_base: 6',
  );
});

test('uploadData partido en medio de un emoji UTF-8 se decodifica una sola vez', () => {
  const view = journal.windows[0].attachWebview(
      'https://chatgpt.com/c/split-utf8',
    ),
    text = 'Hola 😀🚀';
  const bytes = Buffer.from(
    JSON.stringify({
      action: 'next',
      model: 'gpt-5',
      messages: [
        {
          id: 'split-utf8',
          author: { role: 'user' },
          content: { parts: [text] },
        },
      ],
    }),
  );
  const split = bytes.indexOf(Buffer.from('😀')) + 2,
    before = stats();
  journal.webRequest.before
    .get('persist:nexo')
    .listener(
      {
        id: 'split-utf8-net',
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        resourceType: 'xhr',
        webContentsId: view.id,
        uploadData: [
          { bytes: bytes.subarray(0, split) },
          { bytes: bytes.subarray(split) },
        ],
      },
      () => {},
    );
  assert.equal(
    stats().inputTokens,
    before.inputTokens + countGptTokens(text, 'gpt-5'),
  );
});

for (const route of ['network', 'cdp']) {
  test(`${route}: auto no oculta metadata.model_slug GPT-5 ni modifica la solicitud`, async () => {
    const view=journal.windows[0].attachWebview(`https://chatgpt.com/c/auto-metadata-${route}`);
    await pause(50);
    const text='  Hola, mundo.  ',before=stats();
    const body=JSON.stringify({action:'next',model:'auto',metadata:{model_slug:'gpt-5'},messages:[{id:`auto-${route}`,author:{role:'user'},content:{parts:[text]}}]});
    if(route==='network'){
      const bytes=Buffer.from(body),original=Buffer.from(bytes);
      journal.webRequest.before.get('persist:nexo').listener({id:'auto-net',method:'POST',url:'https://chatgpt.com/backend-api/f/conversation',resourceType:'xhr',webContentsId:view.id,uploadData:[{bytes}]},()=>{});
      assert.deepEqual(bytes,original);
    }else{
      view.debugger.emitEvent('Network.requestWillBeSent',{requestId:'auto-cdp',type:'XHR',request:{url:'https://chatgpt.com/backend-api/f/conversation',method:'POST',postData:body}});
      await pause(40);
    }
    assert.equal(stats().messages,before.messages+1);
    assert.equal(stats().inputTokens,before.inputTokens+6,'referencia oficial o200k_base sobre el texto con bordes');
    assert.equal(stats().unknownInputMessages,before.unknownInputMessages);
  });
}

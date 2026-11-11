import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { outgoingMetadata } = require('../src/preload/token-metadata.cjs');
const official = JSON.parse(
  readFileSync(
    new URL('../docs/BPE-OFICIAL-COMPARACION.json', import.meta.url),
    'utf8',
  ),
);
const reference = official.rows.find(
  (row) => row.encoding === 'o200k_base' && row.case === 'bordes',
);
function capturePage() {
  const events = [],
    listeners = new Map(),
    windowListeners = [],
    wire = [];
  const editor = { tagName: 'TEXTAREA', value: reference.text };
  const document = {
    querySelector: () => editor,
    querySelectorAll: () => [],
    addEventListener: (n, f) => listeners.set(n, f),
  };
  const window = {
    __NEXO_CONFIG__: { host: 'chatgpt.com', enabled: true, settings: {} },
    addEventListener: (name, fn) => {
      if (name === 'message') windowListeners.push(fn);
    },
    postMessage(message) {
      events.push(message);
      if (message.__nexo === 'call')
        queueMicrotask(() =>
          windowListeners.forEach((fn) =>
            fn({
              source: window,
              data: {
                __nexo: 'reply',
                id: message.id,
                payload: { text: message.payload?.prompt },
              },
            }),
          ),
        );
    },
    fetch: async (input, init) => {
      wire.push({ input, init });
      return new Response(null, { status: 204 });
    },
  };
  const location = {
    href: 'https://chatgpt.com/c/input-route',
    hostname: 'chatgpt.com',
    protocol: 'https:',
    pathname: '/c/input-route',
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
  return {
    window,
    events,
    listeners,
    wire,
    editor,
    outgoing: () => events.filter((e) => e.type === 'outgoing'),
  };
}
function assertExact(raw, text = reference.text) {
  assert.equal(
    raw.tokens,
    null,
    'la página NO genera estimación de entrada GPT',
  );
  assert.equal(raw.tokenText, text);
  assert.equal(raw.model, 'gpt-5');
  const metadata = outgoingMetadata(raw);
  assert.equal(metadata.tokens, reference.official);
  assert.equal(metadata.tokenEncoding, 'o200k_base');
  assert.equal(metadata.tokenExact, true);
}
test('JSON: model auto con metadata gpt-5 llega al preload con el modelo concreto y texto original', async () => {
  const p = capturePage();
  const body = JSON.stringify({
    action: 'next',
    model: 'auto',
    metadata: { model_slug: 'gpt-5' },
    messages: [
      {
        id: 'm1',
        author: { role: 'user' },
        content: { parts: [reference.text] },
      },
    ],
  });
  await p.window.fetch('/backend-api/f/conversation', { method: 'POST', body });
  assertExact(p.outgoing()[0].payload);
  assert.equal(p.wire[0].init.body, body);
});
for (const format of [
  'URLSearchParams',
  'FormData',
  'urlencoded-string',
  'Request',
]) {
  test(`DPU ${format}: modelo explícito en metadata usa BPE oficial; cuerpo intacto`, async () => {
    const p = capturePage();
    const params = {
      prompt: reference.text,
      model: 'auto',
      metadata: JSON.stringify({ model_slug: 'gpt-5' }),
    };
    let body = format === 'FormData' ? new FormData() : new URLSearchParams();
    for (const [key, value] of Object.entries(params)) body.append(key, value);
    if (format === 'urlencoded-string' || format === 'Request')
      body = body.toString();
    if (format === 'Request') {
      const request = new Request(
        'https://chatgpt.com/unauth-mweb/conversation/updates',
        { method: 'POST', body },
      );
      await p.window.fetch(request);
      assert.equal(await p.wire[0].input.clone().text(), body);
    } else {
      await p.window.fetch('/unauth-mweb/conversation/updates', {
        method: 'POST',
        body,
      });
      assert.equal(p.wire[0].init.body, body);
    }
    assertExact(p.outgoing()[0].payload);
  });
}
test('DPU sin modelo no inventa un tokenizer: queda desconocido sin aproximar', async () => {
  const p = capturePage(),
    body = new URLSearchParams({ prompt: reference.text });
  await p.window.fetch('/unauth-mweb/conversation/updates', {
    method: 'POST',
    body,
  });
  const raw = p.outgoing()[0].payload;
  assert.equal(raw.tokens, null);
  assert.equal(raw.tokenText, reference.text);
  assert.equal(raw.model, '');
  const result = outgoingMetadata(raw);
  assert.equal(result.tokens, null);
  assert.equal(result.tokenExact, false);
  assert.equal(result.tokenMethod, 'unknown-model');
  assert.equal(result.tokenModel, null);
});
test('DPU con texto vacío conocido devuelve 0; prompt ausente no se presenta como vacío conocido', async () => {
  for (const [present, expected] of [
    [true, 0],
    [false, null],
  ]) {
    const p = capturePage(),
      body = new URLSearchParams({ model: 'gpt-5' });
    if (present) body.set('prompt', '');
    await p.window.fetch('/unauth-mweb/conversation/updates', {
      method: 'POST',
      body,
    });
    const raw = p.outgoing()[0].payload;
    assert.equal(raw.tokenText, '');
    assert.equal(raw.tokens, null);
    const result = outgoingMetadata(raw);
    assert.equal(result.tokens, expected);
    assert.equal(result.tokenExact, present);
  }
});
test('compositor alternativo sin solicitud no estima; solicitud tardía aporta el modelo y BPE oficial', async () => {
  const p = capturePage();
  p.listeners.get('submit')();
  await new Promise((r) => setTimeout(r, 2700));
  const gesture = p.outgoing()[0].payload;
  assert.equal(gesture.tokens, null);
  assert.equal(gesture.tokenText, reference.text);
  assert.equal(outgoingMetadata(gesture).tokens, null);
  const body = JSON.stringify({
    action: 'next',
    model: 'auto',
    metadata: { model_slug: 'gpt-5' },
    messages: [
      {
        id: 'late-1',
        author: { role: 'user' },
        content: { parts: [reference.text] },
      },
    ],
  });
  await p.window.fetch('/backend-api/f/conversation', { method: 'POST', body });
  const request = p.outgoing().at(-1).payload;
  assert.equal(
    request.messageId,
    gesture.messageId,
    'el conteo se completa sobre el mismo envío',
  );
  assertExact(request);
  assert.equal(p.editor.value, reference.text);
});

// Regresiones de correlación: bundle real, sin acceder a sus funciones internas.
async function sendText(p, text, id) {
  const body = JSON.stringify({action:'next',model:'gpt-5',messages:[{id,author:{role:'user'},content:{parts:[text]}}]});
  await p.window.fetch('/backend-api/f/conversation',{method:'POST',body});
  assert.equal(p.wire.at(-1).init.body,body,'la correlación no modifica el cuerpo');
  return p.outgoing().at(-1).payload;
}
const gestureCounted = () => new Promise(resolve=>setTimeout(resolve,2700));

test('regresión correlación: dos gestos y peticiones de igual longitud mantienen dos IDs propios',async()=>{
  const p=capturePage();
  p.editor.value='hola';p.listeners.get('submit')();await gestureCounted();
  const first=p.outgoing()[0].payload;
  p.editor.value='chau';p.listeners.get('submit')();
  const second=await sendText(p,'chau','user-chau');
  assert.notEqual(second.messageId,first.messageId,'chau no hereda el ID de hola por medir cuatro caracteres');
  const lateFirst=await sendText(p,'hola','user-hola');
  assert.equal(lateFirst.messageId,first.messageId,'la petición tardía de hola recupera SU gesto');
  assert.equal(new Set(p.outgoing().map(e=>e.payload.messageId)).size,2);
});

test('regresión correlación: una petición distinta no consume el gesto pendiente de igual longitud',async()=>{
  const p=capturePage();
  p.editor.value='hola';p.listeners.get('submit')();
  const unrelated=await sendText(p,'chau','unrelated-chau');
  await gestureCounted();
  const gestures=p.outgoing().filter(e=>e.payload.source==='composer');
  assert.equal(gestures.length,1,'el timer de hola sigue vivo tras la petición ajena');
  const first=gestures[0].payload;
  assert.equal(first.tokenText,'hola');assert.notEqual(first.messageId,unrelated.messageId);
  const matched=await sendText(p,'hola','pending-hola');
  assert.equal(matched.messageId,first.messageId);
});

test('regresión correlación: dos gestos distintos dentro de 800 ms no se descartan como doble clic',async()=>{
  const p=capturePage();
  p.editor.value='hola';p.listeners.get('submit')();
  p.editor.value='chau';p.listeners.get('submit')();
  const early=p.outgoing().filter(e=>e.payload.source==='composer');
  assert.equal(early.length,1,'se conserva el primer gesto al registrar otro texto');
  assert.equal(early[0].payload.tokenText,'hola');
  const first=await sendText(p,'hola','rapid-hola');
  const second=await sendText(p,'chau','rapid-chau');
  assert.equal(first.messageId,early[0].payload.messageId);
  assert.notEqual(first.messageId,second.messageId);
  assert.equal(new Set(p.outgoing().map(e=>e.payload.messageId)).size,2);
});

test('regresión correlación: mismo hash normalizado no sustituye igualdad del texto exacto',async()=>{
  const p=capturePage();
  p.editor.value='Hola';p.listeners.get('submit')();await gestureCounted();
  const first=p.outgoing()[0].payload;
  const other=await sendText(p,'hola','case-sensitive');
  assert.equal(other.promptHash,first.promptHash,'la huella existente normaliza mayúsculas');
  assert.notEqual(other.messageId,first.messageId,'el texto literal es diferente pese a la misma huella y longitud');
  assert.equal((await sendText(p,'Hola','original-case')).messageId,first.messageId);
});

test('regresión correlación: cuerpo ilegible no se identifica por cero caracteres',async()=>{
  const p=capturePage();
  p.editor.value='hola';p.listeners.get('submit')();await gestureCounted();
  const first=p.outgoing()[0].payload;
  await p.window.fetch('/backend-api/f/conversation',{method:'POST',body:'no-es-json'});
  const opaque=p.outgoing().at(-1).payload;
  assert.notEqual(opaque.messageId,first.messageId,'sin texto o identidad no hay prueba de correspondencia');
  assert.equal((await sendText(p,'hola','after-opaque')).messageId,first.messageId);
});

test('regresión correlación: DPU sin prompt no valida identidad con texto copiado del mismo gesto',async()=>{
  const p=capturePage();
  p.editor.value='hola';p.listeners.get('submit')();await gestureCounted();
  const first=p.outgoing()[0].payload;
  const body=new URLSearchParams({model:'gpt-5'});
  await p.window.fetch('/unauth-mweb/conversation/updates',{method:'POST',body});
  assert.equal(p.wire.at(-1).init.body,body);
  assert.notEqual(p.outgoing().at(-1).payload.messageId,first.messageId,'el fallback del gesto no es evidencia independiente');
  assert.equal((await sendText(p,'hola','after-dpu')).messageId,first.messageId);
});

test('regresión correlación: un enlace consume el gesto una vez; otra petición lleva otro ID',async()=>{
  const p=capturePage();
  p.editor.value='hola';p.listeners.get('submit')();await gestureCounted();
  const first=p.outgoing()[0].payload;
  assert.equal((await sendText(p,'hola','same-text-1')).messageId,first.messageId);
  assert.notEqual((await sendText(p,'hola','same-text-2')).messageId,first.messageId);
});


test('DPU con variante de modelo no catalogada no se aproxima con otra familia', () => {
  const raw = {
    host: 'chatgpt.com',
    model: 'gpt-6-preview',
    tokenText: reference.text,
  };
  const result = outgoingMetadata(raw);
  assert.equal(result.tokens, null);
  assert.equal(result.tokenEncoding, null);
  assert.equal(result.tokenExact, false);
  assert.equal(result.tokenMethod, 'unknown-model');
  assert.equal(result.tokenModel, null);
});

/**
 * Prueba opt-in contra Chromium REAL y SSE local, no contra ChatGPT/Electron.
 * Dependencias sólo de desarrollo, instaladas fuera del repo (ver docs).
 * NODE_PATH=/ruta/node_modules node dev/probe-streaming.cjs
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createGzip, constants } = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
const { chromium: playwright } = require('playwright-core');

const expectedText = 'INICIO: ¡Hola! 😊 Repetición legítima: sí, sí. Ñandú, camión. FIN.';
const expectedBody = Buffer.from('data: ' + JSON.stringify({ message: {
  id: 'local-stream', author: { role: 'assistant' },
  content: { content_type: 'text', parts: [expectedText] }, status: 'finished_successfully',
} }) + '\n\ndata: [DONE]\n\n');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function runCase(browser, CdpObserver, compressed, iteration) {
  let resumeTail, activate;
  const tailReady = new Promise((done) => { resumeTail = done; });
  const initialEvents = new Promise((done) => { activate = done; });
  let serverError;
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.end('<!doctype html><title>Local CDP probe</title>'); return; }
    if (request.url !== '/backend-api/f/conversation') { response.writeHead(404).end(); return; }
    (async () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) });
      const output = compressed ? createGzip({ flush: constants.Z_SYNC_FLUSH }) : response;
      if (compressed) output.pipe(response);
      // La escritura se parte dentro de un emoji; Chromium decide los cortes de sus eventos.
      const cut = expectedBody.indexOf(Buffer.from('😊')) + 1;
      output.write(expectedBody.subarray(0, 57));
      await pause(40);
      output.write(expectedBody.subarray(57, cut));
      await tailReady;
      output.write(expectedBody.subarray(cut, cut + 2));
      await pause(20);
      output.end(expectedBody.subarray(cut + 2));
    })().catch((error) => { serverError = error; response.destroy(error); });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const page = await browser.newPage();
  let observer;
  let watchdog;
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const session = await page.context().newCDPSession(page);
    const api = new EventEmitter();
    const chunks = [], commands = [], errors = [];
    let head = Buffer.alloc(0), preDataEvents = 0, encodedLength = 0;
    let targetId, activationDelivered = false, earlyDataEvents = 0;
    api.attach = () => {};
    api.isAttached = () => true;
    api.detach = () => {};
    api.sendCommand = async (method, params) => {
      commands.push(method);
      if (method === 'Network.getResponseBody') throw Error('Fallback deshabilitado para esta prueba local');
      if (method !== 'Network.streamResourceContent') return session.send(method, params);
      // Esperar dos eventos reales sin data fuerza un bufferedData no vacío.
      await initialEvents;
      const response = session.send(method, params);
      resumeTail(); // Hay tráfico también mientras Chromium procesa el comando.
      const result = await response;
      head = Buffer.from(result.bufferedData, 'base64');
      // Simula latencia del puente/promesa, sin fabricar eventos ni bytes.
      await pause(60);
      activationDelivered = true;
      return result;
    };
    for (const name of ['requestWillBeSent', 'responseReceived', 'dataReceived', 'loadingFinished', 'loadingFailed']) {
      session.on('Network.' + name, (params) => {
        if (name === 'requestWillBeSent' && params.request?.url.endsWith('/backend-api/f/conversation')) targetId = params.requestId;
        if (!targetId || params.requestId !== targetId) return;
        if (name === 'dataReceived') {
          if (typeof params.data === 'string' && params.data) {
            chunks.push(Buffer.from(params.data, 'base64'));
            if (!activationDelivered) earlyDataEvents++;
          }
          else { preDataEvents++; if (preDataEvents >= 2) activate(); }
        }
        if (name === 'loadingFinished') encodedLength = params.encodedDataLength;
        // Adaptación EXPLÍCITA: sólo hostname para clasificar el sitio local.
        // IDs, bytes, eventos y respuestas de comandos siguen siendo Chromium real.
        const alias = (url) => url.replace(/http:\/\/127\.0\.0\.1:\d+/, 'https://chatgpt.com');
        if (params.request) params = { ...params, request: { ...params.request, url: alias(params.request.url) } };
        if (params.response) params = { ...params, response: { ...params.response, url: alias(params.response.url) } };
        api.emit('message', {}, 'Network.' + name, params);
      });
    }
    let deliver;
    const captureReady = new Promise((done) => { deliver = done; });
    const captures = [];
    observer = new CdpObserver({ engine: { onCdpCapture(_id, capture) { captures.push(capture); deliver(capture); } },
      log: (error) => errors.push(error) });
    observer.attach({ id: 1, debugger: api, getURL: () => 'https://chatgpt.com/c/local-probe' });
    await session.send('Network.enable');
    const failure = new Promise((_, reject) => {
      watchdog = setTimeout(() => { activate(); resumeTail(); reject(Error('Timeout de la prueba: ' + errors.join('; '))); }, 5000);
    });
    const run = (async () => {
      await page.evaluate(async () => {
        const response = await fetch('/backend-api/f/conversation', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' }, content: { parts: ['prueba sintética local'] } }] }) });
        await response.text();
      });
      const capture = await captureReady;
      const raw = Buffer.concat([head, ...chunks]);
      assert.ok(head.length > 0, 'bufferedData debe ser no vacío');
      assert.ok(chunks.length > 0, 'debe haber datos después de activar');
      assert.ok(earlyDataEvents > 0, 'datos reales llegan antes de resolver la promesa hacia el observador');
      // Comparación byte a byte ANTES del parser, que podría ocultar repetición de snapshots.
      assert.deepEqual(raw, expectedBody, 'bufferedData + dataReceived = cuerpo íntegro sin solapamiento ni huecos');
      assert.equal(capture.text, expectedText, 'texto exacto entregado por el observador de producción');
      assert.equal(captures.length, 1);
      assert.equal(commands.filter((method) => method === 'Network.getResponseBody').length, 0);
      assert.deepEqual(errors, []);
      if (serverError) throw serverError;
      return { iteration, encoding: compressed ? 'gzip' : 'identity', preDataEvents, earlyDataEvents, headBytes: head.length,
        streamedBytes: raw.length - head.length, expectedBytes: expectedBody.length,
        encodedLength, rawExact: true, textExact: true, captures: captures.length };
    })();
    return await Promise.race([run, failure]);
  } finally {
    clearTimeout(watchdog);
    activate(); resumeTail();
    observer?.releaseAll();
    await page.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

(async () => {
  const { CdpObserver } = await import(pathToFileURL(resolve(__dirname, '../src/main/cdp.js')).href);
  const packaged = process.env.CHROMIUM_EXECUTABLE ? null : require('@sparticuz/chromium');
  const executablePath = process.env.CHROMIUM_EXECUTABLE || await (packaged.default || packaged).executablePath();
  const browser = await playwright.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const cases = [];
    for (let iteration = 1; iteration <= 5; iteration++) {
      cases.push(await runCase(browser, CdpObserver, false, iteration));
      cases.push(await runCase(browser, CdpObserver, true, iteration));
    }
    console.log(JSON.stringify({ browser: browser.version(), scope: 'Chromium + HTTP local sintético; no ChatGPT ni Electron', cases }, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

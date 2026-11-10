import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameQueue } from '../src/ui/shell/scheduler.js';
import { safeFaviconUrl, navigationStatus } from '../src/ui/shell/security.js';
import { isPublicAssetPath } from '../src/main/internalAssets.js';

test('mil actualizaciones en una ráfaga producen una tarea por clave y cuadro', () => {
  const frames = []; const rendered = [];
  const queue = createFrameQueue((run) => frames.push(run));
  for (let i = 0; i < 1000; i++) queue.schedule('stats', () => rendered.push(i));
  queue.schedule('memory', () => rendered.push('memory'));
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(rendered, [999, 'memory']);
  queue.schedule('stats', () => rendered.push('next'));
  assert.equal(frames.length, 1);
  frames.shift()(); assert.equal(rendered.at(-1), 'next');
});

test('el trabajo encolado durante un cuadro queda para el siguiente', () => {
  const frames = []; const queue = createFrameQueue((run) => frames.push(run));
  let calls = 0;
  queue.schedule('first', () => queue.schedule('next', () => calls++));
  frames.shift()(); assert.equal(calls, 0);
  frames.shift()(); assert.equal(calls, 1);
});

test('favicons: sólo red sin credenciales o imágenes raster acotadas', () => {
  for (const url of ['javascript:alert(1)', 'file:///secret', 'data:image/svg+xml,<svg/>', 'https://u:p@host/icon', 'x'.repeat(32769), null, '<img onerror=alert(1)>']) assert.equal(safeFaviconUrl(url), null);
  assert.equal(safeFaviconUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(safeFaviconUrl('data:image/png;base64,aGVsbG8='), 'data:image/png;base64,aGVsbG8=');
});

test('HTTPS comunica cifrado, no promete fiabilidad de la página', () => {
  assert.match(navigationStatus('https://example.com').label, /no garantiza/);
  assert.equal(navigationStatus('http://example.com').kind, 'unencrypted');
  assert.equal(navigationStatus('nexo://app/src/ui/start/index.html').kind, 'local');
  assert.equal(navigationStatus('file:///tmp/secret').kind, 'unknown');
});

test('el protocolo público excluye código privilegiado, repositorio, perfil y dotfiles', () => {
  for (const path of ['.git/config', 'package.json', 'src/main/main.js', 'src/preload/shell.cjs', 'src/ui/.secret.js', 'src/ui/../main/main.js', 'src/ui/a/../../.git/config', 'src/memory/private.json', 'src/ui/file.html.bak', 'src/ui//file.js']) assert.equal(isPublicAssetPath(path), false, path);
  for (const path of ['src/ui/shell/index.html', 'src/ui/start/start.js', 'src/nav/url.js', 'src/core/index.js', 'src/memory/engine.js', 'demo/app.js']) assert.equal(isPublicAssetPath(path), true, path);
});

test('la shell consume la ráfaga IPC sin consultar stats de nuevo ni renderizar cada fragmento', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const source = readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');
  const frames = []; let requests = 0; let listener; let writes = 0;
  const keys = ['messages', 'responses', 'turnsCancelled', 'turnsFailed', 'turnsPerformed', 'inTokens', 'outTokens', 'interventions', 'capture'];
  const elements = Object.fromEntries(keys.map((key) => [key, { get textContent() { return this.value; }, set textContent(value) { writes++; this.value = value; } }]));
  const context = vm.createContext({ els: { stats: elements }, uiTasks: createFrameQueue((run) => frames.push(run)), nexo: {
    getStats: async () => { requests++; return { messages: 1 }; }, on: (_name, fn) => { listener = fn; },
  } });
  vm.runInContext(source.slice(source.indexOf('function num(value)'), source.indexOf('const MEM =')), context);
  vm.runInContext(source.match(/nexo\.on\?\.\('nexo:stats-changed',[\s\S]*?\n\}\);/)[0], context);
  for (let i = 0; i < 1000; i++) listener({ messages: i, outputTokens: i });
  assert.equal(requests, 0); assert.equal(writes, 0); assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(elements.messages.textContent, '999');
  assert.equal(elements.outTokens.textContent, '999');
  assert.equal(writes, keys.length);
});

test('una consulta IPC antigua no pisa estadísticas push más nuevas; las consultas concurrentes se comparten', async () => {
  const { readFileSync } = await import('node:fs'); const vm = await import('node:vm');
  const source = readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');
  const keys = ['messages', 'responses', 'turnsCancelled', 'turnsFailed', 'turnsPerformed', 'inTokens', 'outTokens', 'interventions', 'capture'];
  const elements = Object.fromEntries(keys.map((key) => [key, {}]));
  let resolve; let requests = 0;
  const context = vm.createContext({ els: { stats: elements }, nexo: { getStats: () => { requests++; return new Promise((done) => { resolve = done; }); } } });
  vm.runInContext(source.slice(source.indexOf('function num(value)'), source.indexOf('const MEM =')), context);
  const first = vm.runInContext('refreshStats()', context);
  const second = vm.runInContext('refreshStats()', context);
  assert.equal(requests, 1);
  vm.runInContext('renderStats({ messages: 20 })', context);
  resolve({ messages: 1 }); await Promise.all([first, second]);
  assert.equal(elements.messages.textContent, '20');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('capa y bundle no crean ni actualizan el espejo visual de captura', () => {
  for (const path of ['../src/inject/index.js', '../build/inject.js']) {
    const source = read(path);
    assert.doesNotMatch(source, /__nexo-gpt-capture-mirror|ESPEJO DE CAPTURA GPT|gptCaptureMirror|mirrorGptCapture|beginGptCaptureMirror/, path);
  }
  const source = read('../src/inject/index.js');
  assert.match(source, /async function captureChatGptDpuResponse\(/, 'se conserva captura DPU');
  assert.match(source, /function wrapResponse\(/, 'se conserva captura del stream');
  assert.match(source, /bridge\.event\('stream-progress'/, 'se conserva notificación interna de progreso');
});

test('se retira sólo el zoom inferior; cabecera, zoom de sitio y atajos siguen disponibles', () => {
  const html = read('../src/ui/shell/index.html');
  assert.doesNotMatch(html, /floating-zoom|Zoom de interfaz, acceso inferior/);
  assert.doesNotMatch(read('../src/ui/shell/wormhole.css'), /floating-zoom/);
  assert.equal((html.match(/data-ui-zoom-value/g) || []).length, 1);
  assert.equal((html.match(/data-ui-zoom="/g) || []).length, 3);
  assert.match(html, /class="ui-zoom header-zoom"/);
  for (const id of ['zoomOut', 'zoomIn', 'zoomReset']) assert.match(html, new RegExp(`id="${id}"`));
  const app = read('../src/ui/shell/app.js');
  for (const action of ['zoom-in', 'zoom-out', 'zoom-reset']) assert.ok(app.includes(`case '${action}':`));
});

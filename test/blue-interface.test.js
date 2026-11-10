import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPublicAssetPath } from '../src/main/internalAssets.js';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const shell = read('src/ui/shell/index.html');
const start = read('src/ui/start/index.html');
const css = read('src/ui/shell/styles.css');

test('el espacio conserva las nueve herramientas y sus paneles accesibles', () => {
  for (const panel of ['activity', 'repetition', 'memory', 'history', 'bookmarks', 'downloads', 'sites', 'settings', 'about']) {
    assert.ok(shell.includes(`id="panel-tab-${panel}"`));
    assert.ok(shell.includes(`id="panel-${panel}"`));
  }
  const active = [...shell.matchAll(/class="stab active" data-panel="([^"]+)"/g)];
  assert.equal(active.length, 1);
  assert.equal(active[0][1], 'memory');
});

test('inicio conserva los destinos anteriores, sin exponer IPC ni perfil', () => {
  for (const host of ['chatgpt.com', 'claude.ai', 'gemini.google.com', 'www.perplexity.ai', 'chat.deepseek.com', 'copilot.microsoft.com', 'chat.mistral.ai', 'localhost:11434', 'github.com', 'developer.mozilla.org', 'news.ycombinator.com', 'stackoverflow.com']) {
    assert.ok(start.includes(host), host);
  }
  assert.ok(!read('src/ui/start/start.js').includes('window.nexo'));
  assert.match(start, /id="appsList"[^>]*hidden/);
  assert.match(start, /id="moreApps"[^>]*aria-expanded="false"/);
});

test('los destinos sin configurar y las extensiones no prometen una función inexistente', () => {
  for (const name of ['EVO LABS', 'PIXELVERSE']) {
    assert.ok(start.includes(`disabled title="No hay un destino configurado para ${name}"`));
  }
  assert.match(shell, /disabled title="La gestión de extensiones no está disponible/);
  assert.match(shell, /CPU — <span>RAM —<\/span><span>GPU —/);
  assert.ok(!shell.includes('Modo Turbo'));
});

test('los recursos espaciales son locales y públicos sin ampliar la lista permitida', () => {
  for (const path of ['src/ui/assets/nexo-mark.svg', 'src/ui/assets/orbit.svg']) {
    assert.equal(isPublicAssetPath(path), true);
    assert.ok(read(path).length < 6000);
    assert.ok(!read(path).includes('<script'));
    assert.ok(!read(path).includes('<image'));
  }
});

test('azul oscuro, navegación adaptable y movimiento reducido sin animación permanente', () => {
  for (const sheet of [css, read('src/ui/start/start.css')]) {
    assert.match(sheet, /prefers-reduced-motion/);
    assert.match(sheet, /max-width:\s*\d+px/);
    assert.ok(!sheet.includes('infinite'));
    assert.ok(!sheet.includes('backdrop-filter'));
    assert.match(sheet, /#168bff/i);
  }
  assert.match(css, /color-scheme: dark/);
  assert.ok(!css.includes('color-scheme: light'));
});

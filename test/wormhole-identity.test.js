import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { browserPreferences } from '../src/nav/browserPreferences.js';
import { createWormholeChrome } from '../src/ui/shell/wormholeChrome.js';
import { generateIcons } from '../scripts/make-icon.mjs';
function node() {
  const handlers = new Map(),
    classes = new Set();
  return {
    handlers,
    dataset: {},
    attributes: {},
    value: 'auto',
    disabled: false,
    inert: false,
    addEventListener: (n, f) => handlers.set(n, f),
    setAttribute(n, v) {
      this.attributes[n] = v;
    },
    classList: {
      toggle(n, on) {
        if (on) classes.add(n);
        else classes.delete(n);
      },
      contains: (n) => classes.has(n),
    },
    focus() {
      globalThis.document.activeElement = this;
    },
    contains(n) {
      return n === this;
    },
    emit(n, e = {}) {
      return handlers.get(n)?.(e);
    },
  };
}
async function fixture(run) {
  const old = globalThis.document;
  globalThis.document = { activeElement: null };
  const browser = node(),
    leftButton = node(),
    leftMenu = node(),
    rightMenu = node(),
    modeInput = node(),
    closeButton = node(),
    saved = [],
    opens = [];
  let success = true,
    timer;
  const c = createWormholeChrome({
    browser,
    leftButton,
    leftMenu,
    rightMenu,
    modeInput,
    closeButton,
    setSidebar: (open) => opens.push(open),
    saveMode: async (m) => {
      saved.push(m);
      return success;
    },
    setTimer: (fn) => (timer = fn),
    clearTimer: () => (timer = null),
  });
  try {
    await run({
      c,
      browser,
      leftButton,
      leftMenu,
      rightMenu,
      modeInput,
      closeButton,
      saved,
      opens,
      tick: () => timer?.(),
      fail: () => (success = false),
    });
  } finally {
    c.dispose();
    globalThis.document = old;
  }
}
test('PNG oficial conserva exactamente el recurso adjunto, sin sustituir identidad', () => {
  const bytes = readFileSync(
    new URL('../src/ui/assets/identity/NEXO-Wormhole.png', import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '8290387c631e1d7a9f054f2ee3c7a82759405bfc9ca264469f2a03d47f384678',
  );
});
test('generador copia el ICO Wormhole oficial en vez de dibujar el icono genérico anterior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-wormhole-'));
  try {
    const paths = generateIcons(dir);
    assert.deepEqual(
      readFileSync(paths.ico),
      readFileSync(
        new URL('../src/ui/assets/identity/NEXO-Wormhole.ico', import.meta.url),
      ),
    );
    assert.deepEqual(
      readFileSync(paths.png),
      readFileSync(
        new URL('../src/ui/assets/identity/NEXO-Wormhole.png', import.meta.url),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('menú izquierdo cerrado inicialmente; botón abre/cierra y Escape devuelve foco', () =>
  fixture(async (f) => {
    assert.equal(f.leftMenu.inert, true);
    assert.equal(f.leftButton.attributes['aria-expanded'], 'false');
    f.leftButton.emit('click');
    assert.equal(f.leftMenu.inert, false);
    assert.equal(f.browser.classList.contains('left-menu-open'), true);
    f.leftMenu.emit('keydown', { key: 'Escape' });
    assert.equal(f.leftMenu.inert, true);
    assert.equal(document.activeElement, f.leftButton);
    f.leftButton.emit('click');
    f.leftButton.emit('click');
    assert.equal(f.leftMenu.inert, true);
  }));
test('menú automático se contrae al retirar mouse incluso tras enfocar un control; teclado expande al enfocar', () =>
  fixture(async (f) => {
    assert.equal(f.opens.at(-1), false);
    f.rightMenu.emit('pointerenter');
    assert.equal(f.opens.at(-1), true);
    f.rightMenu.emit('pointerleave');
    f.tick();
    assert.equal(f.opens.at(-1), false);
    f.rightMenu.emit('focusin');
    assert.equal(f.opens.at(-1), true);
    document.activeElement = f.rightMenu;
    f.rightMenu.emit('pointerleave');
    f.tick();
    assert.equal(f.opens.at(-1), false);
    f.rightMenu.emit('focusin');
    assert.equal(f.opens.at(-1), true);
    document.activeElement = null;
    f.rightMenu.emit('focusout');
    f.tick();
    assert.equal(f.opens.at(-1), false);
  }));
test('modo fijo guardado mantiene panel abierto y sincroniza Ajustes', () =>
  fixture(async (f) => {
    f.modeInput.value = 'fixed';
    await f.modeInput.emit('change');
    assert.deepEqual(f.saved, ['fixed']);
    assert.equal(f.c.mode, 'fixed');
    assert.equal(f.browser.dataset.rightMenuMode, 'fixed');
    assert.equal(f.closeButton.disabled, true);
    f.rightMenu.emit('pointerleave');
    f.tick();
    assert.equal(f.opens.at(-1), true);
    f.c.apply('auto');
    assert.equal(f.closeButton.disabled, false);
    assert.equal(f.modeInput.value, 'auto');
  }));
test('fallo de persistencia no aparenta guardar modo fijo', () =>
  fixture(async (f) => {
    f.fail();
    f.modeInput.value = 'fixed';
    await f.modeInput.emit('change');
    assert.equal(f.c.mode, 'auto');
    assert.equal(f.modeInput.value, 'auto');
    assert.equal(f.modeInput.disabled, false);
  }));
test('preferencias nuevas conservan las existentes y acotan zoom sin aceptar entradas inválidas', () => {
  const p = browserPreferences({
    rightMenuMode: 'fixed',
    uiZoom: 1.25,
    toolbar: ['memory'],
    search: 'google',
    workspaces: [{ id: 'work', name: 'Trabajo' }],
  });
  assert.equal(p.uiZoom, 1.25);
  assert.equal(p.rightMenuMode, 'fixed');
  assert.equal(p.search, 'google');
  assert.deepEqual(p.toolbar, ['memory']);
  assert.ok(p.workspaces.some((w) => w.id === 'work'));
  assert.equal(browserPreferences({ uiZoom: 99 }).uiZoom, 1.5);
  assert.equal(browserPreferences({ uiZoom: -2 }).uiZoom, 0.75);
  for (const v of [NaN, Infinity, '1.2', {}, null])
    assert.equal(browserPreferences({ uiZoom: v }).uiZoom, 1);
  assert.equal(
    browserPreferences({ rightMenuMode: 'evil' }).rightMenuMode,
    'auto',
  );
});
test('se elimina únicamente la pestaña Repetición; su lector compartido sigue en EVO Memory', () => {
  const html = readFileSync(
      new URL('../src/ui/shell/index.html', import.meta.url),
      'utf8',
    ),
    app = readFileSync(
      new URL('../src/ui/shell/app.js', import.meta.url),
      'utf8',
    );
  assert.doesNotMatch(html, /data-panel="repetition"/);
  assert.doesNotMatch(app, /refreshRepetition|repetitionView/);
  assert.match(app, /const memoryLiveView = createRepetitionView/);
  assert.match(app, /nexo:repetition-changed/);
  for (const name of [
    'memory',
    'understanding',
    'work',
    'history',
    'bookmarks',
    'downloads',
    'sites',
    'settings',
    'about',
    'activity',
  ])
    assert.ok(html.includes(`data-panel="${name}"`), name);
});

test('hamburguesa identificable y navegación sin Repetición en ninguno de los menús', () => {
  const html = readFileSync(new URL('../src/ui/shell/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="toggleLeftMenu"[^>]*aria-label="Menú hamburguesa:[^"]+"[^>]*aria-controls="leftMenu"[^>]*aria-expanded="false"/);
  assert.match(html, /<svg class="hamburger-icon"[^>]*aria-hidden="true"[^>]*>[\s\S]*?M4 6h16M4 12h16M4 18h16/);
  assert.doesNotMatch(html, /data-(?:open-panel|panel)="repetition"|id="panel(?:-tab)?-repetition"|Repetición de (?:la )?conversación/i);
});

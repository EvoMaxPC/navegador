import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { navigationMatches, navigationTabs, navigationLocation, adjacentNavigationTab, workspaceScopedTabs } from '../src/ui/shell/navigationModel.js';
import { commandFor, shortcutConflicts, DEFAULT_BINDINGS, normalizeBinding, COMMANDS } from '../src/nav/shortcuts.js';
import { isPublicAssetPath } from '../src/main/internalAssets.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tab = (id, extra = {}) => ({ id, title: `Título ${id}`, url: `https://example.com/${id}`, workspaceId: 'main', pinned: false, ...extra });

test('la búsqueda local ignora acentos y combina todas las palabras, sin red', () => {
  const item = { title: 'Documentación de Diseño', url: 'https://developer.mozilla.org/es/docs/Web/CSS' };
  assert.equal(navigationMatches(item, 'diseño'), true);
  assert.equal(navigationMatches(item, 'DISENO'), true);
  assert.equal(navigationMatches(item, 'mozilla css'), true);
  assert.equal(navigationMatches(item, ''), true);
  assert.equal(navigationMatches(item, 'mozilla inexistente'), false);
  // El nombre del espacio participa de la búsqueda, no sólo la URL.
  assert.equal(navigationMatches({ title: 'x', url: 'https://a.test' }, 'proyecto', 'Proyecto Norte'), true);
  const source = read('src/ui/shell/navigationHub.js') + read('src/ui/shell/navigationModel.js');
  assert.ok(!/fetch\(|XMLHttpRequest|axios/.test(source), 'la búsqueda de pestañas no consulta la red');
});

test('las pestañas del espacio actual van primero y las fijadas antes que el resto', () => {
  const tabs = [
    tab('a', { workspaceId: 'otro' }),
    tab('b', { pinned: true, title: 'Correo' }),
    tab('c', { title: 'Notas' }),
  ];
  assert.deepEqual(navigationTabs(tabs, { workspace: 'main' }).filter(t => t.workspaceId === 'main').map(t => t.id), ['b', 'c']);
  assert.deepEqual(navigationTabs(tabs, { workspace: 'main', currentOnly: true }).map(t => t.id), ['b', 'c']);
  assert.equal(navigationTabs(tabs, { workspace: 'otro', currentOnly: true }).length, 1);
  assert.equal(navigationTabs(tabs, { query: 'correo' }).map(t => t.id)[0], 'b');
  // No se muta la colección recibida (el orden visual lo decide la shell).
  const original = tabs.map(t => t.id);
  navigationTabs(tabs, { workspace: 'main' });
  assert.deepEqual(tabs.map(t => t.id), original);
});

test('el salto de teclado recorre sólo lo visible y de forma circular', () => {
  const ids = ['t1', 't2', 't3'];
  assert.equal(adjacentNavigationTab(ids, 't1', 'ArrowLeft'), 't3');
  assert.equal(adjacentNavigationTab(ids, 't3', 'ArrowRight'), 't1');
  assert.equal(adjacentNavigationTab(ids, 't2', 'ArrowRight'), 't3');
  assert.equal(adjacentNavigationTab(ids, 't2', 'Home'), 't1');
  assert.equal(adjacentNavigationTab(ids, 't2', 'End'), 't3');
  assert.equal(adjacentNavigationTab([], 't1', 'ArrowRight'), null);
  const app = read('src/ui/shell/app.js');
  assert.match(app, /browserTools\.visibleTabs\(\)|workspaceScopedTabs/, 'el teclado usa las pestañas visibles, no todas las creadas');
  assert.doesNotMatch(app, /const ids = \[\.\.\.state\.tabs\.keys\(\)\];\n\s*const index = ids\.indexOf\(id\);\n\s*const next = event\.key === 'Home'/, 'el orden viejo mezclaba espacios');
});

test('los espacios filtran sin ocultar pestañas ajenas del modelo', () => {
  const tabs = [tab('a'), tab('b', { workspaceId: 'otro' })];
  assert.deepEqual(workspaceScopedTabs(tabs, 'main').map(t => t.id), ['a']);
  assert.equal(tabs.length, 2);
});

test('la ubicación mostrada no expone credenciales ni rutas internas del perfil', () => {
  assert.equal(navigationLocation('https://example.com/'), 'example.com');
  assert.equal(navigationLocation('https://example.com/guia?q=1#x'), 'example.com/guia');
  assert.equal(navigationLocation('nexo://app/src/ui/start/index.html'), 'Página interna de NEXO');
  assert.equal(navigationLocation('file:///home/usuario/secreto.txt'), 'Página local');
  assert.equal(navigationLocation('https://usuario:clave@example.com/ruta'), 'example.com/ruta');
  assert.ok(!navigationLocation('https://usuario:clave@example.com/ruta').includes('clave'));
  assert.equal(navigationLocation(''), 'Sin dirección');
});

test('los atajos nuevos no pisan edición de texto ni ajustes existentes', () => {
  assert.deepEqual(shortcutConflicts({}), []);
  assert.deepEqual(shortcutConflicts({}), shortcutConflicts(DEFAULT_BINDINGS));
  assert.equal(normalizeBinding('Ctrl+A'), null, 'seleccionar todo sigue reservado');
  assert.equal(normalizeBinding('Ctrl+Shift+A'), 'Ctrl+Shift+A', 'la búsqueda de pestañas se permite con Shift');
  assert.equal(commandFor({ key: 'a', ctrlKey: true, shiftKey: true }), 'tab-search');
  assert.equal(commandFor({ key: 'a', ctrlKey: true }), null);
  assert.equal(commandFor({ key: 'f', altKey: true }), 'browser-menu');
  assert.ok(COMMANDS.includes('tab-search') && COMMANDS.includes('browser-menu'));
});

test('el menú del navegador y el buscador usan acciones existentes, no botones vacíos', () => {
  const hub = read('src/ui/shell/navigationHub.js');
  const used = [...hub.matchAll(/\['([a-z-]+)', '[^']*', '[^']*'(, 'panel')?\]/g)].map(m => [m[1], Boolean(m[2])]);
  assert.ok(used.length >= 14);
  // 'tokenizer' y 'settings' son paneles reales de la shell; el resto, comandos.
  for (const [id, panel] of used) {
    if (panel) assert.ok(['tokenizer', 'settings'].includes(id), `panel inesperado: ${id}`);
    else assert.ok(COMMANDS.includes(id), `comando inexistente: ${id}`);
  }
  assert.ok(hub.includes("command.type === 'tab-search'"));
  assert.ok(hub.includes("command.type === 'browser-menu'"));
  assert.ok(hub.includes('state.closed'), 'reabrir usa la pila real de cierres');
  assert.ok(hub.includes('state.tabs'), 'las pestañas provienen del estado real de la shell');
  // Nada de promesas no implementadas.
  for (const word of ['contraseñas', 'sincronización', 'extensiones']) {
    assert.ok(!new RegExp(word, 'i').test(hub), `el menú no ofrece ${word}`);
  }
});

test('el HTML declara el buscador y el menú como disparadores accesibles del mismo diálogo', () => {
  const html = read('src/ui/shell/index.html');
  const hub = read('src/ui/shell/navigationHub.js');
  for (const id of ['tabSearchButton', 'browserMenuButton', 'tabCount']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(hub, /modal\.id = 'navigationHub'/);
  const trigger = html.match(/<button class="icon-btn tab-search"[^>]*>/)?.[0] || '';
  assert.match(trigger, /aria-label="[^"]+"/);
  assert.match(trigger, /aria-haspopup="dialog"/);
  assert.match(trigger, /aria-expanded="false"/);
  assert.match(trigger, /aria-controls="navigationHub"/);
  assert.match(trigger, /title="[^"]*Ctrl\+Shift\+A/);
  assert.match(html, /<button class="icon-btn browser-menu"[^>]*title="[^"]*Alt\+F/);
  assert.ok(html.indexOf('navigationHub.css') > html.indexOf('wormhole.css'), 'la hoja nueva carga después del tema del navegador');
});

test('la hoja del centro de navegación es pública, adaptable y respeta movimiento reducido', () => {
  assert.equal(isPublicAssetPath('src/ui/shell/navigationHub.css'), true);
  const css = read('src/ui/shell/navigationHub.css');
  assert.match(css, /@media\s*\(max-width:\s*\d+px\)/);
  assert.match(css, /prefers-reduced-motion[\s\S]*animation:\s*none/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i, 'no carga recursos remotos');
});

test('el proceso principal ofrece los comandos nuevos en su menú sin duplicar el centro de comandos', () => {
  const menu = read('src/main/menu.js');
  assert.match(menu, /run\('tab-search'\)/);
  assert.match(menu, /run\('browser-menu'\)/);
  assert.equal((menu.match(/run\('command-center'\)/g) || []).length, 1);
});

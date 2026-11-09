import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayUrl, hostOf, isInternal, normalizeUrl, resolveInput, siteOf, urlKey } from '../src/nav/url.js';
import { HistoryStore } from '../src/nav/history.js';
import { BookmarkStore } from '../src/nav/bookmarks.js';
import { DownloadList, describeState, progressOf, sanitizeFilename } from '../src/nav/downloads.js';
import { captureSession, restoreSession, SessionStore } from '../src/nav/session.js';
import { PermissionPolicy, PERMISSION_CATALOG, toGranted } from '../src/nav/permissions.js';
import { ZOOM_STEPS, ZoomStore, clampZoom, zoomLabel } from '../src/nav/zoom.js';
import { acceleratorFor, commandFor } from '../src/nav/shortcuts.js';
import { memoryStorage } from '../src/main/files.js';
import { createProfile } from '../src/main/profile.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;

/* ------------------------------------------------------------------ */
/* URL                                                                 */
/* ------------------------------------------------------------------ */

test('normaliza URLs y descarta lo que no es navegable', () => {
  assert.equal(normalizeUrl('https://www.Claude.ai/chat#x'), 'https://www.claude.ai/chat');
  assert.equal(normalizeUrl('chatgpt.com'), 'https://chatgpt.com/');
  assert.equal(normalizeUrl('about:blank'), null);
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
});

test('distingue URLs internas y obtiene hosts y sitios', () => {
  assert.equal(isInternal('nexo://app/src/ui/shell/index.html'), true);
  assert.equal(isInternal('https://claude.ai'), false);
  assert.equal(hostOf('https://www.chatgpt.com/c/1'), 'chatgpt.com');
  assert.equal(siteOf('https://chat.openai.com/c/1'), 'openai.com');
  assert.equal(siteOf('https://tienda.com.ar/x'), 'tienda.com.ar');
});

test('la clave de URL ignora barra final y fragmento', () => {
  assert.equal(urlKey('https://claude.ai/'), urlKey('https://claude.ai'));
  assert.equal(urlKey('https://x.com/a#b'), urlKey('https://x.com/a'));
  assert.notEqual(urlKey('https://x.com/a?p=1'), urlKey('https://x.com/a?p=2'));
});

test('resuelve lo escrito en la barra como URL o búsqueda', () => {
  assert.equal(resolveInput('claude.ai'), 'https://claude.ai');
  assert.equal(resolveInput('localhost:3000'), 'http://localhost:3000');
  assert.match(resolveInput('qué es un navegador'), /^https:\/\/duckduckgo\.com\/\?q=/);
});

test('muestra la URL sin ruido', () => {
  assert.equal(displayUrl('https://www.claude.ai/'), 'claude.ai');
  assert.equal(displayUrl('https://claude.ai/new?x=1'), 'claude.ai/new?x=1');
  assert.equal(displayUrl('nexo://app/demo/index.html'), 'nexo://demo/index.html');
});

/* ------------------------------------------------------------------ */
/* historial                                                           */
/* ------------------------------------------------------------------ */

test('registra visitas y evita duplicar recargas inmediatas', () => {
  const history = new HistoryStore({ now: clock });
  history.add({ url: 'https://claude.ai/chat/1', title: 'Claude', visitTime: NOW });
  history.add({ url: 'https://claude.ai/chat/1', title: 'Claude', visitTime: NOW + 1000 });
  assert.equal(history.size, 1, 'dos visitas en el mismo segundo son una recarga');

  history.add({ url: 'https://claude.ai/chat/1', title: 'Claude', visitTime: NOW + 60_000 });
  assert.equal(history.size, 2, 'pasada la ventana sí es otra visita');
});

test('el historial ignora páginas internas y vacías', () => {
  const history = new HistoryStore({ now: clock });
  assert.equal(history.add({ url: 'nexo://app/demo/index.html' }), null);
  assert.equal(history.add({ url: 'about:blank' }), null);
  assert.equal(history.size, 0);
});

test('busca por título y por URL', () => {
  const history = new HistoryStore({ now: clock });
  history.add({ url: 'https://chatgpt.com/c/1', title: 'Presupuesto del proyecto' });
  history.add({ url: 'https://gemini.google.com/app', title: 'Gemini' });
  assert.equal(history.search('presupuesto').length, 1);
  assert.equal(history.search('gemini').length, 1);
  assert.equal(history.search('presupuesto').at(0).host, 'chatgpt.com');
});

test('la búsqueda tolera acentos y mayúsculas', () => {
  const history = new HistoryStore({ now: clock });
  history.add({ url: 'https://claude.ai/c/1', title: 'Migración de la base' });
  assert.equal(history.search('MIGRACION').length, 1);
});

test('cuenta los sitios más visitados', () => {
  const history = new HistoryStore({ now: clock });
  history.add({ url: 'https://claude.ai/a', title: 'A', visitTime: NOW - 3000 });
  history.add({ url: 'https://claude.ai/b', title: 'B', visitTime: NOW - 2000 });
  history.add({ url: 'https://chatgpt.com/x', title: 'X', visitTime: NOW - 1000 });
  const top = history.topSites({ limit: 2 });
  assert.equal(top[0].site, 'claude.ai');
  assert.equal(top[0].visits, 2);
});

test('borra por fecha y por sitio', () => {
  const history = new HistoryStore({ now: clock });
  history.add({ url: 'https://a.com/1', title: 'viejo', visitTime: NOW - 10 * 86_400_000 });
  history.add({ url: 'https://b.com/1', title: 'nuevo', visitTime: NOW - 1000 });
  assert.equal(history.clear({ since: NOW - 86_400_000 }).removed, 1);
  assert.equal(history.size, 1);
  assert.equal(history.recent()[0].host, 'a.com');

  const other = new HistoryStore({ now: clock });
  other.add({ url: 'https://a.com/1', title: 'a', visitTime: NOW - 3000 });
  other.add({ url: 'https://b.com/1', title: 'b', visitTime: NOW - 2000 });
  assert.equal(other.clear({ host: 'b.com' }).removed, 1);
  assert.equal(other.size, 1);

  assert.equal(other.clear().removed, 1, 'sin argumentos borra todo');
  assert.equal(other.size, 0);
});

test('persiste y se recarga desde el almacenamiento', () => {
  const storage = memoryStorage();
  const first = new HistoryStore({ storage, now: clock });
  first.add({ url: 'https://claude.ai/chat/9', title: 'Claude 9' });
  assert.ok(first.save());

  const second = new HistoryStore({ storage, now: clock });
  assert.equal(second.size, 1);
  assert.equal(second.recent()[0].title, 'Claude 9');
});

test('un historial corrupto no rompe el arranque', () => {
  const history = new HistoryStore({ storage: memoryStorage('{ roto'), now: clock });
  assert.equal(history.size, 0);
});

/* ------------------------------------------------------------------ */
/* marcadores                                                          */
/* ------------------------------------------------------------------ */

test('marca, desmarca y detecta la estrella', () => {
  const bookmarks = new BookmarkStore({ now: clock });
  const added = bookmarks.toggle({ url: 'https://claude.ai', title: 'Claude' });
  assert.equal(added.added, true);
  assert.equal(bookmarks.isBookmarked('https://claude.ai/'), true);

  const removed = bookmarks.toggle({ url: 'https://claude.ai' });
  assert.equal(removed.added, false);
  assert.equal(bookmarks.isBookmarked('https://claude.ai'), false);
});

test('no duplica marcadores de la misma página', () => {
  const bookmarks = new BookmarkStore({ now: clock });
  bookmarks.add({ url: 'https://x.com/a' });
  const second = bookmarks.add({ url: 'https://x.com/a/' });
  assert.equal(second.created, false);
  assert.equal(bookmarks.size, 1);
});

test('lista por carpeta y busca', () => {
  const bookmarks = new BookmarkStore({ now: clock });
  bookmarks.add({ url: 'https://claude.ai', title: 'Claude', folder: 'IA' });
  bookmarks.add({ url: 'https://news.ycombinator.com', title: 'Noticias', folder: 'Lectura' });
  assert.equal(bookmarks.list({ folder: 'IA' }).length, 1);
  assert.equal(bookmarks.list({ query: 'noticias' }).length, 1);
  assert.deepEqual(bookmarks.folders().map((f) => f.name).sort(), ['IA', 'Lectura']);
});

/* ------------------------------------------------------------------ */
/* descargas                                                           */
/* ------------------------------------------------------------------ */

test('ciclo completo de una descarga', () => {
  const downloads = new DownloadList({ now: clock });
  const item = downloads.start({ id: 'd1', url: 'https://x.com/archivo.zip', filename: '../../archivo.zip', totalBytes: 1000 });
  assert.equal(item.filename, 'archivo.zip');
  assert.equal(item.state, 'started');

  downloads.progress('d1', { receivedBytes: 400, totalBytes: 1000 });
  assert.equal(progressOf(downloads.get('d1')), 0.4);

  downloads.finish('d1', { state: 'completed', savePath: '/descargas/archivo.zip' });
  const done = downloads.get('d1');
  assert.equal(done.state, 'completed');
  assert.equal(downloads.isOpenable('d1'), true);
  assert.equal(describeState(done.state), 'completada');
});

test('los eventos tardíos de una descarga desconocida no rompen nada', () => {
  const downloads = new DownloadList({ now: clock });
  assert.equal(downloads.progress('fantasma', { receivedBytes: 1 }), null);
  assert.equal(downloads.finish('fantasma'), null);
});

test('al reabrir, lo que estaba en curso queda como interrumpido', () => {
  const storage = memoryStorage();
  const first = new DownloadList({ storage, now: clock });
  first.start({ id: 'd2', url: 'https://x.com/big.iso', filename: 'big.iso' });
  first.save();

  const second = new DownloadList({ storage, now: clock });
  assert.equal(second.get('d2').state, 'interrupted');
  assert.equal(second.isOpenable('d2'), false);
});

test('sanea nombres de archivo peligrosos', () => {
  assert.equal(sanitizeFilename('C:\\Users\\x\\a.txt'), 'a.txt');
  assert.equal(sanitizeFilename('malo:con|caracteres?*.txt'), 'malo con caracteres .txt');
  assert.equal(sanitizeFilename(''), 'descarga');
});

/* ------------------------------------------------------------------ */
/* sesión                                                              */
/* ------------------------------------------------------------------ */

test('captura la sesión sin páginas internas', () => {
  const data = captureSession({
    now: clock,
    windows: [
      {
        activeIndex: 1,
        tabs: [
          { url: 'https://claude.ai/chat/1', title: 'Claude' },
          { url: 'nexo://app/demo/index.html', title: 'Demo' },
          { url: 'https://chatgpt.com/c/2', title: 'ChatGPT' },
        ],
      },
    ],
  });
  assert.equal(data.windows[0].tabs.length, 2);
  assert.equal(data.windows[0].activeIndex, 1);
  assert.equal(data.savedAt, NOW);
});

test('restaura validando y recortando', () => {
  const restored = restoreSession(
    {
      savedAt: NOW,
      windows: [
        { activeIndex: 0, tabs: [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'basura' }] },
      ],
    },
    { maxTabs: 2 },
  );
  assert.equal(restored.restored, 2);
  assert.equal(restored.windows[0].tabs.length, 2);
  assert.ok(restored.skipped >= 1);
});

test('una sesión vacía o inválida no se ofrece para restaurar', () => {
  assert.equal(restoreSession(null).restored, 0);
  assert.equal(restoreSession({ windows: [] }).restored, 0);
});

test('SessionStore guarda y devuelve la sesión utilizable', () => {
  const storage = memoryStorage();
  const store = new SessionStore({ storage, now: clock });
  store.capture([{ tabs: [{ url: 'https://claude.ai/chat/1', title: 'Claude' }], activeIndex: 0 }]);
  const restored = store.restore();
  assert.equal(restored.restored, 1);
  assert.equal(restored.windows[0].tabs[0].url, 'https://claude.ai/chat/1');
});

/* ------------------------------------------------------------------ */
/* permisos                                                            */
/* ------------------------------------------------------------------ */

test('concede lo necesario y niega lo invasivo por defecto', () => {
  const policy = new PermissionPolicy();
  assert.equal(policy.decide('claude.ai', 'clipboard-sanitized-write'), 'allow');
  assert.equal(policy.decide('claude.ai', 'geolocation'), 'deny');
  assert.equal(policy.decide('claude.ai', 'notifications'), 'ask');
  assert.equal(toGranted('ask'), false);
});

test('el usuario puede cambiar un permiso por sitio', () => {
  const policy = new PermissionPolicy();
  policy.set('meet.example.com', 'media', 'allow');
  assert.equal(policy.decide('meet.example.com', 'media'), 'allow');
  assert.equal(policy.decide('otro.example.com', 'media'), 'ask');
  assert.equal(policy.rulesFor('meet.example.com').find((r) => r.permission === 'media').isDefault, false);
});

test('volver al valor por defecto borra la regla', () => {
  const policy = new PermissionPolicy();
  policy.set('x.com', 'geolocation', 'allow');
  policy.set('x.com', 'geolocation', 'default');
  assert.equal(policy.decide('x.com', 'geolocation'), 'deny');
  assert.equal(policy.list().length, 0);
});

test('los permisos persisten', () => {
  const storage = memoryStorage();
  const first = new PermissionPolicy({ storage });
  first.set('x.com', 'notifications', 'allow');
  first.save();

  const second = new PermissionPolicy({ storage });
  assert.equal(second.decide('x.com', 'notifications'), 'allow');
});

test('el catálogo cubre todos los permisos con etiqueta y valor', () => {
  for (const [permission, meta] of Object.entries(PERMISSION_CATALOG)) {
    assert.ok(permission.length > 0);
    assert.ok(meta.label.length > 0, `falta etiqueta para ${permission}`);
    assert.ok(['allow', 'deny', 'ask'].includes(meta.default));
  }
});

/* ------------------------------------------------------------------ */
/* zoom                                                                */
/* ------------------------------------------------------------------ */

test('el zoom se recuerda por sitio y se limita a la escala', () => {
  const zoom = new ZoomStore();
  assert.equal(zoom.get('https://claude.ai/chat/1'), 1);
  zoom.set('https://claude.ai/chat/1', 1.25);
  assert.equal(zoom.get('https://claude.ai/otra'), 1.25);
  assert.equal(zoom.get('https://chatgpt.com'), 1);
  assert.equal(zoom.set('https://x.com', 9), 2.5);
  assert.equal(zoom.set('https://x.com', 0.1), 0.5);
});

test('sube y baja por los pasos de la escala', () => {
  const zoom = new ZoomStore();
  assert.equal(zoom.step('claude.ai', 1), ZOOM_STEPS[ZOOM_STEPS.indexOf(1) + 1]);
  zoom.reset('claude.ai');
  assert.equal(zoom.get('claude.ai'), 1);
  assert.equal(zoomLabel(1.25), '125 %');
  assert.equal(clampZoom('basura'), 1);
});

/* ------------------------------------------------------------------ */
/* atajos                                                              */
/* ------------------------------------------------------------------ */

test('los atajos principales se traducen a comandos', () => {
  const ev = (key, extra = {}) => ({ key, ctrlKey: true, ...extra });
  assert.equal(commandFor(ev('t')), 'new-tab');
  assert.equal(commandFor(ev('w')), 'close-tab');
  assert.equal(commandFor(ev('T', { shiftKey: true })), 'reopen-tab');
  assert.equal(commandFor(ev('l')), 'focus-omnibox');
  assert.equal(commandFor(ev('f')), 'find');
  assert.equal(commandFor(ev('d')), 'bookmark');
  assert.equal(commandFor(ev('h')), 'history');
  assert.equal(commandFor(ev('j')), 'downloads');
  assert.equal(commandFor(ev('=')), 'zoom-in');
  assert.equal(commandFor(ev('0')), 'zoom-reset');
  assert.equal(commandFor(ev('3')), 'tab-3');
  assert.equal(commandFor({ key: 'Escape' }), 'escape');
  assert.equal(commandFor(ev('q')), null);
});

test('en macOS el modificador es Command', () => {
  assert.equal(commandFor({ key: 't', ctrlKey: true }, { platform: 'darwin' }), null);
  assert.equal(commandFor({ key: 't', metaKey: true }, { platform: 'darwin' }), 'new-tab');
  assert.equal(acceleratorFor('new-tab', 'darwin'), '⌘T');
  assert.equal(acceleratorFor('history', 'win32'), 'Ctrl+H');
});

/* ------------------------------------------------------------------ */
/* perfil                                                              */
/* ------------------------------------------------------------------ */

test('el perfil reúne todos los almacenes y persiste junto', () => {
  const stores = new Map();
  const profile = createProfile({
    now: clock,
    storageFor: (name) => {
      if (!stores.has(name)) stores.set(name, memoryStorage());
      return stores.get(name);
    },
  });

  profile.history.add({ url: 'https://claude.ai/chat/1', title: 'Claude' });
  profile.bookmarks.add({ url: 'https://gemini.google.com', title: 'Gemini' });
  profile.zoom.set('claude.ai', 1.25);
  profile.permissions.set('claude.ai', 'notifications', 'allow');
  profile.session.capture([{ tabs: [{ url: 'https://claude.ai/chat/1', title: 'Claude' }], activeIndex: 0 }]);

  const saved = profile.saveAll();
  assert.equal(saved.history, true);
  assert.equal(saved.bookmarks, true);
  assert.equal(saved.zoom, true);

  const stats = profile.stats();
  assert.equal(stats.history.total, 1);
  assert.equal(stats.bookmarks, 1);
  assert.equal(stats.zoomSites, 1);
  assert.equal(stats.permissionSites, 1);
  assert.equal(stats.sessionSavedAt, NOW);

  const cleared = profile.clear({ history: true, bookmarks: true });
  assert.equal(cleared.history.removed, 1);
  assert.equal(cleared.bookmarks.removed, 1);
});

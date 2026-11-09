/**
 * Guardas de entrada: lo que una página puede hacer llegar al proceso principal.
 *
 * El caso que justifica todo esto es `shell.openExternal`: si acepta cualquier
 * esquema, una página puede pedirle a Windows que ejecute algo. Los tests fijan
 * qué se permite, qué se recorta y qué se descarta en silencio.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import {
  EXTERNAL_SCHEMES,
  EVENT_TYPES,
  eventMessage,
  integer,
  permissionName,
  safeExternalUrl,
  sessionPayload,
  text,
} from '../src/main/validate.js';

register('./harness/loader.mjs', import.meta.url);

const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
await settle();

/* ---------------- URLs externas ---------------- */

test('sólo se entregan al sistema los esquemas de navegación', () => {
  assert.deepEqual(EXTERNAL_SCHEMES, ['http:', 'https:', 'mailto:']);

  assert.equal(safeExternalUrl('https://github.com/EvoMaxPC/navegador'), 'https://github.com/EvoMaxPC/navegador');
  assert.equal(safeExternalUrl('http://ejemplo.com/a?b=1'), 'http://ejemplo.com/a?b=1');
  assert.equal(safeExternalUrl('mailto:hola@ejemplo.com'), 'mailto:hola@ejemplo.com');

  // Lo que no puede pasar.
  for (const url of [
    'file:///C:/Windows/System32/cmd.exe',
    'smb://servidor/recurso',
    'ms-msdt:/id PCWDiagnostic',
    'javascript:alert(1)',
    'data:text/html,<h1>hola',
    'vbscript:msgbox(1)',
    'chrome://settings',
    'https://usuario:clave@ejemplo.com/',
  ]) {
    assert.equal(safeExternalUrl(url), null, `no debería permitirse ${url}`);
  }

  for (const value of [null, undefined, 42, {}, '', 'no es una url', `https://a.com/${'x'.repeat(3000)}`]) {
    assert.equal(safeExternalUrl(value), null);
  }
});

test('el IPC de abrir externo aplica la misma lista', async () => {
  const handler = journal.ipcHandlers.get('nexo:open-external');
  assert.ok(handler, 'falta el handler');
  const before = journal.external.length;

  const denied = await handler({ sender: { id: 1 } }, 'file:///C:/Windows/System32/cmd.exe');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /esquema/);
  assert.equal(journal.external.length, before, 'no debe llamarse al sistema');

  const allowed = await handler({ sender: { id: 1 } }, 'https://ejemplo.com/nota');
  assert.equal(allowed.ok, true);
  assert.equal(journal.external.length, before + 1);
  assert.equal(journal.external.at(-1).url, 'https://ejemplo.com/nota');
});

/* ---------------- eventos de pestaña ---------------- */

test('un evento de pestaña se acepta sólo con forma conocida', () => {
  assert.deepEqual(EVENT_TYPES.includes('intervention'), true);

  const ok = eventMessage(
    { type: 'intervention', payload: { summary: 'se recortó el contexto' }, href: 'https://chat.openai.com/c/1' },
  );
  assert.deepEqual(ok, {
    type: 'intervention',
    payload: { summary: 'se recortó el contexto' },
    href: 'https://chat.openai.com/c/1',
  });

  assert.equal(eventMessage({ type: 'inventado', payload: {} }), null);
  assert.equal(eventMessage({ type: 'intervention', payload: 'texto' }), null);
  assert.equal(eventMessage({ type: 'intervention', payload: [1, 2] }), null);
  assert.equal(eventMessage({ type: 'intervention' }), null);
  assert.equal(eventMessage(null), null);

  const grande = eventMessage({ type: 'intervention', payload: { texto: 'x'.repeat(30_000) } });
  assert.equal(grande, null, 'un payload de 30 kB se descarta');

  const circular = { type: 'intervention', payload: {} };
  circular.payload.self = circular;
  assert.equal(eventMessage(circular), null, 'un payload circular no debe romper el proceso');

  // El href se valida aparte: si no es navegable, queda vacío.
  const sinHref = eventMessage({ type: 'ready', payload: {} }, { href: 'file:///etc/passwd' });
  assert.equal(sinHref.href, '');
});

test('sólo las webviews pueden anunciar eventos', () => {
  const listener = journal.ipcListeners.get('nexo:event');
  assert.ok(listener, 'falta el listener de eventos');

  const webview = { getType: () => 'webview', getURL: () => 'https://claude.ai/' };
  const window = { getType: () => 'window', getURL: () => 'nexo://app/src/ui/shell/index.html' };

  listener({ sender: webview }, { type: 'intervention', payload: { a: 1 } });
  listener({ sender: window }, { type: 'intervention', payload: { a: 2 } });
  listener({ sender: webview }, { type: 'inventado', payload: {} });

  const shell = journal.windows[0].webContents;
  const events = shell.sent.filter((item) => item.channel === 'nexo:event').map((item) => item.payload);
  assert.equal(events.length, 1, 'sólo pasa el evento válido de una webview');
  assert.deepEqual(events[0], { type: 'intervention', payload: { a: 1 }, href: 'https://claude.ai/' });
});

/* ---------------- sesión ---------------- */

test('la sesión se acota antes de tocar el disco', () => {
  const windows = [];
  for (let index = 0; index < 50; index += 1) {
    windows.push({
      activeIndex: 999,
      tabs: Array.from({ length: 500 }, (_value, tab) => ({
        url: `https://ejemplo.com/${index}/${tab}`,
        title: 'x'.repeat(1000),
      })),
    });
  }
  const payload = sessionPayload({ windows });
  assert.equal(payload.windows.length, 8, 'como mucho 8 ventanas');
  assert.equal(payload.windows[0].tabs.length, 120, 'como mucho 120 pestañas por ventana');
  assert.equal(payload.windows[0].tabs[0].title.length, 300);

  assert.deepEqual(sessionPayload({ windows: [{ tabs: [{ url: '' }, { title: 'sin url' }] }] }).windows, []);
  assert.deepEqual(sessionPayload(null), { windows: [] });
  assert.deepEqual(sessionPayload({ windows: 'no soy un array' }), { windows: [] });

  // Una entrada válida sobrevive entera.
  const one = sessionPayload({
    windows: [{ activeIndex: 1, tabs: [{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com', title: 'B' }] }],
  });
  assert.deepEqual(one, {
    windows: [{ activeIndex: 1, tabs: [{ url: 'https://a.com', title: 'A', pinned: false }, { url: 'https://b.com', title: 'B', pinned: false }] }],
  });
});

/* ---------------- permisos ---------------- */

test('no se pueden inventar permisos', () => {
  assert.equal(permissionName('geolocation', { geolocation: {} }), 'geolocation');
  assert.equal(permissionName('permiso-inventado', { geolocation: {} }), null);
  assert.equal(permissionName('__proto__', { geolocation: {} }), null, 'no debe colarse por el prototipo');
  assert.equal(permissionName('toString', {}), null);
  assert.equal(permissionName(42, { geolocation: {} }), null);
});

/* ---------------- helpers ---------------- */

test('los ayudantes recortan de forma predecible', () => {
  assert.equal(text('  hola \n mundo  ', 100), 'hola  mundo');
  assert.equal(text('a'.repeat(50), 10).length, 10);
  assert.equal(text('\u0000\u0007x', 10), 'x');
  assert.equal(text(42, 10), '');
  assert.equal(text(null, 10), '');

  assert.equal(integer('7'), 7);
  assert.equal(integer(3.9), 3);
  assert.equal(integer(-5), 0);
  assert.equal(integer(1e9, { max: 100 }), 100);
  assert.equal(integer('nada', { fallback: 4 }), 4);
});

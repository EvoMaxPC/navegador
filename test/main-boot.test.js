/**
 * Auditoría de arranque: ejecuta el proceso principal de producción contra el
 * Electron falso y verifica que el navegador queda armado.
 *
 * Esto no es una prueba de navegación real (no hay motor Chromium en node), pero
 * sí ejecuta el mismo código que corre en la aplicación: si algo del arranque,
 * del IPC, del menú, de los permisos o de las descargas está roto, acá falla.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// La ventana de recuperación de choques se acorta para poder medirla.
process.env.NEXO_CRASH_WINDOW_MS = '600';

register('./harness/loader.mjs', import.meta.url);

const { journal } = await import('./harness/electron-stub.mjs');

// Se importa el proceso principal real: ejecuta app.whenReady() con el falso.
await import('../src/main/main.js');

/** Deja correr las promesas del arranque. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Llama a un handler de IPC como lo haría un renderer. */
function callIpc(channel, payload, senderId = 1) {
  const handler = journal.ipcHandlers.get(channel);
  assert.ok(handler, `no hay handler para ${channel}`);
  return handler({ sender: { id: senderId } }, payload);
}

test('el arranque crea una ventana con la interfaz y la endurece', async () => {
  await settle();
  assert.equal(journal.windows.length, 1, 'debe abrirse una ventana');

  const win = journal.windows[0];
  assert.match(win.loadedUrl, /^nexo:\/\/app\/src\/ui\/shell\/index\.html$/);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.webviewTag, true);
});

test('registra el esquema nexo y su manejador con control de ruta', async () => {
  assert.ok(journal.schemes.some((scheme) => scheme.scheme === 'nexo'));
  assert.ok(journal.schemeHandlers.has('nexo'));

  const handler = journal.schemeHandlers.get('nexo');

  // El vector real: segmentos codificados, que sobreviven al parser de URL y se
  // decodifican después. Los `..` literales los normaliza el propio `URL`.
  const escaped = await handler({ url: 'nexo://app/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd' });
  assert.equal(escaped.status, 403, 'no debe servir fuera de la raíz del proyecto');

  const inside = await handler({ url: 'nexo://app/src/ui/shell/index.html' });
  assert.equal(inside.status, 200, 'debe servir una ruta interna válida');
  assert.match(
    inside.headers.get('content-type') || '',
    /^text\/html/,
    'la interfaz debe anunciarse como HTML',
  );
  assert.match(await inside.text(), /<!doctype html>/i);

  // Los módulos ES exigen `text/javascript`; si no, la shell no arranca.
  const script = await handler({ url: 'nexo://app/src/nav/url.js' });
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') || '', /^text\/javascript/);

  // Codificación rota y rutas inexistentes no deben romper el proceso.
  assert.equal((await handler({ url: 'nexo://app/%E0%A4%A' })).status, 400);
  assert.equal((await handler({ url: 'nexo://app/src/no-existe.js' })).status, 404);
  assert.equal((await handler({ url: 'nexo://app/src' })).status, 404, 'un directorio no es un archivo');
});

test('el menú se construye con atajos y no con roles que recarguen la shell', async () => {
  await settle();
  assert.equal(journal.menus.length, 1);
  const template = journal.menus[0].template;
  const flat = JSON.stringify(template);
  assert.match(flat, /Pestaña nueva/);
  assert.match(flat, /CmdOrCtrl\+Tab/);
  assert.doesNotMatch(flat, /"role":"reload"/, 'recargar debe apuntar a la pestaña, no a la interfaz');
});

test('la sesión persistente queda con política de permisos y descargas', async () => {
  const target = journal.sessions.get('persist:nexo');
  assert.ok(target, 'debe configurarse la partición persist:nexo');
  assert.equal(typeof journal.permissions.request, 'function');
  assert.equal(typeof journal.permissions.check, 'function');

  // Un permiso invasivo no se concede, y queda registrado.
  const decisions = [];
  journal.permissions.request({ getURL: () => 'https://ejemplo.com/' }, 'geolocation', (granted) => decisions.push(granted), {});
  assert.deepEqual(decisions, [false]);

  const allowed = [];
  journal.permissions.request({ getURL: () => 'https://ejemplo.com/' }, 'clipboard-sanitized-write', (granted) => allowed.push(granted), {});
  assert.deepEqual(allowed, [true], 'copiar al portapapeles debe estar permitido por defecto');
});

test('una navegación de pestaña entra al historial con su título', async () => {
  const win = journal.windows[0];
  const view = win.attachWebview('https://claude.ai/');

  view.navigateTo('https://claude.ai/chat/abc', 'Proyecto EVO');
  const recent = await callIpc('nexo:history:list', { limit: 10 });
  const entry = recent.find((item) => item.url === 'https://claude.ai/chat/abc');
  assert.ok(entry, 'la visita debe quedar registrada');
  assert.equal(entry.title, 'Proyecto EVO');
  assert.equal(entry.host, 'claude.ai');
});

test('las páginas internas no ensucian el historial', async () => {
  const win = journal.windows[0];
  const view = win.attachWebview('nexo://app/src/ui/start/index.html');
  view.navigateTo('nexo://app/src/ui/start/index.html', 'Pestaña nueva');
  const recent = await callIpc('nexo:history:list', { limit: 50 });
  assert.ok(!recent.some((item) => item.url.startsWith('nexo://')));
});

test('marcar y desmarcar funciona de punta a punta', async () => {
  const added = await callIpc('nexo:bookmarks:toggle', { url: 'https://claude.ai/', title: 'Claude' });
  assert.equal(added.added, true);
  const list = await callIpc('nexo:bookmarks:list', {});
  assert.equal(list.length, 1);
  assert.equal(await callIpc('nexo:bookmarks:is', 'https://claude.ai'), true);

  const removed = await callIpc('nexo:bookmarks:toggle', { url: 'https://claude.ai/' });
  assert.equal(removed.added, false);
  assert.equal((await callIpc('nexo:bookmarks:list', {})).length, 0);
});

test('el zoom se guarda por sitio y se aplica a la pestaña al cargar', async () => {
  const level = await callIpc('nexo:zoom:set', { target: 'https://claude.ai/chat/abc', level: 1.25 });
  assert.equal(level.level, 1.25);

  const view = journal.windows[0].attachedWebviews.at(-1);
  view.url = 'https://claude.ai/chat/abc';
  view.emit('did-finish-load');
  assert.equal(view.zoomFactor, 1.25, 'el zoom guardado debe aplicarse al terminar de cargar');

  assert.equal(await callIpc('nexo:zoom:get', 'https://chatgpt.com/'), 1);
});

test('la sesión se captura y se restaura', async () => {
  await callIpc('nexo:session:capture', {
    windows: [{ activeIndex: 0, tabs: [{ url: 'https://claude.ai/chat/abc', title: 'EVO' }] }],
  });
  const restored = await callIpc('nexo:session:restore');
  assert.equal(restored.restored, 1);
  assert.equal(restored.windows[0].tabs[0].url, 'https://claude.ai/chat/abc');
});

test('una descarga completa se refleja en el gestor', async () => {
  const target = journal.sessions.get('persist:nexo');
  const fakeItem = new (await import('node:events')).EventEmitter();
  fakeItem.getURL = () => 'https://ejemplo.com/informe.pdf';
  fakeItem.getFilename = () => 'informe.pdf';
  fakeItem.getTotalBytes = () => 2048;
  fakeItem.getReceivedBytes = () => 1024;
  fakeItem.getSavePath = () => '/descargas/informe.pdf';
  fakeItem.cancel = () => {};

  target.emit('will-download', {}, fakeItem);
  fakeItem.emit('updated', {}, 'progressing');
  fakeItem.emit('done', {}, 'completed');

  const list = await callIpc('nexo:downloads:list');
  const entry = list.find((item) => item.filename === 'informe.pdf');
  assert.ok(entry, 'la descarga debe aparecer en el gestor');
  assert.equal(entry.state, 'completed');
  assert.equal(entry.savePath, '/descargas/informe.pdf');

  const opened = await callIpc('nexo:downloads:open', entry.id);
  assert.equal(opened.ok, true);
});

test('las sugerencias de la barra combinan marcadores e historial sin repetir', async () => {
  await callIpc('nexo:bookmarks:toggle', { url: 'https://claude.ai/chat/abc', title: 'Proyecto EVO' });
  const suggestions = await callIpc('nexo:suggest', { query: 'claude' });
  assert.ok(suggestions.length >= 1);
  const urls = suggestions.map((item) => item.url);
  assert.equal(new Set(urls).size, urls.length, 'no debe haber URLs repetidas');
  assert.equal(suggestions[0].kind, 'bookmark', 'los marcadores van primero');
});

test('borrar datos respeta el alcance y no deja restos', async () => {
  const cleared = await callIpc('nexo:profile:clear', { history: true, bookmarks: true });
  assert.equal(cleared.history.removed >= 1, true);
  assert.equal((await callIpc('nexo:history:list', { limit: 10 })).length, 0);
  assert.equal((await callIpc('nexo:bookmarks:list', {})).length, 0);

  const data = await callIpc('nexo:data:clear', { cookies: true, cache: true });
  assert.equal(data.ok, true);
  assert.equal(data.cookies, true);
  assert.equal(data.cache, true);
});

test('la memoria EVO responde desde el proceso principal', async () => {
  const stats = await callIpc('nexo:memory:stats');
  assert.equal(typeof stats.active, 'number');
  const recalled = await callIpc('nexo:memory:recall', { query: 'nada' });
  assert.ok(Array.isArray(recalled));
});

test('una pestaña que se cae se recarga, pero no en bucle', async () => {
  await settle();
  const win = journal.windows[0];
  const view = win.attachWebview('https://claude.ai/');
  view.navigateTo('https://claude.ai/', 'Claude');

  view.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(view.reloads, 1, 'debe intentar recuperarla');

  // Se vuelve a caer dentro de la ventana de gracia: no se insiste.
  view.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(view.reloads, 1, 'no debe recargar en bucle');

  // Una salida limpia no es un choque.
  const otro = win.attachWebview('https://chat.openai.com/');
  otro.emit('render-process-gone', {}, { reason: 'clean-exit' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(otro.reloads, 0, 'cerrar una pestaña no es un choque');

  // Si la página se sostiene el tiempo de gracia, un choque nuevo vuelve a
  // tener derecho a su recarga.
  otro.navigateTo('https://chat.openai.com/', 'ChatGPT');
  await new Promise((resolve) => setTimeout(resolve, 200));
  otro.emit('render-process-gone', {}, { reason: 'oom' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(otro.reloads, 1, 'tras cargar bien, se vuelve a intentar');
});

test('el arranque apaga lo que no se usa y no arranca el corrector', async () => {
  await settle();

  // Servicios de Chromium que este navegador no usa: cada uno cuesta un proceso
  // o trabajo de red en segundo plano desde el arranque.
  const features = journal.switches.find((item) => item.name === 'disable-features');
  assert.ok(features, 'debe configurar disable-features');
  for (const feature of ['Translate', 'MediaRouter', 'OptimizationHints']) {
    assert.match(features.value, new RegExp(feature), `falta apagar ${feature}`);
  }

  assert.equal(journal.spellcheck, false, 'el corrector ortográfico no debe arrancar');

  const win = journal.windows[0];
  assert.equal(win.options.webPreferences.spellcheck, false);
  const view = win.attachWebview('https://claude.ai/');
  assert.equal(view.preferences?.spellcheck ?? false, false, 'las pestañas tampoco lo usan');
});

test('el arranque deja marcas de tiempo para medirse', async () => {
  await settle();
  const { marks } = await import('../src/main/perf.js');
  const marcas = marks();
  for (const nombre of ['proceso', 'ready', 'ajustes', 'perfil', 'motor', 'ventana']) {
    assert.equal(typeof marcas[nombre], 'number', `falta la marca ${nombre}`);
    assert.ok(marcas[nombre] >= 0);
  }
  // Las marcas tienen que ser monótonas: si una etapa "tarda menos" que la
  // anterior, lo que se está midiendo no es el arranque.
  const orden = ['ready', 'ajustes', 'perfil', 'motor', 'ventana'].map((n) => marcas[n]);
  for (let i = 1; i < orden.length; i += 1) {
    assert.ok(orden[i] >= orden[i - 1], `el orden de las marcas se rompió en ${i}`);
  }
});

test('las medidas de arranque de la interfaz se registran y las pestañas no pueden inyectarlas', async () => {
  await settle();
  const { marks } = await import('../src/main/perf.js');
  const listener = journal.ipcListeners.get('nexo:perf');
  assert.ok(listener, 'falta el canal nexo:perf');

  // La shell sí: se aceptan números y se guardan con prefijo `ui-`.
  listener({ sender: { getType: () => 'window' } }, { config: 12.3, pestana: 41, basura: 'no es un número' });
  assert.equal(marks()['ui-config'], 12.3);
  assert.equal(marks()['ui-pestana'], 41);
  assert.equal(marks()['ui-basura'], undefined);

  // Una página web no puede escribir en el informe de arranque.
  listener({ sender: { getType: () => 'webview' } }, { config: 999 });
  assert.equal(marks()['ui-config'], 12.3);
  // Ni un mensaje sin forma.
  listener({ sender: { getType: () => 'window' } }, null);
  assert.equal(marks()['ui-config'], 12.3);
});

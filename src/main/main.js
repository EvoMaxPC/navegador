/**
 * Proceso principal de Nexo.
 *
 * Una ventana con la interfaz de navegador (pestañas al estilo Chromium) y una
 * `<webview>` por pestaña. Cada webview lleva el preload que inyecta la capa de
 * mediación en el sitio de IA.
 */

import { app, BrowserWindow, ipcMain, protocol, session, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createMemory } from './memory.js';
import { createProfile } from './profile.js';
import { buildMenu } from './menu.js';
import { DEFAULT_SETTINGS } from '../core/settings.js';
import { hostOf, isInternal } from '../nav/url.js';
import { commandFor } from '../nav/shortcuts.js';
import { sanitizeFilename } from '../nav/downloads.js';
import { runSmoke, report as reportSmoke, render as renderSmoke } from './smoke.js';
import { eventMessage, permissionName, safeExternalUrl, sessionPayload } from './validate.js';
import { PERMISSION_CATALOG } from '../nav/permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SHELL_PRELOAD = join(ROOT, 'src', 'preload', 'shell.cjs');
const PAGE_PRELOAD = join(ROOT, 'src', 'preload', 'bridge.cjs');

const isDev = process.argv.includes('--dev');
/** `--smoke`: arranca, revisa la interfaz y sale. Lo usa el flujo de Windows. */
const isSmoke = process.argv.includes('--smoke') || process.env.NEXO_SMOKE === '1';
/**
 * Archivo donde la prueba de humo deja su informe. En Windows el ejecutable es
 * una aplicación de interfaz: lo que escribe en la consola no llega al proceso
 * que lo lanzó, así que el resultado también va a un archivo.
 */
const smokeOut = process.env.NEXO_SMOKE_OUT || null;

/** Evita que una excepción de apagado cambie un resultado ya escrito. */
let smokeDone = false;

if (isSmoke && smokeOut) {
  // Si el arranque revienta antes de la prueba, el archivo tiene que decirlo.
  const crash = (kind) => (error) => {
    if (smokeDone) {
      // Tarde: el informe ya está y el código de salida ya se decidió.
      appendFile(smokeOut, `\n· ${kind} durante el apagado: ${error?.message || error}\n`).catch(() => {});
      return;
    }
    appendFile(smokeOut, `\n✖ ${kind} al arrancar: ${error?.stack || error}\n`).finally(() =>
      app.exit(70),
    );
  };
  process.on('uncaughtException', crash('excepción'));
  process.on('unhandledRejection', crash('promesa rechazada'));
}

let win = null;
let store = null;
let engine = null;
let memory = null;
let profile = null;
/** Guardado diferido: navegar no debe escribir en disco en cada clic. */
let saveTimer = null;
/** Relación entre descargas de Chromium y entradas del perfil. */
const downloadItems = new Map();
let downloadSeq = 0;

/**
 * Esquema propio para servir la interfaz y la sala de pruebas desde el disco.
 * Permite módulos ES (que `file://` bloquea por CORS) y funciona sin conexión.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nexo',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Sirve la interfaz y la sala de pruebas desde el disco (o desde el asar del
 * empaquetado, que `node:fs` lee de forma transparente).
 *
 * Se lee con `fs` en lugar de `net.fetch('file://…')` para controlar el
 * `Content-Type` —los módulos ES no cargan sin `text/javascript`— y para poder
 * decir «no encontrado» sin que Chromium lo interprete como un fallo de red.
 */
function registerProtocol() {
  protocol.handle('nexo', async (request) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Pedido inválido', { status: 400 });
    }
    if (pathname.includes('\0')) return new Response('Pedido inválido', { status: 400 });
    if (pathname.endsWith('/') || pathname === '') pathname += 'index.html';
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT + sep)) {
      return new Response('Prohibido', { status: 403 });
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) return new Response('No encontrado', { status: 404 });
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
          'content-length': String(info.size),
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('No encontrado', { status: 404 });
    }
  });
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#07080c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: true,
    },
  });

  // En modo humo la ventana queda oculta: hay runners sin escritorio donde
  // mostrar una ventana falla, y la prueba no necesita ver nada.
  if (!isSmoke) win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  // Endurecimiento de cada webview antes de que se cree.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = PAGE_PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
    webPreferences.webSecurity = true;
    if (!/^https?:/i.test(params.src || '') && !String(params.src || '').startsWith('nexo:')) {
      event.preventDefault();
    }
  });

  // Las pestañas no pueden abrir ventanas: se convierten en pestañas nuevas.
  win.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      broadcast('nexo:open-tab', { url });
      return { action: 'deny' };
    });

    // Historial: se registra desde el proceso principal para que no dependa de
    // que el JavaScript de la interfaz esté vivo.
    const recordVisit = (url, transition = 'link') => {
      if (!profile || isInternal(url)) return;
      profile.history.add({ url, title: contents.getTitle() || url, transition });
      scheduleProfileSave();
    };
    contents.on('did-navigate', (_e, url) => recordVisit(url));
    contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) recordVisit(url, 'in-page');
    });
    contents.on('page-title-updated', (_e, title) => {
      const url = contents.getURL();
      if (profile && url) profile.history.retitle(url, title);
    });
    contents.on('did-finish-load', () => {
      applyZoom(contents);
    });

    // Atajos del navegador aunque la página tenga el foco: los aceleradores del
    // menú no siempre ganan contra una webview, y Ctrl+F se lo come el sitio.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const command = commandFor(input, { platform: process.platform });
      // Escape y teclas sin modificador siguen siendo de la página.
      if (!command || command === 'escape') return;
      if (!input.control && !input.meta && !input.alt) return;
      event.preventDefault();
      broadcast('nexo:command', { type: command });
    });

    contents.on('destroyed', () => {
      engine?.dropTab(contents.id);
      if (profile) profile.saveAll();
    });
    if (isDev) contents.on('console-message', (_e, level, message) => console.log('[pestaña]', message));
  });

  win.loadURL('nexo://app/src/ui/shell/index.html');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function registerIpc() {
  ipcMain.handle('nexo:config', (_event, payload = {}) => engine.configFor(payload.host || ''));
  ipcMain.handle('nexo:prepare', (event, payload) => engine.prepare(event.sender.id, payload));
  ipcMain.handle('nexo:stream-end', (event, payload) => engine.onStreamEnd(event.sender.id, payload));
  ipcMain.handle('nexo:stream-stop', (event, payload) => engine.onStreamStop(event.sender.id, payload));

  ipcMain.handle('nexo:settings:get', () => store.settings);
  ipcMain.handle('nexo:settings:set', (_event, patch) => {
    const next = store.setSettings(patch);
    engine.refresh();
    broadcast('nexo:settings-changed', next);
    return next;
  });
  ipcMain.handle('nexo:settings:reset', () => {
    const next = store.setSettings(DEFAULT_SETTINGS);
    engine.refresh();
    broadcast('nexo:settings-changed', next);
    return next;
  });

  ipcMain.handle('nexo:log', () => store.log);
  ipcMain.handle('nexo:log:clear', () => {
    store.clearLog();
    return [];
  });
  ipcMain.handle('nexo:stats', () => ({ ...engine.stats(), log: store.log.length }));

  /* ---------------- EVO MEMORY ---------------- */
  ipcMain.handle('nexo:memory:stats', () => ({ ...engine.memoryStats(), file: memory?.file || null }));
  ipcMain.handle('nexo:memory:list', () => engine.memoryList());
  ipcMain.handle('nexo:memory:recall', (_event, payload = {}) =>
    engine.memoryRecall(String(payload.query || ''), { limit: payload.limit || 12 }));
  ipcMain.handle('nexo:memory:pin', (_event, payload = {}) => engine.memoryPin(payload.id, payload.pinned !== false));
  ipcMain.handle('nexo:memory:forget', (_event, payload = {}) => engine.memoryForget(payload.id));
  ipcMain.handle('nexo:memory:handoff', () => engine.memoryHandoff());
  ipcMain.handle('nexo:memory:import', (_event, packet) => {
    const result = engine.memoryImport(packet);
    broadcast('nexo:memory-changed', engine.memoryStats());
    return result;
  });
  ipcMain.handle('nexo:memory:clear', () => {
    const result = engine.memoryClear();
    broadcast('nexo:memory-changed', engine.memoryStats());
    return result;
  });
  ipcMain.handle('nexo:shell:config', () => ({
    version: app.getVersion(),
    pagePreload: `file://${PAGE_PRELOAD}`,
    platform: process.platform,
  }));

  // Sólo las pestañas pueden anunciar eventos, y sólo con la forma esperada:
  // sin esto, cualquier página podría inventar «intervenciones» en el panel.
  ipcMain.on('nexo:event', (event, message) => {
    if (event.sender?.getType?.() !== 'webview') return;
    const href = event.sender.getURL?.() || '';
    const clean = eventMessage(message, { href });
    if (clean) broadcast('nexo:event', clean);
  });

  ipcMain.handle('nexo:open-external', async (_event, url) => {
    const safe = safeExternalUrl(url);
    if (!safe) return { ok: false, error: 'esquema no permitido' };
    try {
      await shell.openExternal(safe);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || 'no se pudo abrir' };
    }
  });

  /* ---------------- navegador: perfil ---------------- */
  ipcMain.handle('nexo:profile:stats', () => profile?.stats() || null);
  ipcMain.handle('nexo:profile:clear', (_event, scope = {}) => {
    const result = profile?.clear(scope) || {};
    broadcast('nexo:profile-changed', profile?.stats() || null);
    return result;
  });

  /* ---------------- historial ---------------- */
  ipcMain.handle('nexo:history:list', (_event, payload = {}) => {
    if (!profile) return [];
    const limit = Math.min(500, Number(payload.limit) || 100);
    return payload.query
      ? profile.history.search(payload.query, { limit })
      : profile.history.recent({ limit, offset: Number(payload.offset) || 0 });
  });
  ipcMain.handle('nexo:history:top', (_event, payload = {}) => profile?.history.topSites(payload) || []);
  ipcMain.handle('nexo:history:remove', (_event, id) => ({ ok: Boolean(profile?.history.remove(id)) }));
  ipcMain.handle('nexo:history:clear', (_event, payload = {}) => {
    const since = payload.range === 'all' ? null : Date.now() - rangeMs(payload.range);
    const result = profile?.history.clear({ since }) || { removed: 0 };
    profile?.history.save({ force: true });
    broadcast('nexo:profile-changed', profile?.stats() || null);
    return result;
  });
  ipcMain.handle('nexo:suggest', async (_event, payload = {}) => {
    if (!profile) return [];
    const query = String(payload.query || '');
    const bookmarks = profile.bookmarks.suggest(query, { limit: 4 });
    const history = profile.history.suggest(query, { limit: 6 });
    const seen = new Set();
    return [...bookmarks, ...history].filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    }).slice(0, 8);
  });

  /* ---------------- marcadores ---------------- */
  ipcMain.handle('nexo:bookmarks:list', (_event, payload = {}) => profile?.bookmarks.list(payload) || []);
  ipcMain.handle('nexo:bookmarks:folders', () => profile?.bookmarks.folders() || []);
  ipcMain.handle('nexo:bookmarks:is', (_event, url) => Boolean(profile?.bookmarks.isBookmarked(url)));
  ipcMain.handle('nexo:bookmarks:toggle', (_event, payload = {}) => {
    const result = profile?.bookmarks.toggle(payload) || { added: false, bookmark: null };
    profile?.bookmarks.save({ force: true });
    broadcast('nexo:bookmarks-changed', { url: payload.url, added: result.added });
    return result;
  });
  ipcMain.handle('nexo:bookmarks:clear', () => {
    const result = profile?.bookmarks.clear() || { removed: 0 };
    profile?.bookmarks.save({ force: true });
    broadcast('nexo:bookmarks-changed', {});
    return result;
  });
  ipcMain.handle('nexo:bookmarks:remove', (_event, id) => {
    const ok = Boolean(profile?.bookmarks.remove(id));
    profile?.bookmarks.save({ force: true });
    broadcast('nexo:bookmarks-changed', {});
    return { ok };
  });

  /* ---------------- descargas ---------------- */
  ipcMain.handle('nexo:downloads:list', () => profile?.downloads.list({ limit: 100 }) || []);
  ipcMain.handle('nexo:downloads:open', async (_event, id) => {
    const item = profile?.downloads.get(id);
    if (!item?.savePath) return { ok: false };
    const error = await shell.openPath(item.savePath);
    return { ok: !error, error: error || null };
  });
  ipcMain.handle('nexo:downloads:show', (_event, id) => {
    const item = profile?.downloads.get(id);
    if (!item?.savePath) return { ok: false };
    shell.showItemInFolder(item.savePath);
    return { ok: true };
  });
  ipcMain.handle('nexo:downloads:cancel', (_event, id) => {
    const entry = downloadItems.get(id);
    if (!entry) return { ok: false };
    entry.item.cancel();
    return { ok: true };
  });
  ipcMain.handle('nexo:downloads:clear', () => {
    const result = profile?.downloads.clearFinished() || { removed: 0 };
    profile?.downloads.save({ force: true });
    broadcast('nexo:downloads-changed', profile?.downloads.stats() || null);
    return result;
  });

  /* ---------------- permisos y zoom ---------------- */
  ipcMain.handle('nexo:permissions:for', (_event, host) => profile?.permissions.rulesFor(host) || []);
  ipcMain.handle('nexo:permissions:set', (_event, payload = {}) => {
    const permission = permissionName(payload.permission, PERMISSION_CATALOG);
    if (!permission) return { ok: false, error: 'permiso desconocido' };
    const ok = Boolean(profile?.permissions.set(payload.host, permission, payload.value));
    profile?.permissions.save({ force: true });
    return { ok };
  });
  ipcMain.handle('nexo:permissions:sites', () => profile?.permissions.list() || []);
  ipcMain.handle('nexo:permissions:clear', (_event, host) => {
    const result = profile?.permissions.clear(host);
    profile?.permissions.save({ force: true });
    return { ok: Boolean(result) };
  });
  ipcMain.handle('nexo:zoom:get', (_event, target) => profile?.zoom.get(target) ?? 1);
  ipcMain.handle('nexo:zoom:set', (_event, payload = {}) => {
    const level = profile?.zoom.set(payload.target, payload.level) ?? 1;
    profile?.zoom.save();
    return { level };
  });
  ipcMain.handle('nexo:zoom:list', () => profile?.zoom.list() || []);

  /* ---------------- datos del sitio ---------------- */
  ipcMain.handle('nexo:data:clear', async (_event, scope = {}) => {
    const target = session.fromPartition('persist:nexo');
    const done = { ok: true, cookies: false, cache: false };
    try {
      if (scope.cookies) {
        await target.clearStorageData({
          storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
        });
        done.cookies = true;
      }
      if (scope.cache) {
        await target.clearCache();
        done.cache = true;
      }
    } catch (error) {
      done.ok = false;
      done.error = error.message;
    }
    return done;
  });

  /* ---------------- sesión ---------------- */
  ipcMain.handle('nexo:session:capture', (_event, payload = {}) => {
    profile?.session.capture(sessionPayload(payload).windows);
    return { ok: true };
  });
  ipcMain.handle('nexo:session:restore', () => profile?.session.restore() || null);
  ipcMain.on('nexo:session:save-now', (_event, payload = {}) => {
    try {
      profile?.session.capture(sessionPayload(payload).windows);
    } catch (error) {
      console.error('[nexo] no se pudo guardar la sesión:', error.message);
    }
  });
  ipcMain.handle('nexo:session:clear', () => {
    profile?.session.clear();
    return { ok: true };
  });
}

/** Guarda el perfil poco después del último cambio, no en cada navegación. */
function scheduleProfileSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      profile?.saveAll();
    } catch (error) {
      console.error('[nexo] no se pudo guardar el perfil:', error.message);
    }
  }, 4000);
}

/** Milisegundos de los rangos de borrado que ofrece el historial. */
function rangeMs(range) {
  const hour = 3_600_000;
  switch (range) {
    case 'hour':
      return hour;
    case 'day':
      return 24 * hour;
    case 'week':
      return 7 * 24 * hour;
    case 'month':
      return 30 * 24 * hour;
    default:
      return 0;
  }
}

/** Aplica el zoom guardado del sitio a una pestaña. */
function applyZoom(contents) {
  if (!profile) return;
  try {
    const level = profile.zoom.get(contents.getURL());
    if (Math.abs(contents.getZoomFactor() - level) > 0.001) contents.setZoomFactor(level);
  } catch {
    /* una pestaña destruida no debería tumbar el proceso principal */
  }
}

// Un único perfil persistente: las sesiones de los sitios de IA sobreviven al
// cierre de la aplicación, igual que en un navegador normal.
function configureSession() {
  const s = session.fromPartition('persist:nexo');

  // Permisos por sitio: la política del perfil decide, y todo lo denegado queda
  // registrado para que el usuario sepa por qué un sitio no funciona como espera.
  s.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const host = hostOf(webContents?.getURL() || '') || hostOf(details?.requestingUrl || '');
    const decision = profile ? profile.permissions.decide(host, permission) : 'deny';
    const granted = decision === 'allow';
    if (!granted && profile) {
      const entry = {
        kind: 'system',
        code: 'permission-denied',
        severity: 'info',
        title: `Permiso «${permission}» no concedido a ${host || 'sitio desconocido'}`,
        detail: 'Podés habilitarlo en Panel → Sitios cuando quieras.',
        ts: Date.now(),
      };
      store.pushLog(entry);
      broadcast('nexo:event', { type: 'intervention', payload: entry });
    }
    callback(granted);
  });
  s.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!profile) return false;
    return profile.permissions.decide(hostOf(requestingOrigin), permission) === 'allow';
  });

  // Descargas: se reflejan en el gestor del perfil.
  s.on('will-download', (_event, item) => {
    if (!profile) return;
    downloadSeq += 1;
    const id = `dl-${Date.now().toString(36)}-${downloadSeq}`;
    const entry = profile.downloads.start({
      id,
      url: item.getURL(),
      filename: sanitizeFilename(item.getFilename()),
      totalBytes: item.getTotalBytes(),
    });
    downloadItems.set(id, { item, entry });
    broadcast('nexo:downloads-changed', profile.downloads.stats());

    item.on('updated', (_e, state) => {
      if (state === 'interrupted') {
        profile.downloads.finish(id, { state: 'interrupted' });
      } else if (state === 'progressing') {
        profile.downloads.progress(id, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      }
      broadcast('nexo:downloads-changed', profile.downloads.stats());
    });

    item.once('done', (_e, state) => {
      const savePath = item.getSavePath() || null;
      profile.downloads.finish(id, {
        state: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
        savePath,
      });
      profile.downloads.save({ force: true });
      downloadItems.delete(id);
      broadcast('nexo:downloads-changed', profile.downloads.stats());
      broadcast('nexo:download-done', { id, state, filename: item.getFilename() });
    });
  });

  return s;
}

app.whenReady().then(async () => {
  store = new Store();
  const created = createMemory({
    dir: app.getPath('userData'),
    projectId: store.settings.memory?.projectId || 'default',
    projectName: store.settings.memory?.projectName || null,
    maxItems: store.settings.memory?.maxItems,
    episodeEvery: store.settings.memory?.episodeEvery,
  });
  memory = created;
  profile = createProfile({ dir: app.getPath('userData') });
  profile.history.prune();
  engine = new Engine({
    store,
    memory: created.memory,
    onEvent: (entry) => broadcast('nexo:event', { type: 'intervention', payload: entry }),
  });
  registerProtocol();
  registerIpc();
  configureSession();
  buildMenu({ send: (channel, payload) => broadcast(channel, payload) });
  createWindow();

  if (isSmoke) {
    // Sin ventana visible ni interacción: sólo comprobar que el paquete vivo
    // carga la shell desde el asar. Cualquier excepción debe terminar el
    // proceso, no dejarlo colgado en CI.
    const smoke = await runSmoke({ win }).catch((error) => ({
      ok: false,
      checks: [{ name: 'prueba de humo', ok: false, detail: error?.message || String(error) }],
    }));
    smokeDone = true;
    const code = reportSmoke(smoke);
    if (smokeOut) {
      // `reportSmoke` ya escribió en consola; el archivo es la vía confiable.
      const informe = `${renderSmoke(smoke)}código previsto: ${code}\n`;
      await writeFile(smokeOut, informe, 'utf8').catch(() => {});
    }
    app.exit(code);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// La sesión y el perfil se guardan al salir, incluso si la ventana se cerró de
// golpe: son datos que el usuario espera recuperar.
app.on('before-quit', () => {
  try {
    profile?.saveAll();
    memory?.flush?.();
  } catch (error) {
    console.error('[nexo] no se pudo guardar el perfil:', error.message);
  }
});

// Endurecimiento: ninguna pestaña puede pedir Node ni cambiar su preload.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
});

export { ROOT, PAGE_PRELOAD, SHELL_PRELOAD };

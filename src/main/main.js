/**
 * Proceso principal de Nexo.
 *
 * Una ventana con la interfaz de navegador (pestañas al estilo Chromium) y una
 * `<webview>` por pestaña. Cada webview lleva el preload que inyecta la capa de
 * mediación en el sitio de IA.
 */

import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createMemory } from './memory.js';
import { buildMenu } from './menu.js';
import { DEFAULT_SETTINGS } from '../core/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SHELL_PRELOAD = join(ROOT, 'src', 'preload', 'shell.cjs');
const PAGE_PRELOAD = join(ROOT, 'src', 'preload', 'bridge.cjs');

const isDev = process.argv.includes('--dev');

let win = null;
let store = null;
let engine = null;
let memory = null;

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

function registerProtocol() {
  protocol.handle('nexo', async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/') || pathname === '') pathname += 'index.html';
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT + sep)) {
      return new Response('Prohibido', { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(file).toString());
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

  win.once('ready-to-show', () => win.show());
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
    contents.on('destroyed', () => engine?.dropTab(contents.id));
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

  ipcMain.on('nexo:event', (_event, message) => {
    broadcast('nexo:event', message);
  });

  ipcMain.handle('nexo:open-external', (_event, url) => shell.openExternal(url));
}

// Un único perfil persistente: las sesiones de los sitios de IA sobreviven al
// cierre de la aplicación, igual que en un navegador normal.
function configureSession() {
  const s = session.fromPartition('persist:nexo');
  s.setPermissionRequestHandler((_wc, permission, callback) => {
    // Solo se conceden permisos que los chats necesitan de verdad.
    callback(['clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission));
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Endurecimiento: ninguna pestaña puede pedir Node ni cambiar su preload.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
});

export { ROOT, PAGE_PRELOAD, SHELL_PRELOAD };

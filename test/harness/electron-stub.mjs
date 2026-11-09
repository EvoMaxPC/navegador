/**
 * Electron falso para auditar el proceso principal sin display.
 *
 * No sustituye una prueba real de navegación: sirve para ejecutar el arranque,
 * el registro de IPC, el menú, los permisos y las descargas con el código de
 * producción, y encontrar errores que de otro modo solo aparecen al abrir la
 * ventana.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Registro de todo lo que el código de producción hace contra Electron. */
export const journal = {
  windows: [],
  ipcHandlers: new Map(),
  ipcListeners: new Map(),
  schemes: [],
  schemeHandlers: new Map(),
  menus: [],
  sessions: new Map(),
  permissions: { request: null, check: null },
  downloads: [],
  external: [],
  switches: [],
  quit: false,
  userData: mkdtempSync(join(tmpdir(), 'nexo-audit-')),
};

let nextId = 10;

export class FakeWebContents extends EventEmitter {
  constructor(type = 'window', url = 'https://claude.ai/') {
    super();
    this.id = (nextId += 1);
    this.type = type;
    this.url = url;
    this.title = 'Título de prueba';
    this.zoomFactor = 1;
    this.sent = [];
    this.destroyed = false;
    this.reloads = 0;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
    this.emit('sent', { channel, payload });
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  getURL() {
    return this.url;
  }

  getTitle() {
    return this.title;
  }

  getType() {
    return this.type;
  }

  isDestroyed() {
    return this.destroyed;
  }

  openDevTools() {}

  setZoomFactor(value) {
    this.zoomFactor = value;
  }

  getZoomFactor() {
    return this.zoomFactor;
  }

  /** Simula una recarga pedida por el proceso principal. */
  reload() {
    this.reloads = (this.reloads || 0) + 1;
    this.emit('did-finish-load');
    return this;
  }

  /** Simula una navegación completa del usuario. */
  navigateTo(url, title = 'Página') {
    this.url = url;
    this.title = title;
    this.emit('did-navigate', {}, url);
    this.emit('page-title-updated', {}, title);
    this.emit('did-finish-load');
    return this;
  }
}

class FakeSession extends EventEmitter {
  constructor(partition) {
    super();
    this.partition = partition;
    this.cleared = [];
  }

  setSpellCheckerEnabled(enabled) {
    this.spellcheck = enabled;
    journal.spellcheck = enabled;
  }

  setPermissionRequestHandler(fn) {
    journal.permissions.request = fn;
  }

  setPermissionCheckHandler(fn) {
    journal.permissions.check = fn;
  }

  async clearStorageData(options) {
    this.cleared.push({ type: 'storage', options });
  }

  async clearCache() {
    this.cleared.push({ type: 'cache' });
  }
}

export class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents('window');
    this.attachedWebviews = [];
    journal.windows.push(this);
  }

  once(event, callback) {
    if (event === 'ready-to-show') queueMicrotask(callback);
    return super.once(event, callback);
  }

  loadURL(url) {
    this.loadedUrl = url;
    return Promise.resolve();
  }

  isDestroyed() {
    return false;
  }

  show() {}

  /** Simula que la interfaz adjunta una pestaña. */
  attachWebview(url = 'https://claude.ai/') {
    const contents = new FakeWebContents('webview', url);
    this.attachedWebviews.push(contents);
    // Electron anuncia el webContents nuevo antes de adjuntarlo a la ventana; el
    // proceso principal engancha ahí el endurecimiento y la recuperación.
    app.emit('web-contents-created', {}, contents);
    this.webContents.emit('did-attach-webview', {}, contents);
    return contents;
  }

  static getAllWindows() {
    return journal.windows;
  }
}

export const app = Object.assign(new EventEmitter(), {
  name: 'Nexo',
  commandLine: {
    appendSwitch(name, value) {
      journal.switches.push({ name, value });
    },
    hasSwitch: (name) => journal.switches.some((item) => item.name === name),
    getSwitchValue: (name) => journal.switches.find((item) => item.name === name)?.value || '',
  },
  whenReady: () => Promise.resolve(),
  getPath: () => journal.userData,
  getVersion: () => '0.1.0',
  getAppMetrics: () => [],
  quit: () => {
    journal.quit = true;
    app.emit('before-quit');
  },
});

export const ipcMain = {
  handle(channel, handler) {
    journal.ipcHandlers.set(channel, handler);
  },
  on(channel, handler) {
    journal.ipcListeners.set(channel, handler);
  },
  removeHandler(channel) {
    journal.ipcHandlers.delete(channel);
  },
};

export const protocol = {
  registerSchemesAsPrivileged(schemes) {
    journal.schemes.push(...schemes);
  },
  handle(scheme, handler) {
    journal.schemeHandlers.set(scheme, handler);
  },
};

export const session = {
  fromPartition(name) {
    if (!journal.sessions.has(name)) journal.sessions.set(name, new FakeSession(name));
    return journal.sessions.get(name);
  },
  get defaultSession() {
    return session.fromPartition('default');
  },
};

export const shell = {
  async openExternal(url) {
    journal.external.push({ type: 'external', url });
  },
  async openPath(path) {
    journal.external.push({ type: 'path', path });
    return '';
  },
  showItemInFolder(path) {
    journal.external.push({ type: 'folder', path });
  },
};

export const Menu = {
  buildFromTemplate(template) {
    const menu = { template };
    journal.menus.push(menu);
    return menu;
  },
  setApplicationMenu(menu) {
    journal.appMenu = menu;
  },
  getApplicationMenu() {
    return journal.appMenu || null;
  },
};

export const net = {
  async fetch() {
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  },
};

export const clipboard = { writeText() {}, readText: () => '' };

export const dialog = {
  async showOpenDialog() {
    return { canceled: true, filePaths: [] };
  },
};

export { FakeBrowserWindow as BrowserWindow, FakeWebContents as WebContents, FakeSession };

export default {
  app,
  BrowserWindow: FakeBrowserWindow,
  ipcMain,
  protocol,
  session,
  shell,
  Menu,
  net,
  clipboard,
  dialog,
};

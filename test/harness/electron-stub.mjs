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
  contents: [],
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
  userAgents: [],
  /** Manos de `webRequest` por partición: el navegador sólo escucha, no modifica. */
  webRequest: { completed: new Map(), errors: new Map(), before: new Map() },
  quit: false,
  userData: mkdtempSync(join(tmpdir(), 'nexo-audit-')),
};

let nextId = 10;

/**
 * Depurador falso: imita la API de `webContents.debugger` (el CDP de Electron).
 *
 * Guarda los comandos enviados y permite inyectar eventos del protocolo con
 * `emitEvent(method, params)`, que es lo que hace Chromium cuando hay tráfico.
 * `failAttach` reproduce el caso «ya hay un depurador adjunto».
 */
export class FakeDebugger extends EventEmitter {
  constructor(contents = null) {
    super();
    this.contents = contents;
    this.attached = false;
    this.attachedVersion = null;
    this.commands = [];
    this.bodies = new Map();
    this.failAttach = null;
    this.failCommand = null;
    this.rejectBodyFor = new Set();
    /** Búfer inicial base64 del comando de streaming de Chromium. */
    this.streamBuffered = new Map();
  }

  attach(version) {
    if (this.failAttach) throw new Error(this.failAttach);
    if (this.attached) throw new Error('Debugger is already attached to the target');
    this.attached = true;
    this.attachedVersion = version;
    return this;
  }

  isAttached() {
    return this.attached;
  }

  detach() {
    if (!this.attached) throw new Error('Debugger is not attached to the target');
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  }

  async sendCommand(method, params = {}) {
    this.commands.push({ method, params });
    if (this.failCommand && this.failCommand.method === method) {
      throw new Error(this.failCommand.message || 'fallo simulado');
    }
    if (method === 'Network.streamResourceContent') {
      return { bufferedData: this.streamBuffered.get(params.requestId) || '' };
    }
    if (method === 'Network.getResponseBody') {
      if (this.rejectBodyFor.has(params.requestId)) {
        throw new Error('No resource with given identifier found');
      }
      const body = this.bodies.get(params.requestId);
      if (body === undefined) throw new Error('No resource with given identifier found');
      return typeof body === 'string' ? { body, base64Encoded: false } : body;
    }
    return {};
  }

  /** Evento del protocolo, como lo entrega Chromium. */
  emitEvent(method, params = {}) {
    this.emit('message', {}, method, params);
    return this;
  }
}

export class FakeWebContents extends EventEmitter {
  constructor(type = 'window', url = 'https://claude.ai/') {
    super();
    this.id = (nextId += 1);
    journal.contents.push(this);
    this.debugger = new FakeDebugger(this);
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

  /** Inicio de navegación (el proceso principal decide si observar el sitio). */
  startNavigation(url, isMainFrame = true) {
    this.emit('did-start-navigation', {}, url, false, isMainFrame);
    return this;
  }

  /** Simula una navegación completa del usuario. */
  navigateTo(url, title = 'Página') {
    this.startNavigation(url);
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
    this.schemeHandlers = new Map();
    this.protocol = { handle: (scheme, handler) => this.schemeHandlers.set(scheme, handler) };
  }

  get webRequest() {
    return {
      onCompleted: (filter, listener) => {
        journal.webRequest.completed.set(this.partition, { filter, listener });
      },
      onErrorOccurred: (filter, listener) => {
        journal.webRequest.errors.set(this.partition, { filter, listener });
      },
      onBeforeRequest: (filter, listener) => {
        journal.webRequest.before.set(this.partition, { filter, listener });
      },
    };
  }

  setUserAgent(ua) {
    this.userAgent = ua;
    journal.userAgents.push({ partition: this.partition, ua });
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
  /**
   * Lo que Electron pone por defecto: la huella que los sitios con protección
   * anti-bot leen para decidir si atienden al cliente. El proceso principal la
   * normaliza al arrancar.
   */
  userAgentFallback:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Nexo/0.1.0 Chrome/130.0.6723.137 Electron/33.2.0 Safari/537.36',
  getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled', webgl: 'enabled', rasterization: 'enabled' }),
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

export const webContents = { getAllWebContents: () => journal.contents.filter(contents => !contents.isDestroyed()), fromId: (id) => journal.contents.find((contents) => contents.id === id && !contents.isDestroyed()) };

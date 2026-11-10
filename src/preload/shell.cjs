/**
 * Preload de la interfaz del navegador.
 * Expone una API mínima y tipada al renderer de la shell (sin Node).
 */

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set([
  'nexo:event',
  'nexo:understanding-changed',
  'nexo:work-changed',
  'nexo:work-capture',
  'nexo:context-menu',
  'nexo:reading',
  'nexo:browser-prefs',
  'nexo:settings-changed',
  'nexo:command',
  'nexo:open-tab',
  'nexo:memory-changed',
  'nexo:profile-changed',
  'nexo:bookmarks-changed',
  'nexo:downloads-changed',
  'nexo:download-done',
  'nexo:stats-changed',
  'nexo:repetition-changed',
]);

contextBridge.exposeInMainWorld('nexo', {
  understanding: {
    read: p => ipcRenderer.invoke('nexo:understanding:read',p),
    edit: p => ipcRenderer.invoke('nexo:understanding:edit',p),
    recall: p => ipcRenderer.invoke('nexo:understanding:recall',p),
    contexts: p => ipcRenderer.invoke('nexo:understanding:contexts',p),
    bind: p => ipcRenderer.invoke('nexo:understanding:bind',p),
    clear: p => ipcRenderer.invoke('nexo:understanding:clear',p),
  },
  work: {
    read: payload => ipcRenderer.invoke('nexo:work:read', payload),
    mutate: payload => ipcRenderer.invoke('nexo:work:mutate', payload),
    attach: payload => ipcRenderer.invoke('nexo:work:attach', payload),
    capture: payload => ipcRenderer.invoke('nexo:work:capture', payload),
    clear: payload => ipcRenderer.invoke('nexo:work:clear', payload),
    export: payload => ipcRenderer.invoke('nexo:work:export', payload),
  },
  advanced: {
    preferences: () => ipcRenderer.invoke('nexo:advanced:prefs'),
    setPreferences: (prefs) => ipcRenderer.invoke('nexo:advanced:set-prefs', prefs),
    action: (payload) => ipcRenderer.invoke('nexo:advanced:action', payload),
    context: (payload) => ipcRenderer.invoke('nexo:advanced:context', payload),
  },

  getConfig: () => ipcRenderer.invoke('nexo:shell:config'),

  getSettings: () => ipcRenderer.invoke('nexo:settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('nexo:settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('nexo:settings:reset'),

  getLog: () => ipcRenderer.invoke('nexo:log'),
  clearLog: () => ipcRenderer.invoke('nexo:log:clear'),
  getStats: () => ipcRenderer.invoke('nexo:stats'),

  openExternal: (url) => ipcRenderer.invoke('nexo:open-external', url),

  profile: {
    stats: () => ipcRenderer.invoke('nexo:profile:stats'),
    clear: (scope) => ipcRenderer.invoke('nexo:profile:clear', scope),
  },

  history: {
    list: (payload) => ipcRenderer.invoke('nexo:history:list', payload),
    top: (payload) => ipcRenderer.invoke('nexo:history:top', payload),
    remove: (id) => ipcRenderer.invoke('nexo:history:remove', id),
    clear: (range) => ipcRenderer.invoke('nexo:history:clear', { range }),
  },

  suggest: (query) => ipcRenderer.invoke('nexo:suggest', { query }),

  bookmarks: {
    list: (payload) => ipcRenderer.invoke('nexo:bookmarks:list', payload),
    folders: () => ipcRenderer.invoke('nexo:bookmarks:folders'),
    is: (url) => ipcRenderer.invoke('nexo:bookmarks:is', url),
    toggle: (payload) => ipcRenderer.invoke('nexo:bookmarks:toggle', payload),
    remove: (id) => ipcRenderer.invoke('nexo:bookmarks:remove', id),
    clear: () => ipcRenderer.invoke('nexo:bookmarks:clear'),
  },

  downloads: {
    list: () => ipcRenderer.invoke('nexo:downloads:list'),
    open: (id) => ipcRenderer.invoke('nexo:downloads:open', id),
    show: (id) => ipcRenderer.invoke('nexo:downloads:show', id),
    cancel: (id) => ipcRenderer.invoke('nexo:downloads:cancel', id),
    clear: () => ipcRenderer.invoke('nexo:downloads:clear'),
  },

  permissions: {
    for: (host) => ipcRenderer.invoke('nexo:permissions:for', host),
    set: (payload) => ipcRenderer.invoke('nexo:permissions:set', payload),
    sites: () => ipcRenderer.invoke('nexo:permissions:sites'),
    clear: (host) => ipcRenderer.invoke('nexo:permissions:clear', host),
  },

  zoom: {
    get: (target) => ipcRenderer.invoke('nexo:zoom:get', target),
    set: (target, level) => ipcRenderer.invoke('nexo:zoom:set', { target, level }),
    list: () => ipcRenderer.invoke('nexo:zoom:list'),
  },

  data: {
    clear: (scope) => ipcRenderer.invoke('nexo:data:clear', scope),
  },

  /**
   * Medidas de arranque de la interfaz. Va sin respuesta: la interfaz no debe
   * esperar nada para pintar.
   * @param {Record<string, number>} data
   */
  perf: (data) => ipcRenderer.send('nexo:perf', data),

  session: {
    capture: (windows) => ipcRenderer.invoke('nexo:session:capture', { windows }),
    /** Guardado sin esperar respuesta: para el cierre de la ventana. */
    saveNow: (windows) => ipcRenderer.send('nexo:session:save-now', { windows }),
    restore: () => ipcRenderer.invoke('nexo:session:restore'),
    clear: () => ipcRenderer.invoke('nexo:session:clear'),
  },

  repetition: {
    get: (payload) => ipcRenderer.invoke('nexo:repetition:get', payload),
  },

  memory: {
    stats: () => ipcRenderer.invoke('nexo:memory:stats'),
    list: () => ipcRenderer.invoke('nexo:memory:list'),
    conversations: () => ipcRenderer.invoke('nexo:memory:conversations'),
    recall: (query, limit) => ipcRenderer.invoke('nexo:memory:recall', { query, limit }),
    pin: (id, pinned) => ipcRenderer.invoke('nexo:memory:pin', { id, pinned }),
    forget: (id) => ipcRenderer.invoke('nexo:memory:forget', { id }),
    handoff: () => ipcRenderer.invoke('nexo:memory:handoff'),
    import: (packet) => ipcRenderer.invoke('nexo:memory:import', packet),
    clear: () => ipcRenderer.invoke('nexo:memory:clear'),
  },

  on(channel, callback) {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`canal no permitido: ${channel}`);
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

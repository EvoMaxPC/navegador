/**
 * Preload de la interfaz del navegador.
 * Expone una API mínima y tipada al renderer de la shell (sin Node).
 */

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set(['nexo:event', 'nexo:settings-changed', 'nexo:command', 'nexo:open-tab']);

contextBridge.exposeInMainWorld('nexo', {
  getConfig: () => ipcRenderer.invoke('nexo:shell:config'),

  getSettings: () => ipcRenderer.invoke('nexo:settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('nexo:settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('nexo:settings:reset'),

  getLog: () => ipcRenderer.invoke('nexo:log'),
  clearLog: () => ipcRenderer.invoke('nexo:log:clear'),
  getStats: () => ipcRenderer.invoke('nexo:stats'),

  openExternal: (url) => ipcRenderer.invoke('nexo:open-external', url),

  on(channel, callback) {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`canal no permitido: ${channel}`);
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

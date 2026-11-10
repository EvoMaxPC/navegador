import { watchChatGptConversation } from '../core/chatgptConversation.js';

/** Lector del DOM compartido en el mundo AISLADO. No depende de fetch ni del JS del sitio. */
export function startChatGptReader({ document, window, ipcRenderer, config = {} }) {
  let settings = config.settings || {};
  const watcher = watchChatGptConversation({ document, window,
    isEnabled: () => settings.memory?.enabled !== false,
    publishLive: (payload) => ipcRenderer.invoke('nexo:repetition:snapshot', payload),
    publish: (payload) => payload.error
      ? ipcRenderer.send('nexo:event', { type: 'error', payload: { stage: 'conversation-reader', message: 'dom-read-failed' } })
      : ipcRenderer.invoke('nexo:conversation-snapshot', payload).catch(() => {}),
  });
  return {
    read: () => watcher.read({ force: true }),
    updateSettings(payload) { settings = payload?.settings || settings; watcher.read({ force: true }); },
    disconnect: () => watcher.disconnect(),
  };
}

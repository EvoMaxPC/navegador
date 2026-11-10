import { createConversationSaveQueue } from './conversationSaveQueue.js';
import { watchChatGptConversation } from '../core/chatgptConversation.js';

/** Lector del DOM compartido en el mundo AISLADO. No depende de fetch ni del JS del sitio. */
export function startChatGptReader({ document, window, ipcRenderer, config = {} }) {
  let settings = config.settings || {};
  const saves = createConversationSaveQueue(payload => ipcRenderer.invoke('nexo:conversation-snapshot', payload));
  const watcher = watchChatGptConversation({ document, window, memoryLiteral: true,
    // La observación actual es de UUE; main decide si además captura en EVO.
    isEnabled: () => true,
    publishLive: (payload) => ipcRenderer.invoke('nexo:repetition:snapshot', payload),
    publish: (payload) => payload.error
      ? ipcRenderer.send('nexo:event', { type: 'error', payload: { stage: 'conversation-reader', message: 'dom-read-failed' } })
      : saves.publish(payload),
  });
  window.addEventListener?.('pagehide', saves.flush);
  return {
    read: () => watcher.read({ force: true }),
    updateSettings(payload) { settings = payload?.settings || settings; watcher.read({ force: true }); },
    disconnect() { watcher.disconnect(); saves.cancel(); window.removeEventListener?.('pagehide', saves.flush); },
  };
}

import { watchChatGptConversation } from '../core/chatgptConversation.js';
import { readUnderstandingDom } from '../core/understandingConversation.js';
import { createConversationSaveQueue } from './conversationSaveQueue.js';

/** Inyección en mundo aislado: canal UUE propio, sin ajustes o APIs de EVO MEMORY. */
export function startUnderstandingReader({ document, window, ipcRenderer }) {
  const announce = () => {
    try {
      Promise.resolve(
        ipcRenderer.invoke('nexo:understanding:conversation', {
          href: window.location.href,
          ready: true,
        }),
      ).catch(() => {});
    } catch {
      /* main volverá a validar la entrega */
    }
  };
  const queue = createConversationSaveQueue((payload) =>
    ipcRenderer.invoke('nexo:understanding:conversation', payload),
  );
  announce();
  const watcher = watchChatGptConversation({
    document,
    window,
    isEnabled: () => true,
    readTurns: readUnderstandingDom,
    publish: (payload) => {
      if (payload.error) {
        ipcRenderer.send('nexo:event', {
          type: 'error',
          payload: {
            stage: 'understanding-reader',
            message: 'dom-read-failed',
          },
        });
        return { ok: false };
      }
      announce();
      return queue.publish(payload);
    },
  });
  window.addEventListener?.('pagehide', queue.flush);
  return {
    read: () => watcher.read({ force: true }),
    disconnect() {
      watcher.disconnect();
      queue.cancel();
      window.removeEventListener?.('pagehide', queue.flush);
    },
  };
}

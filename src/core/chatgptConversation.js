/** Historial visible de ChatGPT. Nunca lee composer, cookies ni campos de formulario. */
export const MAX_CONVERSATION_TURNS = 200;
export const MAX_TURN_CHARS = 10000;

export function isChatGptMemoryUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname) &&
      url.searchParams.get('temporary-chat') !== 'true';
  } catch { return false; }
}

export function readChatGptConversation(document) {
  const nodes = Array.from(document?.querySelectorAll?.('[data-message-author-role]') || []);
  return nodes.slice(-MAX_CONVERSATION_TURNS).flatMap((node, index) => {
    const role = node.getAttribute?.('data-message-author-role');
    if (!['user', 'assistant'].includes(role)) return [];
    const contentNode = role === 'assistant'
      ? node.querySelector?.('.markdown') || node.querySelector?.('.prose, [data-message-content]') || node
      : node;
    const raw = String(contentNode.innerText ?? contentNode.textContent ?? '').trim();
    if (!raw) return [];
    const id = node.getAttribute?.('data-message-id') ||
      node.closest?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
      node.closest?.('article[data-testid]')?.getAttribute?.('data-testid') || `visible-${Math.max(0, nodes.length - MAX_CONVERSATION_TURNS) + index}`;
    return [{ id, role, content: raw.slice(0, MAX_TURN_CHARS), clipped: raw.length > MAX_TURN_CHARS }];
  });
}

/** Un solo observador, agrupado; funciona aunque ChatGPT no use nuestro fetch. */
export function watchChatGptConversation({ document, window, publish, isEnabled = () => true, isStreaming = () => false }) {
  let timer = null, last = '', observer = null, stopped = false;
  const session = `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const read = () => {
    timer = null;
    if (stopped || !isEnabled() || !isChatGptMemoryUrl(window.location.href)) return;
    try {
      const turns = readChatGptConversation(document);
      if (!turns.length) return;
      const url = new URL(window.location.href);
      const conversationId = url.pathname.includes('/c/') ? url.pathname : `${url.pathname}#${session}`;
      const payload = { conversationId, href: window.location.href, turns, streaming: Boolean(isStreaming()) };
      const signature = JSON.stringify(payload);
      if (signature === last) return;
      last = signature;
      publish(payload);
    } catch (error) {
      // La página no debe romperse si cambia el DOM; error visible al consumidor.
      publish({ error: String(error?.message || error) });
    }
  };
  const schedule = () => { if (!stopped && !timer) timer = setTimeout(read, 500); };
  const start = () => {
    if (stopped) return;
    if (window.MutationObserver && document.body && !observer) {
      observer = new window.MutationObserver(schedule);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-message-id', 'data-message-author-role'] });
    }
    schedule();
  };
  document.addEventListener?.('DOMContentLoaded', start, { once: true });
  window.addEventListener?.('popstate', schedule);
  window.addEventListener?.('pagehide', () => { read(); stopped = true; observer?.disconnect(); clearTimeout(timer); });
  start();
  return { read, disconnect() { stopped = true; clearTimeout(timer); observer?.disconnect(); } };
}

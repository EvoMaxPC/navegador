import { REPETITION_MAX_CHARS, REPETITION_MAX_TURN_CHARS } from './conversationRepetition.js';

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

export function readChatGptConversation(document, { literal = false } = {}) {
  const nodes = Array.from(document?.querySelectorAll?.('[data-message-author-role]') || []);
  return nodes.slice(-MAX_CONVERSATION_TURNS).flatMap((node, index) => {
    const role = node.getAttribute?.('data-message-author-role');
    if (!['user', 'assistant'].includes(role)) return [];
    const contentNode = role === 'assistant'
      ? node.querySelector?.('.markdown') || node.querySelector?.('.prose, [data-message-content]') || node
      : (literal ? node.querySelector?.('.whitespace-pre-wrap') || node : node);
    const value = String(contentNode.innerText ?? contentNode.textContent ?? '');
    const raw = literal ? value : value.trim();
    if (!raw) return [];
    const id = node.getAttribute?.('data-message-id') ||
      node.closest?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
      node.closest?.('article[data-testid]')?.getAttribute?.('data-testid') || `visible-${Math.max(0, nodes.length - MAX_CONVERSATION_TURNS) + index}`;
    const limit = literal ? REPETITION_MAX_TURN_CHARS : MAX_TURN_CHARS;
    return [{ id: literal ? String(id).slice(0, 256) : id, role, content: raw.slice(0, limit), clipped: raw.length > limit }];
  });
}

/** Un solo observador, agrupado; funciona aunque ChatGPT no use nuestro fetch. */
export function watchChatGptConversation({ document, window, publish, isEnabled = () => true, isStreaming = () => false, publishLive = null }) {
  if (typeof document?.querySelectorAll !== 'function') return { read() {}, disconnect() {} };
  let timer = null, last = '', lastLive = '', observer = null, stopped = false;
  const session = `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const read = () => {
    timer = null;
    if (stopped || (!isEnabled() && !publishLive) || !isChatGptMemoryUrl(window.location.href)) return;
    try {
      const url = new URL(window.location.href);
      if (publishLive) {
        const turns = readChatGptConversation(document, { literal: true });
        let remaining = REPETITION_MAX_CHARS;
        let clipped = (document.querySelectorAll?.('[data-message-author-role]') || []).length > MAX_CONVERSATION_TURNS;
        const bounded = turns.flatMap((turn) => {
          if (!remaining) { clipped = true; return []; }
          const content = turn.content.slice(0, remaining);
          remaining -= content.length;
          return [{ ...turn, content, clipped: turn.clipped || content.length < turn.content.length }];
        });
        const live = { href: window.location.href, turns: bounded, clipped, streaming: Boolean(isStreaming()) };
        const signature = JSON.stringify(live);
        if (signature !== lastLive) { lastLive = signature; publishLive(live); }
      }
      if (!isEnabled()) return;
      const turns = readChatGptConversation(document);
      if (!turns.length) return;
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
  window.addEventListener?.('hashchange', schedule);
  window.addEventListener?.('pagehide', () => { read(); stopped = true; observer?.disconnect(); clearTimeout(timer); });
  start();
  return { read, disconnect() { stopped = true; clearTimeout(timer); observer?.disconnect(); } };
}

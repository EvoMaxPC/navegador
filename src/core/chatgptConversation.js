import { selectChatGptMessages, chatGptMessageContent, chatGptMessageId, isChatGptStreaming } from './chatgptAdapter.js';
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

export function readChatGptConversation(document, { literal = false, selection = selectChatGptMessages(document) } = {}) {
  const nodes = selection.messages;
  return nodes.slice(-MAX_CONVERSATION_TURNS).flatMap(({ node, role }, index) => {
    const contentNode = chatGptMessageContent(node, role);
    const value = String(contentNode.innerText ?? contentNode.textContent ?? '');
    const raw = literal ? value : value.trim();
    if (!raw) return [];
    const id = chatGptMessageId(node, Math.max(0, nodes.length - MAX_CONVERSATION_TURNS) + index);
    const limit = literal ? REPETITION_MAX_TURN_CHARS : MAX_TURN_CHARS;
    return [{ id: literal ? String(id).slice(0, 256) : id, role, content: raw.slice(0, limit), clipped: raw.length > limit }];
  });
}

/** Un solo observador, agrupado; funciona aunque ChatGPT no use nuestro fetch. */
export function watchChatGptConversation({ document, window, publish, isEnabled = () => true, isStreaming = () => isChatGptStreaming(document), publishLive = null }) {
  if (typeof document?.querySelectorAll !== 'function') return { read() {}, disconnect() {} };
  let timer = null, pollTimer = null, last = '', lastLive = '', observer = null, stopped = false, suspended = false;
  const session = `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const read = ({ force = false } = {}) => {
    clearTimeout(timer); timer = null;
    if (force) { last = ''; lastLive = ''; }
    if (stopped || suspended || (!isEnabled() && !publishLive) || !isChatGptMemoryUrl(window.location.href)) return;
    try {
      const url = new URL(window.location.href);
      const selection = selectChatGptMessages(document);
      if (publishLive) {
        const turns = readChatGptConversation(document, { literal: true, selection });
        let remaining = REPETITION_MAX_CHARS;
        let clipped = selection.messages.length > MAX_CONVERSATION_TURNS;
        const bounded = turns.flatMap((turn) => {
          if (!remaining) { clipped = true; return []; }
          const content = turn.content.slice(0, remaining);
          remaining -= content.length;
          return [{ ...turn, content, clipped: turn.clipped || content.length < turn.content.length }];
        });
        const live = { href: window.location.href, strategy: selection.strategy, turns: bounded, clipped, streaming: Boolean(isStreaming()) };
        const signature = JSON.stringify(live);
        if (signature !== lastLive) {
          lastLive = signature;
          // No considerar entregado un snapshot rechazado por IPC (p. ej. URL aún navegando).
          const delivery = publishLive(live);
          const rejected = () => { if (lastLive === signature) lastLive = ''; };
          if (delivery?.then) delivery.then((result) => { if (result?.ok === false) rejected(); }, rejected);
          else if (delivery?.ok === false) rejected();
        }
      }
      if (!isEnabled()) return;
      const turns = readChatGptConversation(document, { selection });
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
  const schedule = () => { if (!stopped && !suspended && !timer) { timer = setTimeout(read, 500); timer?.unref?.(); } };
  // Cinco vías complementarias de recuperación: selectores de rol/data-turn/article
  // del adaptador, MutationObserver, sondeo periódico, eventos de navegación y
  // lectura inmediata al volver a la pestaña. El sondeo cubre cambios que React
  // puede aplicar sin mutaciones observables en los nodos seleccionados.
  const poll = () => {
    if (stopped || suspended) return;
    if (document.visibilityState !== 'hidden') schedule();
    pollTimer = setTimeout(poll, 1200);
    pollTimer?.unref?.();
  };
  const start = () => {
    if (stopped || suspended) return;
    if (window.MutationObserver && !observer) {
      observer = new window.MutationObserver(schedule);
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-message-id', 'data-message-author-role', 'data-turn', 'data-turn-id', 'data-testid', 'aria-label', 'disabled'] });
    }
    schedule();
  };
  const listeners = [];
  const listen = (target, type, callback) => {
    target.addEventListener?.(type, callback);
    listeners.push(() => target.removeEventListener?.(type, callback));
  };
  const hide = () => {
    read(); suspended = true;
    observer?.disconnect(); observer = null;
    clearTimeout(timer); timer = null; clearTimeout(pollTimer); pollTimer = null;
  };
  const show = () => {
    if (stopped) return;
    suspended = false; start();
    read({ force: true });
    if (!pollTimer) poll();
  };
  listen(document, 'DOMContentLoaded', start);
  listen(window, 'popstate', show);
  listen(window, 'hashchange', show);
  listen(window, 'pageshow', show);
  listen(window, 'focus', schedule);
  listen(document, 'visibilitychange', schedule);
  listen(window, 'pagehide', hide);
  start();
  poll();
  return { read, disconnect() {
    stopped = true; clearTimeout(timer); clearTimeout(pollTimer); observer?.disconnect();
    for (const remove of listeners) remove();
  } };
}

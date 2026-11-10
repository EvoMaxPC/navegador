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

const MESSAGE_STRATEGIES = [
  {
    name: 'author-role',
    selector: '[data-message-author-role]',
    role: (node) => node.getAttribute?.('data-message-author-role'),
  },
  {
    name: 'data-turn',
    selector: '[data-turn]',
    role: (node) => {
      const value = node.getAttribute?.('data-turn');
      if (value === 'user' || value === 'assistant') return value;
      if (node.querySelector?.('[data-message-author-role="user"]')) return 'user';
      if (node.querySelector?.('[data-message-author-role="assistant"]')) return 'assistant';
      if (node.querySelector?.('.markdown, .prose')) return 'assistant';
      if (node.querySelector?.('.whitespace-pre-wrap')) return 'user';
      return '';
    },
  },
  {
    name: 'conversation-turn',
    selector: '[data-testid^="conversation-turn"]',
    role: (node, index) => {
      if (node.querySelector?.('[data-message-author-role="user"]')) return 'user';
      if (node.querySelector?.('[data-message-author-role="assistant"]')) return 'assistant';
      if (node.querySelector?.('.markdown, .prose')) return 'assistant';
      if (node.querySelector?.('.whitespace-pre-wrap')) return 'user';
      // Último respaldo de EVO Memory: los turnos de conversación alternan
      // usuario/asistente cuando el DOM no expone atributos semánticos.
      return index % 2 === 0 ? 'user' : 'assistant';
    },
  },
  {
    name: 'article',
    selector: 'article',
    role: (node, index) => {
      if (node.querySelector?.('[data-message-author-role="user"]')) return 'user';
      if (node.querySelector?.('[data-message-author-role="assistant"]')) return 'assistant';
      if (node.querySelector?.('.markdown, .prose')) return 'assistant';
      if (node.querySelector?.('.whitespace-pre-wrap')) return 'user';
      return index % 2 === 0 ? 'user' : 'assistant';
    },
  },
];

function outermost(nodes) {
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains?.(node)));
}

function safeQueryAll(document, selector) {
  try {
    return outermost(Array.from(document?.querySelectorAll?.(selector) || []));
  } catch {
    return [];
  }
}

function messageHash(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function contentNodeFor(node, role, literal) {
  if (role === 'assistant') {
    return node.querySelector?.('.markdown') ||
      node.querySelector?.('.prose, [data-message-content]') || node;
  }
  if (role === 'user') {
    return node.querySelector?.('.whitespace-pre-wrap, [data-message-content]') || node;
  }
  return node;
}

/** Elige el primer selector compatible con el DOM actual de ChatGPT. */
function locateMessageNodes(document) {
  for (const strategy of MESSAGE_STRATEGIES) {
    const nodes = safeQueryAll(document, strategy.selector);
    if (!nodes.length) continue;
    const messages = nodes.map((node, index) => ({
      node,
      role: strategy.role(node, index),
      index,
    })).filter((item) => item.role === 'user' || item.role === 'assistant');
    if (messages.length) return { strategy: strategy.name, messages, totalNodes: nodes.length };
  }
  return { strategy: 'none', messages: [], totalNodes: 0 };
}

/** Devuelve los mensajes que ChatGPT tiene renderizados, con IDs estables y deduplicables. */
export function readChatGptConversation(document, { literal = false } = {}) {
  const located = locateMessageNodes(document);
  const occurrences = new Map();
  return located.messages.slice(-MAX_CONVERSATION_TURNS).flatMap(({ node, role, index }) => {
    const contentNode = contentNodeFor(node, role, literal);
    const value = String(contentNode?.innerText ?? contentNode?.textContent ?? '');
    const raw = literal ? value : value.trim();
    if (!raw) return [];

    const nativeId = node.getAttribute?.('data-message-id') ||
      node.getAttribute?.('data-turn-id') ||
      node.closest?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
      node.closest?.('[data-turn-id]')?.getAttribute?.('data-turn-id') ||
      node.closest?.('article[data-testid]')?.getAttribute?.('data-testid');
    const signature = `${role}:${messageHash(raw)}`;
    const occurrence = occurrences.get(signature) || 0;
    occurrences.set(signature, occurrence + 1);
    const id = nativeId || `visible-${signature}-${occurrence}`;
    const limit = literal ? REPETITION_MAX_TURN_CHARS : MAX_TURN_CHARS;
    return [{
      id: literal ? String(id).slice(0, 256) : String(id),
      role,
      content: raw.slice(0, limit),
      clipped: raw.length > limit,
    }];
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
        let clipped = locateMessageNodes(document).totalNodes > MAX_CONVERSATION_TURNS;
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
      publish({ error: String(error?.message || error) });
    }
  };
  const schedule = () => { if (!stopped && !timer) timer = setTimeout(read, 500); };
  const start = () => {
    if (stopped) return;
    if (window.MutationObserver && document.body && !observer) {
      observer = new window.MutationObserver(schedule);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-message-id', 'data-message-author-role', 'data-turn', 'data-turn-id', 'data-testid'],
      });
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

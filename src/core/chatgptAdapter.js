/** Adaptación de EVO: sólo lectura; selectores de ChatGPT centralizados aquí. */
export const CHATGPT_STRATEGIES = ['author-role', 'data-turn', 'conversation-turn', 'article'];
const validRole = (value) => ['user', 'assistant'].includes(value) ? value : '';
const query = (root, selector) => { try { return root?.querySelector?.(selector) || null; } catch { return null; } };
const queryAll = (root, selector) => { try { return Array.from(root?.querySelectorAll?.(selector) || []); } catch { return []; } };
const explicitRole = (node) => validRole(node?.getAttribute?.('data-message-author-role')) || validRole(node?.getAttribute?.('data-turn'));
const nestedRole = (node) => {
  const own = explicitRole(node);
  if (own) return own;
  const user = query(node, '[data-message-author-role="user"], [data-turn="user"]');
  const assistant = query(node, '[data-message-author-role="assistant"], [data-turn="assistant"]');
  const markdown = query(node, '.markdown') || query(node, '.prose');
  // No inferir por índice: una rama regenerada o un artículo mixto rompe la alternancia.
  if (user && (assistant || markdown)) return '';
  if (user) return 'user';
  if (assistant || markdown) return 'assistant';
  return query(node, '.whitespace-pre-wrap') ? 'user' : '';
};
const strategies = [
  { name: 'author-role', selector: '[data-message-author-role]', role: explicitRole },
  { name: 'data-turn', selector: '[data-turn]', role: nestedRole },
  { name: 'conversation-turn', selector: '[data-testid^="conversation-turn"]', role: nestedRole },
  { name: 'article', selector: 'article', role: nestedRole },
];
function outer(nodes) {
  const candidates = new Set(nodes);
  return [...candidates].filter((node) => {
    // DOM real: recorrer ancestros evita comparar todos los pares de mensajes.
    if ('parentElement' in node) {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (candidates.has(parent)) return false;
      return true;
    }
    return !nodes.some((other) => other !== node && typeof other.contains === 'function' && other.contains(node));
  });
}

export function selectChatGptMessages(document) {
  for (const strategy of strategies) {
    const messages = outer(queryAll(document, strategy.selector))
      .map((node) => ({ node, role: strategy.role(node) })).filter((entry) => entry.role);
    // Elementos con atributos desconocidos no bloquean estrategias válidas posteriores.
    if (messages.length) return { strategy: strategy.name, messages };
  }
  return { strategy: 'none', messages: [] };
}

export function chatGptMessageContent(node, role) {
  return role === 'assistant'
    ? query(node, '.markdown') || query(node, '.prose, [data-message-content]') || node
    : query(node, '.whitespace-pre-wrap') || query(node, '[data-message-author-role="user"], [data-turn="user"]') || node;
}

/** No usar hash del texto: un mensaje en generación debe mantener el mismo ID. */
export function chatGptMessageId(node, index) {
  return node.getAttribute?.('data-message-id') || node.getAttribute?.('data-turn-id') ||
    node.closest?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
    node.closest?.('[data-turn-id]')?.getAttribute?.('data-turn-id') ||
    (/^conversation-turn/.test(node.getAttribute?.('data-testid') || '') ? node.getAttribute('data-testid') : '') ||
    node.closest?.('article[data-testid]')?.getAttribute?.('data-testid') || `visible-${index}`;
}

const STOP_RE = /^(stop|detener|parar)\b/i;
const NOT_STOP = /(dictat|dictad|voice|voz|micr)/i;
export function chatGptStopButtons(document) {
  return queryAll(document, '[data-testid="stop-button"], button[aria-label]').filter((button) => {
    const label = String(button.getAttribute?.('aria-label') || '').trim();
    return !button.disabled && (button.getAttribute?.('data-testid') === 'stop-button' ||
      (STOP_RE.test(label) && !NOT_STOP.test(label)));
  });
}
export const isChatGptStreaming = (document) => chatGptStopButtons(document).length > 0;

/** Diagnóstico sin texto, rutas, IDs, atributos arbitrarios ni lectura del composer. */
export function diagnoseChatGptReader(document) {
  const selected = selectChatGptMessages(document);
  return {
    estrategia_mensajes: selected.strategy,
    mensajes: selected.messages.length,
    usuario: selected.messages.filter((message) => message.role === 'user').length,
    ia: selected.messages.filter((message) => message.role === 'assistant').length,
    transmitiendo: isChatGptStreaming(document),
    candidatos: Object.fromEntries(strategies.map((strategy) => [strategy.name, queryAll(document, strategy.selector).length])),
  };
}

/** Código literal disponible para consumidores que lo necesiten; no se duplica en el panel. */
export function readChatGptCode(node) {
  return queryAll(node, 'pre').map((pre) => {
    const code = query(pre, 'code') || pre;
    const lang = String(code.className || '').match(/language-([\w+#-]+)/)?.[1] || '';
    return { lang, code: String(code.innerText ?? code.textContent ?? '') };
  });
}

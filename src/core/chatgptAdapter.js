/** Adaptación de EVO: sólo lectura; selectores de ChatGPT centralizados aquí. */
export const CHATGPT_STRATEGIES = ['print-label', 'author-role', 'data-turn', 'conversation-turn', 'article'];
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
const PRINT_LABEL_ROLES = new Map([
  ['Dijiste:', 'user'],
  ['ChatGPT dijo:', 'assistant'],
  ['You said:', 'user'],
  ['ChatGPT said:', 'assistant'],
]);
// Claves de más larga a más corta: si dos coinciden por prefijo, gana la más
// específica. Se calcula una vez; el `Map` conserva las cuatro etiquetas.
const PRINT_LABEL_KEYS = [...PRINT_LABEL_ROLES.keys()].sort((a, b) => b.length - a.length);
/**
 * Rol de un encabezado visible.
 *
 * En el DOM medido el nombre de quien habla viaja pegado a la etiqueta dentro
 * del mismo `h4` («Dijiste:Tú», «ChatGPT dijo:ChatGPT»), así que la igualdad
 * exacta se queda corta. Se prueba primero la búsqueda de siempre —idéntica
 * para las etiquetas limpias— y sólo si falla se acepta la etiqueta como
 * prefijo de una de las cuatro claves conocidas. No se añaden claves ni
 * idiomas, y una etiqueta que no empiece por ninguna no se reconoce: «Respuesta
 * más reciente» sigue descartándose.
 */
function printLabelRole(label) {
  const exacto = PRINT_LABEL_ROLES.get(label);
  if (exacto) return exacto;
  const clave = PRINT_LABEL_KEYS.find((item) => label.startsWith(item));
  return clave ? PRINT_LABEL_ROLES.get(clave) : '';
}
function selectPrintLabelMessages(document) {
  const messages = queryAll(document, 'main h4').flatMap((header) => {
    const label = String(header.textContent ?? header.innerText ?? '').trim();
    const role = printLabelRole(label);
    // En el DOM observado, el contenido es el hermano inmediato del encabezado h4.
    const node = header.nextElementSibling;
    return role && node ? [{ node, role }] : [];
  });
  return { strategy: 'print-label', messages };
}
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

function containsNode(parent, child) {
  if (parent === child) return true;
  for (let node = child?.parentElement; node; node = node.parentElement) if (node === parent) return true;
  try { return Boolean(parent?.contains?.(child)); } catch { return false; }
}
function isAlreadySelected(messages, candidate) {
  return messages.some((entry) => entry.role === candidate.role &&
    (containsNode(entry.node, candidate.node) || containsNode(candidate.node, entry.node)));
}
function compareDocumentOrder(a, b) {
  try {
    const position = a.node.compareDocumentPosition?.(b.node) || 0;
    if (position & 4) return -1;
    if (position & 2) return 1;
  } catch { /* nodos de prueba o DOM transitorio */ }
  return 0;
}
export function selectChatGptMessages(document) {
  // Las etiquetas visibles pueden detectar sólo una parte de la conversación.
  // No deben bloquear los selectores estructurales que encuentren la respuesta.
  const labelled = selectPrintLabelMessages(document);
  const messages = [...labelled.messages];
  const seen = new Set(messages.map(({ node }) => node));
  const usedStrategies = labelled.messages.length ? ['print-label'] : [];

  for (const strategy of strategies) {
    const found = outer(queryAll(document, strategy.selector))
      .map((node) => ({ node, role: strategy.role(node) }))
      .filter((entry) => entry.role && !seen.has(entry.node) && !isAlreadySelected(messages, entry));
    if (found.length) {
      for (const entry of found) {
        seen.add(entry.node);
        messages.push(entry);
      }
      usedStrategies.push(strategy.name);
    }
  }
  messages.sort(compareDocumentOrder);
  return {
    strategy: usedStrategies.join('+') || 'none',
    messages,
  };
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
    candidatos: {
      'print-label': queryAll(document, 'main h4').length,
      ...Object.fromEntries(strategies.map((strategy) => [strategy.name, queryAll(document, strategy.selector).length])),
    },
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

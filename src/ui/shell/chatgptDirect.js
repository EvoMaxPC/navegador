import { isChatGptMemoryUrl } from '../../core/chatgptConversation.js';
import { repetitionSnapshot } from '../../core/conversationRepetition.js';

// Función autocontenida: se serializa y se ejecuta en el documento del webview.
// Nunca lleva texto del usuario ni instrucciones de la shell dentro del script.
function capturePrintLabels() {
  const main = document.querySelector('main');
  if (!main) return null;
  const messages = [];
  for (const heading of main.querySelectorAll('h4')) {
    const label = String(heading.innerText || heading.textContent || '').trim();
    const role = /^(?:Dijiste|You said)\s*:\s*$/i.test(label) ? 'user'
      : /^(?:ChatGPT dijo|ChatGPT said)\s*:\s*$/i.test(label) ? 'assistant' : null;
    const node = heading.nextElementSibling;
    if (!role || !node || node.matches?.('textarea, input, form, [contenteditable="true"]')) continue;
    const text = String(node.innerText ?? node.textContent ?? '');
    if (!text.trim()) continue;
    const id = node.getAttribute?.('data-message-id') || node.getAttribute?.('data-turn-id') ||
      node.closest?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
      node.closest?.('[data-turn-id]')?.getAttribute?.('data-turn-id') ||
      node.closest?.('article[data-testid]')?.getAttribute?.('data-testid') || `visible-${messages.length}`;
    messages.push({ id: String(id).slice(0, 256), role, content: text.slice(0, 200000), clipped: text.length > 200000 });
  }
  let remaining = 1000000, clipped = messages.length > 200;
  const turns = messages.slice(-200).flatMap(turn => {
    if (!remaining) { clipped = true; return []; }
    const content = turn.content.slice(0, remaining);
    remaining -= content.length;
    return [{ ...turn, content, clipped: turn.clipped || content.length < turn.content.length }];
  });
  const streaming = [...document.querySelectorAll('[data-testid="stop-button"], button[aria-label]')].some(button => {
    const label = String(button.getAttribute('aria-label') || '').trim();
    return !button.disabled && (button.getAttribute('data-testid') === 'stop-button' ||
      (/^(?:stop|detener|parar)\b/i.test(label) && !/(dictat|dictad|voice|voz|micr)/i.test(label)));
  });
  return { href: location.href, turns, clipped, streaming, strategy: 'direct-console-injection' };
}

export const CHATGPT_DIRECT_SCRIPT = `(${capturePrintLabels.toString()})()`;
export const sameConversationSource = (a, b) => Boolean(a && b && a.webContentsId === b.webContentsId && a.href === b.href);

/** Respaldo explícito del webview; no crea otro watcher ni finge activación del usuario. */
export async function readChatGptDirect(tab) {
  const view = tab?.view;
  if (typeof view?.executeJavaScript !== 'function') return null;
  try {
    const source = { webContentsId: view.getWebContentsId(), href: view.getURL() };
    if (!isChatGptMemoryUrl(source.href)) return null;
    const payload = await view.executeJavaScript(CHATGPT_DIRECT_SCRIPT, false);
    const current = { webContentsId: view.getWebContentsId(), href: view.getURL() };
    if (!sameConversationSource(source, current) || payload?.href !== source.href) return null;
    const snapshot = repetitionSnapshot(payload);
    return snapshot?.turns.length ? { ...snapshot, ...source } : null;
  } catch {
    // No imprimir mensajes de error arbitrarios del sitio: pueden contener texto privado.
    return null;
  }
}

/** Resuelve consultas asíncronas sin sustituir eventos más nuevos ni mezclar pestañas. */
export async function readMemoryConversation({ source, tab, getSource, getCached, getLive, getRevision, direct = readChatGptDirect }) {
  if (!source) return getSource() ? undefined : null;
  const current = () => sameConversationSource(source, getSource());
  if (!current()) return undefined;
  const revision = getRevision();
  let fetched = null;
  try { fetched = await getCached(source); } catch { /* IPC no disponible: intentar sólo la lectura directa. */ }
  if (!current()) return undefined;
  if (getRevision() !== revision) return getLive();
  if (sameConversationSource(fetched, source) && fetched.turns?.length) return fetched;
  const live = getLive();
  if (sameConversationSource(live, source) && live.turns?.length) return live;
  const fallback = await direct(tab);
  if (!current()) return undefined;
  if (getRevision() !== revision) return getLive();
  return sameConversationSource(fallback, source) ? fallback : sameConversationSource(fetched, source) ? fetched : null;
}

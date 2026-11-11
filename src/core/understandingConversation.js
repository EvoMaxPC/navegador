/** Transporte DOM UUE independiente. Límites explícitos; nunca afirma historial remoto completo. */
import {
  selectChatGptMessages,
  chatGptMessageContent,
  chatGptMessageId,
} from './chatgptAdapter.js';
export const UNDERSTANDING_DOM_LIMITS = Object.freeze({
  turns: 2000,
  turnChars: 200000,
  chars: 2000000,
  retainedChars: 8000000,
  sources: 8,
  page: 20,
});
export function readUnderstandingDom(
  document,
  { selection = selectChatGptMessages(document) } = {},
) {
  const nodes = selection.messages,
    start = Math.max(0, nodes.length - UNDERSTANDING_DOM_LIMITS.turns);
  let remaining = UNDERSTANDING_DOM_LIMITS.chars;
  const turns = [];
  let omitted = start,
    clipped = false;
  // Retener primero lo más reciente cuando se alcanza el presupuesto, conservando orden DOM.
  for (let i = nodes.length - 1; i >= start; i--) {
    const { node, role } = nodes[i],
      contentNode = chatGptMessageContent(node, role),
      raw = String(contentNode.innerText ?? contentNode.textContent ?? '');
    if (!raw.trim()) continue;
    if (!remaining) {
      omitted++;
      continue;
    }
    const content = raw.slice(
        0,
        Math.min(remaining, UNDERSTANDING_DOM_LIMITS.turnChars),
      ),
      cut = content.length < raw.length;
    clipped ||= cut;
    remaining -= content.length;
    if (!content.trim()) {
      omitted++;
      continue;
    }
    turns.push({
      id: String(chatGptMessageId(node, i)).slice(0, 256),
      role,
      content,
      clipped: cut,
    });
  }
  turns.reverse();
  return {
    turns,
    coverage: {
      scope: 'loaded-dom',
      strategy: selection.strategy,
      detected_turns: nodes.length,
      sent_turns: turns.length,
      omitted_turns: omitted,
      clipped: clipped || omitted > 0,
      remote_history_complete: false,
    },
  };
}
export function validateUnderstandingDom(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.href !== 'string' ||
    payload.href.length > 2048 ||
    (payload.conversationId !== undefined &&
      (typeof payload.conversationId !== 'string' ||
        payload.conversationId.length > 2048)) ||
    typeof payload.streaming !== 'boolean' ||
    !Array.isArray(payload.turns) ||
    !payload.turns.length ||
    payload.turns.length > UNDERSTANDING_DOM_LIMITS.turns
  )
    return false;
  const c = payload.coverage;
  if (
    !c ||
    c.scope !== 'loaded-dom' ||
    typeof c.strategy !== 'string' ||
    c.strategy.length > 200 ||
    !Number.isSafeInteger(c.detected_turns) ||
    c.detected_turns < 0 ||
    c.detected_turns > 100000 ||
    c.sent_turns !== payload.turns.length ||
    c.detected_turns < c.sent_turns ||
    !Number.isSafeInteger(c.omitted_turns) ||
    c.omitted_turns < 0 ||
    c.omitted_turns + c.sent_turns > c.detected_turns ||
    typeof c.clipped !== 'boolean' ||
    c.remote_history_complete !== false ||
    (c.omitted_turns > 0 && !c.clipped)
  )
    return false;
  let chars = 0;
  const ids = new Set();
  for (const t of payload.turns) {
    if (
      !t ||
      !['user', 'assistant'].includes(t.role) ||
      typeof t.id !== 'string' ||
      !t.id ||
      t.id.length > 256 ||
      typeof t.content !== 'string' ||
      !t.content.trim() ||
      t.content.length > UNDERSTANDING_DOM_LIMITS.turnChars ||
      typeof t.clipped !== 'boolean' ||
      (t.clipped && !c.clipped) ||
      ids.has(`${t.role}:${t.id}`)
    )
      return false;
    chars += t.content.length;
    ids.add(`${t.role}:${t.id}`);
  }
  return chars <= UNDERSTANDING_DOM_LIMITS.chars;
}

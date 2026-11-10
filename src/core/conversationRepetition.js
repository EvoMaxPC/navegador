import { CHATGPT_STRATEGIES } from './chatgptAdapter.js';

/** Límites exclusivos de la vista literal; no cambian EVO MEMORY ni contadores. */
export const REPETITION_MAX_TURNS = 200;
export const REPETITION_MAX_TURN_CHARS = 200000;
export const REPETITION_MAX_CHARS = 1000000;

/** Valida texto, nunca HTML. No recorta, resume, normaliza ni interpreta mensajes. */
function validStrategy(value) {
  if (typeof value !== 'string' || !value) return 'none';
  const parts = value.split('+');
  return parts.length > 0 && parts.every((part) => CHATGPT_STRATEGIES.includes(part)) &&
    new Set(parts).size === parts.length ? value : 'none';
}

export function repetitionSnapshot(payload) {
  if (!payload || !Array.isArray(payload.turns) || payload.turns.length > REPETITION_MAX_TURNS) return null;
  let chars = 0;
  const turns = [];
  for (const turn of payload.turns) {
    if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string' ||
        turn.content.length > REPETITION_MAX_TURN_CHARS || typeof turn.id !== 'string' || turn.id.length > 256) return null;
    chars += turn.content.length;
    if (chars > REPETITION_MAX_CHARS) return null;
    turns.push({ id: turn.id, role: turn.role, content: turn.content, clipped: turn.clipped === true });
  }
  return { turns, strategy: validStrategy(payload.strategy), streaming: payload.streaming === true, clipped: payload.clipped === true || turns.some((turn) => turn.clipped) };
}

/** Conteo de conversación: BPE para GPT, estimación existente para otros sitios. */
import { countGptTokens } from '../core/gptTokens.cjs';
import { estimateTokens } from '../core/text.js';
export { countGptTokens };

export function countTokensForProvider(text, model = '', provider = '') {
  const source = String(provider || '').toLowerCase();
  if (source.includes('chatgpt') || source.includes('openai')) return countGptTokens(text, model);
  return estimateTokens(text);
}

/** Diagnóstico temporal: mostrar palabras recibidas para comprobar el flujo de captura. */
export function countOutputTokens(text) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  return (text.match(/[\p{L}\p{N}_]+/gu) || []).length;
}

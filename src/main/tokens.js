/** Conteo de conversación: BPE para GPT, estimación existente para otros sitios. */
import { countGptTokens } from '../core/gptTokens.cjs';
import { estimateTokens, estimateOutputTokens } from '../core/text.js';
export { countGptTokens };

export function countTokensForProvider(text, model = '', provider = '') {
  const source = String(provider || '').toLowerCase();
  if (source.includes('chatgpt') || source.includes('openai')) return countGptTokens(text, model);
  return estimateTokens(text);
}

/** Salida IA: una unidad estimada por palabra capturada, sin tokenizador. */
export function countOutputTokens(text) {
  return estimateOutputTokens(text);
}

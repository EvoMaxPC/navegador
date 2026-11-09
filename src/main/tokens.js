/** Conteo de conversación: BPE para GPT, estimación existente para otros sitios. */
import { countGptTokens } from '../core/gptTokens.cjs';
import { estimateTokens } from '../core/text.js';
export { countGptTokens };

export function countTokensForProvider(text, model = '', provider = '') {
  const source = String(provider || '').toLowerCase();
  if (source.includes('chatgpt') || source.includes('openai')) return countGptTokens(text, model);
  return estimateTokens(text);
}

/** Sólo salida: si falla BPE, estimar sobre el texto real y registrar el motivo. */
export function countOutputTokens(text, model = '', provider = '', onFallback = null) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  try {
    const tokens = countTokensForProvider(text, model, provider);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error(`recuento inválido: ${tokens}`);
    return tokens;
  } catch (error) {
    const tokens = estimateTokens(text);
    const detail = { model, provider, chars: text.length, tokens, error: String(error?.message || error) };
    if (onFallback) onFallback(detail);
    else console.warn('[nexo] output-tokenizer-fallback:', detail);
    return tokens;
  }
}

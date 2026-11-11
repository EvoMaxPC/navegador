/** Categorías separadas: BPE visible, estimación heredada y modelo desconocido. */
import { countGptTokens, resolveModelForEncoding } from '../core/gptTokens.cjs';
import { estimateTokens, estimateOutputTokens } from '../core/text.js';
export { countGptTokens };

export function inputTokenMeasurement(text, model = '', provider = '') {
  if (typeof text !== 'string')
    throw new TypeError('El texto debe ser una cadena');
  const source = String(provider || '').toLowerCase();
  if (
    [
      'chatgpt',
      'openai',
      'chatgpt.com',
      'chat.openai.com',
      'api.openai.com',
    ].includes(source)
  ) {
    const resolved = resolveModelForEncoding(model);
    return {
      tokens: resolved ? countGptTokens(text, resolved.model) : null,
      tokenEncoding: resolved?.encoding || null,
      tokenExact: Boolean(resolved?.exact),
      tokenMethod: resolved
        ? resolved.exact ? 'bpe-original' : 'bpe-nearest-model'
        : 'unknown-model',
      model: model || '',
      tokenModel: resolved?.model || null,
    };
  }
  // Compatibilidad con otros proveedores: nunca etiquetar su estimación como BPE.
  return {
    tokens: estimateTokens(text),
    tokenEncoding: null,
    tokenExact: false,
    tokenMethod: 'legacy-estimate',
    model,
  };
}
export function countTokensForProvider(text, model = '', provider = '') {
  return inputTokenMeasurement(text, model, provider).tokens;
}

/** Estimación de salida heredada, explícitamente separada del BPE de entrada. */
export function countOutputTokens(text) {
  return estimateOutputTokens(text);
}

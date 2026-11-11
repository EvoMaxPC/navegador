/** Categorías separadas: BPE visible, estimación heredada y modelo desconocido. */
import { countGptTokens, encodingForModel } from '../core/gptTokens.cjs';
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
    const encoding = encodingForModel(model);
    // ChatGPT puede no exponer el modelo en el evento del compositor.
    // En ese caso contamos con o200k_base y lo marcamos como aproximado,
    // en lugar de dejar el contador vacío o fingir precisión por modelo.
    const chatGptWeb = ['chatgpt', 'chatgpt.com', 'chat.openai.com'].includes(source);
    const fallbackModel = !encoding && chatGptWeb ? 'gpt-5-chat-latest' : model;
    const fallbackEncoding = !encoding && chatGptWeb ? 'o200k_base' : null;
    return {
      tokens: countGptTokens(text, fallbackModel),
      tokenEncoding: encoding || fallbackEncoding,
      tokenExact: Boolean(encoding),
      tokenMethod: encoding ? 'bpe-original' : fallbackEncoding ? 'bpe-default' : 'unknown-model',
      model: model || (fallbackEncoding ? fallbackModel : ''),
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

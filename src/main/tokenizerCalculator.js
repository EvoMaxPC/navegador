import { countGptTokens, encodingForModel, modelEncodings } from '../core/gptTokens.cjs';

export const MAX_TOKENIZER_TEXT = 200_000;
export function tokenizerModels() {
  return { ok: true, defaultModel: 'gpt-4o', maxTextLength: MAX_TOKENIZER_TEXT,
    models: Object.entries(modelEncodings).map(([id, encoding]) => ({ id, encoding })) };
}

/** Calculadora sin efectos: no modifica contadores, ajustes, memoria ni logs. */
export function calculateTokenizer(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.text !== 'string') {
    return { ok: false, error: 'Ingresá un texto válido.' };
  }
  if (payload.text.length > MAX_TOKENIZER_TEXT) return { ok: false, error: 'El texto supera el límite de 200000 unidades UTF-16. Dividilo para contarlo.' };
  const encoding = encodingForModel(payload.model);
  if (!encoding) return { ok: false, error: 'Elegí un modelo con tokenizador verificado.' };
  try {
    const tokens = countGptTokens(payload.text, payload.model);
    return { ok: true, tokens, model: payload.model, encoding, method: 'bpe-original',
      formula: 'T = length(encode_Em(S_original))' };
  } catch {
    return { ok: false, error: 'No se pudo cargar el tokenizador. No se generó una estimación.' };
  }
}

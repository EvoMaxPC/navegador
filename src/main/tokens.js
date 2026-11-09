/** Conteo de conversación: BPE para GPT y estimación segura como respaldo. */
import { countGptTokens } from '../core/gptTokens.cjs';
import { estimateTokens } from '../core/text.js';
export { countGptTokens };

/**
 * Cuenta texto visible de entrada o salida.
 *
 * El contador nunca debe interrumpir el cierre de un stream: si el paquete BPE
 * no está disponible en el ejecutable empaquetado, falla al cargar una
 * codificación o devuelve un valor inválido, se usa la estimación local. Antes
 * una excepción del tokenizer podía abortar el handler IPC y dejar la respuesta
 * recibida con cero tokens, aunque el texto ya se hubiera capturado.
 */
export function countTokensForProvider(text, model = '', provider = '') {
  if (typeof text !== 'string' || !text.length) return 0;

  const source = String(provider || '').toLowerCase();
  const isGpt = /chatgpt|openai|gpt/i.test(source) || /^gpt-/i.test(String(model || ''));

  if (isGpt) {
    try {
      const count = countGptTokens(text, model);
      if (Number.isFinite(count) && count > 0) return Math.floor(count);
    } catch (error) {
      // El conteo no puede romper el procesamiento de la respuesta. El fallback
      // mantiene el contador útil y evita presentar un cero falso.
    }
  }

  const estimate = estimateTokens(text);
  return Number.isFinite(estimate) && estimate > 0 ? Math.floor(estimate) : 1;
}

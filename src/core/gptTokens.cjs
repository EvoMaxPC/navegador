/** BPE del texto original; siempre elige un tokenizer de referencia. */
const { models } = require('./bpe-models.json');
const cache = new Map();
const MAX_CACHE = 64;
const OPTIONS = { disallowedSpecial: new Set() }; // Literales especiales son texto, no control.
exports.modelEncodings = models;
exports.encodingForModel = function encodingForModel(model) {
  if (typeof model !== 'string') return null;
  const key = model.trim().toLowerCase();
  return Object.hasOwn(models, key) ? models[key] : null;
};

/**
 * Modelo conocido de la tabla verificada, o `null`.
 *
 * Un nombre ausente, un alias («auto») o una familia no catalogada (gpt-6) NO
 * se sustituyen por otro modelo: contar con un encoding ajeno sería inventar
 * una compatibilidad que no está verificada. El nombre se normaliza (espacios
 * y mayúsculas) porque el identificador de la tabla es único.
 */
exports.resolveModelForEncoding = function resolveModelForEncoding(model) {
  const key = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!key || !Object.hasOwn(models, key)) return null;
  return { model: key, encoding: models[key], exact: true };
};
exports.encodeGptText = function encodeGptText(text, model) {
  if (typeof text !== 'string')
    throw new TypeError('El texto debe ser una cadena');
  const resolved = exports.resolveModelForEncoding(model);
  if (!resolved) return null;
  const encoding = resolved.encoding;
  // Tabla cerrada y verificada: model nunca forma parte de una ruta require.
  const tokenizer = require(`gpt-tokenizer/encoding/${encoding}`);
  return tokenizer.encode(text, OPTIONS);
};
exports.countGptTokens = function countGptTokens(text, model = '') {
  if (typeof text !== 'string')
    throw new TypeError('El texto debe ser una cadena');
  const resolved = exports.resolveModelForEncoding(model);
  if (!resolved) return null;
  const encoding = resolved.encoding;
  const key = encoding + '\0' + text;
  if (cache.has(key)) return cache.get(key);
  const count = exports.encodeGptText(text, resolved.model).length; // T = |E_m(S)|
  // Caché local acotada; no se persiste el texto. No deduplica envíos.
  if (text.length <= 65536) {
    cache.set(key, count);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  return count;
};

/** BPE del texto original. Sin encoding identificado NO se inventa un conteo. */
const { models } = require('./bpe-models.json');
const cache = new Map();
const MAX_CACHE = 64;
const OPTIONS = { disallowedSpecial: new Set() }; // Literales especiales son texto, no control.
exports.modelEncodings = models;
exports.encodingForModel = function encodingForModel(model) {
  return typeof model === 'string' && Object.hasOwn(models, model)
    ? models[model]
    : null;
};
exports.encodeGptText = function encodeGptText(text, model) {
  if (typeof text !== 'string')
    throw new TypeError('El texto debe ser una cadena');
  const encoding = exports.encodingForModel(model);
  if (!encoding) return null;
  // Tabla cerrada y verificada: model nunca forma parte de una ruta require.
  const tokenizer = require(`gpt-tokenizer/encoding/${encoding}`);
  return tokenizer.encode(text, OPTIONS);
};
exports.countGptTokens = function countGptTokens(text, model = '') {
  if (typeof text !== 'string')
    throw new TypeError('El texto debe ser una cadena');
  const encoding = exports.encodingForModel(model);
  if (!encoding) return null;
  const key = encoding + '\0' + text;
  if (cache.has(key)) return cache.get(key);
  const count = exports.encodeGptText(text, model).length; // T = |E_m(S)|
  // Caché local acotada; no se persiste el texto. No deduplica envíos.
  if (text.length <= 65536) {
    cache.set(key, count);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  return count;
};

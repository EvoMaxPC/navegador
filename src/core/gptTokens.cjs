/** BPE del texto original. Sin encoding identificado NO se inventa un conteo. */
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
 * Resuelve nombres no catalogados sólo dentro de una familia OpenAI conocida.
 * Devuelve el modelo de referencia cuya codificación se usará; no altera el
 * identificador original recibido. "auto", proveedores ajenos y nombres sin
 * familia inequívoca permanecen sin resolver.
 */
exports.resolveModelForEncoding = function resolveModelForEncoding(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const key = model.trim().toLowerCase();
  if (Object.hasOwn(models, key)) {
    return { model: key, encoding: models[key], exact: true };
  }

  const gptMatch = key.match(/^gpt-(\\d+(?:\\.\\d+)?)(?:$|-)/);
  const oMatch = key.match(/^o(\\d+)(?:$|-)/);
  if (!gptMatch && !oMatch) return null;

  const requested = Number((gptMatch || oMatch)[1]);
  const candidates = Object.keys(models).filter((candidate) =>
    gptMatch
      ? /^gpt-\\d+(?:\\.\\d+)?(?:$|-)/.test(candidate)
      : /^o\\d+(?:$|-)/.test(candidate),
  );
  if (!candidates.length) return null;

  const scored = candidates.map((candidate) => {
    const match = candidate.match(gptMatch
      ? /^gpt-(\\d+(?:\\.\\d+)?)(?:$|-)/ 
      : /^o(\\d+)(?:$|-)/);
    return { model: candidate, distance: Math.abs(Number(match[1]) - requested) };
  }).sort((a, b) => a.distance - b.distance || a.model.localeCompare(b.model));
  const nearest = scored[0].model;
  return { model: nearest, encoding: models[nearest], exact: false };
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

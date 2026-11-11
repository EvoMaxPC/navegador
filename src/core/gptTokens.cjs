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
 * Resuelve el modelo exacto o el modelo de referencia más cercano.
 * Para nombres ausentes, "auto" o familias desconocidas usa GPT-5 como
 * referencia estable. El identificador original no se modifica.
 */
exports.resolveModelForEncoding = function resolveModelForEncoding(model) {
  const key = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!key) {
    const fallback = Object.hasOwn(models, 'gpt-5') ? 'gpt-5' : Object.keys(models)[0];
    return fallback ? { model: fallback, encoding: models[fallback], exact: false } : null;
  }
  if (Object.hasOwn(models, key)) {
    return { model: key, encoding: models[key], exact: true };
  }

  const gptMatch = key.match(/^gpt-(\d+(?:\.\d+)?)(?:$|-)/);
  const oMatch = key.match(/^o(\d+)(?:$|-)/);
  // Si no hay familia reconocible (por ejemplo "auto" o un alias nuevo),
  // elegimos un modelo de referencia estable en vez de devolver null.
  if (!gptMatch && !oMatch) {
    const fallback = Object.hasOwn(models, 'gpt-5') ? 'gpt-5' : Object.keys(models)[0];
    return fallback ? { model: fallback, encoding: models[fallback], exact: false } : null;
  }

  const requested = Number((gptMatch || oMatch)[1]);
  const candidates = Object.keys(models).filter((candidate) =>
    gptMatch
      ? /^gpt-\d+(?:\.\d+)?(?:$|-)/.test(candidate)
      : /^o\d+(?:$|-)/.test(candidate),
  );
  if (!candidates.length) {
    const fallback = Object.hasOwn(models, 'gpt-5') ? 'gpt-5' : Object.keys(models)[0];
    return fallback ? { model: fallback, encoding: models[fallback], exact: false } : null;
  }

  const scored = candidates.map((candidate) => {
    const match = candidate.match(gptMatch
      ? /^gpt-(\d+(?:\.\d+)?)(?:$|-)/ 
      : /^o(\d+)(?:$|-)/);
    return { model: candidate, distance: Math.abs(Number(match[1]) - requested) };
  }).sort((a, b) => a.distance - b.distance || a.model.localeCompare(b.model));
  const nearest = scored[0].model;
  return { model: nearest, encoding: models[nearest], exact: false };
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

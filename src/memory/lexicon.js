/**
 * EVO MEMORY · Léxico
 *
 * La recuperación de memoria no puede depender de un modelo de embeddings: el
 * motor tiene que funcionar sin conexión, sin GPU y sin coste por token. Así que
 * el espacio vectorial se construye aquí, con tres piezas deterministas:
 *
 *   1. normalización + stemming ligero (es/en),
 *   2. pesos TF‑IDF dispersos (vectores ralos, no densos),
 *   3. BM25 para el ranking léxico.
 *
 * Un vector disperso de 40 términos es suficiente para que «el puerto de la base
 * de datos» encuentre «PostgreSQL escucha en 5432» sin que compartan una sola
 * palabra: comparten `base`, `datos` y el número.
 */

const STOPWORDS = new Set([
  // español
  'a', 'al', 'algo', 'algunas', 'algunos', 'ante', 'antes', 'como', 'con', 'contra',
  'cual', 'cuando', 'de', 'del', 'desde', 'donde', 'dos', 'el', 'ella', 'ellas', 'ellos',
  'en', 'entre', 'era', 'es', 'esa', 'ese', 'eso', 'esta', 'este', 'esto', 'estos', 'fue',
  'ha', 'hacia', 'han', 'hasta', 'hay', 'la', 'las', 'le', 'les', 'lo', 'los', 'más',
  'me', 'mi', 'mis', 'muy', 'no', 'nos', 'o', 'otra', 'otro', 'para', 'pero', 'poco',
  'por', 'porque', 'que', 'qué', 'se', 'sin', 'sobre', 'su', 'sus', 'te', 'tiene', 'tu',
  'tus', 'un', 'una', 'uno', 'unos', 'y', 'ya', 'yo', 'ser', 'son', 'está', 'están',
  'también', 'si', 'sí', 'así', 'todo', 'toda', 'todos', 'nada', 'cada', 'mismo',
  // inglés
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
  'when', 'which', 'who', 'will', 'with', 'you', 'your', 'would', 'should', 'could',
]);

/** Sufijos en orden de aplicación. Se corta uno solo: sobre-stemming destruye señal. */
const SUFFIXES = [
  'isimos', 'isimas', 'aciones', 'uciones', 'imientos', 'amiento', 'imiento',
  'adores', 'adoras', 'mente', 'idades', 'acion', 'ucion', 'ancia', 'encia',
  'ando', 'iendo', 'ados', 'adas', 'idos', 'idas', 'ador', 'ista', 'ismo', 'able',
  'ible', 'ones', 'anas', 'anos', 'ares', 'eres', 'ires', 'ando',
  'ing', 'edly', 'ies', 'ied', 'ly', 'ed', 'es', 's',
  'ar', 'er', 'ir', 'ado', 'ada', 'ido', 'ida', 'os', 'as',
];

/**
 * Normaliza un término: minúsculas, sin acentos, sin diacríticos.
 * @param {string} word
 */
export function normalizeTerm(word) {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñü]+/g, '');
}

/**
 * Stemming ligero. No pretende ser Snowball: pretende colapsar «decidimos» /
 * «decisión» / «decidir» sin romper palabras cortas.
 * @param {string} word término ya normalizado
 */
export function stem(word) {
  if (word.length <= 4) return word;
  for (const suffix of SUFFIXES) {
    // Los sufijos largos exigen una raíz de 4 letras: sin esto, «comando»
    // quedaría en «com» y colisionaría con «comer», «común» y «comité».
    const minRoot = suffix.length > 2 ? 4 : 3;
    if (word.length - suffix.length < minRoot) continue;
    if (word.endsWith(suffix)) return word.slice(0, word.length - suffix.length);
  }
  return word;
}

/**
 * Términos indexables de un texto.
 * @param {string} text
 * @param {{keepStopwords?: boolean}} [opts]
 * @returns {string[]}
 */
export function indexTerms(text, opts = {}) {
  if (!text) return [];
  const terms = [];
  const raw = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = raw.match(/[a-z0-9ñü]{2,}/g) || [];
  for (const word of words) {
    if (!opts.keepStopwords && STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word) && word.length < 2) continue;
    const normalized = normalizeTerm(word);
    if (!normalized) continue;
    const term = /^\d+$/.test(normalized) ? normalized : stem(normalized);
    if (term.length < 2) continue;
    terms.push(term);
  }
  return terms;
}

/** Frecuencias de término de una lista de términos. */
export function termFreq(terms) {
  const map = new Map();
  for (const term of terms) map.set(term, (map.get(term) || 0) + 1);
  return map;
}

/** IDF clásico con suavizado, acotado para vocabularios pequeños. */
export function idf(df, total) {
  if (total <= 0) return 0;
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

/**
 * Contribución BM25 de un documento frente a los términos de consulta.
 * @param {Map<string, number>} tf
 * @param {number} docLength
 * @param {number} avgLength
 * @param {(term: string) => number} idfOf
 */
export function bm25(tf, docLength, avgLength, idfOf, queryTerms, k1 = 1.2, b = 0.75, termWeights = null) {
  let score = 0;
  const seen = new Set();
  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const freq = tf.get(term);
    if (!freq) continue;
    const norm = 1 - b + (b * docLength) / (avgLength || 1);
    const weight = termWeights?.get?.(term) ?? 1;
    score += weight * idfOf(term) * ((freq * (k1 + 1)) / (freq + k1 * norm));
  }
  return score;
}

/** Vector TF‑IDF disperso (Map término → peso). */
export function tfidfVector(terms, idfOf) {
  const tf = termFreq(terms);
  const max = Math.max(1, ...tf.values());
  const vector = new Map();
  for (const [term, freq] of tf) {
    const weight = (0.5 + (0.5 * freq) / max) * idfOf(term);
    if (weight > 0) vector.set(term, weight);
  }
  return vector;
}

/** Similitud coseno entre dos vectores dispersos. */
export function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [term, weight] of a) {
    na += weight * weight;
    const other = b.get(term);
    if (other) dot += weight * other;
  }
  for (const weight of b.values()) nb += weight * weight;
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Jaccard sobre conjuntos de términos (para deduplicar). */
export function termJaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const term of setA) if (setB.has(term)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

/**
 * Mapa conceptual de expansión.
 *
 * La búsqueda léxica falla justo donde más importa: «¿qué falta?» no comparte
 * una sola palabra con «queda pendiente». Sin un modelo de embeddings, la forma
 * honesta de cerrar esa brecha es un diccionario de conceptos curado, bilingüe y
 * pequeño. Cada grupo son formas de decir lo mismo **en el contexto de un
 * proyecto técnico**, no sinónimos de diccionario.
 */
const CONCEPTS = [
  ['falta', 'faltante', 'pendiente', 'queda', 'resta', 'incompleto', 'missing', 'remaining', 'todo', 'quedo'],
  ['error', 'fallo', 'falla', 'bug', 'excepcion', 'problema', 'rompe', 'issue', 'failure', 'crash', 'excepcion'],
  ['comando', 'script', 'ejecutar', 'correr', 'terminal', 'cli', 'command', 'run', 'shell', 'npm'],
  ['decision', 'decidir', 'decidimo', 'elegir', 'elegimo', 'optar', 'optamo', 'acordar', 'acordamo', 'choose', 'choice'],
  ['restriccion', 'limite', 'maximo', 'minimo', 'prohibido', 'constraint', 'limit', 'cannot', 'must'],
  ['objetivo', 'meta', 'proposito', 'goal', 'aim', 'purpose', 'vision'],
  ['puerto', 'port', 'endpoint', 'url', 'host', 'servidor', 'server'],
  ['archivo', 'file', 'ruta', 'path', 'fichero', 'carpeta', 'folder'],
  ['version', 'release', 'tag', 'actualizacion', 'update'],
  ['plazo', 'fecha', 'deadline', 'cuando', 'entrega', 'sprint'],
  ['modelo', 'llm', 'bot', 'asistente', 'assistant', 'gpt', 'claude'],
  ['contexto', 'memoria', 'historial', 'context', 'memory', 'history', 'recordar'],
  ['bucle', 'loop', 'repeticion', 'repetir', 'ciclo', 'trabar', 'stuck'],
  ['usuario', 'user', 'cliente', 'persona', 'people'],
  ['preferencia', 'estilo', 'gusto', 'preference', 'style', 'convencion'],
  ['base', 'datos', 'db', 'database', 'postgres', 'postgresql', 'sql', 'tabla'],
  ['probar', 'test', 'prueba', 'testing', 'validar', 'verificar'],
  ['desplegar', 'deploy', 'produccion', 'production', 'publicar'],
  ['seguridad', 'security', 'auth', 'token', 'clave', 'password'],
  ['rendimiento', 'performance', 'lento', 'rapido', 'optimizar', 'speed'],
  ['interfaz', 'ui', 'ux', 'pantalla', 'diseño', 'design'],
];

const CONCEPT_INDEX = new Map();
for (const group of CONCEPTS) {
  for (const term of group) {
    const normalized = stem(normalizeTerm(term));
    if (!CONCEPT_INDEX.has(normalized)) CONCEPT_INDEX.set(normalized, new Set());
    for (const other of group) {
      const peer = stem(normalizeTerm(other));
      if (peer && peer !== normalized) CONCEPT_INDEX.get(normalized).add(peer);
    }
  }
}

/**
 * Expande términos de consulta con sus conceptos afines.
 * Devuelve el peso de cada término: 1 para los literales, 0.5 para los expandidos
 * (una pista, no una certeza).
 *
 * @param {string[]} terms
 * @returns {Map<string, number>}
 */
export function expandQueryTerms(terms) {
  const weights = new Map();
  for (const term of terms) {
    if (term.length < 3) continue;
    weights.set(term, Math.max(weights.get(term) || 0, 1));
  }
  for (const term of terms) {
    const peers = CONCEPT_INDEX.get(term);
    if (!peers) continue;
    for (const peer of peers) {
      if (!weights.has(peer)) weights.set(peer, 0.5);
    }
  }
  return weights;
}

/**
 * Extracción de anclas duras: números, fechas, rutas, URLs, versiones, correos.
 * Son los datos que un resumen pierde primero y los que más se necesitan después.
 * @param {string} text
 */
export function anchors(text) {
  const source = String(text || '');
  const found = new Set();

  for (const match of source.matchAll(/\b\d{1,2}[:.]\d{2}\b/g)) found.add(match[0]);
  for (const match of source.matchAll(/\bhttps?:\/\/[^\s)>\]]+/g)) found.add(stripTrailing(match[0]));
  for (const match of source.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g)) found.add(match[0]);
  for (const match of source.matchAll(/\b[\w./-]+\.(?:js|ts|tsx|jsx|py|json|md|css|html|yml|yaml|sql|go|rs|java|sh)\b/g)) found.add(match[0]);
  for (const match of source.matchAll(/\b(?:v|versi[oó]n\s?)\d+(?:\.\d+){1,3}\b/gi)) found.add(match[0]);
  for (const match of source.matchAll(/\b\d+(?:[.,]\d+)?\s?(?:%|ms|s|min|h|kb|mb|gb|tb|px|tok|tokens|€|\$|usd|eur)\b/gi)) found.add(match[0].replace(/\s+/g, ''));
  for (const match of source.matchAll(/\b\d{1,4}(?:[/-]\d{1,2}){1,2}\b/g)) found.add(match[0]);
  for (const match of source.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g)) {
    if (match[0].length <= 40) found.add(match[0]);
  }
  for (const match of source.matchAll(/\bport\s?\d{2,5}\b|:\d{4,5}\b/g)) found.add(match[0].trim());
  // Números desnudos: puertos, ids, cantidades, versiones sin prefijo.
  for (const match of source.matchAll(/(?<![\w./-])\d{2,6}(?![\w./-])/g)) found.add(match[0]);

  return [...found].slice(0, 24);
}

function stripTrailing(url) {
  return url.replace(/[.,;:!?]+$/, '');
}

/** ¿La oración es una negación? Se usa para detectar contradicciones. */
export function isNegated(text) {
  return /\b(no|nunca|jamás|ningún|ninguna|ni|without|never|not|no longer)\b/i.test(text);
}

/** Idioma aproximado del texto (solo es/en, suficiente para el protocolo). */
export function detectLang(text) {
  const sample = String(text || '').slice(0, 400).toLowerCase();
  const es = (sample.match(/\b(el|la|los|las|que|de|para|con|una|por|es|y|no|como|más|pero|esto)\b/g) || []).length;
  const en = (sample.match(/\b(the|and|for|with|that|this|you|are|is|of|to|how|what|but|not)\b/g) || []).length;
  return en > es * 1.2 ? 'en' : 'es';
}

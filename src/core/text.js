import { countTokens as countO200k } from 'gpt-tokenizer';
import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { countTokens as countP50k } from 'gpt-tokenizer/encoding/p50k_base';
import { countTokens as countR50k } from 'gpt-tokenizer/encoding/r50k_base';

/**
 * Utilidades de texto del motor de mediación.
 *
 * Todo aquí es determinista, sin dependencias y sin estado: son funciones puras
 * que se ejecutan tanto en Node (tests, proceso principal) como en el navegador
 * (playground y script inyectado).
 */

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
/** Reutilizable: crear una expresión por llamada era parte del coste. */
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const SMART_QUOTES = /[\u2018\u2019\u201A\u201B]/g;

/** Normaliza unicode sin cambiar (casi nunca) la longitud del texto. */
export function nfkc(text) {
  return text.normalize('NFKC');
}

/** Quita caracteres invisibles que rompen comparaciones y confunden al modelo. */
export function stripInvisible(text) {
  return text.replace(ZERO_WIDTH, '');
}

/**
 * Canoniza texto para analizarlo: NFKC, sin invisibles, comillas rectas y
 * espacios colapsados en los bordes de cada línea.
 * @param {string} text
 */
export function canonical(text) {
  return stripInvisible(nfkc(text))
    .replace(SMART_QUOTES, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

/**
 * Minúsculas preservando la longitud del string.
 *
 * `String.prototype.toLowerCase` puede cambiar la longitud (p. ej. 'İ' pasa a
 * ser dos unidades de código), y los índices tienen que seguir apuntando al
 * texto original para poder recortarlo.
 *
 * Camino rápido: en la enorme mayoría de los textos la conversión nativa no
 * cambia la longitud, así que se usa tal cual. Antes se recorría carácter por
 * carácter —6 000 llamadas a `toLowerCase` y otras tantas concatenaciones por
 * análisis— y esta función sola costaba más que todo el resto junto.
 */
export function lowerPreservingLength(text) {
  const low = text.toLowerCase();
  if (low.length === text.length) return low;
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Tokens de palabra (letras/números, incluye acentos y CJK). */
export function tokenize(text) {
  return canonical(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

/**
 * Tokens y sus posiciones de inicio, en dos arrays paralelos.
 *
 * Es la forma barata de lo mismo que `tokenizeWithSpans`: sin un objeto por
 * palabra. El análisis corre cada pocos cientos de caracteres mientras el
 * modelo escribe, y ahí Mil objetos por llamada se notan.
 *
 * @param {string} text
 * @returns {{tokens: string[], starts: number[], ends: number[]}}
 */
export function tokenizeWithStarts(text) {
  const tokens = [];
  const starts = [];
  const ends = [];
  const re = TOKEN_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[0].toLowerCase());
    starts.push(m.index);
    ends.push(m.index + m[0].length);
  }
  return { tokens, starts, ends };
}

/**
 * Tokens con sus posiciones en el texto original.
 * Necesario para traducir «repetición de tokens» a un índice de corte exacto.
 * @param {string} text
 * @returns {Array<{token: string, start: number, end: number}>}
 */
export function tokenizeWithSpans(text) {
  const out = [];
  const re = TOKEN_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ token: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Divide en oraciones de forma heurística y multiidioma. */
export function sentences(text) {
  const clean = canonical(text).trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…])\s+(?=[¿¡"'(A-ZÁÉÍÓÚÑ0-9])|\n{2,}/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function lines(text) {
  return canonical(text).split('\n');
}

/** FNV-1a de 32 bits. Barato y suficiente para firmas de tokens. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Convierte una lista de tokens en un string de igual longitud (1 char = 1 token).
 * Permite reutilizar la detección de periodicidad sobre palabras en vez de letras.
 */
export function tokensToSignature(tokens) {
  let out = '';
  for (const t of tokens) out += String.fromCharCode(hash32(t) % 0xffff);
  return out;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/**
 * Estimación de tokens. No pretende competir con un tokenizador real: sirve
 * para decidir presupuestos de contexto con un margen de error aceptable.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  const cjk = (text.match(new RegExp(CJK, 'gu')) || []).length;
  const latin = chars - cjk;
  return Math.ceil(cjk / 1.6 + latin / 3.9) + 1;
}

/**
 * Cuenta tokens con el BPE correspondiente a la familia del modelo GPT.
 * Si el modelo no está disponible en la petición (caso habitual en algunas
 * interfaces web), usa o200k_base, codificación de los GPT modernos.
 */
export function countGptTokens(text, model = '') {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const id = String(model || '').toLowerCase();
  if (/^(text-davinci-001|davinci|curie|babbage|ada)(-|$)/.test(id)) return countR50k(text);
  if (/^(text-davinci-002|text-davinci-003|code-davinci|code-cushman)(-|$)/.test(id)) return countP50k(text);
  if (/^(gpt-3\.5|gpt-4(?:-|$))/.test(id) && !/^gpt-4(?:\.1|o)/.test(id)) return countCl100k(text);
  return countO200k(text);
}

/** Identifica el modelo declarado por el cuerpo de una solicitud GPT. */
export function gptModelFromRequest(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.model,
    payload.model_slug,
    payload.metadata?.model_slug,
    payload.metadata?.model,
    payload.conversation_mode?.model,
  ];
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '');
}

/** Diversidad léxica: tipos / tokens. Muy bajo => degeneración. */
export function distinctRatio(tokens) {
  if (tokens.length === 0) return 1;
  return new Set(tokens).size / tokens.length;
}

/** Entropía de Shannon (bits/token) de una ventana. */
export function entropy(tokens) {
  if (tokens.length === 0) return 0;
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / tokens.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Recorta dejando principio y final visibles. */
export function truncateMiddle(text, max = 400, marker = ' […] ') {
  if (text.length <= max) return text;
  const half = Math.floor((max - marker.length) / 2);
  return text.slice(0, half) + marker + text.slice(-half);
}

/** Cita corta para el registro de intervenciones. */
export function excerpt(text, max = 160) {
  const flat = canonical(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** Colapsa saltos de línea excesivos y espacios finales. */
export function collapseBlankLines(text, maxBlank = 1) {
  const joined = maxBlank === 1 ? '\n\n' : '\n'.repeat(maxBlank + 1);
  return text.replace(/\n{3,}/g, joined).replace(/[ \t]+$/gm, '');
}

/**
 * Estado de los bloques de código markdown (``` o ~~~).
 * @returns {{ open: boolean, fence: string, lang: string, start: number }}
 */
export function codeFenceState(text) {
  const re = /(^|\n)(`{3,}|~{3,})([^\n]*)/g;
  let m;
  let open = false;
  let fence = '';
  let lang = '';
  let start = -1;
  while ((m = re.exec(text)) !== null) {
    if (!open) {
      open = true;
      fence = m[2];
      lang = m[3].trim();
      start = m.index + m[1].length;
    } else if (m[2][0] === fence[0] && m[2].length >= fence.length && !m[3].trim()) {
      open = false;
      fence = '';
      lang = '';
      start = -1;
    }
  }
  return { open, fence: fence || '```', lang, start };
}

/**
 * Índice del último carácter "de contenido" (para detectar cortes).
 */
export function lastMeaningfulChar(text) {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? trimmed[trimmed.length - 1] : '';
}

/** Similitud Jaccard entre dos conjuntos de tokens. */
export function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Divide en bloques separados por línea en blanco. */
export function paragraphs(text) {
  return canonical(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Hash estable de un texto normalizado (para deduplicar turnos/párrafos). */
export function fingerprint(text) {
  const norm = canonical(text).toLowerCase().replace(/\s+/g, ' ').trim();
  return hash32(norm).toString(36);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

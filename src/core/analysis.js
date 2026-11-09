/**
 * Núcleo analítico: detección de periodicidad, tartamudeo y degeneración.
 *
 * La idea central: un bucle de un modelo de lenguaje casi siempre se manifiesta
 * como una *repetición con período* al final del texto generado — un párrafo,
 * una frase o incluso un token que vuelve a empezar. Se detecta con la función
 * de prefijos (KMP), que encuentra el período más corto de un sufijo en O(n).
 */

import {
  codeFenceState,
  distinctRatio,
  entropy,
  lowerPreservingLength,
  tokenize,
  tokenizeWithStarts,
  tokensToSignature,
} from './text.js';

/** Función de prefijos de Knuth-Morris-Pratt. */
export function prefixFunction(s) {
  const n = s.length;
  const pi = new Int32Array(n);
  for (let i = 1; i < n; i += 1) {
    let k = pi[i - 1];
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1];
    if (s[i] === s[k]) k += 1;
    pi[i] = k;
  }
  return pi;
}

/**
 * Igual que `zFunction` pero sobre una secuencia de códigos de carácter.
 *
 * Comparar números es bastante más rápido que comparar strings de un carácter,
 * y evita materializar la cadena invertida. Es el camino que usa el análisis
 * en vivo; `zFunction` queda para los tests y para texto suelto.
 *
 * @param {Uint16Array|number[]} codes
 */
export function zFunctionCodes(codes) {
  const n = codes.length;
  const z = new Int32Array(n);
  if (n === 0) return z;
  z[0] = n;
  let l = 0;
  let r = 0;
  for (let i = 1; i < n; i += 1) {
    if (i <= r) z[i] = Math.min(r - i + 1, z[i - l]);
    while (i + z[i] < n && codes[z[i]] === codes[i + z[i]]) z[i] += 1;
    if (i + z[i] - 1 > r) {
      l = i;
      r = i + z[i] - 1;
    }
  }
  return z;
}

/**
 * Función Z: z[i] = longitud del prefijo común más largo entre `s` y `s[i:]`.
 * Permite saber cuánto se prolonga una repetición a partir de una posición.
 */
export function zFunction(s) {
  const n = s.length;
  const z = new Int32Array(n);
  if (n === 0) return z;
  z[0] = n;
  let l = 0;
  let r = 0;
  for (let i = 1; i < n; i += 1) {
    if (i <= r) z[i] = Math.min(r - i + 1, z[i - l]);
    while (i + z[i] < n && s[z[i]] === s[i + z[i]]) z[i] += 1;
    if (i + z[i] - 1 > r) {
      l = i;
      r = i + z[i] - 1;
    }
  }
  return z;
}

/**
 * Busca el sufijo repetido de menor período.
 *
 * Un bucle se manifiesta al final del texto, no al principio, así que el
 * análisis se hace sobre la cadena invertida: «repetir al final» equivale a
 * «empezar repitiendo» en el reverso, y eso es exactamente lo que mide la
 * función Z.
 *
 * @param {string} str
 * @param {{minUnit?: number, minRepeats?: number, maxUnit?: number, maxScan?: number}} [opts]
 * @returns {null | {unitLength: number, repeats: number, start: number, unit: string, period: number}}
 */
export function repeatingSuffix(str, opts = {}) {
  const { minUnit = 40, minRepeats = 2, maxUnit = Infinity, maxScan = 20000 } = opts;
  const s = str.length > maxScan ? str.slice(-maxScan) : str;
  const offset = str.length - s.length;
  const n = s.length;
  if (n < minUnit * minRepeats) return null;

  // Invertido por unidades de código, en un array numérico: la correspondencia
  // 1:1 de índices se conserva y no se crea un string por carácter (que era,
  // literalmente, un arreglo de 20 000 strings por análisis).
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i += 1) rev[n - 1 - i] = s.charCodeAt(i);
  const z = zFunctionCodes(rev);

  let best = null;
  const limit = Math.floor(n / minRepeats);
  for (let unit = Math.max(1, minUnit); unit <= Math.min(limit, maxUnit, n - 1); unit += 1) {
    if (z[unit] < unit) continue;
    const repeats = 1 + Math.floor(z[unit] / unit);
    if (repeats >= minRepeats) {
      best = { unit, repeats };
      break; // el primero encontrado es el período más corto
    }
  }
  if (!best) return null;

  const span = best.unit * best.repeats;
  const start = n - span;
  return {
    period: best.unit,
    unitLength: best.unit,
    repeats: best.repeats,
    start: start + offset,
    unit: s.slice(start, start + best.unit),
  };
}

/**
 * Tartamudeo de un mismo token: «la la la la la».
 * @param {string[]} tokens
 * @param {{minRepeats?: number, lookback?: number}} [opts]
 */
export function tokenStutter(tokens, opts = {}) {
  const { minRepeats = 6, lookback = 60 } = opts;
  const tail = tokens.slice(-lookback);
  if (tail.length < minRepeats) return null;
  let best = null;
  let run = 1;
  for (let i = 1; i < tail.length; i += 1) {
    if (tail[i] === tail[i - 1]) {
      run += 1;
      if (!best || run > best.repeats) best = { token: tail[i], repeats: run, atEnd: i === tail.length - 1 };
    } else {
      run = 1;
    }
  }
  if (!best || best.repeats < minRepeats) return null;
  return best;
}

/**
 * Líneas idénticas consecutivas o casi idénticas (listas que se reescriben).
 * @param {string} text
 */
export function lineLoop(text, opts = {}) {
  const { minRepeats = 3, minLength = 12, ignore = /^([-*+•]|\d+[.)]|>|#{1,6})?\s*$/ } = opts;
  const raw = text.split('\n');
  const seen = new Map();
  for (let i = 0; i < raw.length; i += 1) {
    const norm = raw[i].toLowerCase().replace(/\s+/g, ' ').replace(/^([-*+•]|\d+[.)])\s*/, '').trim();
    if (norm.length < minLength || ignore.test(norm)) {
      seen.clear();
      continue;
    }
    const key = norm;
    const prev = seen.get(key);
    if (!prev) {
      seen.clear();
      seen.set(key, { first: i, count: 1, index: i });
      continue;
    }
    prev.count += 1;
    prev.last = i;
    if (prev.count >= minRepeats && prev.last - prev.first <= 12) {
      return { line: norm, repeats: prev.count, firstLine: prev.first, lastLine: prev.last };
    }
  }
  return null;
}

/**
 * Repetición de bloques separados por líneas en blanco (párrafos que se repiten).
 */
export function paragraphLoop(text, opts = {}) {
  const { minRepeats = 2, minLength = 60 } = opts;
  const blocks = text.split(/\n{2,}/).map((b) => b.trim());
  const counts = new Map();
  let lastKey = null;
  let run = 0;
  for (const block of blocks) {
    const key = block.toLowerCase().replace(/\s+/g, ' ');
    if (key.length < minLength) {
      run = 0;
      lastKey = null;
      continue;
    }
    if (key === lastKey) run += 1;
    else {
      lastKey = key;
      run = 1;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
    if (run >= minRepeats || counts.get(key) >= minRepeats + 1) {
      return { block: block.slice(0, 120), repeats: Math.max(run, counts.get(key)), exact: true };
    }
  }
  return null;
}

/**
 * Detecta repetición por retardo (*lag*): el final del texto es idéntico a un
 * fragmento que aparece `lag` caracteres antes.
 *
 * Es la detección que funciona en streaming: no hace falta esperar a que se
 * complete una segunda copia del bloque. Con 44 caracteres repetidos ya se sabe
 * que el modelo volvió a donde estaba, y se conoce el punto exacto donde
 * empezó a repetir.
 *
 * @param {string} text
 * @param {{k?: number, minLag?: number, maxLag?: number}} [opts]
 * @returns {null | {lag: number, start: number, cutAt: number, unit: string, repeats: number}}
 */
export function findLagRepeat(text, opts = {}) {
  const { k = 44, minLag = 44, maxLag = 2400 } = opts;
  const n = text.length;
  if (n < k + minLag) return null;

  const tail = text.slice(n - k);
  const from = Math.max(0, n - maxLag - k);
  const hay = text.slice(from, n - k);
  let idx = hay.lastIndexOf(tail);
  let best = null;

  while (idx !== -1) {
    const start = from + idx;
    const lag = n - k - start;
    if (lag >= minLag && lag <= maxLag) {
      // Se prefiere el retardo más grande que siga siendo una repetición
      // contigua hasta el final: describe mejor el bloque completo repetido.
      const span = n - start;
      const repeats = span / lag;
      if (!best || lag > best.lag) best = { lag, start, repeats };
    }
    idx = idx > 0 ? hay.lastIndexOf(tail, idx - 1) : -1;
  }

  if (!best) return null;
  return {
    lag: best.lag,
    start: best.start,
    cutAt: best.start,
    unit: text.slice(best.start, best.start + best.lag),
    repeats: Math.floor(best.repeats * 100) / 100,
  };
}

/**
 * Analiza el final de un texto y devuelve todas las señales de bucle.
 *
 * @param {string} text
 * @param {{policy?: object}} [opts]
 * @returns {{loop: boolean, severity: 'none'|'low'|'medium'|'high', type: string|null, detail: object|null, signals: object}}
 */
export function analyzeTail(text, opts = {}) {
  const {
    tailChars = 6000,
    minUnit = 48,
    minRepeats = 2.4,
    stutterRepeats = 5,
    diversityFloor = 0.22,
  } = opts.policy || {};

  const tail = text.length > tailChars ? text.slice(-tailChars) : text;
  const offset = text.length - tail.length;
  const low = lowerPreservingLength(tail);
  // Tokens y posiciones en dos arrays paralelos: sin un objeto por palabra.
  const { tokens, starts } = tokenizeWithStarts(tail);
  const signals = {
    charRepeat: null,
    tokenRepeat: null,
    stutter: null,
    line: null,
    paragraph: null,
    diversity: distinctRatio(tokens.slice(-160)),
    entropy: null,
  };

  // 1) REPETICIÓN POR RETARDO (detección principal, la que funciona en vivo).
  const lag = findLagRepeat(low, { k: 44, minLag: Math.max(44, minUnit), maxLag: tailChars });
  if (lag) {
    signals.lagRepeat = lag;
    return {
      loop: true,
      severity: lag.repeats >= 2.5 || lag.lag < 140 ? 'high' : 'medium',
      type: 'repeat-unit',
      detail: {
        period: lag.lag,
        unitLength: lag.lag,
        repeats: Math.max(2, Math.round(lag.repeats)),
        start: lag.start + offset,
        cutAt: lag.cutAt + offset,
        unit: lag.unit,
        chars: tail.length - lag.start,
      },
      signals,
    };
  }

  // 2) Repetición exacta de un sufijo completo (varias copias cortas).
  const charRepeat = repeatingSuffix(low, {
    minUnit,
    minRepeats: Math.max(2, Math.round(minRepeats)),
    maxScan: tailChars,
  });
  if (charRepeat) {
    signals.charRepeat = charRepeat;
    const effective = charRepeat.period * charRepeat.repeats;
    const harmful =
      (charRepeat.period >= 120 && charRepeat.repeats >= 2) ||
      charRepeat.repeats >= 3 ||
      (effective >= 400 && charRepeat.period >= 60);
    if (harmful) {
      return {
        loop: true,
        severity: charRepeat.repeats >= 3 || effective > 1200 ? 'high' : 'medium',
        type: 'repeat-unit',
        detail: {
          ...charRepeat,
          start: charRepeat.start + offset,
          cutAt: charRepeat.start + offset + charRepeat.period,
          chars: effective,
        },
        signals,
      };
    }
  }

  // 3) Repetición a nivel de token (misma frase, puntuación distinta).
  if (tokens.length >= 24) {
    const sig = tokensToSignature(tokens);
    const tokenLag = findLagRepeat(sig, { k: 14, minLag: 14, maxLag: 400 });
    if (tokenLag && tokenLag.repeats >= 1.4) {
      signals.tokenRepeat = tokenLag;
      return {
        loop: true,
        severity: tokenLag.repeats >= 2 ? 'high' : 'medium',
        type: 'repeat-tokens',
        detail: {
          tokens: tokenLag.lag,
          repeats: Math.max(2, Math.round(tokenLag.repeats)),
          words: tokens.slice(tokenLag.start, tokenLag.start + tokenLag.lag).join(' '),
          start: offset + (starts[tokenLag.start] ?? 0),
          cutAt: offset + (starts[tokenLag.start] ?? 0),
        },
        signals,
      };
    }
  }

  // 4) Tartamudeo de un token.
  const stutter = tokenStutter(tokens, { minRepeats: stutterRepeats });
  if (stutter) {
    signals.stutter = stutter;
    return { loop: true, severity: 'high', type: 'stutter', detail: stutter, signals };
  }

  // 5) Líneas repetidas (listas que se reescriben).
  const line = lineLoop(tail);
  if (line) {
    signals.line = line;
    return { loop: true, severity: 'high', type: 'line-loop', detail: line, signals };
  }

  // 6) Párrafos repetidos.
  const para = paragraphLoop(tail);
  if (para) {
    signals.paragraph = para;
    return { loop: true, severity: 'medium', type: 'paragraph-loop', detail: para, signals };
  }

  // 7) Degeneración: vocabulario empobrecido.
  if (signals.diversity < diversityFloor && tokens.length >= 60) {
    return {
      loop: true,
      severity: 'low',
      type: 'degeneration',
      detail: { diversity: signals.diversity },
      signals,
    };
  }

  return { loop: false, severity: 'none', type: null, detail: null, signals };
}

/**
 * Detecta si la respuesta quedó cortada (fin abrupto).
 * @param {string} text
 * @returns {{truncated: boolean, reason: string|null}}
 */
export function detectTruncation(text) {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return { truncated: false, reason: null };

  const fence = codeFenceState(trimmed);
  if (fence.open) return { truncated: true, reason: 'code-fence-open' };

  const lastChar = trimmed[trimmed.length - 1];
  if (/[,;:—–\-–/]$/.test(lastChar)) return { truncated: true, reason: 'dangling-punctuation' };

  // Paréntesis/corchetes sin cerrar en la última línea.
  const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
  const open = (lastLine.match(/[([{]/g) || []).length;
  const close = (lastLine.match(/[)\]}]/g) || []).length;
  if (open > close) return { truncated: true, reason: 'unbalanced-brackets' };

  // Termina en palabra de enlace: señal fuerte de corte.
  const tailWord = (trimmed.match(/([\p{L}]+)$/u) || [''])[0].toLowerCase();
  const connectors = new Set([
    'y', 'o', 'pero', 'que', 'de', 'en', 'con', 'para', 'por', 'como', 'si',
    'and', 'or', 'but', 'the', 'of', 'to', 'with', 'for', 'that', 'as', 'if',
    'el', 'la', 'los', 'las', 'un', 'una', 'su', 'sus', 'because', 'while',
  ]);
  if (connectors.has(tailWord) && trimmed.length > 36) {
    return { truncated: true, reason: 'trailing-connector' };
  }

  // Sin puntuación final en un párrafo normal: corte seco.
  const lastBlock = trimmed.split(/\n{2,}/).pop() || '';
  const structural = /^\s*([-*+•]|\d+[.)]|\||#{1,6}\s|>|```)/.test(lastBlock);
  const endsComplete = /[.!?…:;"'”’)\]}*_`]$/.test(trimmed);
  if (!structural && !endsComplete && trimmed.length > 80) {
    return { truncated: true, reason: 'no-terminal-punctuation' };
  }

  return { truncated: false, reason: null };
}

/**
 * Métricas de salud de una respuesta completa.
 */
export function healthReport(text) {
  const tokens = tokenize(text);
  return {
    chars: text.length,
    tokens: tokens.length,
    sentences: (text.match(/[.!?…]+/g) || []).length,
    diversity: Number(distinctRatio(tokens).toFixed(3)),
    entropy: Number(entropy(tokens).toFixed(3)),
    longestTokenRun: tokens.length,
  };
}

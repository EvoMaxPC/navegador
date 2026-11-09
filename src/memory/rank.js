/**
 * EVO MEMORY · Recuperación
 *
 * Seis señales, cada una aporta algo que las otras no ven:
 *
 *   léxica      BM25      — coincidencia de términos con el índice invertido
 *   semántica   coseno    — similitud TF‑IDF, tolera sinónimos parciales y órdenes distintos
 *   anclas      exactas   — números, rutas, URLs, versiones: el dato duro que un resumen pierde
 *   saliencia   peso      — tipo de memoria, confianza, refuerzos por uso
 *   frescura    decaimiento — lo de ayer pesa más que lo del mes pasado
 *   intención   prior     — si preguntás «qué falta», los pendientes suben
 *
 * Después, MMR (maximal marginal relevance) evita que el contexto se llene con
 * cinco versiones de la misma idea. Diversidad no es estética: es presupuesto de
 * tokens que se convierte en información.
 */

import { freshnessOf, isActive, KIND_META, salienceOf } from './item.js';
import { anchors, bm25, cosine, expandQueryTerms, idf, indexTerms, termJaccard, tfidfVector } from './lexicon.js';

export const DEFAULT_WEIGHTS = {
  lexical: 0.32,
  semantic: 0.24,
  anchors: 0.12,
  salience: 0.18,
  recency: 0.09,
  prior: 0.05,
};

/** Señales de intención: la consulta dice qué tipo de memoria necesita. */
const INTENT_RULES = [
  { re: /\b(falta|pendiente|queda|siguiente|pr[oó]ximo|todo|retomar|continuar|avanzar)\b/i, kinds: ['task', 'goal'] },
  { re: /\b(decid|eleg|opt|por qu[eé] se|qu[eé] elegimos|acord)\w*/i, kinds: ['decision', 'constraint'] },
  { re: /\b(puedo|se puede|permitido|restricci[oó]n|l[ií]mite|prohibido|debo)\b/i, kinds: ['constraint', 'preference'] },
  { re: /\b(c[oó]mo era|cu[aá]l era|d[oó]nde|puerto|versi[oó]n|url|ruta|archivo|comando)\b/i, kinds: ['fact', 'artifact', 'entity'] },
  { re: /\b(prefier|estilo|convenci[oó]n|siempre|nunca)\b/i, kinds: ['preference'] },
];

/** Devuelve los tipos que la consulta está pidiendo (vacío si no hay señal). */
export function inferIntent(query) {
  const kinds = new Set();
  for (const rule of INTENT_RULES) {
    if (rule.re.test(query)) for (const kind of rule.kinds) kinds.add(kind);
  }
  return [...kinds];
}

/**
 * Recupera y ordena memorias relevantes.
 *
 * @param {import('./store.js').MemoryStore} store
 * @param {{
 *   query: string,
 *   projectId?: string|null,
 *   limit?: number,
 *   now?: number,
 *   weights?: Partial<typeof DEFAULT_WEIGHTS>,
 *   excludeTerms?: string[],
 *   excludeIds?: Iterable<string>,
 *   mmrLambda?: number,
 *   minScore?: number,
 *   kinds?: string[]|null
 * }} opts
 * @returns {Array<{item: any, score: number, parts: object}>}
 */
export function retrieve(store, opts) {
  const {
    query = '',
    projectId = null,
    limit = 12,
    now = Date.now(),
    weights = {},
    excludeTerms = [],
    excludeIds = [],
    mmrLambda = 0.74,
    minScore = 0.04,
    kinds = null,
  } = opts;

  const W = { ...DEFAULT_WEIGHTS, ...weights };
  const literalTerms = indexTerms(query);
  // Expansión conceptual: 1.0 para lo que el usuario escribió, 0.5 para sus afines.
  const termWeights = expandQueryTerms(literalTerms);
  const queryTerms = [...termWeights.keys()];
  const queryAnchors = new Set(anchors(query));
  const intent = inferIntent(query);
  const excluded = new Set(excludeIds);
  const excludedTermSet = new Set(excludeTerms);

  // Candidatos: índice invertido (con expansión) + una red de seguridad por
  // saliencia. La red evita el peor fallo posible de un motor de memoria: que no
  // devuelva nada cuando sí había algo importante.
  const ids = new Set(store.candidates(queryTerms));
  const projectItems = store.all({ projectId, includeSuperseded: false, kinds });
  for (const item of projectItems) {
    if (item.pinned || item.kind === 'goal') ids.add(item.id);
  }
  if (ids.size < Math.min(limit, projectItems.length)) {
    const bySalience = projectItems
      .slice()
      .sort((a, b) => salienceOf(b, now) - salienceOf(a, now))
      .slice(0, Math.max(limit * 3, 24));
    for (const item of bySalience) ids.add(item.id);
  }

  const candidates = [];
  for (const id of ids) {
    if (excluded.has(id)) continue;
    const item = store.get(id);
    if (!item || !isActive(item)) continue;
    if (kinds && !kinds.includes(item.kind)) continue;
    if (projectId && item.projectId !== projectId) continue;
    candidates.push(item);
  }
  if (!candidates.length) return [];

  // Normalizadores para que las señales sean comparables.
  const N = Math.max(1, store.size);
  const avgdl = store.averageLength;
  const idfOf = (term) => idf(store.documentFrequency(term), N);
  const weightedIdf = (term) => idfOf(term) * (termWeights.get(term) ?? 1);
  const queryVector = tfidfVector(queryTerms, weightedIdf);

  const scored = [];
  let maxLexical = 0;
  let maxSemantic = 0;

  for (const item of candidates) {
    const tf = store.frequencies(item);
    let lexical = bm25(tf, item.terms.length, avgdl, weightedIdf, queryTerms);
    if (item.pinned && !queryTerms.length) lexical = 0;
    const itemVector = tfidfVector(item.terms, idfOf);
    const semantic = queryTerms.length ? cosine(queryVector, itemVector) : 0;

    const anchorHits = item.anchors.filter((a) => queryAnchors.has(a)).length;
    const anchorScore = queryAnchors.size ? anchorHits / queryAnchors.size : 0;

    maxLexical = Math.max(maxLexical, lexical);
    maxSemantic = Math.max(maxSemantic, semantic);

    scored.push({ item, lexical, semantic, anchorScore, itemVector });
  }

  for (const entry of scored) {
    const { item } = entry;
    const lexicalNorm = maxLexical ? entry.lexical / maxLexical : 0;
    const semanticNorm = maxSemantic ? entry.semantic / maxSemantic : 0;
    const salience = salienceOf(item, now);
    const recency = freshnessOf(item, now);

    // Prior de intención: pequeño empujón, nunca decide solo.
    const prior = intent.length ? (intent.includes(item.kind) ? 1 : 0) : 0.35;
    const kindWeight = (KIND_META[item.kind] || KIND_META.fact).weight;

    // Penalización por redundancia con lo que ya está en el contexto.
    const overlap = excludedTermSet.size ? termJaccard(item.terms, [...excludedTermSet]) : 0;
    const redundancy = 1 - 0.65 * overlap;

    const score =
      (W.lexical * lexicalNorm +
        W.semantic * semanticNorm +
        W.anchors * entry.anchorScore +
        W.salience * salience +
        W.recency * recency +
        W.prior * prior) *
      (0.6 + 0.4 * kindWeight) *
      redundancy;

    entry.score = score;
    entry.parts = {
      lexical: round(lexicalNorm),
      semantic: round(semanticNorm),
      anchors: round(entry.anchorScore),
      salience: round(salience),
      recency: round(recency),
      prior: round(prior),
      redundancy: round(redundancy),
    };
  }

  const ranked = scored.filter((e) => e.score >= minScore).sort((a, b) => b.score - a.score);

  // MMR: se elige el siguiente maximizando relevancia − similitud con lo ya elegido.
  const selected = [];
  const pool = [...ranked];
  while (selected.length < limit && pool.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      let maxSim = 0;
      for (const chosen of selected) {
        const sim = cosine(candidate.itemVector, chosen.itemVector);
        if (sim > maxSim) maxSim = sim;
      }
      const value = mmrLambda * candidate.score - (1 - mmrLambda) * maxSim;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    chosen.mmr = round(bestValue);
    selected.push(chosen);
  }

  return selected.map((entry) => ({
    item: entry.item,
    score: round(entry.score, 4),
    mmr: entry.mmr,
    parts: entry.parts,
  }));
}

function round(n, d = 3) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

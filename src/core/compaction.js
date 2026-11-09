/**
 * Compactación de contexto.
 *
 * En conversaciones largas el modelo empieza a perder el hilo (o la ventana se
 * llena y el cliente recorta por su cuenta, casi siempre mal). En vez de dejar
 * que eso ocurra, Nexo pliega los turnos antiguos en una "tarjeta de memoria"
 * extractiva y determinista: no resume con otro modelo, elige y ordena lo que
 * importa. El resultado se inyecta como un único bloque compacto.
 */

import { canonical, estimateTokens, excerpt, fingerprint, sentences, truncateMiddle } from './text.js';

const SIGNAL_PATTERNS = [
  { re: /\b(decid\w*|acordad\w*|acordamos|eleg\w*|elegimos|vamos con|quedamos en)\b/i, weight: 3, kind: 'decision' },
  { re: /\b(pendiente|falta|todavía|todavia|próximo paso|siguiente paso|todo|por hacer|queda)\b/i, weight: 2.2, kind: 'pending' },
  { re: /\b(error|falla|bug|problema|excepción|exception|no funciona|rompe)\b/i, weight: 2, kind: 'issue' },
  { re: /\b(requiere|requisito|debe|tiene que|hay que|obligatorio|restricción)\b/i, weight: 1.9, kind: 'constraint' },
  { re: /\b(versión|version|puerto|API|endpoint|modelo|framework|npm|comando|script)\b/i, weight: 1.6, kind: 'tech' },
  { re: /\b\d{2,}\b/, weight: 1.3, kind: 'number' },
  { re: /`[^`]+`|\b[\w.-]+\.(js|ts|py|json|md|css|html)\b/, weight: 1.5, kind: 'code' },
  { re: /\b(porque|ya que|dado que|motivo|razón|razon)\b/i, weight: 1.2, kind: 'reason' },
  { re: /[?¿]/, weight: 1.1, kind: 'question' },
];

/** Puntúa una oración según las señales que contiene. */
export function scoreSentence(sentence) {
  let score = 0;
  const kinds = [];
  for (const p of SIGNAL_PATTERNS) {
    if (p.re.test(sentence)) {
      score += p.weight;
      kinds.push(p.kind);
    }
  }
  // Las oraciones muy cortas o muy largas aportan poco al resumen.
  const words = sentence.split(/\s+/).length;
  if (words < 4) score -= 0.6;
  if (words > 60) score -= 0.4;
  if (words >= 8 && words <= 30) score += 0.5;
  return { score: Math.max(0, score), kinds };
}

/**
 * Construye una tarjeta de memoria a partir de turnos antiguos.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} turns
 * @param {{maxChars?: number, maxItems?: number}} [opts]
 * @returns {{card: string, items: Array<{role: string, text: string, kind: string}>, foldedTurns: number, charsSaved: number, tokensSaved: number}}
 */
export function buildMemoryCard(turns, opts = {}) {
  const { maxChars = 1200, maxItems = 12 } = opts;
  const candidates = [];
  const seen = new Set();
  let originalChars = 0;

  for (const turn of turns) {
    const content = canonical(turn.content || '');
    originalChars += content.length;
    const parts = sentences(content);
    for (const s of parts) {
      const fp = fingerprint(s);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const { score, kinds } = scoreSentence(s);
      if (score < 1.2) continue;
      candidates.push({
        role: turn.role,
        text: truncateMiddle(s.replace(/\s+/g, ' ').trim(), 220),
        kind: kinds[0] || 'info',
        score,
        order: candidates.length,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const picked = candidates.slice(0, maxItems);

  // Reordenar cronológicamente para que la tarjeta se lea como una historia.
  picked.sort((a, b) => a.order - b.order);

  const grouped = { decision: [], pending: [], issue: [], constraint: [], other: [] };
  for (const item of picked) {
    const bucket = grouped[item.kind] ? item.kind : 'other';
    grouped[bucket].push(item);
  }

  const sectionTitles = {
    decision: 'Decisiones',
    pending: 'Pendientes',
    issue: 'Problemas abiertos',
    constraint: 'Restricciones',
    other: 'Contexto',
  };

  const lines = [];
  for (const key of ['decision', 'constraint', 'pending', 'issue', 'other']) {
    if (!grouped[key].length) continue;
    lines.push(`${sectionTitles[key]}:`);
    for (const item of grouped[key]) {
      const tag = item.role === 'user' ? 'U' : 'A';
      lines.push(`- (${tag}) ${item.text}`);
    }
  }

  let card = lines.join('\n');
  if (card.length > maxChars) {
    card = `${card.slice(0, maxChars - 1).trimEnd()}…`;
  }

  return {
    card,
    items: picked,
    foldedTurns: turns.length,
    charsSaved: Math.max(0, originalChars - card.length),
    tokensSaved: Math.max(0, estimateTokens(turns.map((t) => t.content).join('\n')) - estimateTokens(card)),
  };
}

/**
 * Decide qué turnos se mantienen literales y cuáles se pliegan.
 *
 * @param {Array<{role: string, content: string, tokens?: number}>} turns
 * @param {{budgetTokens?: number, keepRecent?: number}} [opts]
 * @returns {{keep: Array, fold: Array, card: object|null, tokensBefore: number, tokensAfter: number}}
 */
export function planBudget(turns, opts = {}) {
  const { budgetTokens = 6000, keepRecent = 6 } = opts;
  const withTokens = turns.map((t) => ({ ...t, tokens: t.tokens ?? estimateTokens(t.content || '') }));
  const tokensBefore = withTokens.reduce((acc, t) => acc + t.tokens, 0);

  if (tokensBefore <= budgetTokens || withTokens.length <= keepRecent) {
    return { keep: withTokens, fold: [], card: null, tokensBefore, tokensAfter: tokensBefore };
  }

  // Pliega desde el principio hasta que el resto entre en el presupuesto,
  // respetando siempre un mínimo de turnos recientes literales.
  const keep = [];
  let used = 0;
  for (let i = withTokens.length - 1; i >= 0; i -= 1) {
    const t = withTokens[i];
    const mustKeep = withTokens.length - i <= keepRecent;
    if (!mustKeep && used + t.tokens > budgetTokens) break;
    keep.unshift(t);
    used += t.tokens;
  }

  const fold = withTokens.slice(0, withTokens.length - keep.length);
  const card = fold.length ? buildMemoryCard(fold, {
    maxChars: Math.min(1400, Math.max(400, Math.round(budgetTokens * 0.35 * 3.9))),
  }) : null;

  return {
    keep,
    fold,
    card,
    tokensBefore,
    tokensAfter: used + (card ? estimateTokens(card.card) : 0),
  };
}

/** Texto listo para inyectar con la tarjeta de memoria. */
export function renderMemoryBlock(card, header) {
  if (!card || !card.card) return '';
  return `${header}\n${card.card}`;
}

/** Resumen de un turno para la consola de intervenciones. */
export function describeFold(plan) {
  if (!plan.card) return null;
  return {
    foldedTurns: plan.fold.length,
    tokensBefore: plan.tokensBefore,
    tokensAfter: plan.tokensAfter,
    preview: excerpt(plan.card.card, 180),
  };
}

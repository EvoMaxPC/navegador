/**
 * EVO MEMORY · Unidad de memoria
 *
 * Una memoria no es un trozo de texto: es un registro con tipo, procedencia,
 * vigencia y peso. La diferencia importa: «decidimos PostgreSQL» y «usamos
 * PostgreSQL» no valen lo mismo cuando hay que retomar un proyecto tres semanas
 * después, y un pendiente de ayer no debe competir con una preferencia de hace un
 * año.
 */

import { estimateTokens } from '../core/text.js';
import { anchors, indexTerms, isNegated, termJaccard } from './lexicon.js';

/**
 * Tipología y su comportamiento en el tiempo.
 * `halfLifeDays`: a los cuántos días la frescura cae a la mitad.
 * `weight`: importancia intrínseca del tipo.
 */
export const KIND_META = {
  goal: { label: 'Objetivo', short: 'obj', weight: 1.0, halfLifeDays: 120, emoji: '◎' },
  decision: { label: 'Decisión', short: 'dec', weight: 1.0, halfLifeDays: 180, emoji: '◆' },
  constraint: { label: 'Restricción', short: 'res', weight: 0.95, halfLifeDays: 180, emoji: '⛒' },
  preference: { label: 'Preferencia', short: 'pref', weight: 0.85, halfLifeDays: 365, emoji: '★' },
  task: { label: 'Pendiente', short: 'tarea', weight: 0.92, halfLifeDays: 14, emoji: '▸' },
  issue: { label: 'Problema abierto', short: 'issue', weight: 0.88, halfLifeDays: 30, emoji: '⚠' },
  fact: { label: 'Dato', short: 'dato', weight: 0.7, halfLifeDays: 60, emoji: '•' },
  entity: { label: 'Entidad', short: 'ent', weight: 0.6, halfLifeDays: 90, emoji: '◇' },
  artifact: { label: 'Artefacto', short: 'art', weight: 0.82, halfLifeDays: 90, emoji: '⌘' },
  episode: { label: 'Episodio', short: 'ep', weight: 0.5, halfLifeDays: 30, emoji: '≡' },
  question: { label: 'Pregunta abierta', short: 'q', weight: 0.78, halfLifeDays: 7, emoji: '?' },
};

export const KINDS = Object.keys(KIND_META);

let counter = 0;

/** Identificador estable y ordenable. */
export function nextId(prefix = 'm') {
  counter = (counter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * ¿El texto es un bloque cifrado o codificado en vez de lenguaje?
 *
 * Un registro así no es una memoria: es un dato que no se puede leer ni usar
 * para responder. Reconocerlo permite no guardarlo a futuro y no mostrarlo como
 * si fuera texto normal, sin tocar lo que ya esté guardado.
 *
 * El caso que lo motivó es una memoria importada con tokens Fernet (`gAAAAA…`,
 * el formato de `cryptography.fernet` de Python): el panel mostraba el token
 * crudo, indistinguible de basura.
 */
export function looksEncrypted(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  // Firma de un token Fernet (versión 0x80 en base64url). Se busca en cualquier
  // posición: un resumen puede traerlo precedido de su etiqueta («Se respondió:»).
  if (/gAAAAA[A-Za-z0-9_\-+/=]{20,}/.test(value)) return true;
  if (/\s/.test(value)) return false;
  if (value.length < 32) return false;
  // Cualquier otro blob: un solo «alfabeto» de token, sin espacios ni palabras.
  if (!/^[A-Za-z0-9_\-+/=.:]+$/.test(value)) return false;
  const upper = (value.match(/[A-Z]/g) || []).length;
  const digits = (value.match(/\d/g) || []).length;
  return upper / value.length >= 0.2 && digits / value.length >= 0.04;
}

/** Huella normalizada del contenido (para deduplicar sin colisiones semánticas). */
export function fingerprintOf(text) {
  return indexTerms(text).slice(0, 40).join(' ');
}

/**
 * Crea un registro de memoria listo para el índice.
 *
 * @param {{
 *   kind: string, text: string, projectId?: string, conversationId?: string,
 *   source?: object, confidence?: number, pinned?: boolean, id?: string, ts?: number,
 *   supersedes?: string|null
 * }} input
 */
export function createItem(input) {
  const text = String(input.text || '').trim();
  const kind = KIND_META[input.kind] ? input.kind : 'fact';
  const now = input.ts || Date.now();
  const terms = indexTerms(text);

  const item = {
    id: input.id || nextId(),
    kind,
    text,
    fingerprint: fingerprintOf(text),
    terms,
    anchors: anchors(text),
    tokens: estimateTokens(text),
    projectId: input.projectId || 'default',
    conversationId: input.conversationId || null,
    source: {
      role: input.source?.role || 'user',
      model: input.source?.model || null,
      url: input.source?.url || null,
      messageId: input.source?.messageId || null,
    },
    confidence: clamp01(input.confidence ?? 0.7),
    pinned: Boolean(input.pinned),
    createdAt: now,
    updatedAt: now,
    validFrom: now,
    validUntil: null,
    supersededBy: input.supersedes || null,
    supersedes: input.supersedes || null,
    uses: 0,
    lastUsedAt: null,
    merged: 0,
  };

  item.importance = importanceOf(item);
  return item;
}

/** Importancia estática: tipo + confianza + fijado + refuerzos por uso. */
export function importanceOf(item) {
  const meta = KIND_META[item.kind] || KIND_META.fact;
  const reinforcement = Math.min(0.25, item.uses * 0.04);
  const pinnedBonus = item.pinned ? 0.22 : 0;
  return clamp01(meta.weight * 0.62 + item.confidence * 0.24 + reinforcement + pinnedBonus);
}

/** Frescura exponencial según la vida media del tipo. */
export function freshnessOf(item, now = Date.now()) {
  const meta = KIND_META[item.kind] || KIND_META.fact;
  const anchor = item.lastUsedAt || item.updatedAt || item.createdAt;
  const days = Math.max(0, (now - anchor) / 86_400_000);
  return Math.pow(0.5, days / meta.halfLifeDays);
}

/** Peso final de una memoria: importancia y frescura, con la vigencia como castigo. */
export function salienceOf(item, now = Date.now()) {
  if (item.supersededBy) return 0;
  const freshness = freshnessOf(item, now);
  return clamp01(item.importance * (0.55 + 0.45 * freshness));
}

/** ¿Sigue vigente? */
export function isActive(item) {
  return !item.supersededBy && !item.validUntil;
}

/**
 * Fusiona un candidato con una memoria casi idéntica ya existente.
 * Se queda con el texto más informativo, refuerza el peso y conserva las anclas.
 */
export function mergeInto(existing, candidate) {
  const winner = candidate.text.length > existing.text.length ? candidate.text : existing.text;
  existing.text = winner;
  existing.terms = indexTerms(winner);
  existing.fingerprint = fingerprintOf(winner);
  existing.anchors = [...new Set([...(existing.anchors || []), ...(candidate.anchors || [])])].slice(0, 24);
  existing.tokens = estimateTokens(winner);
  existing.uses += 1;
  existing.merged += 1;
  existing.updatedAt = Math.max(existing.updatedAt, candidate.updatedAt || Date.now());
  existing.confidence = clamp01(Math.max(existing.confidence, candidate.confidence ?? 0.7) + 0.02);
  existing.pinned = existing.pinned || Boolean(candidate.pinned);
  existing.importance = importanceOf(existing);
  return existing;
}

/**
 * ¿Dos memorias del mismo asunto se contradicen?
 *
 * Se considera contradicción cuando comparten sujeto (alta similitud de términos)
 * pero difieren en polaridad, o cuando fijan valores distintos para el mismo
 * atributo (puerto 5432 vs 5433). Es deliberadamente conservador: un falso
 * positivo archiva una memoria buena, y eso cuesta más que dejar pasar una mala.
 */
export function contradicts(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.projectId !== b.projectId) return false;
  const similarity = termJaccard(a.terms, b.terms);
  if (similarity < 0.62) return false;

  const polarityDiff = isNegated(a.text) !== isNegated(b.text);
  if (polarityDiff) return true;

  const numbersA = (a.text.match(/\d+(?:[.,]\d+)?/g) || []).join(',');
  const numbersB = (b.text.match(/\d+(?:[.,]\d+)?/g) || []).join(',');
  if (numbersA && numbersB && numbersA !== numbersB) return true;

  return false;
}

/** Marca una memoria como reemplazada por otra (borrado lógico, conserva historia). */
export function supersede(oldItem, newItemId, now = Date.now()) {
  oldItem.supersededBy = newItemId;
  oldItem.validUntil = now;
  oldItem.updatedAt = now;
  return oldItem;
}

/** Registro del uso de una memoria al recuperarla (refuerzo por relevancia). */
export function touch(item, now = Date.now()) {
  item.uses += 1;
  item.lastUsedAt = now;
  item.importance = importanceOf(item);
  return item;
}

/** Proyección pública (para UI, exportación y logs). */
export function toPublic(item) {
  return {
    id: item.id,
    kind: item.kind,
    kindLabel: (KIND_META[item.kind] || KIND_META.fact).label,
    text: item.text,
    // `false` cuando el texto guardado no es lenguaje (un bloque cifrado de un
    // paquete importado): el panel lo dice en vez de escupir el token.
    readable: !looksEncrypted(item.text),
    tokens: item.tokens,
    projectId: item.projectId,
    conversationId: item.conversationId,
    source: item.source,
    confidence: Number(item.confidence.toFixed(2)),
    importance: Number(item.importance.toFixed(3)),
    anchors: item.anchors,
    uses: item.uses,
    pinned: item.pinned,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    validUntil: item.validUntil,
    supersededBy: item.supersededBy,
  };
}

/** Reconstruye un item desde el disco, recalculando lo derivado. */
export function reviveItem(raw) {
  const item = { ...raw };
  item.terms = indexTerms(item.text || '');
  item.anchors = item.anchors || anchors(item.text || '');
  item.tokens = item.tokens || estimateTokens(item.text || '');
  item.fingerprint = item.fingerprint || fingerprintOf(item.text || '');
  item.confidence = clamp01(item.confidence ?? 0.7);
  item.importance = item.importance ?? importanceOf(item);
  item.uses = item.uses || 0;
  item.merged = item.merged || 0;
  return item;
}

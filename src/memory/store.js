/**
 * EVO MEMORY · Almacén
 *
 * Persistencia + índice invertido. Todo en memoria y en un archivo del usuario:
 * sin base de datos, sin servicio, sin latencia de red.
 *
 * Garantías que ofrece el almacén:
 *  · **Deduplicación**: dos frases que dicen lo mismo se fusionan.
 *  · **Vigencia**: una decisión nueva archiva la vieja (borrado lógico, la
 *    historia se conserva para poder explicar qué cambió y cuándo).
 *  · **Índice incremental**: agregar una memoria cuesta O(términos), no O(items).
 */

import {
  contradicts,
  createItem,
  isActive,
  KIND_META,
  looksEncrypted,
  mergeInto,
  reviveItem,
  salienceOf,
  supersede,
} from './item.js';
import { indexTerms, termFreq, termJaccard } from './lexicon.js';

const DEDUPE_JACCARD = 0.82;

export class MemoryStore {
  /**
   * @param {{
   *   storage?: {read: () => string|null, write: (data: string) => void} | null,
   *   maxItems?: number,
   *   now?: () => number
   * }} [opts]
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.maxItems = opts.maxItems ?? 6000;
    this.now = opts.now || (() => Date.now());

    /** @type {Map<string, any>} */
    this.items = new Map();
    /** Transcripciones locales, separadas de las memorias destiladas. */
    this.conversations = new Map();
    /** @type {Map<string, Set<string>>} término → ids */
    this.index = new Map();
    /** @type {Map<string, number>} término → nº de documentos */
    this.df = new Map();
    /** @type {Map<string, string>} huella → id */
    this.byFingerprint = new Map();
    this.totalTerms = 0;
    this.dirty = false;
    this.lastLoadedAt = null;
  }

  /* ---------------- persistencia ---------------- */

  load() {
    if (!this.storage) return this;
    try {
      const raw = this.storage.read();
      if (!raw) return this;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      for (const rawItem of items) {
        const item = reviveItem(rawItem);
        this.#indexItem(item);
      }
      for (const conversation of (Array.isArray(parsed.conversations) ? parsed.conversations : []).slice(-50)) {
        if (conversation?.id && Array.isArray(conversation.turns)) this.conversations.set(conversation.id, conversation);
      }
      this.lastLoadedAt = this.now();
    } catch {
      // Archivo ilegible: se arranca vacío antes que romper la aplicación.
    }
    return this;
  }

  save({ force = false } = {}) {
    if (!this.storage) return false;
    if (!this.dirty && !force) return false;
    try {
      this.storage.write(
        JSON.stringify({
          version: 2,
          conversations: [...this.conversations.values()],
          savedAt: this.now(),
          items: [...this.items.values()],
        }),
      );
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- escritura ---------------- */

  /**
   * Incorpora una memoria candidata.
   * @returns {{item: any, action: 'created'|'merged'|'superseded'|'ignored', conflicts: string[]}}
   */
  add(candidate) {
    const item = createItem({ ...candidate, ts: this.now() });

    if (!item.text || item.text.length < 12) {
      return { item, action: 'ignored', conflicts: [] };
    }

    // Un bloque cifrado no es una memoria: no se puede leer, no se puede
    // recuperar y sólo ensucia el panel. Se descarta el alta (lo ya guardado no
    // se toca: si un expediente viejo los tiene, siguen ahí y se muestran como
    // cifrados).
    if (looksEncrypted(item.text)) {
      return { item, action: 'ignored', reason: 'ilegible', conflicts: [] };
    }

    // 1) ¿Ya existe algo esencialmente igual?
    const duplicate = this.#findDuplicate(item);
    if (duplicate) {
      mergeInto(duplicate, item);
      this.dirty = true;
      return { item: duplicate, action: 'merged', conflicts: [] };
    }

    // 2) ¿Contradice algo vigente?
    const conflicts = [];
    for (const other of this.#similarItems(item)) {
      if (!isActive(other)) continue;
      if (contradicts(other, item)) {
        supersede(other, item.id, this.now());
        conflicts.push(other.id);
      }
    }

    // 3) Alta.
    this.#indexItem(item);
    if (conflicts.length) item.supersedes = conflicts[0];
    this.dirty = true;
    this.#enforceLimit();
    return { item, action: conflicts.length ? 'superseded' : 'created', conflicts };
  }

  /** Refuerza una memoria (se usó para responder). */
  touch(id) {
    const item = this.items.get(id);
    if (!item) return null;
    item.uses += 1;
    item.lastUsedAt = this.now();
    this.dirty = true;
    return item;
  }

  /** Fija o desfija una memoria (las fijadas viajan siempre en el contexto). */
  pin(id, pinned = true) {
    const item = this.items.get(id);
    if (!item) return null;
    item.pinned = pinned;
    item.importance = Math.min(1, item.importance + (pinned ? 0.2 : -0.2));
    this.dirty = true;
    return item;
  }

  /** Borrado real (a diferencia de la superación, que es lógica). */
  forget(id) {
    const item = this.items.get(id);
    if (!item) return false;
    this.#unindexItem(item);
    this.items.delete(id);
    this.dirty = true;
    return true;
  }

  forgetProject(projectId) {
    let removed = 0;
    for (const item of [...this.items.values()]) {
      if (item.projectId === projectId) {
        this.forget(item.id);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    this.items.clear();
    this.index.clear();
    this.df.clear();
    this.byFingerprint.clear();
    this.totalTerms = 0;
    this.dirty = true;
  }

  /* ---------------- lectura ---------------- */

  get(id) {
    return this.items.get(id) || null;
  }

  /** @returns {any[]} */
  all({ includeSuperseded = false, projectId = null, kinds = null } = {}) {
    const out = [];
    for (const item of this.items.values()) {
      if (!includeSuperseded && !isActive(item)) continue;
      if (projectId && item.projectId !== projectId) continue;
      if (kinds && !kinds.includes(item.kind)) continue;
      out.push(item);
    }
    return out;
  }

  /** Candidatos por índice invertido (unión de posting lists). */
  candidates(terms) {
    const ids = new Set();
    for (const term of terms) {
      const posting = this.index.get(term);
      if (!posting) continue;
      for (const id of posting) ids.add(id);
    }
    return ids;
  }

  /** Vector de frecuencias de un item (cacheado en el propio item). */
  frequencies(item) {
    if (!item.__tf || item.__tfSize !== item.terms.length) {
      item.__tf = termFreq(item.terms);
      item.__tfSize = item.terms.length;
    }
    return item.__tf;
  }

  documentFrequency(term) {
    return this.df.get(term) || 0;
  }

  get size() {
    return this.items.size;
  }

  get activeCount() {
    let n = 0;
    for (const item of this.items.values()) if (isActive(item)) n += 1;
    return n;
  }

  get averageLength() {
    if (!this.items.size) return 1;
    return this.totalTerms / this.items.size;
  }

  /** Estadísticas para el panel. */
  stats(now = this.now()) {
    // `byKind` cuenta sólo lo vigente: la leyenda del panel va al lado de
    // «memorias» y tiene que sumar exactamente eso. Lo reemplazado se informa
    // aparte, para no descuadrar la cuenta con registros que ya no se usan.
    const byKind = {};
    const byKindAll = {};
    let tokens = 0;
    let active = 0;
    let superseded = 0;
    let encrypted = 0;
    const projects = new Set();
    for (const item of this.items.values()) {
      byKindAll[item.kind] = (byKindAll[item.kind] || 0) + 1;
      projects.add(item.projectId);
      if (looksEncrypted(item.text)) encrypted += 1;
      if (isActive(item)) {
        active += 1;
        byKind[item.kind] = (byKind[item.kind] || 0) + 1;
        tokens += item.tokens;
      } else {
        superseded += 1;
      }
    }
    return {
      total: this.items.size,
      active,
      superseded,
      tokens,
      projects: projects.size,
      byKind,
      byKindAll,
      // Cuántos registros guardados no se pueden leer (llegaron cifrados de un
      // paquete importado). No se borran: se informan.
      encrypted,
      top: this.all()
        .map((item) => ({ id: item.id, kind: item.kind, text: item.text, salience: Number(salienceOf(item, now).toFixed(3)) }))
        .sort((a, b) => b.salience - a.salience)
        .slice(0, 10),
    };
  }

  /* ---------------- internos ---------------- */

  #indexItem(item) {
    this.items.set(item.id, item);
    for (const term of new Set(item.terms)) {
      let posting = this.index.get(term);
      if (!posting) {
        posting = new Set();
        this.index.set(term, posting);
      }
      posting.add(item.id);
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }
    this.totalTerms += item.terms.length;
    if (item.fingerprint) this.byFingerprint.set(item.fingerprint, item.id);
  }

  #unindexItem(item) {
    for (const term of new Set(item.terms)) {
      const posting = this.index.get(term);
      if (posting) {
        posting.delete(item.id);
        if (!posting.size) this.index.delete(term);
      }
      const count = (this.df.get(term) || 1) - 1;
      if (count <= 0) this.df.delete(term);
      else this.df.set(term, count);
    }
    this.totalTerms = Math.max(0, this.totalTerms - item.terms.length);
    if (item.fingerprint && this.byFingerprint.get(item.fingerprint) === item.id) {
      this.byFingerprint.delete(item.fingerprint);
    }
  }

  #findDuplicate(item) {
    const byFp = this.byFingerprint.get(item.fingerprint);
    if (byFp) {
      const existing = this.items.get(byFp);
      if (existing && isActive(existing) && existing.kind === item.kind) return existing;
    }
    for (const other of this.#similarItems(item)) {
      if (!isActive(other) || other.kind !== item.kind) continue;
      if (termJaccard(other.terms, item.terms) >= DEDUPE_JACCARD) return other;
    }
    return null;
  }

  /** Items que comparten al menos dos términos, ordenados por cercanía. */
  #similarItems(item, limit = 40) {
    const counts = new Map();
    for (const term of new Set(item.terms)) {
      const posting = this.index.get(term);
      if (!posting) continue;
      for (const id of posting) {
        if (id === item.id) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([, shared]) => shared >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.items.get(id))
      .filter(Boolean);
  }

  /** Si el almacén crece demasiado, se olvidan las memorias menos salientes. */
  #enforceLimit() {
    if (this.items.size <= this.maxItems) return;
    const removable = [...this.items.values()]
      .filter((item) => !item.pinned && item.kind !== 'goal' && item.kind !== 'decision')
      .map((item) => ({ item, salience: salienceOf(item, this.now()) }))
      .sort((a, b) => a.salience - b.salience);

    let excess = this.items.size - this.maxItems;
    for (const { item } of removable) {
      if (excess <= 0) break;
      this.forget(item.id);
      excess -= 1;
    }
  }
}

export { KIND_META };

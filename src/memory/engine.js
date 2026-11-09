/**
 * EVO MEMORY · Motor
 *
 * Une almacén, extracción, recuperación y compilación en una sola pieza con una
 * API pequeña y explícita:
 *
 *   remember(turn)      → escribe memoria a partir de una conversación
 *   recall(query)       → devuelve lo relevante, con sus puntuaciones
 *   compile({...})      → arma el contexto que se envía, bajo presupuesto
 *   handoff()           → paquete de continuidad portable
 *   importHandoff(json) → recupera un paquete de otro equipo o modelo
 *
 * La regla de oro: la memoria nunca crece más rápido de lo que se usa. Cada
 * turno se destila; lo que no aporta no entra, y lo que entra se refuerza cuando
 * sirve.
 */

import { compileContext } from './context.js';
import { extractFromTurn, summarizeEpisode } from './extract.js';
import { buildHandoff, importHandoff as importPacket } from './handoff.js';
import { createItem, isActive, salienceOf, toPublic } from './item.js';
import { retrieve } from './rank.js';
import { MemoryStore } from './store.js';

export class EvoMemory {
  /**
   * @param {{
   *   storage?: {read: () => string|null, write: (data: string) => void} | null,
   *   projectId?: string,
   *   projectName?: string|null,
   *   maxItems?: number,
   *   episodeEvery?: number,
   *   language?: 'es'|'en',
   *   now?: () => number
   * }} [opts]
   */
  constructor(opts = {}) {
    this.projectId = opts.projectId || 'default';
    this.projectName = opts.projectName || null;
    this.language = opts.language || 'es';
    this.now = opts.now || (() => Date.now());
    this.episodeEvery = opts.episodeEvery ?? 8;
    this.store = new MemoryStore({
      storage: opts.storage || null,
      maxItems: opts.maxItems ?? 6000,
      now: this.now,
    });
    this.store.load();
    this.turnsSinceEpisode = 0;
    this.recentTurns = [];
    this.lastCompile = null;
    this.metrics = {
      turnsIngested: 0,
      itemsCreated: 0,
      itemsMerged: 0,
      itemsSuperseded: 0,
      tokensInjected: 0,
      tokensSaved: 0,
      recalls: 0,
    };
  }

  /* ---------------- escritura ---------------- */

  /**
   * Destila un turno y guarda lo que merece sobrevivir.
   * @param {{role: 'user'|'assistant', content: string}} turn
   * @param {{conversationId?: string, projectId?: string, model?: string, url?: string}} [meta]
   */
  remember(turn, meta = {}) {
    const projectId = meta.projectId || this.projectId;
    const conversationId = meta.conversationId || null;
    const candidates = extractFromTurn(turn, {
      projectId,
      conversationId,
      source: { model: meta.model, url: meta.url },
      now: this.now(),
    });

    const outcome = { created: [], merged: [], superseded: [], candidates: candidates.length };

    for (const candidate of candidates) {
      const result = this.store.add(candidate);
      if (result.action === 'created') {
        outcome.created.push(result.item);
        this.metrics.itemsCreated += 1;
      } else if (result.action === 'merged') {
        outcome.merged.push(result.item);
        this.metrics.itemsMerged += 1;
      } else if (result.action === 'superseded') {
        outcome.superseded.push(result.item);
        this.metrics.itemsSuperseded += 1;
        outcome.created.push(result.item);
      }
    }

    this.metrics.turnsIngested += 1;
    this.turnsSinceEpisode += 1;
    this.recentTurns.push({ role: turn.role, content: turn.content });

    if (this.turnsSinceEpisode >= this.episodeEvery) this.#closeEpisode(projectId, conversationId);
    if (outcome.created.length || outcome.merged.length) this.store.save();

    return outcome;
  }

  /** Cierra un episodio: comprime el tramo reciente en una sola memoria. */
  #closeEpisode(projectId, conversationId) {
    if (this.recentTurns.length < 4) {
      this.turnsSinceEpisode = 0;
      return;
    }
    const text = summarizeEpisode(this.recentTurns, { maxChars: 320 });
    if (text.length > 40) {
      this.store.add({
        kind: 'episode',
        text,
        projectId,
        conversationId,
        confidence: 0.65,
        source: { role: 'system' },
      });
      this.metrics.itemsCreated += 1;
    }
    this.recentTurns = [];
    this.turnsSinceEpisode = 0;
    this.store.save();
  }

  /* ---------------- lectura ---------------- */

  /**
   * Recuperación directa, con puntuaciones explicadas. No toca presupuestos:
   * sirve para el panel, para depurar y para consultar desde la consola.
   */
  recall(query, opts = {}) {
    this.metrics.recalls += 1;
    return retrieve(this.store, {
      query,
      projectId: opts.projectId || this.projectId,
      now: this.now(),
      limit: opts.limit ?? 12,
      minScore: opts.minScore ?? 0.05,
      kinds: opts.kinds || null,
      mmrLambda: opts.mmrLambda ?? 0.74,
    });
  }

  /**
   * Compila el contexto a enviar.
   * @param {{query: string, history?: Array, budgetTokens?: number, projectId?: string, caps?: object}} input
   */
  compile(input) {
    const projectId = input.projectId || this.projectId;
    const compiled = compileContext({
      store: this.store,
      query: input.query || '',
      history: input.history || [],
      projectId,
      projectName: this.projectName,
      budgetTokens: input.budgetTokens ?? 6000,
      now: this.now(),
      language: this.language,
      caps: input.caps,
    });

    // Refuerzo: lo que se usó para responder pesa más la próxima vez.
    for (const id of compiled.memoryIds) this.store.touch(id);
    this.store.save();

    this.metrics.tokensInjected += compiled.stats.used;
    this.metrics.tokensSaved += compiled.stats.savedTokens;
    this.lastCompile = compiled;
    return compiled;
  }

  /* ---------------- continuidad ---------------- */

  /** Paquete de continuidad del proyecto (JSON + markdown). */
  handoff(opts = {}) {
    return buildHandoff({
      store: this.store,
      projectId: opts.projectId || this.projectId,
      projectName: this.projectName,
      language: this.language,
      now: this.now(),
      maxPerSection: opts.maxPerSection,
    });
  }

  /** Importa un paquete (de otro equipo, otro modelo o un respaldo). */
  importHandoff(packet, opts = {}) {
    const result = importPacket(this.store, packet, { projectId: opts.projectId || this.projectId });
    this.store.save({ force: true });
    return result;
  }

  /* ---------------- mantenimiento ---------------- */

  pin(id, pinned = true) {
    const item = this.store.pin(id, pinned);
    this.store.save();
    return item;
  }

  forget(id) {
    const ok = this.store.forget(id);
    this.store.save({ force: true });
    return ok;
  }

  /** Memorias ordenadas por saliencia, para el panel. */
  list({ kind = null, includeSuperseded = false, limit = 200 } = {}) {
    return this.store
      .all({ projectId: this.projectId, includeSuperseded, kinds: kind ? [kind] : null })
      .map((item) => ({ ...toPublic(item), salience: Number(salienceOf(item, this.now()).toFixed(3)) }))
      .sort((a, b) => b.salience - a.salience)
      .slice(0, limit);
  }

  stats() {
    return {
      ...this.store.stats(this.now()),
      // Economía del último contexto compilado: es la cifra que ve el usuario.
      savedPct: this.lastCompile?.stats?.savedPct ?? 0,
      compression: this.lastCompile?.stats?.compression ?? null,
      lastUsed: this.lastCompile?.stats?.used ?? 0,
      metrics: { ...this.metrics },
      projectId: this.projectId,
      projectName: this.projectName,
      lastCompile: this.lastCompile
        ? {
            used: this.lastCompile.stats.used,
            budget: this.lastCompile.stats.budget,
            retrieved: this.lastCompile.stats.retrieved,
            savedPct: this.lastCompile.stats.savedPct,
          }
        : null,
    };
  }

  /** Reconstruye un proyecto a partir de una conversación completa. */
  ingestConversation(turns, meta = {}) {
    const results = [];
    for (const turn of turns) results.push(this.remember(turn, meta));
    return results;
  }

  /** Estado interno para depuración y pruebas. */
  debug() {
    return {
      projectId: this.projectId,
      items: this.store.size,
      active: this.store.activeCount,
      terms: this.store.df.size,
      termsIndexed: this.store.totalTerms,
      episodes: this.store.all({ kinds: ['episode'] }).length,
      superseded: this.store.all({ includeSuperseded: true }).filter((i) => !isActive(i)).length,
    };
  }
}

export { MemoryStore, createItem };

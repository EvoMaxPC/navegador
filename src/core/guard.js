/**
 * ConversationGuard — orquestador de una conversación completa.
 *
 * Une las tres piezas del motor:
 *   · promptEngine   (antes de enviar)
 *   · streamSentinel (durante la recepción)
 *   · responseEngine (al terminar)
 *
 * y añade la memoria del hilo: cuántas veces se trabó el modelo, con qué patrón
 * y qué hacer la próxima vez.
 */

import { buildContinuationPrompt } from './protocol.js';
import { enhancePrompt } from './promptEngine.js';
import { recoverySuggestions, repairResponse } from './responseEngine.js';
import { DEFAULT_SETTINGS, mergeSettings } from './settings.js';
import { describeLoop, StreamSentinel } from './streamSentinel.js';
import { excerpt, fingerprint, estimateTokens } from './text.js';

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Libro de intervenciones en memoria (la UI lo persiste si el usuario quiere). */
export class Logbook {
  constructor({ maxEntries = 400 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.listeners = new Set();
  }

  add(entry) {
    const item = {
      id: nextId('ev'),
      ts: Date.now(),
      severity: 'info',
      kind: 'sending',
      ...entry,
    };
    this.entries.unshift(item);
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
    for (const fn of this.listeners) fn(item);
    return item;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear() {
    this.entries = [];
  }

  stats() {
    const byKind = { sending: 0, receiving: 0, context: 0, system: 0 };
    const byCode = {};
    let charsSaved = 0;
    for (const e of this.entries) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      if (e.code) byCode[e.code] = (byCode[e.code] || 0) + 1;
      charsSaved += e.savedChars || 0;
    }
    return { total: this.entries.length, byKind, byCode, charsSaved };
  }
}

export class ConversationGuard {
  /**
   * @param {{
   *   settings?: object, host?: string, language?: string, logbook?: Logbook,
   *   onEvent?: Function, memory?: object, conversationId?: string
   * }} [opts]
   */
  constructor(opts = {}) {
    this.settings = mergeSettings(DEFAULT_SETTINGS, opts.settings || {});
    this.host = opts.host || null;
    this.language = opts.language || 'es';
    this.logbook = opts.logbook || new Logbook({ maxEntries: this.settings.logging.maxEntries });
    this.onEvent = opts.onEvent || null;
    /** Motor EVO MEMORY compartido entre conversaciones (puede ser null). */
    this.memory = opts.memory || null;
    this.conversationId = opts.conversationId || null;
    this.loopSignatures = new Map();
    this.history = [];
    this.turns = 0;
  }

  setSettings(patch) {
    this.settings = mergeSettings(this.settings, patch);
    return this.settings;
  }

  #emit(entry) {
    const item = this.logbook.add(entry);
    if (this.onEvent) this.onEvent(item);
    return item;
  }

  /** Añade un turno ya existente (p. ej. al abrir una conversación ya empezada). */
  seedHistory(turns) {
    this.history = turns.map((t) => ({
      role: t.role,
      content: String(t.content || ''),
      tokens: estimateTokens(t.content || ''),
    }));
  }

  /** Prepara el envío: aplica el motor saliente y registra las intervenciones. */
  preparePrompt(prompt) {
    // El contexto se compila ANTES de recordar este turno: recuperar lo que el
    // usuario acaba de escribir sería pagar dos veces por la misma frase.
    const report = enhancePrompt({
      prompt,
      history: this.history,
      host: this.host,
      settings: this.settings,
      memory: this.memory,
    });

    if (this.memory) {
      this.memory.remember(
        { role: 'user', content: report.userText },
        { conversationId: this.conversationId, url: this.host },
      );
    }

    if (report.context?.engine === 'evo') {
      this.#emit({
        kind: 'context',
        code: 'evo-recall',
        severity: 'info',
        title: `EVO recuperó ${report.context.stats.retrieved} memorias`,
        detail: `${report.context.stats.used} tokens de contexto compilado · presupuesto ${report.context.stats.budget} · ${report.context.stats.savedPct}% menos que pegar el historial.`,
        meta: {
          retrieved: report.context.retrieved.slice(0, 6).map((r) => ({ kind: r.kind, text: r.text, score: r.score })),
          stats: report.context.stats,
        },
      });
    } else if (report.context) {
      this.#emit({
        kind: 'context',
        code: 'fold',
        severity: 'info',
        title: `Contexto compactado (${report.context.foldedTurns} turnos)`,
        detail: `~${report.context.tokensBefore} → ~${report.context.tokensAfter} tokens. Se conservaron decisiones, restricciones y pendientes.`,
        savedChars: Math.max(0, report.context.tokensBefore - report.context.tokensAfter) * 4,
        meta: { foldedTurns: report.context.foldedTurns, keptTurns: report.context.keptTurns },
      });
    }

    for (const finding of report.findings) {
      this.#emit({
        kind: 'sending',
        code: finding.id,
        severity: finding.level === 'warn' ? 'warn' : 'info',
        title: finding.title,
        detail: finding.detail,
        suggestion: finding.suggestion,
      });
    }

    if (report.blocks.length) {
      this.#emit({
        kind: 'sending',
        code: 'inject',
        severity: 'info',
        title: `Protocolo inyectado (${report.blocks.length} bloque${report.blocks.length > 1 ? 's' : ''})`,
        detail: report.blocks.map((b) => b.label).join(' · '),
        meta: { injectedTokens: report.stats.injectedTokens },
      });
    }

    this.history.push({ role: 'user', content: report.userText, tokens: estimateTokens(report.userText) });
    this.turns += 1;

    return report;
  }

  /**
   * Agrega una entrada al libro de intervenciones.
   *
   * Lo usan los caminos que no pasan por `preparePrompt`/`finalizeResponse`
   * (por ejemplo la observación por CDP), para que sus avisos salgan por el
   * mismo canal y lleguen a la interfaz como cualquier otro.
   */
  note(entry) {
    return this.#emit(entry);
  }

  /**
   * Registra un turno **observado**, no mediado.
   *
   * Hay respuestas que llegan por canales que la capa de la página no toca
   * (frames de WebSocket, cuerpos JSON sin streaming). Esas respuestas ya se
   * mostraron tal cual: no se recortaron ni se repararon. Lo único honesto es
   * guardarlas en el historial y en EVO MEMORY, para que el contexto de los
   * próximos turnos sea el real, y no emitir ningún evento que insinúe una
   * intervención que no ocurrió.
   */
  observeTurn({ prompt = null, answer = null, meta = {} } = {}) {
    const recorded = [];
    const remember = (role, content) => {
      this.history.push({ role, content, tokens: estimateTokens(content) });
      if (this.memory) {
        this.memory.remember({ role, content }, { conversationId: this.conversationId, url: this.host, ...meta });
      }
    };

    if (typeof prompt === 'string' && prompt.trim()) {
      remember('user', prompt.trim());
      this.turns += 1;
      recorded.push('user');
    }
    if (typeof answer === 'string' && answer.trim()) {
      remember('assistant', answer.trim());
      recorded.push('assistant');
    }
    return { recorded, turns: this.turns };
  }

  /**
   * Abre la recepción de una respuesta.
   * @returns {ConversationTurn}
   */
  beginResponse(meta = {}) {
    return new ConversationTurn(this, meta);
  }

  /** Cierra un turno de respuesta y devuelve la acción recomendada. */
  finalizeResponse({ delivered, verdict, meta = {} }) {
    const repaired = repairResponse(delivered, {
      settings: this.settings,
      lang: this.language,
      truncated: verdict?.truncated,
    });

    this.history.push({
      role: 'assistant',
      content: repaired.text,
      tokens: estimateTokens(repaired.text),
    });

    if (this.memory) {
      this.memory.remember(
        { role: 'assistant', content: repaired.text },
        { conversationId: this.conversationId, url: this.host },
      );
    }

    for (const fix of repaired.fixes) {
      this.#emit({
        kind: 'receiving',
        code: fix.id,
        severity: 'info',
        title: fix.label,
        detail: fix.detail,
        meta,
      });
    }

    let nextAction = null;

    if (verdict?.stopped) {
      // ¿Es la enésima vez que este modelo repite el mismo patrón?
      const sig = fingerprint((verdict.interventions?.[0]?.unit || '').slice(0, 120) || verdict.stopReason || 'loop');
      const count = (this.loopSignatures.get(sig) || 0) + 1;
      this.loopSignatures.set(sig, count);

      const strategy = count >= 2 ? 'regenerate' : 'continue';
      nextAction = {
        type: strategy,
        count,
        prompt:
          strategy === 'continue'
            ? buildContinuationPrompt({
                reason: 'loop',
                lastWords: tailWords(repaired.text, 14),
                avoid: verdict.interventions?.[0]?.unit || '',
                lang: this.language,
              })
            : regeneratePrompt(repaired.text, this.language),
        label:
          strategy === 'continue'
            ? this.language === 'en'
              ? 'Continue where it stopped'
              : 'Continuar donde se cortó'
            : this.language === 'en'
              ? 'Retake the task with another approach (2nd loop)'
              : 'Retomar con otro enfoque (2.º bucle)',
      };
    } else if (repaired.needsContinue) {
      nextAction = {
        type: 'continue',
        count: 1,
        prompt: buildContinuationPrompt({
          reason: 'truncated',
          lastWords: tailWords(repaired.text, 14),
          lang: this.language,
        }),
        label: this.language === 'en' ? 'Continue the cut answer' : 'Continuar la respuesta cortada',
      };
    }

    const suggestions = recoverySuggestions(repaired, this.language);

    return { repaired, verdict, nextAction, suggestions };
  }

  stats() {
    return {
      turns: this.turns,
      historyTurns: this.history.length,
      loopsSeen: [...this.loopSignatures.values()].reduce((a, b) => a + b, 0),
      distinctLoops: this.loopSignatures.size,
      logbook: this.logbook.stats(),
    };
  }
}

/** Un turno: envuelve el centinela y acumula lo entregado. */
export class ConversationTurn {
  constructor(guard, meta = {}) {
    this.guard = guard;
    this.meta = meta;
    this.sentinel = new StreamSentinel({
      settings: guard.settings,
      host: guard.host,
      language: guard.language,
    });
    this.events = [];
    this.closed = false;
  }

  /**
   * Procesa un delta del modelo.
   * @returns {{emit: string, stopped: boolean, events: object[]}} `emit` es el
   * texto que SÍ se debe mostrar.
   */
  push(delta) {
    const result = this.sentinel.push(delta);
    for (const event of result.events) {
      this.events.push(event);
      this.guard.logbook.add({
        kind: 'receiving',
        code: event.code,
        severity: event.severity === 'high' ? 'error' : 'warn',
        title: describeLoop(
          { type: event.code, repeats: event.repeats, severity: event.severity },
          this.guard.language,
        ),
        detail: event.unit ? `Fragmento: «${excerpt(event.unit, 120)}»` : undefined,
        savedChars: event.droppedChars || 0,
        meta: { ...this.meta, at: event.at },
      });
    }
    return result;
  }

  /** Texto entregado hasta el momento. */
  get text() {
    return this.sentinel.text;
  }

  /** Cierra el turno, repara y devuelve el resultado final. */
  complete() {
    if (this.closed) return null;
    this.closed = true;
    const verdict = this.sentinel.finish();
    return this.guard.finalizeResponse({
      delivered: verdict.delivered,
      verdict,
      meta: this.meta,
    });
  }
}

function tailWords(text, n = 12) {
  return (text || '').trim().split(/\s+/).slice(-n).join(' ');
}

function regeneratePrompt(text, lang) {
  const outline = excerpt(text, 240);
  return lang === 'en'
    ? `[Automatic retake · Nexo]\nThe previous answer got stuck repeating itself. Do not continue it.\nGive me a NEW answer with a different structure: first a 5-point outline, then develop only point 1.\nPrevious attempt started with: "${outline}"`
    : `[Reintento automático · Nexo]\nLa respuesta anterior se trabó repitiendo. No la continúes.\nDame una respuesta NUEVA con otra estructura: primero un esquema de 5 puntos y después desarrolla solo el punto 1.\nEl intento anterior empezaba con: «${outline}»`;
}

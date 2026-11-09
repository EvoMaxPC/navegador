/**
 * Anfitrión del motor en el proceso principal.
 *
 * Mantiene un `ConversationGuard` por pestaña: así la compactación de contexto
 * y la memoria de bucles son por conversación y no por aplicación.
 */

import { ConversationGuard } from '../core/guard.js';
import { detectSite } from '../core/sites.js';
import { settingsForHost } from '../core/settings.js';

export class Engine {
  /**
   * @param {{store: import('./store.js').Store, onEvent?: (entry: object) => void}} deps
   */
  constructor({ store, onEvent }) {
    this.store = store;
    this.onEvent = onEvent || (() => {});
    /** @type {Map<number, ConversationGuard>} */
    this.guards = new Map();
    this.requestCounter = 0;
  }

  #guard(webContentsId, host) {
    let guard = this.guards.get(webContentsId);
    if (!guard) {
      guard = new ConversationGuard({
        settings: settingsForHost(this.store.settings, host),
        host,
        language: this.store.settings.uiLocale === 'en' ? 'en' : 'es',
      });
      this.guards.set(webContentsId, guard);
    }
    return guard;
  }

  /** Configuración que necesita el preload antes de inyectar. */
  configFor(host) {
    const settings = settingsForHost(this.store.settings, host);
    return {
      enabled: settings.enabled,
      settings,
      language: settings.protocol.lang === 'en' ? 'en' : 'es',
      version: '0.1.0',
      site: detectSite(host).id,
    };
  }

  /** ¿Está el sitio habilitado? */
  isEnabledFor(host) {
    return settingsForHost(this.store.settings, host).enabled !== false;
  }

  /**
   * Intervención saliente: recibe el texto del usuario tal cual y devuelve el
   * texto que debe viajar al modelo.
   */
  prepare(webContentsId, { prompt, url, site }) {
    const host = safeHost(url) || site || 'desconocido';
    if (!this.isEnabledFor(host)) return { text: prompt, skipped: 'disabled' };

    const guard = this.#guard(webContentsId, host);
    // Se refrescan los ajustes por si el usuario los cambió en vivo.
    guard.setSettings(settingsForHost(this.store.settings, host));

    const report = guard.preparePrompt(prompt);
    this.#publish(guard);
    return {
      text: report.enhanced,
      changed: report.changed,
      lang: report.lang,
      stats: report.stats,
      blocks: report.blocks.map((b) => ({ id: b.id, label: b.label })),
      findings: report.findings.map((f) => ({ id: f.id, level: f.level, title: f.title })),
      context: report.context
        ? { foldedTurns: report.context.foldedTurns, tokensBefore: report.context.tokensBefore, tokensAfter: report.context.tokensAfter }
        : null,
    };
  }

  /**
   * El centinela de la página detectó un bucle y cortó la generación.
   */
  onStreamStop(webContentsId, payload) {
    const guard = this.guards.get(webContentsId);
    const entry = {
      kind: 'receiving',
      code: payload.code || 'loop',
      severity: 'warn',
      title: `Bucle cortado en ${payload.site || 'sitio'} (${payload.code || 'repetición'})`,
      detail: `${payload.droppedChars ?? 0} caracteres descartados antes de mostrarse.`,
      savedChars: payload.droppedChars || 0,
      ts: Date.now(),
    };
    this.store.pushLog(entry);
    this.onEvent(entry);
    return { ok: true, guard: Boolean(guard) };
  }

  /**
   * Fin del stream: se repara la respuesta, se decide la continuación y se
   * actualiza el historial de la conversación.
   */
  onStreamEnd(webContentsId, payload) {
    const guard = this.guards.get(webContentsId);
    if (!guard) return { nextAction: null };

    const verdict = {
      stopped: Boolean(payload.stopped),
      stopReason: payload.code || null,
      truncated: Boolean(payload.truncated),
      droppedChars: payload.droppedChars || 0,
      interventions: payload.stopped
        ? [{ type: 'loop', unit: payload.dropped || '', code: payload.code }]
        : [],
    };

    const result = guard.finalizeResponse({
      delivered: payload.text || '',
      verdict,
      meta: { site: payload.site },
    });

    this.#publish(guard);

    return {
      nextAction: result.nextAction
        ? { type: result.nextAction.type, label: result.nextAction.label, prompt: result.nextAction.prompt }
        : null,
      repaired: {
        fixes: result.repaired.fixes.map((f) => f.label),
        truncated: result.repaired.truncated,
        refusal: result.repaired.refusal,
      },
      suggestions: result.suggestions.map((s) => ({ id: s.id, label: s.label, prompt: s.prompt || '' })),
    };
  }

  /** Cambios de ajustes: se propagan a los guards existentes. */
  refresh() {
    for (const [id, guard] of this.guards) {
      const host = guard.host || '';
      guard.setSettings(settingsForHost(this.store.settings, host));
    }
  }

  stats() {
    let turns = 0;
    let loops = 0;
    for (const guard of this.guards.values()) {
      const s = guard.stats();
      turns += s.turns;
      loops += s.loopsSeen;
    }
    return { tabs: this.guards.size, turns, loops };
  }

  dropTab(webContentsId) {
    this.guards.delete(webContentsId);
  }

  #publish(guard) {
    for (const entry of guard.logbook.entries.slice(0, 3)) {
      if (entry.__published) continue;
      entry.__published = true;
      this.store.pushLog({ ...entry, __published: undefined });
      this.onEvent(entry);
    }
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

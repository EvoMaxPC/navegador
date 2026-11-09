/**
 * Anfitrión del motor en el proceso principal.
 *
 * Mantiene un `ConversationGuard` por pestaña: así la compactación de contexto
 * y la memoria de bucles son por conversación y no por aplicación.
 */

import { ConversationGuard } from '../core/guard.js';
import { detectSite, isAuthRequest, isProfileId } from '../core/sites.js';
import { isAiHost } from '../core/cdp.js';
import { settingsForHost } from '../core/settings.js';
import { StreamSentinel } from '../core/streamSentinel.js';
import { recoverySuggestions, repairResponse } from '../core/responseEngine.js';
import { estimateTokens, fingerprint } from '../core/text.js';

/** Cómo se llama cada canal en los textos que ve el usuario. */
const CHANNEL_LABEL = {
  websocket: 'WebSocket',
  json: 'respuesta JSON',
};

export class Engine {
  /**
   * @param {{
   *   store: import('./store.js').Store,
   *   onEvent?: (entry: object) => void,
   *   memory?: import('../memory/engine.js').EvoMemory
   * }} deps
   */
  constructor({ store, onEvent, memory }) {
    this.store = store;
    this.onEvent = onEvent || (() => {});
    /** EVO MEMORY: una sola memoria por perfil, compartida por todas las pestañas. */
    this.memory = memory || null;
    /** @type {Map<number, ConversationGuard>} */
    this.guards = new Map();
    this.requestCounter = 0;
    /**
     * Huellas de lo ya contado, por pestaña. Las escriben los dos caminos —el
     * HTTP/SSE de la página y la observación CDP— para que un mismo turno no se
     * cuente dos veces si llega por los dos canales.
     */
    this.cdpSeen = new Map();
    this.cdp = { captures: 0, duplicates: 0, loops: 0, truncated: 0, failures: 0 };

    /**
     * Contadores de conversación.
     *
     * Cuentan hechos, no actividad: un mensaje es un envío que la capa reconoció
     * como texto del usuario, una respuesta es un stream que se cerró, y un turno
     * es el par de los dos. **Ninguno depende de que el motor intervenga**: un
     * mensaje sin mediación cuenta igual.
     *
     * Los tokens son una estimación (`estimateTokens`), no un tokenizador real:
     * `tokensEstimated` lo dice y la interfaz lo marca.
     */
    this.counters = {
      messages: 0,
      responses: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      interventions: 0,
      loopsSeen: 0,
      loopsCut: 0,
    };
    this.tokensEstimated = true;
    /** Envíos vistos, por pestaña: `${pestaña}|${messageId}`. */
    this.seenMessages = new Map();
    /** Respuestas contadas, por pestaña: `${pestaña}|${messageId}`. */
    this.seenResponses = new Map();
    /** Último envío de cada pestaña esperando respuesta. */
    this.awaiting = new Map();
    /** Fallos de red ya informados, para no repetirlos en cada reintento. */
    this.cdpFailures = new Map();
  }

  #guard(webContentsId, host) {
    let guard = this.guards.get(webContentsId);
    if (!guard) {
      guard = new ConversationGuard({
        settings: settingsForHost(this.store.settings, host),
        host,
        language: this.store.settings.uiLocale === 'en' ? 'en' : 'es',
        memory: this.memory,
        conversationId: `${host}#${webContentsId}`,
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
      // Sin perfil no hay nada que mediar: el preload no inyecta la capa. Es la
      // segunda barrera, además de `isMediable`, contra reescribir cuerpos
      // ajenos (formularios de acceso, APIs de sitios que no son de IA).
      profiled: isAiHost(host),
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
    // La URL de una petición puede llegar relativa (`/backend-api/conversation`),
    // que es lo normal en una aplicación web. En ese caso la procedencia la dice
    // el identificador de sitio que informa la capa; sin ninguno de los dos, no
    // se media: adivinar el host es cómo se terminan reescribiendo cuerpos ajenos.
    const host = safeHost(url) || (isProfileId(site) ? String(site) : 'desconocido');
    if (!this.isEnabledFor(host)) return { text: prompt, skipped: 'disabled' };
    // Defensa en profundidad: aunque una página pida mediación, no se prepara
    // un texto que venga de un host sin perfil ni de una ruta de acceso. Ese
    // texto puede ser una contraseña, y acá se guarda en la memoria del motor.
    if (!(isAiHost(host) || isProfileId(host)) || isAuthRequest(url)) {
      return { text: prompt, skipped: 'fuera-de-alcance' };
    }

    const guard = this.#guard(webContentsId, host);
    // Se refrescan los ajustes por si el usuario los cambió en vivo.
    guard.setSettings(settingsForHost(this.store.settings, host));

    const report = guard.preparePrompt(prompt);
    // Intervención real: el texto que viaja al modelo no es el que escribió el
    // usuario. Sin cambio, no hay intervención que contar.
    if (report.changed) this.counters.interventions += 1;
    this.#publish(guard);
    return {
      text: report.enhanced,
      changed: report.changed,
      lang: report.lang,
      stats: report.stats,
      blocks: report.blocks.map((b) => ({ id: b.id, label: b.label })),
      findings: report.findings.map((f) => ({ id: f.id, level: f.level, title: f.title })),
      context: report.context
        ? {
            engine: report.context.engine || 'fold',
            foldedTurns: report.context.foldedTurns,
            tokensBefore: report.context.tokensBefore,
            tokensAfter: report.context.tokensAfter,
            retrieved: report.context.retrieved || [],
            stats: report.context.stats || null,
          }
        : null,
    };
  }

  /**
   * Mensaje del usuario reconocido por la capa de la página.
   *
   * Se cuenta **aquí y no en `prepare()`**: un mensaje existe aunque el motor no
   * intervenga, aunque el texto no cambie y aunque no haya guardián todavía.
   * La clave es el identificador que genera la página, no el texto: dos mensajes
   * iguales en la misma conversación son dos mensajes.
   */
  onUserMessage(webContentsId, payload = {}) {
    const messageId = String(payload.messageId || '');
    if (!messageId) return { ok: false, skipped: 'sin-id' };
    const key = `${webContentsId}|${messageId}`;
    if (this.seenMessages.has(key)) return { ok: true, duplicate: true };

    const now = Date.now();
    this.seenMessages.set(key, now);
    this.#prune(this.seenMessages, now);

    const chars = Math.max(0, Number(payload.chars) || 0);
    const tokens = Number.isFinite(Number(payload.tokens)) ? Math.max(0, Number(payload.tokens)) : estimateTokens(' ');
    this.counters.messages += 1;
    this.counters.inputTokens += tokens;

    // Queda esperando su respuesta para poder cerrar el turno.
    this.awaiting.set(webContentsId, {
      messageId,
      at: now,
      host: payload.host || null,
      conversationId: payload.conversationId || null,
    });

    return { ok: true, duplicate: false, messageId, chars, tokens };
  }

  /**
   * Respuesta cerrada. Cuenta una sola vez, asocia el turno y distingue una
   * respuesta completa de una cortada.
   */
  #countResponse(webContentsId, payload = {}) {
    const messageId = String(payload.messageId || '');
    const now = Date.now();
    // La clave es el identificador del envío; si el sitio no lo diera (camino
    // viejo), se usa pestaña + longitud + huella, que sigue distinguiendo dos
    // respuestas distintas de una repetida.
    const key = messageId
      ? `${webContentsId}|${messageId}`
      : `${webContentsId}|sse|${String(payload.text || '').length}|${fingerprint(String(payload.text || ''))}`;
    if (this.seenResponses.has(key)) return { ok: true, duplicate: true };

    this.seenResponses.set(key, now);
    this.#prune(this.seenResponses, now);

    this.counters.responses += 1;
    this.counters.outputTokens += Math.max(0, Number(payload.tokens) || 0);
    if (payload.stopped) this.counters.loopsCut += 1;

    const awaiting = this.awaiting.get(webContentsId);
    if (awaiting && (!awaiting.messageId || !messageId || awaiting.messageId === messageId)) {
      this.counters.turns += 1;
      this.awaiting.delete(webContentsId);
    }

    return { ok: true, duplicate: false };
  }

  /** Descarta claves viejas de un mapa de deduplicación. */
  #prune(map, now = Date.now(), ttl = 30 * 60_000) {
    if (map.size < 500) return;
    for (const [key, ts] of map) if (now - ts > ttl) map.delete(key);
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
    // Se anota lo que ya contó este camino ANTES de mirar el guard: si CDP ve el
    // mismo texto por otro canal, no se vuelve a registrar.
    const host = payload?.host || this.guards.get(webContentsId)?.host || safeHost(payload?.url) || 'desconocido';
    if (payload?.text) this.#markSeen(webContentsId, [`h:${host}|${fingerprint(String(payload.text))}`]);

    // La respuesta se cuenta antes de exigir guardián: una respuesta existe
    // aunque no se haya preparado ningún envío (mediación apagada o en pausa).
    const counted = this.#countResponse(webContentsId, payload);

    const guard = this.guards.get(webContentsId);
    if (!guard) return { nextAction: null, counted };

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
      counted,
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

  /**
   * Turno observado por CDP (frame de WebSocket o cuerpo JSON sin streaming).
   *
   * Este camino **no media**: cuando CDP ve la respuesta, el sitio ya la mostró.
   * Se analiza con el mismo centinela que el stream en vivo, se registra en el
   * historial y en EVO MEMORY, y sólo se emite un aviso cuando hay algo que
   * contar (un bucle o un corte), siempre dicho como observación.
   *
   * @param {number} webContentsId pestaña
   * @param {{text: string, prompt?: string|null, host?: string, site?: string,
   *   source?: string, conversationId?: string, seq?: number, frames?: number}} capture
   */
  onCdpCapture(webContentsId, capture = {}) {
    const text = String(capture.text || '');
    if (!text.trim()) return { ok: false, skipped: 'empty' };

    const host = capture.host || safeHost(capture.url) || 'desconocido';
    if (!this.isEnabledFor(host)) {
      // El usuario apagó el sitio: tampoco se observa.
      return { ok: false, skipped: 'disabled' };
    }

    // Un mismo turno puede aparecer dos veces (frame repetido, cuerpo pedido de
    // nuevo, socket reabierto) y también puede haberlo contado ya el camino
    // HTTP/SSE de esta misma pestaña: la huella lo descarta.
    const keys = [
      `c:${capture.site || host}|${capture.prompt || ''}|${fingerprint(text)}`,
      `h:${host}|${fingerprint(text)}`,
    ];
    if (this.#seenAlready(webContentsId, keys)) {
      this.cdp.duplicates += 1;
      return { ok: true, duplicate: true };
    }
    this.#markSeen(webContentsId, keys);

    // Una respuesta que sólo vio CDP también es una respuesta: se cuenta igual.
    // Si ya la había contado el camino SSE, la huella de arriba la descartó.
    this.counters.responses += 1;
    this.counters.outputTokens += estimateTokens(text);
    const awaiting = this.awaiting.get(webContentsId);
    if (awaiting) {
      this.counters.turns += 1;
      this.awaiting.delete(webContentsId);
    }

    const guard = this.#guard(webContentsId, host);
    const settings = settingsForHost(this.store.settings, host);
    guard.setSettings(settings);

    // Mismo detector que corta los streams, aplicado al texto ya recibido.
    const sentinel = new StreamSentinel({ settings, host, language: guard.language });
    for (let i = 0; i < text.length; i += 2048) sentinel.push(text.slice(i, i + 2048));
    const verdict = sentinel.finish();

    guard.observeTurn({
      prompt: capture.prompt || null,
      answer: text,
      meta: { via: 'cdp', source: capture.source || 'websocket' },
    });

    // Lo mismo que el camino en vivo hace al terminar, pero sin aplicar nada.
    const repaired = repairResponse(text, {
      settings,
      lang: guard.language,
      truncated: verdict.truncated,
    });

    const meta = {
      via: 'cdp',
      observed: true,
      source: capture.source || 'websocket',
      conversationId: capture.conversationId || null,
      seq: capture.seq ?? null,
      frames: capture.frames ?? 0,
      chars: text.length,
    };
    const channel = CHANNEL_LABEL[capture.source] || 'CDP';

    if (verdict.stopped) {
      this.cdp.loops += 1;
      const unit = (verdict.interventions.find((item) => item.unit) || {}).unit || '';
      const repeats = (verdict.interventions.find((item) => item.repeats) || {}).repeats || null;
      guard.note({
        kind: 'receiving',
        code: `cdp-${verdict.stopReason || 'loop'}`,
        severity: 'warn',
        title: `Bucle observado por CDP en ${capture.site || host} (no se pudo cortar)`,
        detail:
          `Se repitió ${repeats ? `×${repeats} ` : ''}un bloque de ${unit.length} caracteres tras ${verdict.chars} caracteres. ` +
          `Llegó por ${channel}, así que el texto ya estaba en el sitio: se registra como observación, sin intervención.`,
        savedChars: 0,
        meta: { ...meta, unit: unit.slice(0, 140), repeats },
      });
    } else if (repaired.refusal || repaired.empty) {
      // `responseEngine` evalúa la calidad del texto; acá sólo se informa, porque
      // lo que el usuario vio ya está en pantalla.
      const suggestion = recoverySuggestions(repaired, guard.language)[0] || null;
      guard.note({
        kind: 'receiving',
        code: repaired.empty ? 'cdp-empty' : 'cdp-refusal',
        severity: 'warn',
        title: repaired.empty
          ? `Respuesta vacía observada por CDP en ${capture.site || host}`
          : `Negativa observada por CDP en ${capture.site || host}`,
        detail:
          `El modelo ${repaired.empty ? 'no devolvió texto' : 'se negó a responder'} (${verdict.chars} caracteres vía ${channel}). ` +
          'Se registra para el contexto; no se agregó ni se cambió nada en lo que ya se mostró.',
        suggestion: suggestion ? suggestion.label : undefined,
        meta: { ...meta, refusal: Boolean(repaired.refusal), empty: Boolean(repaired.empty) },
      });
    } else if (verdict.truncated) {
      this.cdp.truncated += 1;
      guard.note({
        kind: 'receiving',
        code: `cdp-${verdict.truncationReason || 'truncated'}`,
        severity: 'info',
        title: `Respuesta cortada observada por CDP en ${capture.site || host}`,
        detail:
          `Terminó a mitad de frase (${verdict.chars} caracteres vía ${channel}). ` +
          'Se registra para el contexto del próximo turno; no se agregó texto.',
        meta,
      });
    }

    this.#publish(guard);
    this.cdp.captures += 1;
    return {
      ok: true,
      duplicate: false,
      loop: verdict.stopped,
      truncated: verdict.truncated,
      chars: text.length,
    };
  }

  /** Cambios de ajustes: se propagan a los guards existentes. */
  refresh() {
    for (const [id, guard] of this.guards) {
      const host = guard.host || '';
      guard.setSettings(settingsForHost(this.store.settings, host));
    }
  }

  /**
   * Contadores para la interfaz.
   *
   * `turns` son turnos **completos** (mensaje y respuesta emparejados), no
   * envíos preparados: `guardTurns` conserva la cuenta interna de los guardianes
   * para quien la necesite, pero no se muestra como «turnos».
   */
  stats() {
    let guardTurns = 0;
    let loopsSeen = 0;
    for (const guard of this.guards.values()) {
      const s = guard.stats();
      guardTurns += s.turns;
      loopsSeen += s.loopsSeen;
    }
    const c = this.counters;
    const observed = loopsSeen + this.cdp.loops;
    return {
      tabs: this.guards.size,
      // Ocho métricas independientes.
      messages: c.messages,
      responses: c.responses,
      turns: c.turns,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      interventions: c.interventions,
      loopsSeen: observed,
      loopsCut: c.loopsCut,
      // Compatibilidad con lo anterior.
      loops: observed,
      guardTurns,
      tokensEstimated: this.tokensEstimated,
      cdp: { ...this.cdp },
    };
  }

  dropTab(webContentsId) {
    this.guards.delete(webContentsId);
    this.cdpSeen.delete(webContentsId);
    this.awaiting.delete(webContentsId);
    for (const map of [this.seenMessages, this.seenResponses]) {
      for (const key of [...map.keys()]) if (key.startsWith(`${webContentsId}|`)) map.delete(key);
    }
    for (const key of [...this.cdpFailures.keys()]) {
      if (key.startsWith(`${webContentsId}|`)) this.cdpFailures.delete(key);
    }
  }

  /**
   * Fallo de red observado por CDP en un sitio con perfil.
   *
   * No se guarda contenido: sólo la URL, el estado y el error. Es lo que explica
   * un «no se pudo conectar» sin obligar al usuario a abrir DevTools. No depende
   * de que la mediación esté encendida —de hecho es cuando más falta hace— pero
   * tampoco lee la conversación.
   *
   * @param {number} webContentsId pestaña
   * @param {{kind: 'http'|'net', url: string, host?: string, site?: string,
   *   status?: number, errorText?: string, resourceType?: string,
   *   blockedReason?: string|null}} failure
   */
  onCdpFailure(webContentsId, failure = {}) {
    const url = String(failure.url || '');
    const host = failure.host || safeHost(url) || 'desconocido';
    const site = failure.site || detectSite(host).id;
    const key = `${webContentsId}|${failure.kind}|${failure.status || failure.errorText}|${url}`;
    const now = Date.now();
    if (now - (this.cdpFailures.get(key) || 0) < 60_000) return { ok: true, duplicate: true };
    this.cdpFailures.set(key, now);
    if (this.cdpFailures.size > 200) {
      for (const [k, ts] of this.cdpFailures) if (now - ts > 120_000) this.cdpFailures.delete(k);
    }

    const path = safePath(url);
    const isHttp = failure.kind === 'http';
    const entry = {
      kind: 'system',
      code: isHttp ? 'http-error' : 'net-failed',
      severity: 'warn',
      title: isHttp
        ? `${site || host} respondió ${failure.status} a ${path}`
        : `Se cortó la conexión con ${site || host} (${path})`,
      detail: isHttp
        ? `El sitio rechazó la petición con estado ${failure.status}. Es el error que la propia interfaz muestra como «no se pudo conectar»: si es 401/403, el proveedor está bloqueando al cliente; si es 429, hay límite de uso.`
        : `Fallo de red: ${failure.errorText || 'sin detalle'}${failure.blockedReason ? ` (bloqueado: ${failure.blockedReason})` : ''}.`,
      meta: {
        via: 'cdp',
        observed: true,
        url,
        host,
        site,
        status: failure.status ?? null,
        errorText: failure.errorText ?? null,
        resourceType: failure.resourceType || null,
      },
      ts: now,
    };
    this.store.pushLog(entry);
    this.onEvent(entry);
    this.cdp.failures += 1;
    return { ok: true, duplicate: false, code: entry.code };
  }

  /* ---------------- deduplicación entre canales ---------------- */

  /** Huellas vistas por esta pestaña en los últimos dos minutos. */
  #seenAlready(webContentsId, keys) {
    const seen = this.cdpSeen.get(webContentsId);
    if (!seen) return false;
    return keys.some((key) => seen.has(key));
  }

  #markSeen(webContentsId, keys) {
    let seen = this.cdpSeen.get(webContentsId);
    if (!seen) {
      seen = new Map();
      this.cdpSeen.set(webContentsId, seen);
    }
    const now = Date.now();
    for (const key of keys) seen.set(key, now);
    for (const [key, ts] of seen) if (now - ts > 120_000) seen.delete(key);
  }

  /* ---------------- EVO MEMORY ---------------- */

  memoryList() {
    return this.memory ? this.memory.list() : [];
  }

  memoryStats() {
    return this.memory ? this.memory.stats() : { total: 0, active: 0, byKind: {}, tokens: 0, circuits: {} };
  }

  memoryRecall(query, opts = {}) {
    if (!this.memory) return [];
    return this.memory.recall(query, opts).map((entry) => ({
      id: entry.item.id,
      kind: entry.item.kind,
      text: entry.item.text,
      score: Number(entry.score.toFixed(3)),
      parts: entry.parts,
      pinned: Boolean(entry.item.pinned),
      createdAt: entry.item.createdAt,
      uses: entry.item.uses,
    }));
  }

  memoryPin(id, pinned = true) {
    if (!this.memory) return { ok: false };
    this.memory.pin(id, pinned);
    return { ok: true };
  }

  memoryForget(id) {
    if (!this.memory) return { ok: false };
    return { ok: this.memory.forget(id) };
  }

  memoryTouch(id) {
    if (!this.memory) return { ok: false };
    return { ok: this.memory.touch(id) };
  }

  memoryHandoff() {
    if (!this.memory) return null;
    return this.memory.handoff();
  }

  memoryImport(packet) {
    if (!this.memory) return { added: 0, merged: 0, superseded: 0 };
    return this.memory.importHandoff(packet);
  }

  memoryClear() {
    if (!this.memory) return { ok: false };
    const items = this.memory.store.all({ includeSuperseded: true });
    for (const item of items) this.memory.store.forget(item.id);
    this.memory.store.save();
    return { ok: true, removed: items.length };
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

/** Ruta corta de una URL, para textos legibles. */
function safePath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search ? '…' : ''}`.slice(0, 80);
  } catch {
    return String(url || '').slice(0, 80);
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

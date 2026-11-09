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
import { fingerprint } from '../core/text.js';
import { countOutputTokens } from './tokens.js';
import { TURN_OUTCOMES, turnOutcome } from '../core/turnOutcome.js';
import { looksEncrypted } from '../memory/item.js';

/** Cómo se llama cada canal en los textos que ve el usuario. */
/**
 * Ventana en la que dos avisos del mismo envío se consideran el mismo mensaje:
 * la capa avisa al enviar y CDP cuando Chromium informa la petición.
 */
const VENTANA_ENVIO_MS = 10_000;

/** Ventana en la que dos textos son la misma respuesta todavía creciendo. */
const VENTANA_RESPUESTA_MS = 120_000;

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
    this.cdp = { captures: 0, duplicates: 0, truncated: 0, failures: 0 };

    /**
     * Contadores de conversación.
     *
     * Cuentan hechos, no actividad: un mensaje es un envío que la capa reconoció
     * como texto del usuario, una respuesta es un stream que se cerró, y un turno
     * clasifica el resultado de ChatGPT. Ninguno depende de que el motor
     * intervenga: un mensaje sin mediación cuenta igual.
     *
     * Los tokens visibles de texto se cuentan con BPE GPT según el modelo detectado.
     * No incluyen contenido multimodal ni tokens internos no expuestos por el proveedor.
     */
    this.counters = {
      messages: 0,
      responses: 0,
      turnsCompleted: 0,
      turnsCancelled: 0,
      turnsFailed: 0,
      turnsUnknown: 0,
      inputTokens: 0,
      outputTokens: 0,
      /**
       * Intervenciones del motor: cuántas veces Nexo cambió el texto que salía o
       * cortó un bucle. Es la medida de lo que hizo el mediador, no del tráfico.
       */
      interventions: 0,
      /**
       * Actividad de la conversación: +1 por cada mensaje contado y +1 por cada
       * respuesta contada. Es el número que muestra el panel como
       * «intervenciones»: dos intercambios completos suman cuatro.
       */
      activity: 0,
    };
    this.tokensEstimated = true;
    /** Envíos vistos, por pestaña: `${pestaña}|${messageId}`. */
    this.seenMessages = new Map();
    /** Respuestas contadas, por pestaña: `${pestaña}|${messageId}`. */
    this.seenResponses = new Map();
    /** Último envío de cada pestaña esperando respuesta. */
    this.awaiting = new Map();
    /**
     * Último envío de cada pestaña, con su huella. Segunda barrera contra el
     * mismo mensaje anunciado por dos caminos (gesto de la página, petición de
     * la capa, petición observada por CDP) cuando el identificador no coincide.
     */
    this.lastSend = new Map();
    /**
     * Identificadores alternativos del mismo envío: `${pestaña}|${id}` → id del
     * mensaje que lo representa. La red, la capa y CDP pueden anunciar el mismo
     * envío con identificadores distintos; con el alias, la respuesta encuentra
     * su turno sin cerrar el de al lado.
     */
    this.messageAliases = new Map();
    /** Última señal de vida de la capa de la página, por pestaña. */
    this.layerSeen = new Map();
    /**
     * Cuándo cerró la capa un stream en cada pestaña. Es lo que decide si CDP
     * puede leer el SSE de una respuesta sin arriesgar contarla dos veces: que
     * la capa haya contado el envío no prueba que haya capturado la respuesta.
     */
    this.layerEnded = new Map();
    /**
     * Cuándo la capa cerró un stream **con texto**, por pestaña. Es lo único que
     * prueba que la respuesta ya tiene sus tokens: un cierre sin texto no puede
     * dejar a CDP sin leer el cuerpo, o la respuesta se cuenta y se queda sin
     * tokens para siempre.
     */
    this.layerEndedText = new Map();
    /**
     * Respuestas ya contadas sin poder leer su texto, por pestaña:
     * `{at, messageId, host}`. Si el texto aparece después —CDP suele llegar más
     * tarde que el cierre de la red— sus tokens se suman a **esa** respuesta en
     * vez de contar otra. Es lo que evita que arreglar la lectura duplique las
     * respuestas que ya se contaban bien.
     */
    this.sinTexto = new Map();
    /**
     * Textos ya contados como respuesta, por pestaña. Permite reconocer la misma
     * respuesta entregada en pedazos: mientras crece, no es otra respuesta.
     */
    this.recentTexts = new Map();
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
    const now = Date.now();
    const key = `${webContentsId}|${messageId}`;
    if (this.seenMessages.has(key)) return { ok: true, duplicate: true };

    // El mismo envío puede llegar por dos caminos con identificadores distintos:
    // el gesto de la página, la petición de la capa y la petición que ve CDP. Se
    // reconoce por la huella del texto y el momento, no por el texto solo: dos
    // envíos iguales seguidos desde la misma fuente son dos mensajes.
    const hash = payload.promptHash ? String(payload.promptHash) : '';
    const source = String(payload.source || 'request');
    const previo = this.lastSend.get(webContentsId);
    if (previo && now - previo.at < VENTANA_ENVIO_MS) {
      const mismaHuella = hash && previo.hash ? hash === previo.hash : !hash || !previo.hash;
      if (mismaHuella && previo.source !== source) {
        this.seenMessages.set(key, now);
        // El envío ya está contado con otro identificador: se registra el alias
        // para que su respuesta cierre el turno correcto.
        if (previo.messageId) this.messageAliases.set(key, previo.messageId);
        return { ok: true, duplicate: true, merged: true, messageId: previo.messageId || messageId };
      }
    }

    this.seenMessages.set(key, now);
    this.#prune(this.seenMessages, now);
    // La capa se marca viva sólo si el aviso viene de la página. Los avisos de
    // CDP o del vigilante de red no dicen nada de la capa: creerlos capa activa
    // dejaría el stream sin nadie que lo lea.
    if (source === 'composer' || source === 'request') this.noteLayer(webContentsId);
    this.onTurnInterrupted(webContentsId);
    this.lastSend.set(webContentsId, {
      host: payload.host || safeHost(payload.url),
      at: now,
      hash,
      source,
      messageId,
      chars: Math.max(0, Number(payload.chars) || 0),
    });

    const chars = Math.max(0, Number(payload.chars) || 0);
    const tokens = Number.isFinite(Number(payload.tokens)) ? Math.max(0, Number(payload.tokens)) : 0;
    this.counters.messages += 1;
    this.counters.inputTokens += tokens;
    this.counters.activity += 1;

    // Un mensaje nuevo cierra la atribución diferida del anterior: el texto que
    // llegue de acá en adelante es de esta pregunta, no de aquella.
    this.sinTexto.delete(webContentsId);

    // Queda esperando su respuesta para poder cerrar el turno.
    this.awaiting.set(webContentsId, {
      messageId,
      at: now,
      host: payload.host || null,
      conversationId: payload.conversationId || null,
      model: payload.model || '',
    });

    return { ok: true, duplicate: false, messageId, chars, tokens };
  }

  /** Regenerar/continuar inicia otra respuesta, pero no otro mensaje de entrada.
   * Reutiliza el turno pendiente para distinguir respuestas de texto idéntico.
   */
  onTurnStarted(webContentsId, payload = {}) {
    if (payload.site !== 'chatgpt' || !payload.messageId) return { skipped: 'fuera-de-alcance' };
    const messageId = String(payload.messageId);
    if (this.awaiting.get(webContentsId)?.messageId === messageId ||
      this.seenResponses.has(`${webContentsId}|outcome|${messageId}`)) return { duplicate: true };
    this.onTurnInterrupted(webContentsId);
    this.awaiting.set(webContentsId, { messageId, host: payload.host || 'chatgpt.com', at: Date.now(), model: payload.model || '' });
    return { started: true };
  }

  /** Resultado exclusivo del turno, almacenado en la deduplicación existente.
   * Una señal tardía puede confirmar un desconocido: se mueve, no se suma otro.
   * Nunca convierte un aborto de transporte en una cancelación del usuario.
   */
  onTurnResult(webContentsId, payload = {}) {
    const pending = this.#pendingTurn(webContentsId, Date.now());
    const host = payload.host || safeHost(payload.url) || pending?.entry.host || this.lastSend.get(webContentsId)?.host;
    if (detectSite(host || '').id !== 'chatgpt' && payload.site !== 'chatgpt') return { skipped: 'otro-proveedor' };
    const text = String(payload.text || '');
    const id = String(payload.messageId || pending?.entry.messageId || this.lastSend.get(webContentsId)?.messageId ||
      (text ? `sse|${text.length}|${fingerprint(text)}` : ''));
    if (!id) return { skipped: 'sin-turno' };
    const tabId = pending && (!payload.messageId || this.resolveMessageId(pending.id, id) === pending.entry.messageId)
      ? pending.id : webContentsId;
    let canonical = this.resolveMessageId(tabId, id);
    // El mismo texto recuperado por CDP y por la capa utiliza la identidad ya
    // resuelta por el motor, no crea otro turno con el ID del otro transporte.
    if (text) {
      const seen = (this.recentTexts.get(webContentsId) || []).findLast((item) =>
        item.messageId && (item.text === text || item.text.startsWith(text) || text.startsWith(item.text)) &&
        (!pending || item.messageId === pending.entry.messageId));
      if (seen) canonical = seen.messageId;
    }
    if (canonical !== id) this.messageAliases.set(`${tabId}|${id}`, canonical);
    let key = `${tabId}|outcome|${canonical}`;
    // Chromium puede atribuir el envío a un worker (-1) y la capa al webview.
    if (tabId !== -1 && this.seenResponses.has(`-1|outcome|${canonical}`)) key = `-1|outcome|${canonical}`;
    const previous = this.seenResponses.get(key);
    const outcome = turnOutcome(payload);
    if (previous && (previous.outcome !== 'unknown' || outcome === 'unknown')) return { duplicate: true, outcome: previous.outcome };
    if (previous) this.counters[TURN_OUTCOMES[previous.outcome]] -= 1;
    this.counters[TURN_OUTCOMES[outcome]] += 1;
    this.seenResponses.set(key, { at: Date.now(), outcome });
    this.onEvent({ kind: 'system', code: 'turn-result', severity: 'info',
      title: 'Resultado del turno actualizado', meta: { messageId: canonical, outcome }, ts: Date.now() });
    return { counted: true, outcome, reclassified: Boolean(previous) };
  }

  /** Navegación/cierre o reemplazo del envío sin resultado confirmado. */
  onTurnInterrupted(webContentsId) {
    const pending = this.awaiting.get(webContentsId);
    if (!pending) return { skipped: 'sin-turno' };
    return this.onTurnResult(webContentsId, { ...pending, outcome: 'unknown' });
  }

  /**
   * Respuesta cerrada. Cuenta una sola vez, asocia el turno y distingue una
   * respuesta completa de una cortada.
   */
  #countResponse(webContentsId, payload = {}) {
    const messageId = String(payload.messageId || '');
    const now = Date.now();
    const textoPayload = String(payload.text || '');
    // El texto de una respuesta ya contada por la red: se suman los tokens y la
    // respuesta no se cuenta dos veces.
    if (textoPayload.trim() && this.#absorbTokens(webContentsId, textoPayload, messageId || null, payload.model, payload.host)) {
      return { ok: true, duplicate: true, tokens: true };
    }
    // La clave es el identificador del envío; si el sitio no lo diera (camino
    // viejo), se usa pestaña + longitud + huella, que sigue distinguiendo dos
    // respuestas distintas de una repetida.
    const key = messageId
      ? `${webContentsId}|${messageId}`
      : `${webContentsId}|sse|${String(payload.text || '').length}|${fingerprint(String(payload.text || ''))}`;
    const alreadySeen = this.seenResponses.has(key);

    // Misma respuesta vista antes (por CDP o por otro cierre del stream): no se
    // cuenta, aunque el identificador del envío haya cambiado. Lo que decide es
    // si hay un turno esperando: si lo hay y la respuesta es de ese turno, es
    // nueva aunque el texto se repita; cinco respuestas iguales son cinco.
    const texto = String(payload.text || '');
    this.noteLayer(webContentsId);
    const pendiente = this.#pendingTurn(webContentsId, now);
    const awaitId = this.resolveMessageId(pendiente?.id ?? webContentsId, messageId);
    const merge = this.#mergeResponse(webContentsId, texto, { messageId: awaitId, pendiente, model: payload.model || pendiente?.entry?.model || '', provider: payload.host || pendiente?.entry?.host || '' });
    if (merge.duplicate) {
      this.seenResponses.set(key, now);
      return { ok: true, duplicate: true, merged: true };
    }

    if (alreadySeen) return { ok: true, duplicate: true };
    this.seenResponses.set(key, now);
    this.#prune(this.seenResponses, now);

    // Respuesta contada sin texto: si el texto aparece después, sus tokens se
    // suman a esta misma respuesta.
    if (!texto.trim()) {
      const pendienteSinTexto = pendiente || this.#pendingTurn(webContentsId, now);
      this.sinTexto.set(pendienteSinTexto?.id ?? webContentsId, {
        at: now,
        messageId: awaitId || null,
        host: pendienteSinTexto?.entry.host || payload.host || null,
        model: payload.model || pendienteSinTexto?.entry.model || '',
      });
    } else {
      this.sinTexto.delete(pendiente?.id ?? webContentsId);
    }

    this.counters.responses += 1;
    this.counters.activity += 1;
    // El proceso principal es la fuente de verdad. No aceptar un 0 enviado
    // por el preload: si su tokenizador no pudo contar, ese cero anulaba
    // silenciosamente el recuento que #mergeResponse ya calculó con el texto.
    const tokens = merge.tokens;
    this.counters.outputTokens += tokens;

    if (
      pendiente &&
      now - pendiente.entry.at <= VENTANA_RESPUESTA_MS &&
      (!pendiente.entry.messageId || !awaitId || pendiente.entry.messageId === awaitId)
    ) {
      this.awaiting.delete(pendiente.id);
    }

    return { ok: true, duplicate: false };
  }

  /**
   * Respuesta contada desde la red: la petición de conversación terminó bien.
   *
   * Es el quinto camino de salida y el único que no depende de leer el cuerpo:
   * si el POST de conversación completó con 2xx y en esa pestaña sigue habiendo
   * un mensaje esperando respuesta, entonces el modelo contestó. No se inventan
   * caracteres ni tokens (no hay texto: la capa y CDP no lo dieron), y por eso
   * tampoco suma tokens de salida.
   *
   * No puede duplicar: si la capa o CDP ya contaron esa respuesta, el turno ya
   * no está esperando y esto no hace nada.
   */
  onNetworkResponse(webContentsId, payload = {}) {
    const now = Date.now();
    const pendiente = payload.messageId
      ? [...this.awaiting.entries()]
          .map(([id, entry]) => ({ id, entry }))
          .find((item) => item.entry.messageId === String(payload.messageId)) || null
      : this.#pendingTurn(webContentsId, now);
    if (!pendiente || now - pendiente.entry.at > VENTANA_RESPUESTA_MS) {
      return { ok: true, skipped: 'sin-turno' };
    }
    const key = `${pendiente.id}|net-resp|${pendiente.entry.messageId || pendiente.entry.at}`;
    if (this.seenResponses.has(key)) return { ok: true, duplicate: true };
    this.seenResponses.set(key, now);

    this.onTurnResult(pendiente.id, { ...pendiente.entry, host: payload.host || pendiente.entry.host, outcome: 'unknown' });
    this.counters.responses += 1;
    this.counters.activity += 1;
    this.awaiting.delete(pendiente.id);
    // Queda anotado que esta respuesta se contó sin texto: si CDP o la capa
    // consiguen el texto un instante después, suman sus tokens a **esta**
    // respuesta en vez de contar una segunda.
    this.sinTexto.set(pendiente.id, {
      at: now,
      messageId: pendiente.entry.messageId || null,
      host: pendiente.entry.host || payload.host || null,
      model: pendiente.entry.model || '',
    });

    return {
      ok: true,
      counted: true,
      messageId: pendiente.entry.messageId || null,
      host: pendiente.entry.host || payload.host || null,
      model: pendiente.entry.model || '',
    };
  }

  /**
   * Si esta llegada es el **texto** de una respuesta que ya se contó sin texto,
   * suma sus tokens y devuelve `true`: la respuesta no se cuenta otra vez.
   *
   * Es la pieza que permite leer el cuerpo de la respuesta sin tocar el contador
   * de respuestas: la red ya sumó la respuesta cuando cerró la petición; cuando
   * CDP consigue el texto un segundo después, lo que faltaba eran los tokens.
   */
  #absorbTokens(webContentsId, text, messageId = null, model = '', provider = '') {
    const anotada = this.sinTexto.get(webContentsId);
    if (!anotada) return false;
    const now = Date.now();
    if (now - anotada.at > VENTANA_RESPUESTA_MS) {
      this.sinTexto.delete(webContentsId);
      return false;
    }
    // Un turno que salió después de contar esa respuesta ya es otra pregunta: el
    // texto que llega es suyo, no de la respuesta anterior.
    const esperando = this.awaiting.get(webContentsId);
    if (esperando && esperando.at >= anotada.at) return false;
    // El identificador no decide: la red y CDP nombran el mismo envío de forma
    // distinta (`net-…` y `cdp-…`) y compararlos rechazaría justo el caso que
    // esto resuelve. Lo que acota es la pestaña, la ventana y que no haya salido
    // una pregunta nueva. `messageId` queda para anotar el texto ya contado.

    const tokens = this.#outputTokens(text, model || anotada.model, provider || anotada.host);
    this.counters.outputTokens += Math.max(0, tokens);
    this.sinTexto.delete(webContentsId);
    // Queda en el registro: si los tokens de salida suben sin una respuesta
    // nueva, esto es lo que lo explica.
    try {
      this.store?.pushLog?.({
        kind: 'receiving',
        code: 'tokens-recuperados',
        severity: 'info',
        title: `Tokens de la respuesta sumados en ${anotada.host || 'el sitio'}`,
        detail: `La respuesta ya estaba contada sin texto; el texto apareció después y aportó ${tokens} tokens de salida (${text.length} caracteres). No se contó otra respuesta.`,
        meta: { host: anotada.host || null, chars: text.length, tokens, messageId: messageId || anotada.messageId || null },
        ts: now,
      });
    } catch {
      /* el registro no puede tumbar el conteo */
    }
    // El texto entra en la lista de lo ya contado: un segundo canal no lo suma
    // de nuevo, y un fragmento posterior sólo aporta la diferencia.
    const vistos = (this.recentTexts.get(webContentsId) || []).filter((v) => now - v.at < VENTANA_RESPUESTA_MS);
    vistos.push({ at: now, text, tokens, messageId: messageId || anotada.messageId || null,
      model: model || anotada.model, provider: provider || anotada.host });
    this.recentTexts.set(webContentsId, vistos.slice(-6));
    return true;
  }

  #outputTokens(text, model = '', provider = '') {
    return countOutputTokens(text, model, provider, (detail) => {
      const entry = {
        kind: 'receiving', code: 'output-tokenizer-fallback', severity: 'warn',
        title: 'Tokens de salida estimados: falló el tokenizador',
        detail: `${detail.error}. Se estimaron ${detail.tokens} tokens sobre ${detail.chars} caracteres reales.`,
        meta: { ...detail, method: 'estimateTokens' }, ts: Date.now(),
      };
      try { this.store?.pushLog?.(entry); } catch { console.warn('[nexo]', entry); }
    });
  }

  /**
   * ¿Es la misma respuesta que ya se contó, llegando en pedazos?
   *
   * Una captura parcial es un prefijo de la respuesta completa: no es otra
   * respuesta. Si más tarde llega el texto completo, se corrige el conteo de
   * tokens en vez de sumar una respuesta nueva.
   *
   * Devuelve `{duplicate, tokens, sameText}`; `tokens` es lo que hay que sumar
   * al contador de salida cuando la respuesta es nueva.
   */
  #mergeResponse(webContentsId, text, { messageId = null, pendiente = undefined, model = '', provider = '' } = {}) {
    const now = Date.now();
    const esperando = pendiente === undefined ? this.#pendingTurn(webContentsId, now) : pendiente;
    const vistos = (this.recentTexts.get(webContentsId) || []).filter((v) => now - v.at < VENTANA_RESPUESTA_MS);
    for (const visto of vistos) {
      const crece = text.length > visto.text.length && text.startsWith(visto.text);
      const esPrefijo = visto.text.length > text.length && visto.text.startsWith(text);
      const igual = visto.text === text;
      if (!crece && !esPrefijo && !igual) continue;
      // El texto igual sólo es la misma respuesta si no hay un turno nuevo
      // esperando, si el turno esperando es el mismo que ya se contó, o si lo
      // visto es posterior al envío de ese turno (o sea, ya estaba llegando
      // cuando la pregunta salió: no es su respuesta).
      //
      // Sin esta condición, cinco respuestas «Listo.» seguidas se contaban como
      // una sola: el texto se usa para no duplicar entre canales, no para
      // fundir respuestas distintas.
      const turno = esperando ? esperando.entry : null;
      const mismoTurno =
        !turno ||
        (visto.messageId && messageId ? visto.messageId === messageId : false) ||
        visto.at > turno.at;
      if (!mismoTurno) continue;
      if (crece) {
        const tokens = this.#outputTokens(text, model || visto.model || esperando?.entry?.model || '', provider || visto.provider || esperando?.entry?.host || '');
        this.counters.outputTokens += tokens - visto.tokens;
        visto.text = text;
        visto.tokens = tokens;
        visto.at = now;
        if (messageId) visto.messageId = messageId;
      }
      this.recentTexts.set(webContentsId, vistos);
      return { duplicate: true, sameText: igual, tokens: 0 };
    }

    // Sin un mensaje esperando respuesta, una llegada nueva no es una respuesta
    // nueva: es la misma, por otro canal o en otro trozo. Se acumula el texto
    // (sin repetir lo ya visto) y se corrige el conteo de tokens.
    const ultima = vistos[vistos.length - 1];
    if (!esperando && ultima && !ultima.text.includes(text)) {
      const junto = `${ultima.text}${text}`;
      const tokens = this.#outputTokens(junto, model || ultima.model || esperando?.entry?.model || '', provider || ultima.provider || esperando?.entry?.host || '');
      this.counters.outputTokens += tokens - ultima.tokens;
      ultima.text = junto;
      ultima.tokens = tokens;
      ultima.at = now;
      this.recentTexts.set(webContentsId, vistos);
      return { duplicate: true, sameText: false, tokens: 0, joined: true };
    }

    const tokens = this.#outputTokens(text, model || esperando?.entry?.model || '', provider || esperando?.entry?.host || '');
    vistos.push({ at: now, text, tokens, messageId: messageId || null,
      model: model || esperando?.entry?.model || '', provider: provider || esperando?.entry?.host || '' });
    this.recentTexts.set(webContentsId, vistos.slice(-6));
    return { duplicate: false, sameText: false, tokens };
  }

  /** Descarta claves viejas de un mapa de deduplicación. */
  #prune(map, now = Date.now(), ttl = 30 * 60_000) {
    if (map.size < 500) return;
    for (const [key, ts] of map) if (now - (typeof ts === 'object' ? ts.at : ts) > ttl && !key.includes('|outcome|')) map.delete(key);
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
    this.onTurnResult(webContentsId, { ...payload, finished: payload?.finished ?? true });
    // La capa cerró un stream: desde acá, esa respuesta ya la contó ella.
    this.layerEnded.set(webContentsId, Date.now());
    if (String(payload?.text || '').trim()) this.layerEndedText.set(webContentsId, Date.now());
    // Se anota lo que ya contó este camino ANTES de mirar el guard: si CDP ve el
    // mismo texto por otro canal, no se vuelve a registrar.
    const host = payload?.host || this.guards.get(webContentsId)?.host || safeHost(payload?.url) || 'desconocido';
    if (payload?.text) {
      this.#markSeen(webContentsId, [`h:${host}|${fingerprint(String(payload.text))}`], payload?.messageId);
    }

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
   * La capa de la página avisó que está viva: se instaló, o contó un envío o una
   * respuesta. Es lo que decide quién captura el stream: la página o CDP.
   */
  noteLayer(webContentsId) {
    if (webContentsId === undefined || webContentsId === null) return;
    this.layerSeen.set(webContentsId, Date.now());
  }

  /**
   * Identificador del mensaje que está esperando respuesta en esa pestaña.
   *
   * Lo usa CDP para atar una respuesta a su mensaje sin adivinar: si el envío
   * todavía no tiene respuesta, ese es el turno que hay que cerrar. Pasada la
   * ventana, no se devuelve nada: un mensaje viejo sin respuesta no se cierra con
   * una respuesta ajena.
   */
  /**
   * Turno esperando respuesta para esta pestaña.
   *
   * Cuando el navegador no informa la pestaña (una petición salida de un worker
   * del sitio llega con `webContentsId` desconocido), el mensaje se anota en la
   * pestaña `-1`. Si la respuesta aparece en una pestaña real y **no hay otro**
   * turno esperando, ese mensaje es el suyo: se enlaza en vez de dejar el turno
   * abierto para siempre. Con más de un turno pendiente no se adivina.
   */
  #pendingTurn(webContentsId, now) {
    const propio = this.awaiting.get(webContentsId);
    if (propio) return { id: webContentsId, entry: propio };
    const sinPestana = this.awaiting.get(-1);
    if (!sinPestana || now - sinPestana.at > VENTANA_RESPUESTA_MS) return null;
    // Sólo se enlaza si es el turno más reciente: si hay otro más nuevo en otra
    // pestaña, esta respuesta no le pertenece al mensaje sin pestaña.
    let ultimo = null;
    for (const [id, entry] of this.awaiting) {
      if (!ultimo || entry.at > ultimo.entry.at) ultimo = { id, entry };
    }
    return ultimo && ultimo.id === -1 ? ultimo : null;
  }

  /** Identificador canónico de un mensaje, aunque haya llegado con un alias. */
  resolveMessageId(webContentsId, messageId) {
    if (!messageId) return null;
    return this.messageAliases.get(`${webContentsId}|${messageId}`) || String(messageId);
  }

  currentSendId(webContentsId, withinMs = VENTANA_RESPUESTA_MS) {
    const awaiting = this.awaiting.get(webContentsId);
    if (!awaiting) return null;
    if (Date.now() - awaiting.at > withinMs) return null;
    return awaiting.messageId || null;
  }

  /**
   * ¿La capa de la página sigue viva en esa pestaña?
   *
   * Si lo está, el stream lo captura la página y CDP no debe leerlo (sería
   * contarlo dos veces). Si no lo está —la capa no se instaló, quedó bloqueada
   * por el sitio o la pestaña se restauró sin ella—, CDP es el único camino y
   * tiene que leer también los cuerpos `text/event-stream`.
   */
  hasRecentLayer(webContentsId, withinMs = 180_000) {
    const at = this.layerSeen.get(webContentsId);
    return Boolean(at && Date.now() - at < withinMs);
  }

  /**
   * ¿La capa cerró un stream en esta pestaña después de que empezara la
   * petición `sinceMs`?
   *
   * Es la pregunta que hay que hacer y no «¿la capa está viva?». Una capa que
   * contó el envío pero nunca cerró el stream deja la respuesta sin contar: en
   * ese caso CDP tiene que leerla. Si la cerró, la respuesta ya está contada y
   * leer el cuerpo desde CDP sólo serviría para volver a contarla.
   */
  layerEndedAfter(webContentsId, sinceMs = 0) {
    const at = this.layerEnded.get(webContentsId);
    return Boolean(at && at >= Number(sinceMs || 0));
  }

  /**
   * ¿La capa cerró un stream **con texto** después de ese instante?
   *
   * Es la pregunta correcta antes de que CDP descarte leer un cuerpo: un cierre
   * sin texto no prueba que la respuesta tenga sus tokens. Si la capa se calló,
   * CDP lee el cuerpo y `#absorbTokens` suma lo que faltaba sin contar otra
   * respuesta.
   */
  layerEndedWithTextAfter(webContentsId, sinceMs = 0) {
    const at = this.layerEndedText.get(webContentsId);
    return Boolean(at && at >= Number(sinceMs || 0));
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
    if (!text.trim()) {
      this.onTurnResult(webContentsId, capture);
      return { ok: false, skipped: 'empty' };
    }
    const now = Date.now();

    const host = capture.host || safeHost(capture.url) || 'desconocido';
    if (!this.isEnabledFor(host)) {
      // El usuario apagó el sitio: tampoco se observa.
      return { ok: false, skipped: 'disabled' };
    }

    this.onTurnResult(webContentsId, capture);

    // Un mismo turno puede aparecer dos veces (frame repetido, cuerpo pedido de
    // nuevo, socket reabierto) y también puede haberlo contado ya el camino
    // HTTP/SSE de esta misma pestaña: la huella lo descarta.
    const keys = [
      `c:${capture.site || host}|${capture.prompt || ''}|${fingerprint(text)}`,
      `h:${host}|${fingerprint(text)}`,
    ];
    // El turno pendiente se resuelve antes de decidir: sin él, dos respuestas
    // iguales seguidas se tomaban por una sola.
    const pendiente = this.#pendingTurn(webContentsId, now);
    const awaitId = capture.messageId
      ? this.resolveMessageId(pendiente?.id ?? webContentsId, capture.messageId)
      : pendiente?.entry.messageId || null;

    // ¿Es el texto de una respuesta que la red ya contó sin texto? Entonces lo
    // que falta son los tokens, no otra respuesta.
    if (this.#absorbTokens(webContentsId, text, awaitId, capture.model, capture.host)) {
      this.#markSeen(webContentsId, keys, awaitId);
      this.cdp.duplicates += 1;
      return { ok: true, duplicate: true, tokens: true };
    }

    if (this.#seenAlready(webContentsId, keys, { pendiente, messageId: awaitId })) {
      this.cdp.duplicates += 1;
      return { ok: true, duplicate: true };
    }
    this.#markSeen(webContentsId, keys, awaitId);

    // Una respuesta que sólo vio CDP también es una respuesta: se cuenta igual.
    // Si ya la había contado el camino SSE, la huella de arriba la descartó. Y si
    // es la misma respuesta llegando en pedazos, se corrige el conteo de tokens
    // en vez de sumar otra respuesta.
    const merge = this.#mergeResponse(webContentsId, text, { messageId: awaitId, pendiente, model: capture.model || pendiente?.entry?.model || '', provider: capture.host || pendiente?.entry?.host || '' });
    if (merge.duplicate) {
      this.cdp.duplicates += 1;
      return { ok: true, duplicate: true, merged: true };
    }
    this.counters.responses += 1;
    this.counters.activity += 1;
    this.counters.outputTokens += merge.tokens;

    // El turno se cierra con **su** mensaje. Si la captura trae identificador, se
    // exige que coincida; si no lo trae (un socket), se acepta el pendiente de la
    // pestaña sólo dentro de la ventana de respuesta.
    let paired = false;
    if (pendiente) {
      const vigente = now - pendiente.entry.at <= VENTANA_RESPUESTA_MS;
      const coincide = awaitId ? pendiente.entry.messageId === awaitId : true;
      if (vigente && coincide) {
        this.awaiting.delete(pendiente.id);
        paired = true;
      }
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
      // Cómo quedó atada la respuesta: por identificador (preciso) o por
      // pestaña, y si cerró un turno. Se usa para el registro y las pruebas.
      paired,
      messageId: awaitId,
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
   * Los cuatro resultados clasifican respuestas de ChatGPT, no
   * envíos preparados: `guardTurns` conserva la cuenta interna de los guardianes
   * para quien la necesite, pero no se muestra como «turnos».
   */
  stats() {
    let guardTurns = 0;
    for (const guard of this.guards.values()) {
      const s = guard.stats();
      guardTurns += s.turns;
    }
    const c = this.counters;
    return {
      tabs: this.guards.size,
      // Métricas de sesión; los cuatro resultados de turno son exclusivos.
      messages: c.messages,
      responses: c.responses,
      turnsCompleted: c.turnsCompleted,
      turnsCancelled: c.turnsCancelled,
      turnsFailed: c.turnsFailed,
      turnsUnknown: c.turnsUnknown,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      // El panel muestra la actividad de la conversación: +1 al enviar y +1 al
      // recibir. Lo que hizo el mediador va aparte, para no mezclar dos cosas.
      interventions: c.activity,
      mediatedInterventions: c.interventions,
      guardTurns,
      tokensEstimated: this.tokensEstimated,
      cdp: { ...this.cdp },
    };
  }

  dropTab(webContentsId) {
    this.onTurnInterrupted(webContentsId);
    this.guards.delete(webContentsId);
    this.cdpSeen.delete(webContentsId);
    this.awaiting.delete(webContentsId);
    this.lastSend.delete(webContentsId);
    this.recentTexts.delete(webContentsId);
    this.layerSeen.delete(webContentsId);
    this.layerEnded.delete(webContentsId);
    this.layerEndedText.delete(webContentsId);
    this.sinTexto.delete(webContentsId);
    for (const key of [...this.messageAliases.keys()]) {
      if (key.startsWith(`${webContentsId}|`)) this.messageAliases.delete(key);
    }
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
    if (failure.chat) this.onTurnResult(webContentsId, { ...failure,
      outcome: failure.canceled || /ERR_ABORTED/.test(failure.errorText || '') ? 'unknown' : 'failed' });
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

  /**
   * ¿Esta huella ya se vio en esta pestaña?
   *
   * La huella sirve para no contar dos veces el mismo texto entre canales, no
   * para fundir respuestas distintas: si hay un turno nuevo esperando y lo visto
   * viene de un turno anterior, es otra respuesta aunque diga exactamente lo
   * mismo («Listo.» cinco veces son cinco respuestas).
   */
  #seenAlready(webContentsId, keys, { pendiente = null, messageId = null } = {}) {
    const seen = this.cdpSeen.get(webContentsId);
    if (!seen) return false;
    const marca = keys.map((key) => seen.get(key)).find(Boolean);
    if (!marca) return false;
    if (!pendiente) return true;
    const turno = pendiente.entry;
    if (marca.messageId && messageId) return marca.messageId === messageId;
    return marca.at > turno.at;
  }

  #markSeen(webContentsId, keys, messageId = null) {
    let seen = this.cdpSeen.get(webContentsId);
    if (!seen) {
      seen = new Map();
      this.cdpSeen.set(webContentsId, seen);
    }
    const now = Date.now();
    const marca = { at: now, messageId: messageId ? String(messageId) : null };
    for (const key of keys) seen.set(key, marca);
    for (const [key, valor] of seen) if (now - valor.at > 120_000) seen.delete(key);
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
      // La búsqueda también marca lo ilegible: si no, buscar mostraba el token.
      readable: !looksEncrypted(entry.item.text),
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

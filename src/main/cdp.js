/**
 * Transporte CDP: un observador por pestaña.
 *
 * Usa el depurador de Electron (`webContents.debugger`, que es el protocolo
 * Chrome DevTools) para mirar dos canales que el enganche de `fetch` no alcanza:
 *
 *   · `Network.webSocketFrameReceived` / `…Sent` — frames de WebSocket.
 *   · `Network.responseReceived` + `Network.getResponseBody` — respuestas JSON
 *     completas, sin streaming.
 *
 * Reglas de convivencia con la capa HTTP/SSE que ya existe:
 *
 *   1. Los cuerpos `text/event-stream` y los streams se ignoran acá: de esos se
 *      ocupa la página, y procesarlos también duplicaría el turno.
 *   2. Sólo se adjunta el depurador a los hosts con perfil conocido.
 *   3. Si el depurador no está disponible (ya hay uno adjunto, Electron sin
 *      soporte, error del protocolo), el observador queda inerte: el navegador
 *      sigue funcionando exactamente igual que antes.
 *
 * Lo observado se entrega al motor con `engine.onCdpCapture()`, que es quien
 * decide qué registrar y cómo. Este módulo no reescribe nada: CDP sólo mira.
 */

import {
  CdpCapture,
  hostOf,
  isAiHost,
  isJsonMime,
  isStreamMime,
  promptOf,
  terminalOf,
} from '../core/cdp.js';
import { detectSite } from '../core/sites.js';

/** Versión del protocolo que expone Electron/Chromium. */
const CDP_VERSION = '1.3';

/** Tipos de recurso que pueden traer una respuesta de chat en JSON. */
const OBSERVED_RESOURCE_TYPES = new Set(['XHR', 'Fetch']);

/** Tope del cuerpo que se pide al depurador. */
const MAX_BODY_BYTES = 2_000_000;

export class CdpObserver {
  /**
   * @param {{
   *   engine?: object,
   *   log?: (message: string) => void,
   *   enabled?: boolean,
   *   isAllowed?: (host: string) => boolean
   * }} [opts]
   */
  constructor(opts = {}) {
    this.engine = opts.engine || null;
    this.log = opts.log || (() => {});
    this.enabled = opts.enabled !== false;
    /**
     * ¿El usuario quiere que este sitio se observe? Si apagó la mediación para
     * un sitio, tampoco se mira su tráfico.
     */
    this.isAllowed = opts.isAllowed || null;
    /** @type {Map<number, object>} pestañas observadas */
    this.tabs = new Map();
    this.stats = {
      attached: 0,
      detached: 0,
      failed: 0,
      sockets: 0,
      frames: 0,
      bodies: 0,
      captures: 0,
      duplicates: 0,
      ignored: 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* ciclo de vida                                                      */
  /* ------------------------------------------------------------------ */

  /** ¿Esta pestaña necesita el depurador? Sólo los hosts con perfil. */
  static wants(url) {
    return isAiHost(hostOf(url));
  }

  /**
   * Adjunta el depurador a una pestaña. Devuelve si quedó observando.
   *
   * `url` permite decidir con la URL a la que la pestaña *va*: durante
   * `did-start-navigation` el `webContents` todavía informa la anterior.
   */
  attach(contents, url = null) {
    if (!this.enabled || !contents || contents.isDestroyed?.()) return false;
    if (this.tabs.has(contents.id)) return true;

    const target = url || (typeof contents.getURL === 'function' ? contents.getURL() : '');
    if (!CdpObserver.wants(target)) return false;
    const host = hostOf(target);
    if (this.isAllowed && !this.isAllowed(host)) return false;

    const debuggerApi = contents.debugger;
    if (!debuggerApi || typeof debuggerApi.attach !== 'function') {
      this.stats.failed += 1;
      this.log('CDP no disponible en esta versión de Electron');
      return false;
    }

    try {
      debuggerApi.attach(CDP_VERSION);
    } catch (error) {
      // Ya hay un depurador adjunto (DevTools abierto) o el proceso no lo
      // permite: se sigue sin observar, sin tocar la navegación.
      this.stats.failed += 1;
      this.log(`CDP no se pudo adjuntar: ${error?.message || error}`);
      return false;
    }

    const state = {
      id: contents.id,
      contents,
      debuggerApi,
      sockets: new Map(),
      pending: new Map(),
      closed: false,
    };
    this.tabs.set(contents.id, state);
    this.stats.attached += 1;

    debuggerApi.on('message', (_event, method, params) => {
      this.handleMessage(contents.id, method, params).catch((error) => {
        this.log(`CDP: ${method}: ${error?.message || error}`);
      });
    });
    debuggerApi.on('detach', (_event, reason) => {
      this.tabs.delete(contents.id);
      this.stats.detached += 1;
      if (reason) this.log(`CDP: depurador separado (${reason})`);
    });

    // Los búferes son lo que permite pedir el cuerpo de una respuesta después
    // de que terminó. Sin esto, `getResponseBody` falla en respuestas grandes.
    this.#send(state, 'Network.enable', {
      maxTotalBufferSize: 40 * MAX_BODY_BYTES,
      maxResourceBufferSize: MAX_BODY_BYTES,
      maxPostDataSize: 65536,
    }).catch((error) => this.log(`CDP: Network.enable: ${error?.message || error}`));

    return true;
  }

  /** Suelta el depurador de una pestaña (cierre, navegación a otro sitio). */
  release(contents) {
    const id = contents?.id;
    if (id === undefined) return false;
    const state = this.tabs.get(id);
    if (!state) return false;
    // Lo pendiente se cierra antes de soltar: si no, el último turno se pierde.
    this.#flushAll(state, 'release');
    this.tabs.delete(id);
    this.stats.detached += 1;
    try {
      if (state.debuggerApi.isAttached?.() !== false) state.debuggerApi.detach();
    } catch (error) {
      this.log(`CDP: al separar: ${error?.message || error}`);
    }
    return true;
  }

  /** Suelta todo (cierre de la ventana). */
  releaseAll() {
    for (const state of [...this.tabs.values()]) this.release(state.contents);
  }

  /**
   * Ajusta la observación a la URL actual de la pestaña. Se llama en cada
   * navegación: si el sitio deja de ser proveedor, se suelta; si pasa a serlo,
   * se adjunta.
   */
  sync(contents, url = null) {
    if (!contents || contents.isDestroyed?.()) return false;
    const target = url || (typeof contents.getURL === 'function' ? contents.getURL() : '');
    if (CdpObserver.wants(target)) return this.attach(contents, target);
    if (this.tabs.has(contents.id)) this.release(contents);
    return false;
  }

  /** Estado resumido para la interfaz y las pruebas. */
  status() {
    return {
      enabled: this.enabled,
      tabs: this.tabs.size,
      ...this.stats,
    };
  }

  /* ------------------------------------------------------------------ */
  /* eventos CDP                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Procesa un evento del protocolo. Es público y sin dependencias de Electron
   * para poder probarlo con eventos grabados.
   */
  async handleMessage(tabId, method, params = {}) {
    const state = this.tabs.get(tabId);
    if (!state || state.closed) return;

    switch (method) {
      case 'Network.webSocketCreated':
        return this.#socketCreated(state, params);
      case 'Network.webSocketFrameReceived':
        return this.#frame(state, params, 'received');
      case 'Network.webSocketFrameSent':
        return this.#frame(state, params, 'sent');
      case 'Network.webSocketClosed':
        return this.#socketClosed(state, params);
      case 'Network.responseReceived':
        return this.#responseReceived(state, params);
      case 'Network.loadingFinished':
        return this.#loadingFinished(state, params);
      case 'Network.loadingFailed':
        state.pending.delete(params.requestId);
        return undefined;
      default:
        return undefined;
    }
  }

  /* -------------------------- WebSocket ----------------------------- */

  #socketCreated(state, params) {
    const url = String(params.url || '');
    const host = hostOf(url);
    if (!isAiHost(host)) {
      this.stats.ignored += 1;
      return;
    }
    const site = detectSite(host);
    state.sockets.set(params.requestId, {
      requestId: params.requestId,
      url,
      host,
      site,
      capture: new CdpCapture({
        site,
        host,
        url,
        source: 'websocket',
        conversationId: `${site.id}#${state.id}#${params.requestId}`,
      }),
    });
    this.stats.sockets += 1;
  }

  #frame(state, params, direction) {
    const socket = state.sockets.get(params.requestId);
    if (!socket) return;
    const frame = params.response || params;
    // Sólo texto: los frames binarios vienen en base64 y no son conversación.
    const opcode = Number(frame?.opcode ?? 1);
    if (opcode !== 1) {
      this.stats.ignored += 1;
      return;
    }
    const payload = String(frame?.payloadData ?? '');
    if (!payload || payload.length > MAX_BODY_BYTES) return;

    const json = safeJson(payload);
    if (!json) {
      this.stats.ignored += 1;
      return;
    }

    if (direction === 'sent') {
      const prompt = promptOf(json);
      if (prompt) socket.capture.prompt(prompt);
      return;
    }

    const { added, terminal } = socket.capture.add(json);
    if (added) this.stats.frames += 1;
    if (terminal) this.#flush(state, socket, terminal);
  }

  #socketClosed(state, params) {
    const socket = state.sockets.get(params.requestId);
    if (!socket) return;
    this.#flush(state, socket, 'closed');
    state.sockets.delete(params.requestId);
  }

  /* ---------------------- respuestas JSON --------------------------- */

  #responseReceived(state, params) {
    const response = params.response || {};
    const requestId = params.requestId;
    if (!OBSERVED_RESOURCE_TYPES.has(String(params.type || ''))) return;
    const url = String(response.url || '');
    const host = hostOf(url);
    if (!isAiHost(host)) return;
    const mimeType = String(response.mimeType || '');
    // Los SSE de estos sitios ya los media la página: contarlos acá sería
    // contarlos dos veces.
    if (isStreamMime(mimeType) || !isJsonMime(mimeType)) {
      this.stats.ignored += 1;
      return;
    }
    if (response.status && (response.status < 200 || response.status > 299)) return;

    state.pending.set(requestId, {
      requestId,
      url,
      host,
      site: detectSite(host),
      status: Number(response.status) || 200,
    });
  }

  async #loadingFinished(state, params) {
    const pending = state.pending.get(params.requestId);
    if (!pending) return;
    state.pending.delete(params.requestId);

    let body;
    try {
      body = await this.#send(state, 'Network.getResponseBody', { requestId: params.requestId });
    } catch (error) {
      // El cuerpo ya no está en el búfer (o era una descarga): no es un error.
      this.log(`CDP: cuerpo no disponible: ${error?.message || error}`);
      return;
    }
    if (!body || typeof body.body !== 'string') return;
    if (body.base64Encoded) {
      this.stats.ignored += 1;
      return;
    }
    if (body.body.length > MAX_BODY_BYTES) return;

    const json = safeJson(body.body);
    if (!json) {
      this.stats.ignored += 1;
      return;
    }

    const capture = new CdpCapture({
      site: pending.site,
      host: pending.host,
      url: pending.url,
      source: 'json',
      conversationId: `${pending.site.id}#${state.id}#${params.requestId}`,
    });
    // En el camino WebSocket el prompt llega en un frame saliente; acá se busca
    // dentro del propio cuerpo (algunos sitios devuelven el mensaje del usuario).
    const prompt = promptOf(json);
    if (prompt) capture.prompt(prompt);
    const { added } = capture.add(json);
    if (!added) {
      this.stats.ignored += 1;
      return;
    }
    this.stats.bodies += 1;
    this.#deliver(state, capture.take());
  }

  /* ------------------------------------------------------------------ */
  /* entrega al motor                                                   */
  /* ------------------------------------------------------------------ */

  #flush(state, socket, reason) {
    const capture = socket.capture.take();
    if (!capture) return;
    capture.closedBy = reason;
    this.#deliver(state, capture);
  }

  #flushAll(state, reason) {
    for (const socket of [...state.sockets.values()]) this.#flush(state, socket, reason);
    state.sockets.clear();
  }

  #deliver(state, capture) {
    if (!capture || !capture.text) return;
    this.stats.captures += 1;
    if (!this.engine || typeof this.engine.onCdpCapture !== 'function') return;
    try {
      const result = this.engine.onCdpCapture(state.id, capture);
      if (result?.duplicate) this.stats.duplicates += 1;
    } catch (error) {
      this.log(`CDP: al entregar al motor: ${error?.message || error}`);
    }
  }

  #send(state, method, params) {
    const api = state.debuggerApi;
    if (!api || typeof api.sendCommand !== 'function') {
      return Promise.reject(new Error('sin depurador'));
    }
    return Promise.resolve(api.sendCommand(method, params));
  }
}

/** JSON completo o `null`: media respuesta no se interpreta. */
function safeJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Reexportes usados por las pruebas y por `main.js`. */
export { terminalOf };

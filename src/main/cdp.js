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
import { detectSite, isMediable, isPreparationRequest, isResponseRequest, locateUserText } from '../core/sites.js';
import { fingerprint, gptModelFromRequest } from '../core/text.js';
import { countTokensForProvider } from './tokens.js';
import { parseSSE } from '../core/sse.js';

/** Versión del protocolo que expone Electron/Chromium. */
const CDP_VERSION = '1.3';

/** Tipos de recurso que pueden traer una respuesta de chat en JSON. */
const OBSERVED_RESOURCE_TYPES = new Set(['XHR', 'Fetch']);
/**
 * Tipos con los que Chromium a veces informa un `fetch` hecho desde un worker.
 * Sólo se aceptan si la respuesta es un stream: un JSON de esta puerta sería un
 * listado o el historial, no la respuesta del modelo.
 */
const ALTERNATIVE_STREAM_TYPES = new Set(['Other', 'EventSource']);

/** Tope del cuerpo que se pide al depurador. */
const MAX_BODY_BYTES = 2_000_000;

export class CdpObserver {
  /**
   * @param {{
   *   engine?: object,
   *   log?: (message: string) => void,
   *   enabled?: boolean,
   *   contentAllowed?: (host: string) => boolean
   * }} [opts]
   */
  constructor(opts = {}) {
    this.engine = opts.engine || null;
    this.log = opts.log || (() => {});
    /**
     * Aviso de lo que se cuenta: `{type:'send'|'capture'}`. Lo usa el proceso
     * principal para dejarlo en el registro y refrescar los contadores de la
     * interfaz sin esperar a que el usuario cambie de pestaña.
     */
    this.onEvent = opts.onEvent || (() => {});
    this.enabled = opts.enabled !== false;
    /**
     * ¿Está permitido observar este sitio? Con la mediación apagada, no: ni se
     * adjunta el depurador ni se lee tráfico.
     *
     * Se consulta dos veces por motivos distintos: al adjuntar (decisión de
     * privacidad, la del interruptor) y al leer cuerpos (por si el usuario
     * cambia el interruptor con la pestaña ya abierta).
     */
    this.contentAllowed = opts.contentAllowed || (() => true);
    /**
     * Aviso de lo que se descartó y por qué. Sin esto, una respuesta que no se
     * captura deja un cero sin rastro: el registro dirá si faltó el cuerpo, si
     * el tipo o el MIME no estaban entre los observados, o si el cuerpo llegó
     * pero no se reconoció texto.
     */
    this.onDiagnostic = opts.onDiagnostic || (() => {});
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
      failures: 0,
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
    // El interruptor del sitio manda: si el usuario apagó la mediación ahí, no
    // se adjunta el depurador. Observar un sitio que el usuario apagó sería
    // cambiar el contrato de privacidad que muestra la interfaz.
    if (!this.contentAllowed(hostOf(target))) return false;

    const debuggerApi = contents.debugger;
    if (!debuggerApi || typeof debuggerApi.attach !== 'function') {
      this.stats.failed += 1;
      this.log('CDP no disponible en esta versión de Electron');
      // Sin depurador no hay lectura de respuestas por observación. Antes esto
      // sólo salía por consola, que en la aplicación empaquetada no ve nadie:
      // el panel mostraba un cero sin causa.
      this.onDiagnostic({
        code: 'cdp-sin-depurador',
        key: 'cdp-sin-depurador|version',
        severity: 'warn',
        title: 'El depurador de Chromium no está disponible',
        detail: 'Esta versión de Electron no expone `webContents.debugger`: las respuestas sólo se pueden leer desde la página y desde la red.',
        meta: { host: hostOf(target) },
      });
      return false;
    }

    try {
      debuggerApi.attach(CDP_VERSION);
    } catch (error) {
      // Ya hay un depurador adjunto (DevTools abierto) o el proceso no lo
      // permite: se sigue sin observar, sin tocar la navegación.
      this.stats.failed += 1;
      this.log(`CDP no se pudo adjuntar: ${error?.message || error}`);
      this.onDiagnostic({
        code: 'cdp-sin-depurador',
        key: `cdp-sin-depurador|${hostOf(target)}`,
        severity: 'warn',
        title: `${hostOf(target) || 'la pestaña'}: el depurador no se pudo adjuntar`,
        detail: `${error?.message || error}. Con DevTools abierto en esa pestaña el navegador no puede observar el tráfico: cerralo y recargá.`,
        meta: { host: hostOf(target) },
      });
      return false;
    }

    const state = {
      id: contents.id,
      contents,
      debuggerApi,
      sockets: new Map(),
      pending: new Map(),
      requests: new Map(),
      failures: new Set(),
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
      case 'Network.requestWillBeSent':
        return this.#requestStarted(state, params);
      case 'Network.responseReceived':
        return this.#responseReceived(state, params);
      case 'Network.loadingFinished':
        return this.#loadingFinished(state, params);
      case 'Network.loadingFailed':
        return this.#loadingFailed(state, params);
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
    if (!this.contentAllowed(host)) {
      // Mediación apagada para este sitio: se mira el tráfico para detectar
      // fallos, pero no se lee la conversación.
      this.stats.ignored += 1;
      return;
    }
    state.sockets.set(params.requestId, {
      requestId: params.requestId,
      url,
      host,
      site,
      capture: new CdpCapture({
        site,        host,
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

  /* ---------------------- fallos de red ----------------------------- */

  /** Recuerda las peticiones de un proveedor: sin la URL, un fallo no se explica. */
  #requestStarted(state, params) {
    const type = String(params.type || '');
    const request = params.request || {};
    const url = String(request.url || '');
    const host = hostOf(url);
    if (!isAiHost(host)) return;
    const method = String(request.method || 'GET').toUpperCase();
    const site = detectSite(host);
    // ChatGPT puede exponer /unauth-mweb/conversation/updates como «Other»
    // (por ejemplo, si la petición nace en un worker). No descartarla antes
    // de reconocer la ruta: necesitamos correlacionar su requestId al recibir
    // la respuesta. El resto de recursos «Other» sigue fuera del observador.
    const responseRequest = isResponseRequest(site, url, method);
    if (!OBSERVED_RESOURCE_TYPES.has(type) && !responseRequest) return;
    const entry = {
      url,
      host,
      site: site.id,
      type,
      method,
      post: method === 'POST',
      /**
       * ¿Es la petición de conversación del sitio? No alcanza con que sea un
       * POST al dominio: el resto de las peticiones del sitio devuelven JSON
       * de cuentas, listas y metadatos, que no son respuestas del modelo.
       */
      chat: isMediable(site, url, method) || responseRequest,
      responseRequest,
      sendRequest: isMediable(site, url, method),
      /** Cuándo se vio salir la petición: acota qué cierre de la capa cuenta. */
      at: Date.now(),
      send: false,
      prompt: null,
      messageId: null,
    };
    state.requests.set(params.requestId, entry);
    if (state.requests.size > 200) {
      const first = state.requests.keys().next().value;
      state.requests.delete(first);
    }

    // El cuerpo de la petición trae el mensaje del usuario. Leerlo acá es lo que
    // hace que la entrada se cuente aunque la capa de la página no esté activa.
    // Se lee el cuerpo de cualquier POST del proveedor que pueda ser un envío,
    // no sólo el de la ruta declarada: si el sitio cambió de endpoint, la ruta
    // no lo delata pero el cuerpo sí, y sin esto la respuesta de esa petición no
    // se leía nunca. El canal de respuestas (`entry.responseRequest`) no lleva
    // el prompt: leerlo como envío sería inventar un mensaje del usuario.
    if (entry.post && !entry.responseRequest && this.contentAllowed(host)) {
      this.#noteSend(state, params.requestId, String(request.postData || '')).catch((error) =>
        this.log(`CDP: al leer el envío: ${error?.message || error}`),
      );
    }
  }

  /**
   * Anota el mensaje del usuario de una petición POST.
   *
   * Es el mismo dato que la capa lee dentro de la página, pero desde el proceso
   * principal. Sirve de camino independiente: si la capa no está instalada, la
   * entrada se cuenta igual. Cuando los dos caminos ven el mismo envío, el motor
   * lo descarta por la huella del texto y la cercanía en el tiempo.
   */
  async #noteSend(state, requestId, postData) {
    const entry = state.requests.get(requestId);
    if (!entry || entry.send) return;

    let body = postData;
    if (!body) {
      try {
        const got = await this.#send(state, 'Network.getRequestPostData', { requestId });
        body = typeof got?.postData === 'string' ? got.postData : '';
      } catch {
        body = '';
      }
    }
    if (!body || !body.trimStart().startsWith('{')) return;

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return;
    }

    // Regenerar o continuar son peticiones de conversación, pero no un mensaje
    // nuevo del usuario.
    if (typeof json?.action === 'string' && json.action && json.action !== 'next') return;

    const site = detectSite(entry.host);
    const model = gptModelFromRequest(json);
    const located = locateUserText(json, site);
    const text = located && typeof located.value === 'string' ? located.value.trim() : '';
    if (!text) return;

    if (!entry.chat && isPreparationRequest(site, entry.url)) {
      // Preparar no es enviar: mismo cuerpo, pero no es el mensaje.
      return;
    }
    entry.send = true;
    entry.prompt = text;
    entry.model = model;
    if (!entry.chat) {
      // El cuerpo es el de un mensaje del usuario aunque la ruta no sea la que
      // el perfil declara: la conversación cambió de endpoint. Desde acá la
      // respuesta de esta petición se lee como cualquier otra.
      entry.chat = true;
      this.onDiagnostic({
        code: 'chat-ruta',
        key: `chat-ruta|${entry.host}|${pathOf(entry.url)}`,
        severity: 'info',
        title: `${entry.host}: el mensaje viaja por una ruta nueva`,
        detail: `POST ${pathOf(entry.url)} — el perfil declara otra ruta, pero el cuerpo trae el mensaje del usuario: su respuesta se lee igual.`,
        meta: { host: entry.host, path: pathOf(entry.url), site: site.id },
      });
    }
    const messageId = `cdp-${requestId}`;
    entry.messageId = messageId;
    if (!this.engine || typeof this.engine.onUserMessage !== 'function') return;
    try {
      const counted = this.engine.onUserMessage(state.id, {
        messageId,
        source: 'cdp',
        site: site.id,
        host: entry.host,
        url: entry.url,
        chars: text.length,
        tokens: countTokensForProvider(text, model, entry.host),
        promptHash: fingerprint(text),
        textFound: true,
      });
      // Si el envío ya estaba contado (la red o la capa lo vieron antes), la
      // petición guarda el identificador del mensaje que manda en el turno.
      if (counted?.messageId) entry.messageId = counted.messageId;
      this.onEvent(state.id, {
        type: 'send',
        duplicate: Boolean(counted?.duplicate),
        host: entry.host,
        site: site.id,
        url: entry.url,
        chars: text.length,
        tokens: countTokensForProvider(text, model, entry.host),
        promptHash: fingerprint(text),
      });
    } catch (error) {
      this.log(`CDP: al anotar el mensaje: ${error?.message || error}`);
    }
  }

  #loadingFailed(state, params) {
    const request = state.requests.get(params.requestId);
    state.requests.delete(params.requestId);
    state.pending.delete(params.requestId);
    // canceled no demuestra Stop: también ocurre al navegar o por decisión del sitio.
    if (!request) return;
    if (params.canceled && !request.chat) return;
    this.#failure(state, {
      kind: 'net',
      chat: request.chat,
      messageId: request.messageId,
      canceled: Boolean(params.canceled),
      url: request.url,
      host: request.host,
      site: request.site,
      resourceType: request.type,
      errorText: String(params.errorText || ''),
      blockedReason: params.blockedReason ? String(params.blockedReason) : null,
    });
  }

  /** Informa un fallo al motor. Se descarta el contenido: sólo el hecho. */
  #failure(state, failure) {
    const key = `${failure.kind}|${failure.status || failure.errorText}|${failure.url}`;
    if (state.failures.has(key) && !failure.chat) return;
    state.failures.add(key);
    if (state.failures.size > 100) state.failures.delete(state.failures.values().next().value);
    this.stats.failures += 1;
    if (!this.engine || typeof this.engine.onCdpFailure !== 'function') return;
    try {
      this.engine.onCdpFailure(state.id, failure);
      this.onEvent(state.id, { type: 'turn-result' });
    } catch (error) {
      this.log(`CDP: al informar un fallo: ${error?.message || error}`);
    }
  }

  /* ---------------------- respuestas JSON --------------------------- */

  #responseReceived(state, params) {
    const response = params.response || {};
    const requestId = params.requestId;
    const url = String(response.url || '');
    const host = hostOf(url);
    if (!isAiHost(host)) return;
    const origenTipo = state.requests.get(requestId);
    const mimePrevio = String(response.mimeType || '');
    // Un stream es la respuesta del modelo aunque Chromium lo clasifique como
    // «Other» o «EventSource» (pasa cuando el fetch sale de un worker). Lo que
    // nunca se acepta por esta puerta es un JSON: un historial o una lista
    // también llegan como «Other» y no son respuestas.
    const tipoAlternativo = ALTERNATIVE_STREAM_TYPES.has(String(params.type || '')) && isStreamMime(mimePrevio);
    if (!OBSERVED_RESOURCE_TYPES.has(String(params.type || '')) && !tipoAlternativo && !origenTipo?.responseRequest) {
      // Una respuesta del endpoint de conversación con un tipo que no miramos
      // (por ejemplo «Other», típico de un fetch desde un worker) se perdía sin
      // decir nada. Si es la conversación, se avisa.
      if (origenTipo?.chat) {
        this.stats.ignored += 1;
        this.onDiagnostic({
          code: 'response-tipo',
          key: `response-tipo|${host}|${String(params.type || 'otro')}`,
          severity: 'warn',
          title: `${host}: respuesta de tipo no observado`,
          detail: `La respuesta de la conversación llegó como «${params.type || 'sin tipo'}»: el depurador no la lee, así que el texto no se cuenta.`,
          meta: { host, tipo: params.type || null, url },
        });
      }
      return;
    }
    if (response.status && (response.status < 200 || response.status > 299)) {
      // Un 403 en `/backend-api/conversation` es exactamente el motivo por el que
      // la interfaz del sitio dice «no se pudo conectar».
      this.#failure(state, {
        kind: 'http',
        chat: Boolean(origenTipo?.chat),
        messageId: origenTipo?.messageId || null,
        url,
        host,
        site: detectSite(host).id,
        resourceType: params.type,
        status: Number(response.status),
        mimeType: String(response.mimeType || ''),
      });
      return;
    }
    const mimeType = String(response.mimeType || '');
    /**
     * Una respuesta de conversación que llega como `text/plain` se lee igual: el
     * cuerpo se interpreta después con el lector tolerante (SSE, JSON por líneas
     * o texto). Descartarla por el MIME era dejar la respuesta sin sus tokens.
     */
    const origenMime = state.requests.get(requestId);
    const textoPlanoDeChat =
      /^text\/plain/i.test(mimeType) && Boolean(origenMime && (origenMime.chat || origenMime.responseRequest));
    const stream = isStreamMime(mimeType) || textoPlanoDeChat;
    if (!stream && !isJsonMime(mimeType)) {
      this.stats.ignored += 1;
      if (state.requests.get(requestId)?.chat) {
        this.onDiagnostic({
          code: 'response-mime',
          key: `response-mime|${host}|${mimeType}`,
          severity: 'warn',
          title: `${host}: respuesta con MIME no observado`,
          detail: `La respuesta de la conversación llegó como «${mimeType || 'sin MIME'}»: no es SSE ni JSON, así que su texto no se cuenta.`,
          meta: { host, mimeType: mimeType || null, url },
        });
      }
      return;
    }
    // Sólo la respuesta a la petición de conversación es una respuesta del
    // modelo. Un JSON de cuentas, de ajustes o de listas no lo es aunque venga
    // del mismo dominio y sea un POST.
    const origen = state.requests.get(requestId);
    // Un GET (historial, listados) nunca es una respuesta del modelo. Un POST
    // cuya ruta no está declarada se decide al terminar la carga, cuando ya se
    // sabe si su cuerpo era el de un mensaje del usuario.
    if (origen && !origen.chat && !origen.post) {
      this.stats.ignored += 1;
      return;
    }
    // El stream se lee desde CDP aunque la capa esté viva, salvo que la capa
    // haya cerrado ESE stream (se decide al terminar la carga, cuando ya se
    // sabe). Que la capa cuente el envío no garantiza que capture la
    // contestación: si se calla, la respuesta se perdería.
    state.pending.set(requestId, {
      requestId,
      url,
      host,
      site: detectSite(host),
      status: Number(response.status) || 200,
      stream,
      textoPlanoDeChat,
      // Instante en que salió la petición: sólo un cierre de la capa posterior
      // a esto cuenta como «la respuesta ya la contó ella».
      since: Number(origen?.at) || Date.now(),
    });
  }

  async #loadingFinished(state, params) {
    const pending = state.pending.get(params.requestId);
    const request = state.requests.get(params.requestId);
    state.requests.delete(params.requestId);
    if (!pending) return;
    state.pending.delete(params.requestId);
    // Sólo la respuesta a una petición que la página envió puede ser una
    // respuesta nueva. Un GET (por ejemplo, abrir el historial de la
    // conversación) devuelve JSON con todos los mensajes anteriores: contarlo
    // sería sumar el historial como si la IA acabara de contestar.
    if (request && !request.post) {
      this.stats.ignored += 1;
      return;
    }
    // Un POST del proveedor que no es la conversación (telemetría, ajustes) no
    // se lee: su cuerpo no es una respuesta del modelo.
    if (request && !request.chat) {
      this.stats.ignored += 1;
      return;
    }
    if (!this.contentAllowed(pending.host)) {
      this.stats.ignored += 1;
      return;
    }

    // Un stream que la capa cerró **con texto** ya está contado: no se vuelve a
    // leer. Si la capa lo cerró sin texto (su lector no reconoció el protocolo),
    // la respuesta se contó y se quedó sin tokens: ahí CDP tiene que leer el
    // cuerpo, y el motor suma los tokens a esa misma respuesta.
    const cerroConTexto = this.engine?.layerEndedWithTextAfter
      ? this.engine.layerEndedWithTextAfter(state.id, pending.since)
      : this.engine?.layerEndedAfter?.(state.id, pending.since);
    if (pending.stream && cerroConTexto) {
      this.stats.ignored += 1;
      // No es un fallo, pero sí la explicación de por qué el texto no vino de
      // acá: sin este aviso, «CDP no capturó» y «la capa llegó primero» se
      // veían igual en el registro.
      this.onDiagnostic({
        code: 'response-capa',
        key: `response-capa|${pending.host}`,
        severity: 'info',
        title: `${pending.host}: el stream lo cerró la capa de la página`,
        detail: 'La página ya contó ese stream, así que el depurador no lo vuelve a leer: contarlo otra vez sería sumar dos veces la misma respuesta.',
        meta: { host: pending.host, url: pending.url },
      });
      return;
    }

    let body;
    try {
      body = await this.#send(state, 'Network.getResponseBody', { requestId: params.requestId });
    } catch (error) {
      // El cuerpo ya no está en el búfer (o era una descarga). No es un error
      // del navegador, pero sí explica una respuesta que no se cuenta.
      this.log(`CDP: cuerpo no disponible: ${error?.message || error}`);
      if (pending.url) {
        this.onDiagnostic({
          code: 'response-sin-cuerpo',
          key: `response-sin-cuerpo|${pending.host}`,
          severity: 'warn',
          title: `${pending.host}: no se pudo leer el cuerpo de la respuesta`,
          detail: `${error?.message || error}. El depurador no conservó el cuerpo (respuesta muy larga o ya liberada): el texto no se cuenta.`,
          meta: { host: pending.host, url: pending.url },
        });
      }
      return;
    }
    if (!body || typeof body.body !== 'string') return;
    let cuerpo = body.body;
    if (body.base64Encoded) {
      // Chromium entrega en base64 cuando el cuerpo no es texto plano. Un SSE
      // puede llegar así si el servidor comprime la respuesta: antes se
      // descartaba en silencio y la respuesta no la contaba nadie.
      try {
        cuerpo = Buffer.from(String(cuerpo), 'base64').toString('utf8');
      } catch {
        this.stats.ignored += 1;
        return;
      }
      this.onDiagnostic({
        code: 'response-base64',
        key: `response-base64|${pending.host}`,
        severity: 'info',
        title: `${pending.host}: la respuesta llegó codificada en base64`,
        detail: 'Se decodificó para poder leer el texto. Si la respuesta se ve, quedó registrado el detalle.',
        meta: { host: pending.host, url: pending.url },
      });
    }
    if (!cuerpo) {
      // El depurador devolvió el cuerpo vacío: es lo que pasa con algunos
      // streams largos. La respuesta la contará el camino de red, pero el texto
      // no se puede leer y hay que decirlo.
      if (pending.stream) {
        this.onDiagnostic({
          code: 'response-vacio',
          key: `response-vacio|${pending.host}`,
          severity: 'warn',
          title: `${pending.host}: el depurador devolvió el cuerpo vacío`,
          detail: 'La respuesta llegó, pero su texto no está en el búfer del depurador.',
          meta: { host: pending.host, url: pending.url },
        });
      }
      return;
    }
    if (cuerpo.length > MAX_BODY_BYTES) return;

    // Respuesta en streaming (SSE): se arma igual que en la página, con los
    // mismos adaptadores, y se cuenta una sola vez al terminar.
    if (pending.stream) {
      const capture = new CdpCapture({
        site: pending.site,
        host: pending.host,
        url: pending.url,
        source: 'sse',
        messageId: request?.messageId || null,
        conversationId: `${pending.site.id}#${state.id}#${params.requestId}`,
      });
      const prompt = request?.prompt || null;
      if (prompt) capture.prompt(prompt);
      // Primero SSE (`data:`), que es lo habitual. Si no hay un solo evento así,
      // el cuerpo puede ser JSON por líneas —el canal de actualizaciones del
      // cliente sin cuenta manda así— y antes se descartaba entero: la respuesta
      // se contaba por la red y los tokens quedaban en cero.
      let leidos = eventosSSE(cuerpo);
      if (!leidos.length) leidos = eventosNDJSON(cuerpo);
      let eventos = leidos.length;
      let primerEvento = leidos[0] || null;
      for (const evento of leidos) capture.add(evento);
      if (!eventos) {
        // Sin estructura reconocible, pero si el cuerpo es texto corrido (sin
        // una sola llave: no hay JSON que interpretar), ese texto **es** la
        // respuesta y sus tokens se estiman de ahí. No se inventa nada: se lee
        // lo que el sitio mandó.
        const pareceTexto = pending.textoPlanoDeChat && !cuerpo.includes('{') && !cuerpo.includes('[') &&
          !/^(?:event|data|id|retry):|^:/m.test(cuerpo);
        if (pareceTexto && cuerpo.trim()) {
          capture.add({ text: cuerpo });
          eventos = 1;
        } else {
          // Cuerpo sin un solo evento `data:` parseable: no es el stream que
          // creemos. Se avisa con una muestra corta en vez de dejar un cero mudo.
          this.onDiagnostic({
            code: 'response-formato',
            key: `response-formato|${pending.host}`,
            severity: 'warn',
            title: `${pending.host}: la respuesta no tiene eventos SSE reconocibles`,
            detail: `Se leyeron ${cuerpo.length} caracteres y ningún evento «data:» con JSON. Muestra: ${cuerpo.slice(0, 120).replace(/\s+/g, ' ')}`,
            meta: { host: pending.host, url: pending.url, bytes: cuerpo.length },
          });
        }
      }
      this.stats.bodies += 1;
      const listo = capture.take();
      if (listo) {
        listo.model = listo.model || request?.model || '';
        if (listo && listo.outcome === 'unknown') listo.outcome = 'completed';
      }
      if (!listo) {
        // El cuerpo se leyó y los eventos se parsearon, pero ninguno trajo
        // texto del asistente. Es la forma silenciosa de perder una respuesta:
        // el protocolo del sitio no es el que el adaptador espera. Se deja la
        // forma del primer evento para poder corregirlo sin adivinar.
        this.onDiagnostic({
          code: 'response-sin-texto',
          key: `response-sin-texto|${pending.host}`,
          severity: 'warn',
          title: `${pending.host}: el stream llegó y no se reconoció texto`,
          detail: `${eventos} evento(s) y ningún texto del asistente. Forma del primer evento: ${shapeOf(primerEvento)}.`,
          meta: { host: pending.host, url: pending.url, events: eventos, shape: shapeOf(primerEvento) },
        });
        return;
      }
      this.#deliver(state, listo);
      return;
    }

    let json = safeJson(cuerpo);
    if (!json) {
      // Un cuerpo con varios JSON, uno por línea (NDJSON): se entrega como
      // captura igual que un JSON completo.
      const sueltos = eventosNDJSON(cuerpo);
      if (sueltos.length) {
        const captureNd = new CdpCapture({
          site: pending.site,
          host: pending.host,
          url: pending.url,
          source: 'json',
          messageId: request?.messageId || null,
          conversationId: `${pending.site.id}#${state.id}#${params.requestId}`,
        });
        const promptNd = request?.prompt || null;
        if (promptNd) captureNd.prompt(promptNd);
        for (const evento of sueltos) captureNd.add(evento);
        this.stats.bodies += 1;
        const listoNd = captureNd.take();
        if (listoNd) {
          listoNd.model = listoNd.model || request?.model || '';
          if (listoNd.outcome === 'unknown') listoNd.outcome = 'completed';
          this.#deliver(state, listoNd);
          return;
        }
        json = null;
      }
    }
    if (!json) {
      // Cuerpo leído, ni SSE ni JSON: sin este aviso el cero no tenía causa.
      this.stats.ignored += 1;
      if (request?.chat) {
        this.onDiagnostic({
          code: 'response-formato',
          key: `response-formato|${pending.host}`,
          severity: 'warn',
          title: `${pending.host}: la respuesta no es SSE ni JSON`,
          detail: `Se leyeron ${cuerpo.length} caracteres que no forman un JSON completo. Muestra: ${cuerpo.slice(0, 120).replace(/\s+/g, ' ')}`,
          meta: { host: pending.host, url: pending.url, bytes: cuerpo.length },
        });
      }
      return;
    }

    const capture = new CdpCapture({
      site: pending.site,
      host: pending.host,
      url: pending.url,
      source: 'json',
      messageId: request?.messageId || null,
      conversationId: `${pending.site.id}#${state.id}#${params.requestId}`,
    });
    // En el camino WebSocket el prompt llega en un frame saliente; acá se busca
    // dentro del propio cuerpo (algunos sitios devuelven el mensaje del usuario).
    const prompt = request?.prompt || promptOf(json);
    if (prompt) capture.prompt(prompt);
    const { added } = capture.add(json);
    capture.model = request?.model || '';
    if (!added) {
      // Un JSON de la conversación que no se reconoce como texto: se deja la
      // forma de sus claves para saber qué buscaba el perfil y qué trajo el
      // sitio. Sin esto el cero no tenía causa.
      this.stats.ignored += 1;
      if (request?.chat) {
        this.onDiagnostic({
          code: 'response-sin-texto',
          key: `response-sin-texto|${pending.host}`,
          severity: 'warn',
          title: `${pending.host}: la respuesta llegó y no se reconoció texto`,
          detail: `El cuerpo es JSON y el perfil del sitio no encontró el texto del asistente. Forma: ${shapeOf(json)}.`,
          meta: { host: pending.host, url: pending.url, shape: shapeOf(json) },
        });
      }
      return;
    }
    this.stats.bodies += 1;
    const listo = capture.take();
    if (listo) listo.model = listo.model || request?.model || '';
    if (listo && listo.outcome === 'unknown') listo.outcome = 'completed';
    this.#deliver(state, listo);
  }

  /* ------------------------------------------------------------------ */
  /* entrega al motor                                                   */
  /* ------------------------------------------------------------------ */

  #flush(state, socket, reason) {
    const capture = socket.capture.take();
    if (!capture) return;
    capture.closedBy = reason;
    if (capture.outcome === 'unknown' && reason === 'message' && capture.site !== 'chatgpt') capture.outcome = 'completed';
    // Un socket no trae el identificador de la petición HTTP, pero sí pertenece
    // a la pestaña: se asocia al mensaje que está esperando respuesta en ella.
    if (!capture.messageId && typeof this.engine?.currentSendId === 'function') {
      capture.messageId = this.engine.currentSendId(state.id) || null;
    }
    this.#deliver(state, capture);
  }

  #flushAll(state, reason) {
    for (const socket of [...state.sockets.values()]) this.#flush(state, socket, reason);
    state.sockets.clear();
  }

  #deliver(state, capture) {
    if (!capture || (!capture.text && !capture.outcome)) return;
    this.stats.captures += 1;
    if (!this.engine || typeof this.engine.onCdpCapture !== 'function') return;
    try {
      const result = this.engine.onCdpCapture(state.id, capture);
      if (result?.duplicate) this.stats.duplicates += 1;
      this.onEvent(state.id, {
        type: 'capture',
        capture,
        duplicate: Boolean(result?.duplicate),
        paired: Boolean(result?.paired),
        messageId: result?.messageId || capture?.messageId || null,
      });
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

/** Eventos SSE (`data: …`) de un cuerpo ya descargado. */
function eventosSSE(cuerpo) {
  return parseSSE(`${cuerpo}\n\n`).events
    .map((event) => safeJson(event.data)).filter(Boolean);
}

/**
 * Eventos de un cuerpo JSON por líneas (NDJSON/JSONL).
 *
 * El canal de actualizaciones del cliente sin cuenta entrega la respuesta así.
 * Se ignoran las líneas de comentario y las cabeceras SSE, y se descartan las
 * líneas que no son un JSON completo.
 */
function eventosNDJSON(cuerpo) {
  const eventos = [];
  for (const linea of String(cuerpo).split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia === '[DONE]') continue;
    if (limpia.startsWith('event:') || limpia.startsWith(':') || limpia.startsWith('data:')) continue;
    if (limpia[0] !== '{' && limpia[0] !== '[') continue;
    const evento = safeJson(limpia);
    if (evento) eventos.push(evento);
  }
  return eventos;
}

/** Ruta de una URL, sin dominio ni consulta: lo que se anota en el registro. */
function pathOf(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url || '').split('?')[0].slice(0, 120);
  }
}

/**
 * Forma de un objeto para el registro: las claves, no el contenido.
 *
 * Se usa cuando una respuesta llegó y no se reconoció su texto. Con las claves
 * alcanza para saber qué protocolo habló el sitio; el texto del usuario no
 * necesita salir de la conversación para explicar un cero.
 */
function shapeOf(value, depth = 0) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return typeof value;
  if (depth > 1) return '…';
  const keys = Array.isArray(value) ? [] : Object.keys(value).slice(0, 8);
  const inside = keys
    .slice(0, 8)
    .map((key) => `${key}:${shapeOf(value[key], depth + 1)}`)
    .join(', ');
  return Array.isArray(value) ? `[${value.length}]` : `{${inside}}`;
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
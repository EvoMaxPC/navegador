/**
 * Capa de inyección (mundo principal de la página).
 *
 * Este script se empaqueta con esbuild y lo inyecta el preload de cada pestaña
 * ANTES de que la aplicación del sitio cargue. Su trabajo:
 *
 *   1. Enganchar `window.fetch` para quedarse con la petición de chat.
 *   2. Pedir al proceso principal el mensaje mediado (motor `promptEngine`) y
 *      reescribir el cuerpo de la petición con ese texto.
 *   3. Envolver la respuesta en un `TransformStream` que parsea SSE, extrae los
 *      deltas de texto y los pasa por el `StreamSentinel`. Si hay bucle, los
 *      fragmentos repetidos se vacían antes de llegar al DOM.
 *   4. Al terminar, informar al proceso principal y, si corresponde, enviar la
 *      continuación automática escribiendo en el cuadro de texto del sitio.
 *
 * Nada de esto requiere permisos especiales del sitio: trabaja sobre la API del
 * navegador que la propia página usa.
 */

import { createStreamFilter } from '../core/streamFilter.js';
import { getPath, looksLikeStream } from '../core/sse.js';
import { detectSite, isMediable, locateUserText, patchUserText } from '../core/sites.js';
import { countGptTokens, estimateTokens, fingerprint, gptModelFromRequest } from '../core/text.js';

const CONFIG = window.__NEXO_CONFIG__ || {};
const site = detectSite(CONFIG.host || location.hostname);

const state = {
  enabled: CONFIG.enabled !== false,
  settings: CONFIG.settings || {},
  language: CONFIG.language || 'es',
  continuations: 0,
  active: 0,
  /** Identificador de cada envío reconocido: asocia mensaje, respuesta y turno. */
  messageSeq: 0,
};

/* ------------------------------------------------------------------ */
/* puente con el proceso principal (vía preload, mundo aislado)        */
/* ------------------------------------------------------------------ */

const bridge = (() => {
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__nexo !== 'reply') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.payload);
  });

  return {
    // El envío del sitio espera esta respuesta. Dos segundos alcanzan de sobra
    // para un motor en proceso; esperar cinco retrasaba el mensaje y hacía
    // parecer que el botón de enviar no respondía.
    request(type, payload, timeout = 2000) {
      const id = `n${Date.now().toString(36)}-${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null };
        pending.set(id, entry);
        window.postMessage({ __nexo: 'call', id, type, payload }, '*');
        // Cancelable: si la respuesta llega, el temporizador no debe quedar vivo
        // sujetando la promesa ni dispararse después con el mismo id.
        entry.timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`nexo:timeout:${type}`));
        }, timeout);
      });
    },
    ready(payload) {
      window.postMessage({ __nexo: 'ready', payload }, '*');
    },
    event(type, payload) {
      window.postMessage({ __nexo: 'event', type, payload }, '*');
    },
  };
})();

/* ------------------------------------------------------------------ */
/* utilidades                                                          */
/* ------------------------------------------------------------------ */

function safeJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function shouldMediate(url, method) {
  if (!state.enabled) return false;
  if (state.settings.sites?.[site.id]?.enabled === false) return false;
  // `isMediable` deja fuera los hosts sin perfil y todo flujo de acceso: una
  // contraseña o un código de OAuth no son un mensaje que haya que mejorar.
  return isMediable(site, url, method);
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  return input?.url || String(input?.href || '');
}

/**
 * URL absoluta de la petición.
 *
 * Una aplicación web puede pedir `fetch('/backend-api/conversation')`. El
 * proceso principal necesita el host para decidir si media y para anotar el
 * origen en el registro; la página sí lo conoce (`location.href`).
 */
function absoluteUrl(url) {
  try {
    return new URL(String(url || ''), location.href).href;
  } catch {
    return String(url || '');
  }
}

function methodOf(input, init) {
  return String(init?.method || input?.method || 'GET');
}

/**
 * Identificador de la conversación abierta, tomado de la URL del sitio
 * (`/c/<id>` en ChatGPT, `/chat/<id>` en Claude). Es lo que permite asociar
 * mensaje, respuesta y turno sin mirar el texto.
 */
function conversationIdOf() {
  try {
    const match = String(location.pathname).match(/\/(?:c|chat|conversation)\/([A-Za-z0-9-]{8,})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 0. un envío del usuario = un mensaje contado                        */
/* ------------------------------------------------------------------ */

/**
 * Estado del envío en curso.
 *
 * Un envío tiene **un solo** identificador y se cuenta **una sola vez**, venga
 * el aviso del gesto (pulsar Enviar o Enter) o de la petición que sale después.
 * Si vienen los dos, se enlazan: la petición reutiliza el identificador del gesto.
 */
const envio = {
  /** Gesto visto, esperando la petición que lo confirme. */
  pendiente: null,
  /** Envío que ya se contó sólo con el gesto, por si la petición no aparece. */
  porGesto: null,
};

/** Margen para que aparezca la petición antes de contar el gesto por su cuenta. */
const ESPERA_PETICION_MS = 2500;
/** Dos gestos seguidos del mismo envío (click y Enter, por ejemplo). */
const VENTANA_GESTO_MS = 800;
/** Distancia máxima entre gesto y petición para considerarlos el mismo envío. */
const VENTANA_ENLACE_MS = 10_000;

function nuevoMessageId() {
  state.messageSeq += 1;
  return `m${Date.now().toString(36)}-${state.messageSeq}`;
}

/** La capa actúa sólo si el navegador y el sitio están habilitados. */
function sitioActivo() {
  if (!state.enabled) return false;
  return state.settings.sites?.[site.id]?.enabled !== false;
}

/**
 * Anuncia un mensaje del usuario al proceso principal.
 *
 * Único camino: lo llaman el gesto de enviar o la petición, nunca los dos para
 * el mismo envío. `chars` y `tokens` pueden ser 0 cuando la petición es de
 * conversación pero no se puede leer el texto: el mensaje existe igual y el
 * contador lo tiene que ver. No se inventan cifras en ese caso.
 */
function anunciarEnvio(datos = {}) {
  const payload = {
    messageId: datos.messageId || nuevoMessageId(),
    site: site.id,
    host: CONFIG.host || location.hostname,
    conversationId: conversationIdOf(),
    url: String(datos.url || location.href).slice(0, 200),
    mediated: Boolean(datos.mediated),
    // De dónde salió el aviso: el gesto del usuario o la petición del sitio.
    source: datos.source === 'composer' ? 'composer' : 'request',
    // Si el texto se pudo leer del cuerpo. Con `false`, `chars` es 0.
    textFound: datos.textFound !== false,
    chars: Math.max(0, Number(datos.chars) || 0),
    tokens: Math.max(0, Number(datos.tokens) || 0),
    model: String(datos.model || ''),
    // Huella del texto enviado: permite reconocer el mismo envío cuando lo
    // anuncia también la observación CDP, sin mandar el texto por el puente.
    promptHash: datos.promptHash || (datos.texto ? fingerprint(datos.texto) : ''),
  };
  bridge.event('outgoing', payload);
  return payload;
}

/** Texto que hay ahora mismo en el cuadro de diálogo. */
/** Texto de un cuadro, sea `textarea`, `input` o `contenteditable`. */
function textoDe(el) {
  if (!el) return '';
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
  return String(el.innerText || el.textContent || '');
}

/**
 * Texto que hay ahora mismo en el cuadro de diálogo.
 *
 * Primero los selectores del perfil. Si el sitio cambió el marcado y no hay
 * ninguno, se usa lo que tiene el foco y, por último, el primer cuadro editable
 * de la página: el mensaje se tiene que contar aunque el selector envejezca.
 */
function textoDelCuadro() {
  for (const selector of site.composer || []) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {
      el = null;
    }
    if (el) return textoDe(el);
  }

  try {
    const activo = document.activeElement;
    const texto = textoDe(activo);
    if (texto.trim()) return texto;
  } catch {
    /* sin foco accesible */
  }

  for (const selector of ['[contenteditable="true"]', 'textarea', 'form textarea']) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {
      el = null;
    }
    const texto = textoDe(el);
    if (texto.trim()) return texto;
  }
  return '';
}

/**
 * El usuario pulsó Enviar (o Enter) en el cuadro.
 *
 * Se cuenta siempre, aunque la petición no se pueda leer: es el gesto más
 * directo que existe de «envié un mensaje». Se espera un momento a la petición
 * porque su cuerpo trae el texto exacto; si no aparece (la página envía desde un
 * worker, o cambió el formato del cuerpo), el gesto cuenta solo.
 */
function gestoDeEnvio(razon) {
  if (!sitioActivo()) return null;
  const texto = textoDelCuadro().trim();
  if (!texto) return null; // sin texto no hay mensaje que contar

  const ahora = Date.now();
  const pendiente = envio.pendiente;
  // El mismo envío visto dos veces: el click que dispara el Enter, o al revés.
  if (pendiente && ahora - pendiente.at < VENTANA_GESTO_MS) return pendiente;

  const nuevo = {
    id: nuevoMessageId(),
    at: ahora,
    chars: texto.length,
    tokens: countGptTokens(texto),
    promptHash: fingerprint(texto),
    razon,
    timer: null,
  };
  nuevo.timer = setTimeout(() => {
    if (envio.pendiente !== nuevo) return;
    envio.pendiente = null;
    envio.porGesto = { at: nuevo.at, chars: nuevo.chars, id: nuevo.id };
    anunciarEnvio({ ...nuevo, source: 'composer', textFound: true });
  }, ESPERA_PETICION_MS);

  envio.pendiente = nuevo;
  return nuevo;
}

/** ¿Este envío ya se contó por el gesto? Entonces la petición no lo repite. */
function yaContadoPorGesto(chars) {
  const gesto = envio.porGesto;
  if (!gesto) return false;
  if (Date.now() - gesto.at > VENTANA_ENLACE_MS) return false;
  // Sin texto en el cuerpo se acepta el del gesto; con texto, tiene que coincidir.
  return !chars || chars === gesto.chars;
}

/** Toma el gesto pendiente y lo desactiva: su petición llegó. */
function tomarEnvioPendiente() {
  const pendiente = envio.pendiente;
  if (!pendiente) return null;
  clearTimeout(pendiente.timer);
  envio.pendiente = null;
  return pendiente;
}

/* ------------------------------------------------------------------ */
/* 1 + 2. petición saliente                                            */
/* ------------------------------------------------------------------ */

/**
 * Decide qué hacer con la petición y devuelve un informe.
 *
 * Nunca devuelve `null`: hay tres estados y los tres importan.
 *
 *   · `chat: false` — no es una petición de conversación; no se toca nada.
 *   · `chat: true, plan: null` — es una conversación pero no se cambia el texto
 *     (sin prompt reconocible, o el motor no modificó nada). **La respuesta se
 *     captura igual**: contar lo que el usuario envió y lo que la IA respondió no
 *     puede depender de que Nexo intervenga.
 *   · `plan: { input, init }` — hay que enviar el cuerpo mediado.
 *
 * Esta función sólo PREPARA: nunca envía. Así, un fallo del motor (tiempo de
 * espera, error de IPC, esquema desconocido) se resuelve enviando la petición
 * original, y un fallo de la RED no puede provocar un segundo envío del mensaje.
 */
async function planRequest(input, init) {
  const url = absoluteUrl(urlOf(input));
  if (!shouldMediate(url, methodOf(input, init))) return { chat: false };

  // El cuerpo viaja como string en `init`, o dentro de un objeto `Request`.
  let text = typeof init?.body === 'string' ? init.body : null;
  const desdeRequest =
    text === null && init?.body === undefined && typeof Request !== 'undefined' && input instanceof Request;
  if (desdeRequest) text = await input.clone().text();

  // Sin cuerpo legible sigue siendo una conversación: se captura la respuesta y
  // el envío se cuenta igual (lo confirma el gesto o la propia petición).
  const parsed = safeJson(text);
  if (!parsed) return { chat: true, send: true, reason: 'cuerpo-no-legible' };

  // «Regenerar» y «continuar» son peticiones de conversación, pero no son un
  // mensaje nuevo del usuario: se captura la respuesta y no se cuenta mensaje.
  if (site.id === 'chatgpt' && typeof parsed.action === 'string' && parsed.action && parsed.action !== 'next') {
    return { chat: true, send: false, reason: `accion-${parsed.action}` };
  }

  const located = locateUserText(parsed, site);
  if (!located || !located.value) return { chat: true, send: true, reason: 'sin-texto' };

  const prompt = located.value;
  // El motor puede no contestar (arranque, IPC lento, error interno). Eso **no**
  // puede costar la captura: se sigue sin mediación, pero contando el mensaje y
  // envolviendo la respuesta.
  let report = null;
  try {
    report = await bridge.request('prepare', { prompt, url, site: site.id });
  } catch (error) {
    bridge.event('error', { stage: 'prepare', message: String(error?.message || error) });
  }
  const base = {
    chat: true,
    send: true,
    promptChars: prompt.length,
    promptTokens: countGptTokens(prompt, gptModelFromRequest(parsed)),
    model: gptModelFromRequest(parsed),
    promptHash: fingerprint(prompt),
    url,
  };
  if (!report?.text) return { ...base, plan: null };

  // El texto no cambió: no hay nada que reescribir, pero el envío se registra y
  // la respuesta se captura. Antes se descartaba todo y el turno no existía.
  if (report.text === prompt) return { ...base, plan: { input, init }, mediated: false };

  if (!patchUserText(parsed, site, report.text)) return { ...base, plan: null };
  const body = JSON.stringify(parsed);
  return {
    ...base,
    plan: desdeRequest ? { input: new Request(input, { body }), init } : { input, init: { ...init, body } },
    mediated: true,
  };
}

/* ------------------------------------------------------------------ */
/* 3. respuesta entrante (streaming)                                   */
/* ------------------------------------------------------------------ */

// Estados sin cuerpo: `new Response(stream, { status: 204 })` lanza TypeError y
// la petición se rompería para la página.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * Tope del texto que viaja al proceso principal.
 *
 * No es un recorte de la captura: es el límite de lo que se guarda en el
 * historial y en la memoria. Antes eran 8 000 caracteres fijos, que cortaban
 * respuestas largas de verdad; ahora entra una conversación entera.
 */
const MAX_CAPTURE_CHARS = 200_000;

function wrapResponse(response, capture = {}) {
  if (!response || !response.body || !looksLikeStream(response.headers)) return response;
  if (NULL_BODY_STATUS.has(response.status) || response.status < 200 || response.status > 599) return response;

  const filtered = response.body.pipeThrough(
    createStreamFilter({
      settings: state.settings,
      adapter: site.streamAdapter || null,
      deltaPaths: site.deltaPaths,
      language: state.language,
      host: CONFIG.host,
      onStop: (info) => {
        bridge.event('stream-stop', { ...capture, site: site.id, host: CONFIG.host, ...info });
      },
      onError: (info) => {
        // El adaptador no supo leer un evento. Se reenvió tal cual y la
        // conversación siguió; queda anotado para no diagnosticar a ciegas.
        bridge.event('error', { stage: `filtro:${info.stage}`, message: info.message });
      },
      onEnd: (info) => {
        const text = String(info.text || '');
        const recortado = text.length > MAX_CAPTURE_CHARS;
        bridge.event('stream-end', {
          ...capture,
          site: site.id,
          host: CONFIG.host,
          finished: true,
          stopped: info.stopped,
          code: info.code,
          truncated: info.truncated,
          truncationReason: info.truncationReason,
          deliveredChars: info.deliveredChars,
          droppedChars: info.droppedChars,
          chars: text.length,
          tokens: countGptTokens(text, capture.model),
          clipped: recortado,
          text: recortado ? text.slice(0, MAX_CAPTURE_CHARS) : text,
          dropped: info.dropped.slice(0, 600),
        });
      },
    }),
  );

  const headers = new Headers(response.headers);
  // El cuerpo ya viene descomprimido: si la cabecera sobrevive, el cliente
  // intenta descomprimir otra vez y el stream falla. `content-length` deja de
  // valer porque el texto filtrado no mide lo mismo.
  headers.delete('content-length');
  headers.delete('content-encoding');

  const wrapped = new Response(filtered, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  // Una `Response` construida a mano pierde `url` y `redirected`, que algunos
  // clientes leen (por ejemplo para resolver rutas relativas del stream).
  for (const key of ['url', 'redirected']) {
    try {
      Object.defineProperty(wrapped, key, { value: response[key] });
    } catch {
      // Propiedad no redefinible en esta versión: se ignora.
    }
  }
  return wrapped;
}

/* ------------------------------------------------------------------ */
/* enganche de fetch                                                   */
/* ------------------------------------------------------------------ */

if (!window.__NEXO_HOOKED__) {
  window.__NEXO_HOOKED__ = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function nexoFetch(input, init) {
    const url = absoluteUrl(urlOf(input));
    const method = methodOf(input, init);

    // 1) Preparar: no envía nada. Cualquier fallo → petición original.
    let prepared = { chat: false };
    try {
      prepared = await planRequest(input, init);
    } catch (error) {
      bridge.event('error', { stage: 'prepare', message: String(error?.message || error) });
    }

    // Un envío se anota siempre: con o sin mediación, y aunque no se pueda leer
    // el texto del cuerpo. De acá sale el contador de mensajes del usuario y el
    // identificador con el que se empareja su respuesta.
    let messageId = null;
    if (prepared.chat && prepared.send !== false) {
      const gesto = tomarEnvioPendiente();
      const chars = prepared.promptChars || gesto?.chars || 0;
      if (yaContadoPorGesto(chars)) {
        // Ya lo contó el gesto: la respuesta tiene que usar su identificador.
        messageId = envio.porGesto.id;
      } else {
        messageId = anunciarEnvio({
          messageId: gesto?.id,
          source: 'request',
          mediated: prepared.mediated,
          chars,
          tokens: prepared.promptTokens ?? gesto?.tokens ?? 0,
          model: prepared.model || '',
          promptHash: prepared.promptHash || gesto?.promptHash || '',
          textFound: Boolean(prepared.promptChars),
          url,
        }).messageId;
      }
    }
    // Sin mensaje propio (regenerar, o una petición que no es conversación) la
    // respuesta igual necesita un identificador único para no duplicarse.
    if (!messageId) messageId = nuevoMessageId();

    const target = prepared.plan || { input, init };

    // 2) Enviar, UNA sola vez. Un error de red o un AbortError (el usuario pulsó
    //    «Detener») se propaga a la página, que ya sabe qué hacer: reenviar desde
    //    acá duplicaría el mensaje en el servidor.
    state.active += 1;
    let response;
    try {
      response = await nativeFetch(target.input, target.init);
    } finally {
      state.active -= 1;
    }

    // Un rechazo del proveedor (403, 429…) se informa con su código: es el dato
    // que explica «no se pudo conectar» sin abrir las herramientas del sitio.
    if (response.ok === false) {
      bridge.event('error', {
        stage: 'http',
        message: `${response.status} ${method} ${url.slice(0, 160)}`,
      });
    }

    // 3) Envolver la respuesta. Sólo se captura lo que es una conversación: una
    //    página cualquiera no se toca. Si el filtro fallara, se entrega la
    //    original sin reenviar nada (el cuerpo todavía no se consumió).
    if (!prepared.chat) return response;
    try {
      return wrapResponse(response, {
        messageId,
        conversationId: conversationIdOf(),
        mediated: Boolean(prepared.mediated),
        promptChars: prepared.promptChars || 0,
      });
    } catch (error) {
      bridge.event('error', { stage: 'stream', message: String(error?.message || error) });
      return response;
    }
  };
}

/* ------------------------------------------------------------------ */
/* 5. continuación automática (adaptador DOM)                          */
/* ------------------------------------------------------------------ */

const COMPOSER = site.composer || [];
const SEND = site.sendButton || [];

/* ------------------------------------------------------------------ */
/* 4b. gesto de envío: pulsar Enviar o Enter en el cuadro              */
/* ------------------------------------------------------------------ */

/**
 * Es el aviso más directo que hay de «el usuario envió un mensaje», y no
 * depende de cómo venga el cuerpo de la petición ni de que se pueda leer.
 * La petición que salga después se enlaza con este gesto por identificador.
 */
function esBotonDeEnvio(nodo) {
  if (!nodo || typeof nodo.closest !== 'function') return false;
  const boton = nodo.closest('button, [role="button"], input[type="submit"]');
  if (!boton || boton.disabled) return false;
  return SEND.some((selector) => {
    try {
      return boton.matches(selector);
    } catch {
      return false;
    }
  });
}

function estaEnElCuadro(nodo) {
  if (!nodo || typeof nodo.closest !== 'function') return false;
  return COMPOSER.some((selector) => {
    try {
      return Boolean(nodo.closest(selector));
    } catch {
      return false;
    }
  });
}

try {
  document.addEventListener(
    'click',
    (event) => {
      if (esBotonDeEnvio(event.target)) gestoDeEnvio('boton');
    },
    true,
  );

  // Algunos sitios envían con un formulario: `submit` es el gesto, no el click.
  document.addEventListener(
    'submit',
    () => {
      gestoDeEnvio('formulario');
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      // Enter sin modificadores envía. Shift+Enter e IME no.
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      if (!estaEnElCuadro(event.target)) return;
      gestoDeEnvio('enter');
    },
    true,
  );
} catch {
  /* sin DOM accesible el gesto no existe; la petición sigue contando */
}

function findFirst(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function setComposerText(text) {
  const el = findFirst(COMPOSER);
  if (!el) return false;
  el.focus();

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (el.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    return true;
  }
  return false;
}

async function sendComposer() {
  await new Promise((r) => setTimeout(r, 60));
  const button = findFirst(SEND);
  if (button && !button.disabled) {
    button.click();
    return true;
  }
  const composer = findFirst(COMPOSER);
  if (composer) {
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }),
    );
    return true;
  }
  return false;
}

async function submitContinuation(prompt) {
  const maxContinuations = state.settings.receiving?.autoContinue ?? 0;
  if (maxContinuations <= 0 || state.continuations >= maxContinuations) return false;
  state.continuations += 1;

  const ok = setComposerText(prompt);
  if (!ok) {
    bridge.event('error', { stage: 'continuation', message: 'no-composer' });
    return false;
  }
  return sendComposer();
}

/* ------------------------------------------------------------------ */
/* mensajes desde el proceso principal                                 */
/* ------------------------------------------------------------------ */

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.__nexo !== 'action') return;

  if (data.type === 'settings') {
    state.settings = data.payload?.settings || state.settings;
    state.enabled = data.payload?.enabled !== false;
    return;
  }

  if (data.type === 'continue' && data.payload?.prompt) {
    submitContinuation(data.payload.prompt).then((sent) => {
      bridge.event('continuation-sent', { sent });
    });
  }
});

/* ------------------------------------------------------------------ */
/* arranque                                                            */
/* ------------------------------------------------------------------ */

bridge.ready({
  site: site.id,
  host: CONFIG.host,
  href: location.href,
  version: CONFIG.version || '0.1.0',
});

// Se expone un objeto de depuración para la consola del navegador.
window.__nexo = {
  site,
  state,
  setComposerText,
  submitContinuation,
  getPath,
};

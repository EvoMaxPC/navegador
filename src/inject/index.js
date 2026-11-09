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

const CONFIG = window.__NEXO_CONFIG__ || {};
const site = detectSite(CONFIG.host || location.hostname);

const state = {
  enabled: CONFIG.enabled !== false,
  settings: CONFIG.settings || {},
  language: CONFIG.language || 'es',
  continuations: 0,
  active: 0,
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
    request(type, payload, timeout = 5000) {
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

/* ------------------------------------------------------------------ */
/* 1 + 2. petición saliente                                            */
/* ------------------------------------------------------------------ */

/**
 * Decide si la petición se media y, si es así, devuelve los argumentos con los
 * que hay que enviarla. Devuelve `null` cuando NO hay nada que cambiar.
 *
 * Esta función sólo PREPARA: nunca envía. Así, un fallo del motor (tiempo de
 * espera, error de IPC, esquema desconocido) se resuelve enviando la petición
 * original, y un fallo de la RED no puede provocar un segundo envío del mensaje.
 */
async function planRequest(input, init) {
  const url = absoluteUrl(urlOf(input));
  if (!shouldMediate(url, methodOf(input, init))) return null;

  // El cuerpo viaja como string en `init`, o dentro de un objeto `Request`.
  let text = typeof init?.body === 'string' ? init.body : null;
  const desdeRequest =
    text === null && init?.body === undefined && typeof Request !== 'undefined' && input instanceof Request;
  if (desdeRequest) text = await input.clone().text();

  const parsed = safeJson(text);
  if (!parsed) return null;

  const located = locateUserText(parsed, site);
  if (!located || !located.value) return null;

  const report = await bridge.request('prepare', { prompt: located.value, url, site: site.id });
  if (!report?.text || report.text === located.value) return null;

  if (!patchUserText(parsed, site, report.text)) return null;
  const body = JSON.stringify(parsed);
  return desdeRequest ? { input: new Request(input, { body }), init } : { input, init: { ...init, body } };
}

/* ------------------------------------------------------------------ */
/* 3. respuesta entrante (streaming)                                   */
/* ------------------------------------------------------------------ */

// Estados sin cuerpo: `new Response(stream, { status: 204 })` lanza TypeError y
// la petición se rompería para la página.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function wrapResponse(response) {
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
        bridge.event('stream-stop', { site: site.id, host: CONFIG.host, ...info });
      },
      onError: (info) => {
        // El adaptador no supo leer un evento. Se reenvió tal cual y la
        // conversación siguió; queda anotado para no diagnosticar a ciegas.
        bridge.event('error', { stage: `filtro:${info.stage}`, message: info.message });
      },
      onEnd: (info) => {
        bridge.event('stream-end', {
          site: site.id,
          host: CONFIG.host,
          stopped: info.stopped,
          code: info.code,
          truncated: info.truncated,
          truncationReason: info.truncationReason,
          deliveredChars: info.deliveredChars,
          droppedChars: info.droppedChars,
          text: info.text.slice(-8000),
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
    // 1) Preparar: no envía nada. Cualquier fallo → petición original.
    let plan = null;
    try {
      plan = await planRequest(input, init);
    } catch (error) {
      bridge.event('error', { stage: 'prepare', message: String(error?.message || error) });
    }
    if (!plan) return nativeFetch(input, init);

    // 2) Enviar, UNA sola vez. Un error de red o un AbortError (el usuario pulsó
    //    «Detener») se propaga a la página, que ya sabe qué hacer: reenviar desde
    //    acá duplicaría el mensaje en el servidor.
    state.active += 1;
    let response;
    try {
      response = await nativeFetch(plan.input, plan.init);
    } finally {
      state.active -= 1;
    }

    // 3) Envolver la respuesta. Si el filtro fallara, se entrega la original sin
    //    reenviar nada (el cuerpo todavía no se consumió).
    try {
      return wrapResponse(response);
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

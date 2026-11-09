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
import { detectSite, isChatRequest, locateUserText, patchUserText } from '../core/sites.js';

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
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.payload);
  });

  return {
    request(type, payload, timeout = 5000) {
      const id = `n${Date.now().toString(36)}-${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.postMessage({ __nexo: 'call', id, type, payload }, '*');
        setTimeout(() => {
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

function bodyToText(body) {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return null;
  if (body instanceof FormData) return null;
  return null;
}

function shouldMediate(url) {
  if (!state.enabled) return false;
  if (state.settings.sites?.[site.id]?.enabled === false) return false;
  return isChatRequest(site, url);
}

/* ------------------------------------------------------------------ */
/* 1 + 2. petición saliente                                            */
/* ------------------------------------------------------------------ */

async function mediateRequest(input, init) {
  const url = typeof input === 'string' ? input : input?.url || String(input?.href || '');
  if (!shouldMediate(url)) return init;

  const raw = bodyToText(init?.body);
  const parsed = safeJson(raw);
  if (!parsed) return init;

  try {
    const located = locateUserText(parsed, site);
    if (!located || !located.value) return init;

    const report = await bridge.request('prepare', {
      prompt: located.value,
      url,
      site: site.id,
    });

    if (!report?.text || report.text === located.value) return init;

    patchUserText(parsed, site, report.text);
    return { ...init, body: JSON.stringify(parsed) };
  } catch (error) {
    // Nunca se rompe la petición del usuario por un fallo del motor.
    bridge.event('error', { stage: 'prepare', message: String(error?.message || error) });
    return init;
  }
}

/* ------------------------------------------------------------------ */
/* 3. respuesta entrante (streaming)                                   */
/* ------------------------------------------------------------------ */

function wrapResponse(response) {
  if (!response || !response.body || !looksLikeStream(response.headers)) return response;

  const filtered = response.body.pipeThrough(
    createStreamFilter({
      settings: state.settings,
      deltaPaths: site.deltaPaths,
      language: state.language,
      host: CONFIG.host,
      onStop: (info) => {
        bridge.event('stream-stop', { site: site.id, ...info });
      },
      onEnd: (info) => {
        bridge.event('stream-end', {
          site: site.id,
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
  headers.delete('content-length');

  return new Response(filtered, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/* ------------------------------------------------------------------ */
/* enganche de fetch                                                   */
/* ------------------------------------------------------------------ */

if (!window.__NEXO_HOOKED__) {
  window.__NEXO_HOOKED__ = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function nexoFetch(input, init) {
    const parsed = safeJson(bodyToText(init?.body));
    if (!parsed || !shouldMediate(typeof input === 'string' ? input : input?.url || '')) {
      return nativeFetch(input, init);
    }

    state.active += 1;
    try {
      const mediatedInit = await mediateRequest(input, init);
      const response = await nativeFetch(input, mediatedInit);
      return wrapResponse(response);
    } catch (error) {
      bridge.event('error', { stage: 'fetch', message: String(error?.message || error) });
      return nativeFetch(input, init);
    } finally {
      state.active -= 1;
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

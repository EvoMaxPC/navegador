import { diagnoseChatGptReader } from '../core/chatgptAdapter.js';
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
import { detectSite, isChatRequest, isMediable, isResponseRequest, locateUserText, patchUserText } from '../core/sites.js';
import { readChatGptDpuAnswer, waitForChatGptDpuAnswer, extractChatGptVisibleAnswer, isChatGptDpuMime } from '../core/chatgptDpu.js';
import { estimateTokens, fingerprint, gptModelFromRequest, userMessageIdentity } from '../core/text.js';
import { normalizeEgress } from '../core/egressConfig.js';
import { readBody } from '../core/readBody.js';
import { detectSensitive } from '../egress/detect.js';
import { guardSlots } from '../egress/slots.js';

const CONFIG = window.__NEXO_CONFIG__ || {};
const site = detectSite(CONFIG.host || location.hostname);

const state = {
  enabled: CONFIG.enabled !== false,
  settings: CONFIG.settings || {},
  language: CONFIG.language || 'es',
  continuations: 0,
  active: 0,
  response: null,
  currentMessageId: null,
  /** Identificador de cada envío reconocido: asocia mensaje, respuesta y turno. */
  messageSeq: 0,
  /** Último veredicto del guardián de salida (`null` si nunca corrió). */
  egress: null,
};

/* ------------------------------------------------------------------ */
/* puente con el proceso principal (vía preload, mundo aislado)        */
/* ------------------------------------------------------------------ */

const bridge = (() => {
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.__nexo !== 'reply') return;
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
  /**
   * Gesto apartado mientras el guardián decide. Su temporizador está parado: no
   * puede contar un envío que quizá no salga. `anunciado` dice si ya llegó a
   * contar (si el temporizador venció antes de retenerlo).
   */
  retenido: null,
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
    tokens: Number.isFinite(datos.tokens) ? Math.max(0, datos.tokens) : null,
    model: String(datos.model || ''),
    submissionId: datos.submissionId || '',
    // Sólo llega al preload local; se quita antes del IPC y del registro.
    tokenText: datos.tokenText || '',
    // Huella del texto enviado: permite reconocer el mismo envío cuando lo
    // anuncia también la observación CDP, sin reenviar el texto al proceso principal.
    promptHash: datos.promptHash || (datos.texto ? fingerprint(datos.texto) : ''),
  };
  state.currentMessageId = payload.messageId;
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

function anunciarGesto(gesto) {
  envio.porGesto = {
    at: gesto.at, chars: gesto.chars, id: gesto.id,
    tokenText: gesto.tokenText, tokens: gesto.tokens, promptHash: gesto.promptHash,
    // Texto saneado que reemplazó al del cuadro: la petición lo traerá así.
    sustituidoPor: gesto.sustituidoPor || null,
    // Sólo para `liberarGesto`: si el envío se retuvo, no hay que borrar la
    // marca de un gesto posterior.
    _timer: gesto.timer,
  };
  anunciarEnvio({ ...gesto, messageId: gesto.id, source: 'composer', textFound: true });
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
  const texto = textoDelCuadro();
  if (!texto) return null; // sin texto no hay mensaje que contar

  const ahora = Date.now();
  const pendiente = envio.pendiente;
  // El mismo envío visto dos veces: el click que dispara el Enter, o al revés.
  if (pendiente && ahora - pendiente.at < VENTANA_GESTO_MS && pendiente.tokenText === texto) return pendiente;
  if (pendiente) {
    clearTimeout(pendiente.timer);
    anunciarGesto(pendiente); // Otro texto es otro envío: no se pierde el anterior.
  }

  const nuevo = {
    id: nuevoMessageId(),
    at: ahora,
    chars: texto.length,
    tokenText: texto,
    tokens: legacyProviderInputTokens(texto),
    promptHash: fingerprint(texto),
    razon,
    timer: null,
  };
  nuevo.timer = setTimeout(() => {
    if (envio.pendiente !== nuevo) return;
    envio.pendiente = null;
    anunciarGesto(nuevo);
  }, ESPERA_PETICION_MS);

  envio.pendiente = nuevo;
  return nuevo;
}

/** Correlación sin usar longitud ni huellas normalizadas como identidad. */
function mismoEnvioDelGesto(gesto, peticion) {
  if (!gesto) return false;
  // El gesto local no trae ID del proveedor: sólo es evidencia el texto literal de la
  // petición, no texto tomado del propio gesto como respaldo (caso DPU opaco).
  if (peticion.textFound === false || peticion.promptFromRequest === false) return false;
  if (typeof peticion.promptText !== 'string') return false;
  // El guardián pudo redactar entre el gesto y la petición: entonces la
  // petición trae el texto saneado, no el del cuadro. Es el mismo envío.
  return peticion.promptText === gesto.tokenText ||
    (typeof gesto.sustituidoPor === 'string' && peticion.promptText === gesto.sustituidoPor);
}

/** Devuelve el ID del gesto contado sólo si esta petición corresponde a él. */
function yaContadoPorGesto(peticion) {
  const gesto = envio.porGesto;
  if (!gesto || Date.now() - gesto.at > VENTANA_ENLACE_MS) return null;
  if (!mismoEnvioDelGesto(gesto, peticion)) return null;
  envio.porGesto = null;
  return gesto.id;
}

/**
 * El gesto que corresponde a este texto, lo haya confirmado la petición o no.
 *
 * En `enforce` la petición espera al diálogo del guardián, así que puede tardar
 * más que `ESPERA_PETICION_MS`: para entonces el gesto ya se anunció solo y vive
 * en `porGesto`. Sin mirar ahí, el envío se contaría dos veces.
 */
function gestoDeEsteEnvio(texto) {
  if (envio.retenido && mismoEnvioDelGesto(envio.retenido, { promptText: texto })) return envio.retenido;
  if (envio.pendiente && mismoEnvioDelGesto(envio.pendiente, { promptText: texto })) return envio.pendiente;
  const gesto = envio.porGesto;
  if (gesto && Date.now() - gesto.at <= VENTANA_ENLACE_MS && mismoEnvioDelGesto(gesto, { promptText: texto })) return gesto;
  return null;
}

/**
 * Aparta el gesto mientras el guardián decide, y para su temporizador.
 *
 * Sólo para `enforce` con un gesto que corresponda al texto que se va a enviar.
 * En `off` y `observe` no se llama, y sin gesto no hace nada.
 */
function retenerGesto(texto) {
  // Si quedó un retenido de un envío anterior (por ejemplo, un planRequest que
  // murió sin liberar), no se reutiliza como propio: se descarta con la regla de
  // «no salió» y se retiene el de ahora. Así un huérfano no contamina el envío
  // siguiente ni se queda retenido para siempre.
  if (envio.retenido) liberarGesto(envio.retenido);
  const gesto = gestoDeEsteEnvio(texto);
  if (!gesto) return null;
  if (gesto === envio.pendiente) {
    clearTimeout(gesto.timer);
    gesto.timer = null;
    envio.pendiente = null;
  }
  const retenido = {
    ...gesto,
    timer: null,
    retenidoEn: Date.now(),
    anunciado: Boolean(gesto.messageId),
    sustituidoPor: gesto.sustituidoPor || null,
  };
  if (gesto === envio.porGesto) envio.porGesto = null;
  envio.retenido = retenido;
  return retenido;
}

/**
 * Devuelve el gesto retenido a la circulación.
 *
 * Se llama SIEMPRE (try/finally), también cuando la consulta lanza.
 *
 *   · Sin texto (`saneado` nulo): la decisión fue retener. Se descarta el gesto
 *     y, si ya se había anunciado, se cierra el turno como cancelado. Ojo: un
 *     cancelado ya anunciado **queda contado** como mensaje; es una limitación
 *     aceptada (pasó `ESPERA_PETICION_MS` antes de la decisión) y no se puede
 *     descontar sin inventar contadores negativos en el motor.
 *   · Con texto: el envío sigue. El gesto vuelve a `pendiente` con el reloj
 *     renovado, y con `sustituidoPor` si el guardián lo redactó.
 */
function liberarGesto(retenido, saneado = null) {
  if (!retenido) return;
  if (envio.retenido === retenido) envio.retenido = null;

  if (typeof saneado !== 'string') {
    if (retenido.anunciado) {
      bridge.event('turn-result', {
        messageId: retenido.messageId,
        host: CONFIG.host || location.hostname,
        site: site.id,
        outcome: 'cancelled',
        stoppedByUser: false,
        blockedByGuard: true,
      });
    }
    return;
  }

  const nuevo = {
    ...retenido,
    at: Date.now(),
    // `true` = provisional: hay un temporizador vivo que puede anunciarlo.
    provisional: true,
    sustituidoPor: saneado === retenido.tokenText ? null : saneado,
    promptHash: fingerprint(saneado),
  };
  nuevo.timer = setTimeout(() => {
    if (envio.pendiente !== nuevo) return;
    envio.pendiente = null;
    anunciarGesto(nuevo);
  }, ESPERA_PETICION_MS);
  envio.pendiente = nuevo;
  return nuevo;
}

/** Una petición ajena no consume ni cancela el gesto pendiente. */
function tomarEnvioPendiente(peticion) {
  const pendiente = envio.pendiente;
  if (!mismoEnvioDelGesto(pendiente, peticion)) return null;
  clearTimeout(pendiente.timer);
  envio.pendiente = null;
  return pendiente;
}

/** GPT se cuenta exclusivamente en preload con BPE, nunca en la página con reglas. */
function legacyProviderInputTokens(text) {
  return site.id === 'chatgpt' ? null : estimateTokens(text);
}

/** Lee texto y modelo declarados en el formulario DPU, sin alterar el prompt. */
async function chatGptDpuRequest(input, init) {
  let body = init?.body;
  if (body === undefined && typeof Request !== 'undefined' && input instanceof Request) {
    try { body = await input.clone().text(); } catch { body = null; }
  }
  try {
    const fields = (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
      (typeof FormData !== 'undefined' && body instanceof FormData) ? body :
      typeof body === 'string' ? new URLSearchParams(body) : null;
    if (fields) {
      const prompt = fields.get('prompt');
      return {
        prompt: typeof prompt === 'string' ? prompt : null,
        model: gptModelFromRequest({
          model: fields.get('model'), model_slug: fields.get('model_slug'),
          metadata: safeJson(fields.get('metadata')),
          conversation_mode: safeJson(fields.get('conversation_mode')),
        }),
      };
    }
  } catch {
    /* El compositor sigue como respaldo; no se inventa modelo ni conteo. */
  }
  return {prompt:null, model:''};
}

/* ------------------------------------------------------------------ */
/* 1b. guardián de salida (datos sensibles)                            */
/* ------------------------------------------------------------------ */

/** Margen sobre el tiempo de decisión: el diálogo puede tardar, el puente no. */
const MARGEN_EGRESS_MS = 5000;

/** ¿Hay algo crítico en este texto? El mismo juicio que usa la puerta. */
function hayCritico(texto) {
  return detectSensitive(String(texto || '')).some((f) => f.severity === 'critical');
}

/**
 * Red de seguridad para cuando `planRequest` lanza.
 *
 * `guardPrompt` está escrito para no lanzar, pero un fallo ANTES de que llegue a
 * mirar el cuerpo dejaba la petición seguir hasta el `fetch` nativo con el dato
 * dentro. En `enforce` se vuelve a leer el cuerpo con `readBody` (que no lo
 * consume) y se decide con el detector local: sólo un hallazgo crítico retiene.
 * En `observe` y `off` no cambia nada: nunca se ha retenido por esta vía.
 */
async function planFallido(input, init) {
  if (normalizeEgress(state.settings?.egress).mode !== 'enforce') return { chat: false };
  let critico = false;
  try {
    const { text } = await readBody(input, init);
    critico = typeof text === 'string' && hayCritico(text);
  } catch {
    // Si la lectura falla y no se sabía nada, se deja pasar como siempre.
  }
  if (!critico) return { chat: false };
  state.egress = { mode: 'enforce', action: 'block', reason: 'fail-safe', at: Date.now() };
  // `red` distingue este bloqueo del que decide la puerta: la puerta ya avisa
  // por `onDiagnostic` (egress-block), así que aquí no se repite el diagnóstico.
  return { chat: true, send: true, blocked: true, red: true };
}

/**
 * Consulta la puerta de salida antes de enviar. Nunca lanza: un guardián que
 * rompe el envío de la página es peor que uno que no interviene.
 *
 *   · `off` no cuesta nada y no habla con el proceso principal.
 *   · `observe` registra lo que la puerta habría hecho y deja pasar siempre.
 *   · `enforce` obedece a la puerta (`replace`, `block`, `pass`).
 *
 * Si la puerta no contesta (o contesta algo que no entiende) se mira el texto
 * acá con el mismo detector del proceso principal: sólo se retiene si hay datos
 * críticos. Es el único camino en el que la decisión se toma en la página.
 */
async function guardPrompt(text, { canRewrite = false, unreadable = null, slots = null } = {}) {
  const cfg = normalizeEgress(state.settings?.egress);
  if (cfg.mode === 'off') return { action: 'pass' };

  const decidido = (resultado) => {
    state.egress = { mode: cfg.mode, action: resultado.action, reason: resultado.reason || '', at: Date.now() };
    return resultado;
  };
  // `cfg` ya viene de normalizeEgress: el tope de 600 000 y el mínimo de 5 000
  // son los mismos que aplica la puerta, así que los dos esperan lo mismo.
  const espera = cfg.decisionTimeoutMs + MARGEN_EGRESS_MS;

  // Cuerpo ilegible: se declara el motivo y decide la puerta (`onUnreadable`).
  // Sin texto que juzgar, el respaldo local no tiene nada que mirar.
  if (unreadable) {
    try {
      const out = await bridge.request('egress', { unreadable, canRewrite: false }, espera);
      if (cfg.mode === 'enforce' && out?.action === 'block') return decidido({ action: 'block', reason: unreadable });
      return decidido({ action: 'pass', reason: unreadable });
    } catch (error) {
      bridge.event('error', { stage: 'egress', message: String(error?.message || error) });
      return decidido({ action: 'pass', reason: unreadable });
    }
  }

  // Se envían todas las partes de texto del mensaje, no sólo la que se puede
  // reponer: si el usuario pegó el dato en un segundo bloque, también se ve.
  const partes = Array.isArray(slots) && slots.length ? slots : [text];
  let out = null;
  let fallo = '';
  try {
    out = await bridge.request('egress', { slots: partes, canRewrite }, espera);
  } catch (error) {
    fallo = String(error?.message || error);
    bridge.event('error', { stage: 'egress', message: fallo });
  }

  if (!fallo && out && out.action === 'replace' && Array.isArray(out.slots) &&
      out.slots.length === partes.length && out.slots.every((x) => typeof x === 'string')) {
    return decidido({ action: 'replace', texts: out.slots });
  }
  // `observe` no interviene nunca: se deja constancia y el envío sigue igual.
  if (cfg.mode === 'observe') return decidido({ action: 'pass', reason: `observado:${out?.action || 'sin-puerta'}` });
  if (!fallo && out?.action === 'block') return decidido({ action: 'block', reason: out.reason || 'egress' });
  if (!fallo && (out?.action === 'pass' || out?.action === 'error')) {
    // `error` es un payload que la puerta no aceptó: se cae al detector local.
    if (out.action === 'pass') return decidido({ action: 'pass', reason: out.reason || '' });
  }

  const criticos = detectSensitive(String(text || '')).some((f) => f.severity === 'critical');
  return decidido(criticos ? { action: 'block', reason: 'fail-safe' } : { action: 'pass', reason: fallo ? 'sin-puerta' : 'sin-veredicto' });
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
  const method = methodOf(input, init);

  // ChatGPT sin cuenta envía el prompt y la respuesta por /conversation/updates.
  // Es un formulario DPU, no el JSON /conversation que procesa el filtro SSE.
  if (site.id === 'chatgpt' && isResponseRequest(site, url, method)) {
    const form = await chatGptDpuRequest(input, init);
    const gesture = envio.pendiente || (
      envio.porGesto && Date.now() - envio.porGesto.at <= VENTANA_ENLACE_MS ? envio.porGesto : null
    );
    const prompt = form.prompt ?? gesture?.tokenText ?? '';
    // En DPU el cuerpo se reescribe en el proceso principal, no acá: el guardián
    // sólo puede retener (`block`) y no se le ofrece redactar.
    const dpuGuard = await guardPrompt(prompt, { canRewrite: false, unreadable: form.prompt === null ? 'formulario' : null });
    if (dpuGuard.action === 'block') return { chat: true, send: true, blocked: true, promptText: prompt, url };
    return {
      chat: true,
      send: true,
      dpu: true,
      promptChars: prompt.length,
      promptText: prompt,
      textFound: form.prompt !== null || typeof gesture?.tokenText === 'string',
      promptFromRequest: form.prompt !== null,
      promptTokens: null,
      model: form.model,
      promptHash: prompt ? fingerprint(prompt) : '',
      url,
    };
  }

  // Capturar una respuesta no debe depender de que la mediación esté activa.
  // Primero reconocemos la petición de chat por su endpoint; después decidimos
  // por separado si podemos modificar el prompt. Si se sale aquí por
  // shouldMediate(), con la mediación apagada también se pierde la respuesta.
  if (!isChatRequest(site, url, method)) return { chat: false };
  const canMediate = shouldMediate(url, method);

  // El cuerpo viaja como string en `init`, o dentro de un objeto `Request`.
  let text = typeof init?.body === 'string' ? init.body : null;
  const desdeRequest =
    text === null && init?.body === undefined && typeof Request !== 'undefined' && input instanceof Request;
  if (desdeRequest) text = await input.clone().text();

  // Sin cuerpo legible sigue siendo una conversación: se captura la respuesta y
  // el envío se cuenta igual (lo confirma el gesto o la propia petición).
  const parsed = safeJson(text);
  if (!parsed) {
    // Sin cuerpo legible no hay texto que redactar; el guardián sólo puede
    // retener, y eso lo decide el ajuste `onUnreadable` de la puerta.
    const sinCuerpo = await guardPrompt('', { canRewrite: false, unreadable: 'stream-o-desconocido' });
    if (sinCuerpo.action === 'block') return { chat: true, send: true, blocked: true, promptText: '' };
    return { chat: true, send: true, reason: 'cuerpo-no-legible' };
  }

  // «Regenerar» y «continuar» son peticiones de conversación, pero no son un
  // mensaje nuevo del usuario: se captura la respuesta y no se cuenta mensaje.
  if (site.id === 'chatgpt' && typeof parsed.action === 'string' && parsed.action && parsed.action !== 'next') {
    return { chat: true, send: false, reason: `accion-${parsed.action}` };
  }

  const located = locateUserText(parsed, site);
  if (!located || !located.value) return { chat: true, send: true, reason: 'sin-texto' };

  const prompt = located.value;
  // Guardián de salida ANTES de la mediación: redactar aquí deja el texto
  // saneado como base y el motor registra exactamente lo que se va a enviar.
  // `canRewrite` sólo si sabemos volver a poner el texto en el cuerpo.
  // Con más de un bloque no se puede reponer el texto sin adivinar cuál es cuál:
  // no se ofrece redactar, para que el diálogo no prometa algo que después se
  // quedaría en retención (ver el `length !== 1` de abajo).
  const slots = guardSlots(parsed);
  const canRewrite = (site.body?.kind === 'chatgpt-messages' || site.body?.kind === 'claude-prompt') &&
    slots.length <= 1;
  // Mientras la puerta decide, el gesto del usuario no puede contar el envío:
  // el diálogo puede tardar más que ESPERA_PETICION_MS.
  const retenido = normalizeEgress(state.settings?.egress).mode === 'enforce' ? retenerGesto(prompt) : null;
  const ctx = { input, init, parsed, prompt, url, canMediate, canRewrite, slots, desdeRequest, liberar: () => {} };
  if (!retenido) return continuarPlan(ctx);
  // Todo lo que va del `retenerGesto` al final puede lanzar (JSON.stringify del
  // cuerpo, `new Request`, `patchUserText`…). El `finally` garantiza que el gesto
  // se libere UNA vez: con texto si el plan salió, sin texto si no.
  let liberado = false;
  const liberar = (saneado = null) => {
    if (liberado) return;
    liberado = true;
    liberarGesto(retenido, saneado);
  };
  try {
    const plan = await continuarPlan({ ...ctx, liberar });
    liberar(plan?.blocked ? null : plan?.promptText);
    return plan;
  } finally {
    // Cualquier excepción o retorno que no haya pasado por `liberar` descarta.
    liberar();
  }
}

/**
 * Resto de `planRequest` después del guardián.
 *
 * Vive aparte para que la liberación del gesto esté en UN `try/finally` y no en
 * cinco `return` repartidos. `liberar` llega desde arriba cuando hay gesto
 * retenido; si no hay, este camino no toca nada del gesto.
 */
async function continuarPlan({ input, init, parsed, prompt, url, canMediate, canRewrite, slots, desdeRequest, liberar }) {
  const guard = await guardPrompt(prompt, { canRewrite, slots });
  if (guard.action === 'block') return { chat: true, send: true, blocked: true, promptText: prompt, url };
  let outbound = prompt;
  if (guard.action === 'replace') {
    // Un solo bloque de texto: se repone en el cuerpo y se sigue. Con varios no
    // hay forma segura de saber cuál es cuál, así que se retiene (falla cerrado)
    // en vez de enviar alguno sin sanear.
    if (guard.texts.length !== 1) return { chat: true, send: true, blocked: true, promptText: prompt, url };
    outbound = guard.texts[0];
  }
  if (outbound !== prompt && !patchUserText(parsed, site, outbound)) {
    // No se pudo dejar el texto saneado en el cuerpo: no se envía el original.
    return { chat: true, send: true, blocked: true, promptText: prompt, url };
  }

  const base = {
    chat: true,
    send: true,
    promptChars: prompt.length,
    promptText: outbound,
    promptTokens: legacyProviderInputTokens(outbound),
    model: gptModelFromRequest(parsed),
    submissionId: userMessageIdentity(parsed),
    promptHash: fingerprint(outbound),
    url,
  };

  // La captura pasiva sigue activa aunque el usuario haya apagado la
  // intervención de NEXO. En ese caso se devuelve la petición original y se
  // conserva el envoltorio de la respuesta para contabilizarla/guardarla.
  if (!canMediate) return { ...base, plan: null, mediated: false };

  // El motor puede no contestar (arranque, IPC lento, error interno). Eso **no**
  // puede costar la captura: se sigue sin mediación, pero contando el mensaje y
  // envolviendo la respuesta.
  let report = null;
  try {
    report = await bridge.request('prepare', { prompt: outbound, url, site: site.id });
  } catch (error) {
    bridge.event('error', { stage: 'prepare', message: String(error?.message || error) });
  }
  // Si el guardián reescribió el cuerpo antes de la mediación, el plan base ya
  // lleva ese texto: la petición original no puede volver a salir con el dato.
  const planBase = outbound === prompt ? { input, init } : {
    input: desdeRequest ? new Request(input, { body: JSON.stringify(parsed) }) : input,
    init: desdeRequest ? init : { ...init, body: JSON.stringify(parsed) },
  };
  // El proceso principal retuvo el texto mediado (no pudo ocultar un crítico
  // de la memoria): se frena como un bloqueo, no se envía el original.
  if (report?.blocked) return { chat: true, send: true, blocked: true, promptText: outbound, url };
  if (!report?.text) return { ...base, plan: planBase };

  // El texto no cambió: no hay nada que reescribir, pero el envío se registra y
  // la respuesta se captura. Antes se descartaba todo y el turno no existía.
  if (report.text === outbound) return { ...base, plan: planBase, mediated: false };

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
const MAX_DPU_RESPONSE_BYTES = 12_000_000;

/**
 * ChatGPT anónimo aplica la respuesta como HTML DPU al documento. Se lee una
 * copia del stream (sin alterar el que consume el sitio) y, al llegar EOF, se
 * toma el último bloque de respuesta visible asociado al prompt actual.
 */
async function captureChatGptDpuResponse(response, capture = {}, generation = null) {
  let reader = null;
  let observer = null;
  let lastText = '';
  let finished = false;
  const prompt = capture.promptText || '';
  const { promptText: _promptText, ...metadata } = capture;

  const readVisible = () => {
    if (generation && state.response !== generation) return '';
    const snapshot = readChatGptDpuAnswer(document, prompt);
    const before = generation?.dpuBefore;
    // El observador no puede rescatar texto anterior ni mensajes de otro user.
    if (snapshot.user) {
      if (!snapshot.text) return '';
      if (before && snapshot.text === before.text && snapshot.user === before.user &&
          snapshot.assistant === before.assistant) return '';
      return snapshot.text;
    }
    if (before && snapshot.body === before.body) return '';
    return extractChatGptVisibleAnswer(document, prompt);
  };
  const publish = (candidate = readVisible()) => {
    if (generation && state.response !== generation) return;
    const text = String(candidate || '');
    if (!text || text === lastText || finished) return;
    lastText = text;
    bridge.event('stream-progress', {
      ...metadata,
      site: 'chatgpt',
      host: CONFIG.host || location.hostname,
      text,
      cumulative: true,
      deliveredChars: text.length,
    });
  };
  const finish = (outcome, interrupted = false) => {
    if (finished) return;
    publish();
    finished = true;
    observer?.disconnect?.();
    const text = lastText;
    if (text) {
      bridge.event('stream-end', {
        ...metadata,
        site: 'chatgpt',
        host: CONFIG.host || location.hostname,
        source: 'dpu-dom',
        outcome,
        stoppedByUser: Boolean(generation?.stoppedByUser),
        finished: !interrupted,
        interrupted,
        stopped: false,
        truncated: interrupted,
        deliveredChars: text.length,
        droppedChars: 0,
        chars: text.length,
        tokens: estimateTokens(text),
        clipped: text.length > MAX_CAPTURE_CHARS,
        text: text.slice(0, MAX_CAPTURE_CHARS),
        dropped: '',
      });
    } else {
      bridge.event('turn-result', {
        messageId: capture.messageId,
        site: 'chatgpt',
        host: CONFIG.host || location.hostname,
        outcome: generation?.stoppedByUser ? 'cancelled' : (outcome === 'completed' ? 'unknown' : outcome),
        stoppedByUser: Boolean(generation?.stoppedByUser),
      });
      bridge.event('error', {
        stage: 'dpu-capture',
        message: 'No se pudo extraer texto visible asociado al prompt de esta respuesta.',
      });
    }
  };

  try {
    // El observador se instala antes de devolver el Response al sitio. Así cada
    // actualización real del DOM alimenta el contador mientras ChatGPT escribe.
    if (typeof MutationObserver !== 'undefined' && document.body) {
      observer = new MutationObserver(() => publish());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (!response?.body || typeof response.clone !== 'function') {
      throw new Error('el cuerpo DPU no está disponible para lectura');
    }
    reader = response.clone().body?.getReader?.();
    if (!reader) throw new Error('no se pudo abrir una copia del stream DPU');

    let bytes = 0;
    let readError = null;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += Number(chunk.value?.byteLength) || 0;
        publish();
        if (bytes > MAX_DPU_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new Error(`respuesta DPU supera el límite de lectura (${bytes} bytes)`);
        }
      }
    } catch (error) {
      readError = error;
    }

    // Espera sólo a que el DOM refleje el contenido que ya llegó. Si el
    // transporte se abortó, conserva y cierra el parcial en vez de descartarlo.
    const answer = await waitForChatGptDpuAnswer(document, prompt, generation?.dpuBefore, {
      isCurrent: () => !generation || state.response === generation,
      timeout: readError ? 1200 : 5000,
    });
    publish(answer || readVisible());
    if (!lastText) {
      throw new Error(`no se pudo confirmar texto DPU del prompt actual (${bytes} bytes; ${readError?.message || 'sin respuesta nueva en el DOM'})`);
    }
    if (readError) {
      bridge.event('error', { stage: 'dpu-interrupted', message: String(readError?.message || readError).slice(0, 300) });
    }
    finish(generation?.stoppedByUser ? 'cancelled' : readError ? 'unknown' : 'completed', Boolean(readError));
  } catch (error) {
    publish(readVisible());
    finish(generation?.stoppedByUser ? 'cancelled' : 'unknown', true);
    bridge.event('error', {
      stage: 'dpu-capture',
      message: String(error?.message || error).slice(0, 300),
    });
  } finally {
    observer?.disconnect?.();
    if (state.response === generation) state.response = null;
    try { reader?.releaseLock?.(); } catch { /* stream ya cerrado */ }
  }
}

function wrapResponse(response, capture = {}, generation = null, promptText = '') {
  const mime = String(response?.headers?.get?.('content-type') || '');
  const jsonUpdates = site.id === 'chatgpt' &&
    isResponseRequest(site, capture.url || '', 'POST') &&
    /application[/]json/i.test(mime);
  if (!response || !response.body || (!looksLikeStream(response.headers) && !jsonUpdates)) return response;
  if (NULL_BODY_STATUS.has(response.status) || response.status < 200 || response.status > 599) return response;

  const formato = site.id === 'chatgpt' && /ndjson|jsonl|application[/]json/i.test(mime) ? 'ndjson'
    : site.id === 'chatgpt' && /text\/plain/i.test(mime) ? 'auto' : 'sse';
  // Diagnóstico: el formato elegido y cuánto se leyó. Sirve para saber si un
  // cierre sin texto viene de haber leído otro formato (`diag-stream-end`).
  // Sólo tipo/subtipo del MIME: sin parámetros ni otras cabeceras.
  const diagnostico = {
    formato,
    mime: String(mime.split(';')[0] || '').trim().toLowerCase().slice(0, 40),
    trozos: 0,
    bytes: 0,
  };
  const filter = createStreamFilter({
      format: formato,
      settings: state.settings,
      adapter: site.streamAdapter || null,
      deltaPaths: site.deltaPaths,
      language: state.language,
      host: CONFIG.host,
      onText: (info) => {
        bridge.event('stream-progress', {
          ...capture,
          site: site.id,
          host: CONFIG.host,
          text: info.text,
          deliveredChars: info.deliveredChars,
        });
      },
      onStop: (info) => {
        bridge.event('stream-stop', { ...capture, site: site.id, host: CONFIG.host, ...info });
      },
      onError: (info) => {
        // El adaptador no supo leer un evento. Se reenvió tal cual y la
        // conversación siguió; queda anotado para no diagnosticar a ciegas.
        bridge.event('error', { stage: `filtro:${info.stage}`, message: info.message });
      },
      onEnd: (info) => {
        const sendEnd = (text, source = null) => {
          const clipped = text.length > MAX_CAPTURE_CHARS;
          bridge.event('stream-end', {
            ...capture, site: site.id, host: CONFIG.host || location.hostname,
            ...(source ? { source } : {}),
            outcome: generation?.stoppedByUser ? 'cancelled' : info.outcome,
            stoppedByUser: Boolean(generation?.stoppedByUser),
            finished: !info.interrupted, interrupted: Boolean(info.interrupted),
            model: info.model || capture.model || '', stopped: info.stopped, code: info.code,
            truncated: info.truncated, truncationReason: info.truncationReason,
            deliveredChars: text.length, droppedChars: info.droppedChars,
            chars: text.length, tokens: estimateTokens(text), clipped,
            text: clipped ? text.slice(0, MAX_CAPTURE_CHARS) : text,
            dropped: String(info.dropped || '').slice(0, 600),
            // Números, no contenido: el proceso principal sólo los publica con
            // NEXO_DIAG=1. `diag` mantiene su contrato de números y etiquetas;
            // el resumen de formas —nombres de evento y de clave, tipos de `v`,
            // cuántos portadores— va al lado, no dentro.
            diag: { ...diagnostico },
            ...(info.estructura ? { estructura: info.estructura } : {}),
          });
        };
        const text = String(info.text || '');
        // No retrasar respuestas/contadores si la captura de red vino vacía.
        sendEnd(text);
        if (site.id === 'chatgpt' && !text.trim() && !info.stopped) {
          // Complemento recibido del remoto: sólo si la red no aportó texto.
          // Reutiliza la misma espera, la identidad y la recuperación CDP/main.
          void waitForChatGptDpuAnswer(document, promptText, generation?.dpuBefore, {
            requireRole: true, isCurrent: () => !generation || state.response === generation,
          }).then((answer) => {
            if (answer) sendEnd(answer, 'dom-recovery');
            else bridge.event('error', { stage: 'chatgpt-output-capture',
              message: 'El stream terminó sin texto y no se pudo confirmar una respuesta nueva del prompt actual en el DOM.' });
          }).catch((error) => bridge.event('error', { stage: 'chatgpt-output-capture', message: String(error?.message || error) }))
            .finally(() => { if (state.response === generation) state.response = null; });
        } else if (state.response === generation) state.response = null;
      },
    });
  const contador = new TransformStream({
    transform(chunk, controller) {
      diagnostico.trozos += 1;
      diagnostico.bytes += chunk?.byteLength ?? chunk?.length ?? 0;
      controller.enqueue(chunk);
    },
  });
  response.body.pipeThrough(contador).pipeTo(filter.writable).catch((error) => {
    filter.finishInterrupted();
    // El mensaje exacto del rechazo viaja aparte: `message` mezcla el motivo
    // con el valor (`String(undefined)`), y el proceso principal necesita
    // distinguir «cancelación sin motivo» de un error de verdad.
    const motivo = String(error?.message || '');
    const tipo = String(error?.name || '');
    bridge.event('error', { stage: 'stream-interrupted', message: String(error?.message || error),
      ...(motivo || tipo ? { motivo: motivo.slice(0, 200), errorName: tipo.slice(0, 40) }
        : { sinMotivo: true }) });
  });
  const filtered = filter.readable;

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
    // Si sólo está activa la repetición, leer el DOM no habilita captura de red
    // ni mediación. Se devuelve el fetch original sin inspeccionar el cuerpo.
    const egressActivo = normalizeEgress(state.settings?.egress).mode !== 'off';
    if (site.id === 'chatgpt' && !state.enabled && state.settings.memory?.enabled === false && !egressActivo) return nativeFetch(input, init);
    const url = absoluteUrl(urlOf(input));
    const method = methodOf(input, init);

    // 1) Preparar: no envía nada. Cualquier fallo → petición original.
    let prepared = { chat: false };
    try {
      prepared = await planRequest(input, init);
    } catch (error) {
      bridge.event('error', { stage: 'prepare', message: String(error?.message || error) });
      // Última red: si el plan falló con datos críticos dentro, no sale igual.
      prepared = await planFallido(input, init);
    }

    // 2) El guardián de salida retuvo el mensaje: no se envía y se simula una
    //    cancelación de red, que es el camino que la página ya sabe manejar
    //    («Detener»). Tampoco se anota como envío: no llegó a salir.
    if (prepared.blocked) {
      // Si retuvo la puerta, ya lo contó ella con su propio diagnóstico
      // (`egress-block`, main/egressGate.js:30). Repetirlo acá daba dos entradas
      // en el panel y la segunda con un título peor («Fallo de la mediación»).
      if (prepared.red) {
        bridge.event('error', {
          stage: 'egress-fail-safe',
          message: 'planRequest falló con datos críticos; envío retenido',
        });
      }
      throw new DOMException('NEXO retuvo el envío', 'AbortError');
    }

    // Un envío se anota siempre: con o sin mediación, y aunque no se pueda leer
    // el texto del cuerpo. De acá sale el contador de mensajes del usuario y el
    // identificador con el que se empareja su respuesta.
    let messageId = null;
    if (prepared.chat && prepared.send !== false) {
      const gesto = tomarEnvioPendiente(prepared);
      const chars = prepared.promptChars ?? gesto?.chars ?? 0;
      const countedGesture = gesto ? null : yaContadoPorGesto(prepared);
      // El gesto ya se anunció (venció el temporizador antes de la decisión):
      // si el guardián retuvo el envío, no hay nada que reanunciar y el turno
      // hay que cerrarlo, porque el aviso ya salió.
      if (prepared.blocked && countedGesture) {
        bridge.event('turn-result', { messageId: countedGesture, host: CONFIG.host || location.hostname,
          site: site.id, outcome: 'cancelled', stoppedByUser: false, blockedByGuard: true });
        throw new DOMException('NEXO retuvo el envío', 'AbortError');
      }
      if (countedGesture) {
        // Ya lo contó el gesto: la respuesta tiene que usar su identificador.
        messageId = countedGesture;
        anunciarEnvio({messageId, source:'request', chars, tokenText:prepared.promptText ?? '',
          model:prepared.model || '', submissionId:prepared.submissionId || '', promptHash:prepared.promptHash || '', textFound:prepared.textFound ?? typeof prepared.promptText === 'string', url});
      } else {
        messageId = anunciarEnvio({
          messageId: gesto?.id,
          source: 'request',
          mediated: prepared.mediated,
          chars,
          tokenText: prepared.promptText ?? gesto?.tokenText ?? '',
          tokens: prepared.promptTokens ?? gesto?.tokens ?? null,
          model: prepared.model || '',
          submissionId: prepared.submissionId || '',
          promptHash: prepared.promptHash || gesto?.promptHash || '',
          textFound: prepared.textFound ?? typeof prepared.promptText === 'string',
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
    const generation = prepared.chat ? { messageId, stoppedByUser: false } : null;
    if (generation) {
      state.response = generation;
      if (site.id === 'chatgpt') generation.dpuBefore = readChatGptDpuAnswer(document, prepared.promptText || '');
      if (prepared.send === false) bridge.event('turn-result', { phase: 'started', messageId, site: site.id,
        host: CONFIG.host || location.hostname, model: prepared.model || '' });
    }
    const reportResult = (outcome) => bridge.request('turn-result', { messageId, host: CONFIG.host || location.hostname,
      site: site.id, url, outcome, stoppedByUser: Boolean(generation?.stoppedByUser) });
    state.active += 1;
    let response;
    try {
      response = await nativeFetch(target.input, target.init);
    } catch (error) {
      if (generation) {
        await reportResult(generation.stoppedByUser ? 'cancelled' : error?.name === 'AbortError' ? 'unknown' : 'failed')
          .catch((reportError) => bridge.event('error', { stage: 'turn-result', message: String(reportError?.message || reportError) }));
        if (state.response === generation) state.response = null;
      }
      throw error;
    } finally {
      state.active -= 1;
    }

    // Un rechazo del proveedor (403, 429…) se informa con su código: es el dato
    // que explica «no se pudo conectar» sin abrir las herramientas del sitio.
    if (response.ok === false) {
      if (generation) {
        await reportResult('failed')
          .catch((reportError) => bridge.event('error', { stage: 'turn-result', message: String(reportError?.message || reportError) }));
        if (state.response === generation) state.response = null;
      }
      bridge.event('error', {
        stage: 'http',
        message: `${response.status} ${method} ${url.slice(0, 160)}`,
      });
    }

    // 3) Envolver la respuesta. Sólo se captura lo que es una conversación: una
    //    página cualquiera no se toca. Si el filtro fallara, se entrega la
    //    original sin reenviar nada (el cuerpo todavía no se consumió).
    if (!prepared.chat) return response;
    const capture = {
      messageId,
      conversationId: conversationIdOf(),
      mediated: Boolean(prepared.mediated),
      promptChars: prepared.promptChars || 0,
      model: prepared.model || '',
      url,
    };
    const mime = String(response.headers?.get?.('content-type') || '');
    // La ruta updates también transporta SSE/NDJSON: decide el MIME recibido,
    // no la hipótesis usada para leer el formulario de envío.
    if (isChatGptDpuMime(mime)) {
      if (generation && !generation.dpuBefore) generation.dpuBefore = readChatGptDpuAnswer(document, prepared.promptText || '');
      // No se reemplaza el Response: Chromium y ChatGPT deben aplicar los DPU
      // originales al DOM sin que Nexo altere ni consuma el flujo visible.
      void captureChatGptDpuResponse(response, { ...capture, promptText: prepared.promptText || '' }, generation);
      return response;
    }
    try {
      return wrapResponse(response, capture, generation, prepared.promptText || '');
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
      if (site.id === 'chatgpt' && sitioActivo() && event.isTrusted && (state.response || state.currentMessageId) &&
        (site.stopButton || []).some((selector) => {
          try { return Boolean(event.target?.closest?.(selector)); } catch { return false; }
        })) {
        if (state.response) state.response.stoppedByUser = true;
        bridge.event('turn-result', { messageId: state.response?.messageId || state.currentMessageId, host: CONFIG.host || location.hostname,
          site: site.id, outcome: 'cancelled', stoppedByUser: true });
      }
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

// El único lector de conversación vive en el preload aislado (no en la web).

// Se expone un objeto de depuración para la consola del navegador.
window.__nexo = {
  site,
  state,
  setComposerText,
  submitContinuation,
  getPath,
  conversationReader: () => diagnoseChatGptReader(document),
};

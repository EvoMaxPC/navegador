/**
 * Lectura de lo que entrega el protocolo CDP.
 *
 * El enganche de `fetch` ve las peticiones y los streams SSE que salen de la
 * página. Quedan dos canales fuera: los **frames de WebSocket** y las
 * **respuestas JSON** completas (sin streaming). Este módulo convierte esos dos
 * canales en el mismo material que ya sabe procesar el motor: texto de una
 * respuesta y el mensaje del usuario que la provocó.
 *
 * Es isomorfo y no sabe nada de Electron: recibe objetos ya parseados. El
 * transporte (adjuntarse al depurador, pedir cuerpos) vive en `src/main/cdp.js`.
 *
 * Nada de lo que se lee acá se puede reescribir: para CDP el tráfico ya salió o
 * ya llegó. Por eso todo lo capturado se marca como **observado**, nunca como
 * mediado.
 */

import { extractDeltas } from './sse.js';
import { createAdapter } from './streamAdapters.js';
import { detectSite } from './sites.js';

/** Tope de texto por captura: una respuesta de chat no llega ni cerca. */
export const MAX_CAPTURE_CHARS = 1_500_000;

/** Host de una URL, sin `www.` ni puerto. Cadena vacía si no es válida. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * ¿Es un sitio que Nexo conoce? Sólo se observan los perfiles declarados en
 * `sites.js`: abrir el depurador en cada pestaña costaría memoria y eventos de
 * red en sitios donde no hay nada que mirar.
 */
export function isAiHost(host) {
  const clean = String(host || '').toLowerCase();
  if (!clean) return false;
  return detectSite(clean).id !== 'generic';
}

/** ¿El tipo MIME corresponde a un cuerpo JSON completo? */
export function isJsonMime(mimeType = '') {
  const value = String(mimeType).toLowerCase().split(';')[0].trim();
  if (!value) return false;
  return value === 'application/json' || value === 'text/json' || value.endsWith('+json');
}

/**
 * ¿El cuerpo es un stream? Se excluye a propósito: los SSE ya los intercepta la
 * capa de la página, y procesarlos también acá contaría el mismo turno dos veces.
 */
export function isStreamMime(mimeType = '') {
  return /event-stream|ndjson|jsonl|x-www-form-urlencoded/i.test(String(mimeType || ''));
}

const TERMINAL = /stop|end|done|complete|finish|closed|conversaci[oó]n_finalizada/i;

/** Señal de cierre que trae un evento, si la trae. */
export function terminalOf(json) {
  const candidates = [
    json?.type,
    json?.event,
    json?.status,
    json?.choices?.[0]?.finish_reason,
    json?.stop_reason,
  ];
  const found = candidates.find((value) => typeof value === 'string' && TERMINAL.test(value));
  return found || null;
}

/** Rol del autor del evento, en cualquiera de las formas habituales. */
export function roleOf(json) {
  const role =
    json?.role ??
    json?.author?.role ??
    json?.message?.author?.role ??
    json?.message?.role ??
    json?.choices?.[0]?.message?.role ??
    json?.choices?.[0]?.delta?.role;
  return typeof role === 'string' ? role.toLowerCase() : null;
}

/**
 * Texto del usuario dentro de un frame saliente.
 *
 * Deliberadamente conservador: un falso positivo ensuciaría el historial y EVO
 * MEMORY con texto que no escribió nadie. Sólo se aceptan las formas en las que
 * el mensaje del usuario es inequívoco.
 */
export function promptOf(json) {
  if (!json || typeof json !== 'object') return null;

  if (Array.isArray(json.messages)) {
    for (let i = json.messages.length - 1; i >= 0; i -= 1) {
      const message = json.messages[i];
      const role = String(message?.role ?? message?.author?.role ?? '').toLowerCase();
      if (role !== 'user') continue;
      const parts = message?.content?.parts ?? message?.parts;
      if (Array.isArray(parts)) {
        for (let j = parts.length - 1; j >= 0; j -= 1) {
          if (typeof parts[j] === 'string' && parts[j].trim()) return parts[j];
        }
      }
      if (typeof message?.content === 'string' && message.content.trim()) return message.content;
      if (typeof message?.text === 'string' && message.text.trim()) return message.text;
      break;
    }
  }

  if (typeof json.prompt === 'string' && json.prompt.trim()) return json.prompt;

  // Formas planas: sólo con una marca explícita de «esto es del usuario».
  const kind = `${json.type || ''} ${json.event || ''}`.toLowerCase();
  if (/user|prompt|input|question/.test(kind)) {
    for (const key of ['content', 'text', 'message', 'query']) {
      const value = json[key];
      if (typeof value === 'string' && value.trim().length >= 2) return value;
    }
  }
  return null;
}

/** ¿Es un evento del protocolo de parches de ChatGPT? */
function isPatchShaped(json) {
  return typeof json?.p === 'string' || json?.o === 'patch';
}

/** Mitad común de dos textos: sirve para pasar de acumulado a lo nuevo. */
export function commonPrefix(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return a.slice(0, i);
}

/**
 * Acumulador de una respuesta observada.
 *
 * Reutiliza los mismos adaptadores que el filtro SSE: si el sitio es ChatGPT o
 * Claude, un frame de WebSocket con su forma se lee igual que un evento del
 * stream. Para el resto se usa la extracción genérica con una regla de
 * deduplicación por ruta: si un frame repite en prefijo lo ya visto (protocolo
 * acumulado), sólo se agrega lo nuevo.
 */
export class CdpCapture {
  /**
   * @param {{
   *   site?: object, host?: string, conversationId?: string, url?: string,
   *   source?: 'websocket'|'json'
   * }} [opts]
   */
  constructor(opts = {}) {
    this.site = opts.site || detectSite(opts.host || '');
    this.host = opts.host || this.site.host || '';
    this.conversationId = opts.conversationId || '';
    this.url = opts.url || '';
    this.source = opts.source || 'websocket';
    /** Un adaptador por captura: guarda el estado de los protocolos acumulados. */
    this.adapter = this.site.streamAdapter ? createAdapter(this.site.streamAdapter) : null;
    this.seq = 0;
    this.reset();
  }

  /** Vacía el texto acumulado, conservando la identidad de la conversación. */
  reset() {
    this.parts = [];
    this.length = 0;
    this.frames = 0;
    /** Último texto visto por ruta: base de la deduplicación del genérico. */
    this.seen = new Map();
    this.promptText = null;
    this.controls = [];
    this.lastTerminal = null;
  }

  get text() {
    return this.parts.join('');
  }

  get empty() {
    return this.length === 0;
  }

  /** Marca el mensaje del usuario que originó la respuesta observada. */
  prompt(text) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (value) this.promptText = value;
    return this.promptText;
  }

  /**
   * Incorpora un evento ya parseado.
   * @returns {{added: string, terminal: string|null}}
   */
  add(json) {
    if (!json || typeof json !== 'object') return { added: '', terminal: null };
    if (roleOf(json) === 'user') return { added: '', terminal: null };

    let pieces = [];
    let terminal = null;

    if (this.adapter) {
      const plan = this.adapter.read(json);
      pieces = (plan.segments || []).map((segment) => segment.newText).filter(Boolean);
      terminal = plan.terminal ? String(plan.terminal) : null;
      // Un JSON que el adaptador del sitio no reconoce —cuerpo de otra forma,
      // respuesta no-streaming de otro proveedor— se lee con la extracción
      // genérica. Se exceptúa el protocolo de parches propio (`p`/`o`), donde un
      // `v` de control como `finished_successfully` no es texto.
      if (!pieces.length && !isPatchShaped(json)) pieces = this.#genericPieces(json);
      terminal = terminal || terminalOf(json);
    } else {
      pieces = this.#genericPieces(json);
      terminal = terminalOf(json);
    }

    const added = pieces.join('');
    if (added) {
      if (this.length + added.length > MAX_CAPTURE_CHARS) {
        // Fuera de escala: mejor no capturar nada que guardar media respuesta.
        return { added: '', terminal: null, overflow: true };
      }
      this.parts.push(added);
      this.length += added.length;
      this.frames += 1;
    }
    if (terminal) {
      this.controls.push(terminal);
      this.lastTerminal = terminal;
    }
    return { added, terminal };
  }

  /**
   * Extracción genérica con deduplicación por ruta: si un frame repite como
   * prefijo lo ya visto (protocolo acumulado), sólo se agrega la parte nueva.
   */
  #genericPieces(json) {
    const pieces = [];
    const { texts } = extractDeltas(json, { hintPaths: this.site.deltaPaths || null });
    for (const item of texts) {
      const previous = this.seen.get(item.path) || '';
      let piece = item.text;
      if (previous) {
        if (piece === previous) piece = '';
        else if (piece.length > previous.length && piece.startsWith(previous)) {
          piece = piece.slice(previous.length);
        }
      }
      this.seen.set(item.path, item.text);
      if (piece) pieces.push(piece);
    }
    return pieces;
  }

  /**
   * Cierra el turno actual y devuelve lo observado.
   * @returns {null|{text: string, prompt: string|null, frames: number, controls: string[], conversationId: string, source: string, url: string, host: string, site: string, seq: number}}
   */
  take() {
    if (this.empty) {
      this.reset();
      return null;
    }
    this.seq += 1;
    const capture = {
      text: this.text,
      prompt: this.promptText,
      frames: this.frames,
      controls: this.controls.slice(),
      conversationId: this.conversationId,
      source: this.source,
      url: this.url,
      host: this.host,
      site: this.site.id,
      seq: this.seq,
    };
    this.reset();
    return capture;
  }
}

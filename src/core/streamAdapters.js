/**
 * Adaptadores de stream por proveedor.
 *
 * El filtro SSE sabe leer el protocolo de cable (eventos, líneas `data:`), pero
 * no sabe qué significa cada JSON: eso depende de cada sitio. Acá vive ese
 * conocimiento, separado del transporte y en un único lugar por proveedor.
 *
 * Cada adaptador tiene que responder tres preguntas:
 *
 *   · `read(json)`   — ¿este evento trae texto nuevo? ¿cierra algo?
 *   · `write(...)`   — ¿dónde se escribe el texto que sí se entrega?
 *   · `pending(...)` — si queda texto retenido al cerrar, ¿con qué evento se
 *                      entrega para que llegue ANTES del cierre?
 *
 * Hay dos formas de mandar texto y las dos existen en producción:
 *
 *   · **append** (delta): cada evento trae sólo lo nuevo.
 *     OpenAI: `choices[0].delta.content`; Claude: `delta.text`;
 *     ChatGPT nuevo: `{"p":"/message/content/parts/0","o":"append","v":"…"}`.
 *
 *   · **acumulado**: cada evento trae TODO el texto hasta ese momento.
 *     ChatGPT viejo: `message.content.parts[0]`; Claude viejo: `completion`.
 *     Acá no alcanza con entregar lo nuevo: hay que escribir el texto ya
 *     entregado (que es lo que el cliente va a mostrar), no el recibido, o el
 *     búfer de retención se vería como texto que se borra y reaparece.
 */

import { extractDeltas, setPath } from './sse.js';

/* ------------------------------------------------------------------ */
/* utilidades                                                          */
/* ------------------------------------------------------------------ */

/** JSON Pointer (`/message/content/parts/0`) → ruta con puntos. */
function pointerToPath(pointer) {
  return String(pointer || '')
    .replace(/^\//, '')
    .replace(/\//g, '.');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Copia profunda barata de un evento ya parseado (para fabricar el de cierre). */
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* adaptador genérico                                                  */
/* ------------------------------------------------------------------ */

/**
 * Sin adaptador específico: se buscan claves de delta conocidas en cualquier
 * parte del objeto. Es lo que usa la mayoría de los sitios y los modelos
 * locales (que hablan el dialecto de OpenAI).
 */
function genericAdapter({ deltaPaths = null } = {}) {
  const state = { lastJson: null, lastPaths: [], lastEvent: null };

  return {
    name: 'generic',
    state,

    read(json) {
      const { texts } = extractDeltas(json, { hintPaths: deltaPaths });
      return {
        segments: texts.map((item) => ({ path: item.path, newText: item.text, cumulative: false })),
        terminal: null,
      };
    },

    write(json, segments, values, eventName) {
      segments.forEach((segment, i) => setPath(json, segment.path, values[i]));
      state.lastJson = json;
      state.lastPaths = segments.map((segment) => segment.path);
      // Nombre SSE del último evento con texto: el sintético de cierre tiene
      // que salir con el mismo nombre o el cliente lo ignora.
      if (eventName) state.lastEvent = eventName;
    },

    pending({ text }) {
      const base = state.lastJson && cloneJson(state.lastJson);
      if (!base || !state.lastPaths.length) return null;
      let first = true;
      for (const path of state.lastPaths) {
        setPath(base, path, first ? text : '');
        first = false;
      }
      return { event: state.lastEvent, json: base };
    },
  };
}

/* ------------------------------------------------------------------ */
/* adaptador de ChatGPT                                                */
/* ------------------------------------------------------------------ */

const PARTS_PATH = /^\/message\/content\/parts\/(\d+)$/;
const TEXT_CONTENT_TYPES = new Set(['text', 'multimodal_text']);
/** Estados de `/message/status` que significan «el mensaje terminó». */
const CHATGPT_TERMINAL_STATUS = new Set([
  'finished_successfully',
  'finished_partial_completion',
  'message_stream_complete',
]);

/**
 * ChatGPT usa dos protocolos según la época y el tipo de cuenta:
 *
 *  1. **parches** (el actual): eventos `{"p": ruta, "o": "append"|"replace", "v": valor}`
 *     y `{"v": "…"}` como continuación de la ruta anterior. Las rutas son JSON
 *     Pointer y el texto vive en `/message/content/parts/N`.
 *  2. **acumulado** (legacy/anon): `{"message": {author, content: {parts: [texto completo]}}}`.
 *
 * Además manda el eco del mensaje del usuario (`author.role === "user"`), estados
 * y eventos sin texto (`"v1"`, `title_generation`): nada de eso se toca.
 */
function chatgptAdapter() {
  const state = {
    /** `null` = todavía no se vio de quién es el mensaje abierto. */
    assistantText: null,
    /** ¿La última ruta apuntada con `p` es texto del asistente? */
    pathIsText: false,
    lastTextPath: '/message/content/parts/0',
    lastEvent: null,
    /** Longitud ya recibida por ruta acumulada (`o: replace` / legacy). */
    received: new Map(),
    /** Mensaje acumulado vigente, para fabricar el evento de cierre. */
    lastMessage: null,
    /** Ruta acumulada vigente. */
    cumulativePath: null,
  };

  const segment = (path, text, cumulative = false) => ({ path, newText: text, cumulative });

  /**
   * Texto nuevo de un tramo acumulado: el evento trae el texto completo.
   *
   * `clave` identifica el tramo para recordar cuánto se recibió (un puntero o
   * una ruta); `destino` es dónde se escribe en el evento (`v` en el protocolo
   * de parches, la ruta del mensaje en el acumulado).
   */
  function cumulativeSegment(clave, destino, full) {
    const prev = state.received.get(clave) || 0;
    const base = typeof full === 'string' ? full : '';
    const nuevo = base.length >= prev ? base.slice(prev) : base;
    state.received.set(clave, base.length);
    return nuevo ? segment(destino, nuevo, true) : null;
  }

  function read(json) {
    const segments = [];
    let terminal = null;
    if (!isPlainObject(json)) return { segments, terminal };

    // --- protocolo acumulado ------------------------------------------------
    const message = json.message;
    if (isPlainObject(message) && isPlainObject(message.content)) {
      const role = message.author?.role;
      if (role === 'user') {
        // Eco del mensaje del usuario: pasa sin tocarse y cierra el turno del asistente.
        state.assistantText = false;
        state.lastMessage = null;
        return { segments, terminal };
      }
      if (role === 'assistant') state.assistantText = true;
      const type = message.content.content_type;
      const parts = message.content.parts;
      if (Array.isArray(parts) && state.assistantText !== false && (!type || TEXT_CONTENT_TYPES.has(type))) {
        parts.forEach((part, i) => {
          if (typeof part !== 'string' || !part) return;
          const path = `message.content.parts.${i}`;
          const added = cumulativeSegment(path, path, part);
          if (added) segments.push(added);
          state.lastTextPath = `/message/content/parts/${i}`;
          state.cumulativePath = path;
        });
        state.lastMessage = message;
        state.lastEvent = state.lastEvent || 'message';
      }
      return { segments, terminal };
    }

    // --- protocolo de parches ----------------------------------------------
    const ops = [];
    if (json.o === 'patch' && Array.isArray(json.v)) {
      for (const item of json.v) if (isPlainObject(item)) ops.push(item);
    } else if (typeof json.p === 'string') {
      ops.push(json);
    } else if (typeof json.v === 'string' && state.pathIsText) {
      // Continuación de la ruta anterior.
      ops.push({ p: state.lastTextPath, o: 'append', v: json.v, viaContinuation: true });
    }

    for (const op of ops) {
      const pointer = typeof op.p === 'string' ? op.p : null;
      const value = op.v;

      if (pointer === '/message' && isPlainObject(value)) {
        state.assistantText = value.author?.role === 'assistant' ? true : value.author?.role === 'user' ? false : null;
        continue;
      }
      if (pointer === '/message/author/role' && typeof value === 'string') {
        state.assistantText = value === 'assistant';
        continue;
      }
      if (pointer === '/message/content/content_type' && typeof value === 'string') {
        continue;
      }
      if (pointer === '/message/status' && typeof value === 'string') {
        if (CHATGPT_TERMINAL_STATUS.has(value)) terminal = 'message';
        continue;
      }

      if (pointer && PARTS_PATH.test(pointer)) {
        state.pathIsText = state.assistantText !== false;
        if (state.pathIsText) state.lastTextPath = pointer;
        if (typeof value !== 'string' || !value) continue;
        // En el protocolo de parches el texto viaja en `v`, no en la ruta: la
        // ruta dice dónde lo aplica el cliente. Se reescribe `v` y nada más.
        if (op.o === 'replace') {
          const path = `message.content.parts.${PARTS_PATH.exec(pointer)[1]}`;
          const added = cumulativeSegment(pointer, 'v', value);
          state.cumulativePath = path;
          if (added) segments.push(added);
        } else if (op.o === 'append' || op.viaContinuation) {
          segments.push(segment('v', value));
        }
        continue;
      }

      if (pointer && pointer.startsWith('/message/content/parts')) {
        // Escritura en la lista de parts que no es un texto concreto: no se toca.
        state.pathIsText = false;
        continue;
      }
    }

    if (json.type === 'message_stream_complete' || json.type === 'title_generation') terminal = 'message';
    return { segments, terminal };
  }

  function write(json, segments, values, eventName) {
    segments.forEach((item, i) => {
      setPath(json, item.path, values[i]);
      if (item.cumulative) state.cumulativePath = item.path;
    });
    if (segments.some((item) => item.path.startsWith('message.'))) state.lastEvent = state.lastEvent || 'message';
    else if (eventName && !state.lastEvent) state.lastEvent = eventName;
  }

  function pending({ text, delivered }) {
    // Acumulado: el cliente reemplaza, así que hay que reenviar el texto completo
    // entregado, no sólo lo retenido.
    if (state.lastMessage && state.cumulativePath) {
      const base = cloneJson(state.lastMessage);
      if (!base) return null;
      // `message.content.parts.0` → `['content', 'parts', 0]` sobre el mensaje.
      const rest = state.cumulativePath.split('.').slice(1);
      if (rest[1] === 'parts') rest[2] = Number(rest[2]);
      setPath(base, rest, delivered);
      return { event: state.lastEvent, json: { message: base } };
    }
    return {
      event: state.lastEvent,
      json: { p: state.lastTextPath, o: 'append', v: text },
    };
  }

  return { name: 'chatgpt', state, read, write, pending };
}

/* ------------------------------------------------------------------ */
/* adaptador de Claude                                                 */
/* ------------------------------------------------------------------ */

function claudeAdapter() {
  const state = {
    lastIndex: 0,
    lastEvent: 'content_block_delta',
    lastJson: null,
    /** Longitud ya recibida del formato antiguo (`completion` acumulado). */
    received: 0,
    /** `completion` (antiguo) o `delta` (actual). */
    mode: 'delta',
  };

  return {
    name: 'claude',
    state,

    read(json) {
      const segments = [];
      let terminal = null;
      if (!isPlainObject(json)) return { segments, terminal };

      // Formato antiguo: `{"completion": "texto completo hasta ahora", "stop_reason": …}`
      if (typeof json.completion === 'string') {
        state.mode = 'completion';
        const full = json.completion;
        const nuevo = full.length >= state.received ? full.slice(state.received) : full;
        state.received = full.length;
        if (nuevo) segments.push({ path: 'completion', newText: nuevo, cumulative: true });
        if (json.stop_reason) terminal = 'message';
        return { segments, terminal };
      }

      const delta = json.delta;
      if (isPlainObject(delta) && typeof delta.text === 'string' && delta.text) {
        state.mode = 'delta';
        state.lastIndex = Number.isInteger(json.index) ? json.index : state.lastIndex;
        state.lastEvent = 'content_block_delta';
        segments.push({ path: 'delta.text', newText: delta.text });
      }

      // Cierres: el texto tiene que haber salido antes que ellos.
      const type = String(json.type || '');
      if (type === 'content_block_stop') terminal = 'block';
      else if (type === 'message_stop') terminal = 'message';
      else if (type === 'message_delta' && json.delta?.stop_reason) terminal = 'message';
      return { segments, terminal };
    },

    write(json, segments, values) {
      segments.forEach((item, i) => setPath(json, item.path, values[i]));
      state.lastJson = json;
    },

    pending({ text, delivered }) {
      if (state.mode === 'completion') return { event: state.lastEvent, json: { completion: delivered } };
      const base = state.lastJson ? cloneJson(state.lastJson) : { type: 'content_block_delta', delta: {} };
      if (!base) return null;
      base.type = 'content_block_delta';
      base.index = state.lastIndex;
      base.delta = { type: 'text_delta', text };
      return { event: 'content_block_delta', json: base };
    },
  };
}

/* ------------------------------------------------------------------ */
/* fábrica                                                             */
/* ------------------------------------------------------------------ */

/**
 * Devuelve el adaptador para un proveedor.
 * @param {string|null} name `chatgpt`, `claude` o cualquier otra cosa (genérico)
 * @param {{deltaPaths?: string[]|null}} [opts]
 */
export function createAdapter(name, opts = {}) {
  if (name === 'chatgpt') return chatgptAdapter();
  if (name === 'claude') return claudeAdapter();
  return genericAdapter(opts);
}

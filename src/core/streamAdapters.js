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
/** Etiquetas publicables: minúsculas y `_`, igual que en el diagnóstico del filtro. */
const LISTA_BLANCA = /^[a-z_]{1,24}$/;
const TEXT_CONTENT_TYPES = new Set(['text', 'multimodal_text']);
/** Estados de `/message/status` que significan «el mensaje terminó». */
const CHATGPT_TERMINAL_STATUS = new Set([
  'finished_successfully',
  'finished_partial_completion',
  'message_stream_complete',
]);

/**
 * ChatGPT usa tres protocolos según la época y el tipo de cuenta:
 *
 *  1. **parches** (el actual): eventos `{"p": ruta, "o": "append"|"replace", "v": valor}`
 *     y `{"v": "…"}` como continuación de la ruta anterior. Las rutas son JSON
 *     Pointer y el texto vive en `/message/content/parts/N`.
 *  2. **acumulado** (legacy): `{"message": {author, content: {parts: [texto completo]}}}`.
 *  3. **NDJSON** sin cuenta: content/markdown con mode/revision y controles.
 * Los registros SSE multiplexados usan `c` para seleccionar el mensaje: sus
 * fragmentos ocultos y el mensaje fusionado visible no se suman dos veces.
 *
 * Además manda el eco del mensaje del usuario (`author.role === "user"`), estados
 * y eventos sin texto (`"v1"`, `title_generation`): nada de eso se toca.
 */
function chatgptAdapter() {
  const channels = new Map();
  let channel = 'legacy';
  let active;
  let lastTextChannel;
  let model = '';
  return {
    name: 'chatgpt',
    read(json) {
      if (json && json.c !== undefined) channel = json.c;
      if (!channels.has(channel)) channels.set(channel, chatgptChannelAdapter());
      active = channels.get(channel);
      const plan = active.read(json);
      if (plan.model) model = plan.model;
      if (plan.segments.length) lastTextChannel = channel;
      return plan;
    },
    write(...args) { return active.write(...args); },
    pending(info) {
      const synth = channels.get(lastTextChannel)?.pending(info);
      if (synth && lastTextChannel !== 'legacy') synth.json.c = lastTextChannel;
      return synth;
    },
    snapshot() {
      const parts = [...channels.values()].map((item) => item.snapshot()).filter((text) => text !== null);
      return parts.length ? parts.join('') : null;
    },
    model: () => model,
  };
}

function chatgptChannelAdapter() {
  const state = {
    /** `null` = todavía no se vio de quién es el mensaje abierto. */
    assistantText: null,
    /** ¿La última ruta apuntada con `p` es texto del asistente? */
    pathIsText: false,
    lastTextPath: '/message/content/parts/0',
    lastEvent: null,
    /** Mensaje acumulado vigente, para fabricar el evento de cierre. */
    lastMessage: null,
    /** Ruta acumulada vigente. */
    cumulativePath: null,
  };

  const segment = (path, text, cumulative = false) => ({ path, newText: text, cumulative });

  // Snapshot por mensaje/parte: permite reconstruir replace/append sin sumar
  // dos veces revisiones ni fragmentos ocultos de la misma respuesta.
  const texts = new Map();
  const revisions = new Map();
  let messageId = '';
  let pointer = '';
  let operation = 'append';
  let model = '';
  let captured = false;
  // Marca de oculto por mensaje, con el valor VIGENTE: ChatGPT abre el mensaje
  // con `is_visually_hidden_from_conversation: true` y la quita con un `remove`
  // en el primer evento de texto. Decidir al abrir descartaba la respuesta.
  // Sin entrada = no vista; `true` = oculta; `false` = la marca ya no está.
  const ocultos = new Map();
  // Veredicto de los demás criterios (rol, tipo, canal, destinatario, fragmento)
  // por mensaje. Se guarda aparte de la marca para poder reevaluar el mensaje
  // cuando un `remove` la levanta, sin dejar de aplicar los otros filtros.
  const aceptables = new Map();
  /** Ruta exacta que levanta la marca: la misma clave que lee el criterio. */
  const RUTA_OCULTO = '/message/metadata/is_visually_hidden_from_conversation';
  // Cierre del protocolo del mensaje ACEPTADO: `status finished_successfully`
  // y `end_turn: true`. Lo pone el propio proveedor; es más fiable que la
  // puntuación del texto, que marca «cortada» una respuesta completa.
  const cierres = new Map();
  let ocultoLevantado = 0;
  const removes = [];

  /**
   * Veredicto de cierre del mensaje vigente, con las dos señales juntas.
   * `end_turn` puede llegar por parche (`/message/end_turn`) o dentro del
   * mensaje; el estado terminal, por cualquiera de las dos vías.
   */
  function marcarCierre(estado, finDeTurno) {
    const clave = String(messageId || '');
    if (!clave) return;
    const previo = cierres.get(clave) || { estado: false, fin: false };
    cierres.set(clave, {
      estado: previo.estado || estado === true,
      fin: previo.fin || finDeTurno === true,
    });
  }

  function remember(key, full, path, cumulative = true) {
    const previous = texts.get(key) || '';
    texts.set(key, full);
    captured = true;
    const added = full.startsWith(previous) ? full.slice(previous.length) : full;
    return added ? segment(path, added, cumulative) : null;
  }

  function read(json) {
    const segments = [];
    let terminal = null;
    let descartados = 0;
    let sinTexto = 0;
    const porEvento = { string: 0, array: 0, object: 0, otro: 0 };
    let segmentos = 0;
    /** Textos retenidos por la marca de oculto, a la espera de un `remove`. */
    const pendientes = [];
    const levantadoAntes = ocultoLevantado;
    /** Forma de `v` en las operaciones que apuntan a una parte de texto. */
    const formaTexto = { string: 0, array: 0, object: 0, otro: 0 };
    let conSegmentoTexto = false;
    const handled = isPlainObject(json) && Boolean(json.type || json.message || 'v' in json || 'p' in json || 'o' in json);
    const result = () => ({ segments, terminal, handled, model, descartados, sinTexto,
      porEvento, segmentos,
      ocultoLevantado: ocultoLevantado - levantadoAntes, removes,
      // Sólo el mensaje ACEPTADO (assistant, sin marca de oculto) cuenta.
      cierre: Boolean(aceptables.get(String(messageId || '')) && ocultos.get(String(messageId || '')) === false &&
        cierres.get(String(messageId || ''))?.estado && cierres.get(String(messageId || ''))?.fin) });
    if (!isPlainObject(json)) return result();

    // Canal sin cuenta: no lleva message.content, sino markdown con revisiones.
    if (json.type === 'content' && typeof json.markdown === 'string') {
      const id = String(json.messageId || 'ndjson');
      const revision = Number(json.revision);
      if (Number.isFinite(revision) && revision <= (revisions.get(id) ?? -1)) return result();
      if (Number.isFinite(revision)) revisions.set(id, revision);
      const key = `${id}:markdown`;
      const full = json.mode === 'append' ? (texts.get(key) || '') + json.markdown : json.markdown;
      const added = remember(key, full, 'markdown');
      if (added) segments.push(added);
      if (json.status === 'complete') terminal = 'message';
      return result();
    }
    if (json.type === 'end' || json.type === 'message_stream_complete' ||
        (json.type === 'control' && json.detail?.kind === 'terminal-received')) terminal = 'message';

    function readMessage(message, prefix) {
      if (!isPlainObject(message)) return;
      const role = message.author?.role;
      const type = message.content?.content_type;
      messageId = String(message.id || messageId || 'message');
      const meta = message.metadata || {};
      model = meta.model_slug || meta.resolved_model_slug || model;
      // La marca se guarda por `id`. Si el mensaje la trae, manda ella; si no
      // la trae y nadie la había levantado, queda oculta (apertura normal).
      if (meta.is_visually_hidden_from_conversation !== undefined) {
        ocultos.set(messageId, Boolean(meta.is_visually_hidden_from_conversation));
      } else if (!ocultos.has(messageId)) {
        ocultos.set(messageId, false);
      }
      // Los filtros de siempre, sin la marca de oculto: eso decide aparte.
      const cumple = (role ? role === 'assistant' : state.assistantText !== false) &&
        (!type || TEXT_CONTENT_TYPES.has(type)) &&
        (!message.recipient || message.recipient === 'all') &&
        (!message.channel || message.channel === 'final') &&
        !meta.is_message_fragment;
      aceptables.set(messageId, cumple);
      state.assistantText = cumple && !ocultos.get(messageId);
      state.pathIsText = false;
      if (!state.assistantText) {
        descartados += 1;
        sinTexto += 1;
        return;
      }
      const parts = message.content?.parts;
      if (Array.isArray(parts)) parts.forEach((part, i) => {
        if (typeof part !== 'string') return;
        const path = `${prefix}.content.parts.${i}`;
        const added = remember(`${messageId}:${i}`, part, path);
        if (added) segments.push(added);
        state.lastTextPath = `/message/content/parts/${i}`;
        state.cumulativePath = `message.content.parts.${i}`;
      });
      state.lastMessage = prefix === 'message' ? message : null;
      if (CHATGPT_TERMINAL_STATUS.has(message.status)) terminal = 'message';
      if (CHATGPT_TERMINAL_STATUS.has(message.status) && message.end_turn === true) marcarCierre(true, true);
    }

    if (isPlainObject(json.message)) {
      readMessage(json.message, 'message');
      return result();
    }

    function readOperation(op, valuePath, inheritedPointer, inheritedOperation, depth = 0) {
      if (!isPlainObject(op)) return;
      const target = typeof op.p === 'string' ? op.p : inheritedPointer;
      const action = typeof op.o === 'string' ? op.o : inheritedOperation;
      // Un array de parches puede mezclar elementos con `p` y elementos que no
      // encajan (null, números, cadenas, objetos sin `p`). Basta con que **alguno**
      // sea un parche para recorrerlo: los demás se ignoran sin lanzar. Exigir
      // que todos encajaran descartaba el array entero y el turno salía con 0
      // caracteres aunque el texto estuviera ahí.
      const traeParche = Array.isArray(op.v) &&
        (action === 'patch' || op.v.some((item) => isPlainObject(item) && typeof item.p === 'string'));
      // Tope de elementos y profundidad: un `o:'patch'` dentro de un elemento
      // puede recursar una vez más, nunca sin límite.
      if (traeParche && depth < 2) {
        op.v.slice(0, 256).forEach((child, i) => readOperation(child, `${valuePath}.${i}.v`, target, 'append', depth + 1));
        return;
      }
      const value = op.v;
      // La marca de oculto se levanta SÓLO con la ruta exacta que lee el
      // criterio. Cualquier otra ruta de `remove` (o un `remove` sin mensaje)
      // se registra para el diagnóstico y no cambia nada. Va ANTES de los
      // retornos tempranos: un `remove` no trae texto ni mensaje.
      if (action === 'remove') {
        const clave = String(messageId || '');
        if (target === RUTA_OCULTO && clave) {
          if (ocultos.get(clave) !== false) ocultoLevantado += 1;
          ocultos.set(clave, false);
          // Levantar la marca reabre el mensaje sólo si los demás criterios lo
          // permitían: `system` y `user` siguen fuera por su rol.
          if (aceptables.get(clave) !== false) state.assistantText = true;
        }
        // Dígitos → `N`: los índices de parche no identifican la ruta.
        if (removes.length < 6) removes.push(rutaRemove(target));
        return;
      }
      // El protocolo delta_encoding usa raíces {p:'',o:'add',v:{message}}
      // y objetos {v:{message}} que heredan la operación anterior.
      if (target === '' && isPlainObject(value?.message)) {
        readMessage(value.message, `${valuePath}.message`);
        return;
      }
      if (target === '/message' && isPlainObject(value)) {
        readMessage(value, valuePath);
        return;
      }
      state.pathIsText = PARTS_PATH.test(target) && state.assistantText !== false;
      if (target === '/message/author/role') {
        state.assistantText = value === 'assistant';
        if (!state.assistantText) sinTexto += 1;
        return;
      }
      if (target === '/message/status' && CHATGPT_TERMINAL_STATUS.has(value)) {
        terminal = 'message';
        marcarCierre(true, false);
      }
      if (target === '/message/end_turn' && value === true) marcarCierre(false, true);
      // El texto de un mensaje que aún está marcado como oculto no se entrega
      // todavía: la marca puede levantarse más adelante EN ESTE MISMO evento.
      // Se queda pendiente con su ruta y su operación, y sale al final si la
      // marca se levantó (`aplicarPendientes`).
      if (PARTS_PATH.test(target)) {
        // La ruta de texto puede venir en el `p` del evento o en el de un
        // elemento del array de parches; el diagnóstico mira las dos.
        if (typeof value === 'string') formaTexto.string += 1;
        else if (Array.isArray(value)) formaTexto.array += 1;
        else if (isPlainObject(value)) formaTexto.object += 1;
        else formaTexto.otro += 1;
      }
      if (typeof value === 'string' && PARTS_PATH.test(target) && ocultos.get(messageId) === true) {
        pendientes.push({ key: `${messageId || 'message'}:${PARTS_PATH.exec(target)[1]}`,
          target, value, action, valuePath });
        return;
      }
      if (!state.pathIsText || typeof value !== 'string') return;
      const index = PARTS_PATH.exec(target)[1];
      if (emitirTexto(`${messageId || 'message'}:${index}`, target, value, action, valuePath)) conSegmentoTexto = true;
    }

    /**
     * Publica un trozo de texto del mensaje vigente. Lo usan el camino normal y
     * el de los pendientes, para no tener dos versiones de la misma cuenta.
     */
    function emitirTexto(key, target, value, action, valuePath) {
      const full = action === 'append' ? (texts.get(key) || '') + value : value;
      const added = remember(key, full, valuePath, action !== 'append');
      state.lastTextPath = target;
      // El cierre sintético de los parches es append, no el mensaje legacy.
      state.lastMessage = null;
      if (added) segments.push(added);
      return Boolean(added);
    }

    /**
     * Aplica los textos que quedaron retenidos por la marca de oculto, y sólo
     * los de los mensajes cuya marca se levantó. Si el mensaje sigue oculto al
     * terminar, su texto no se publica nunca.
     */
    function aplicarPendientes() {
      if (!pendientes.length) return;
      for (const item of pendientes) {
        const clave = messageIdDe(item.key);
        // Sale sólo si el mensaje ya no está oculto Y los demás criterios lo
        // permiten: un `system` con la marca levantada sigue sin publicar.
        if (ocultos.get(clave) !== false || aceptables.get(clave) === false) continue;
        // Un `replace` que es la primera escritura de esa parte no tiene nada
        // que reemplazar: se aplica tal cual.
        const accion = item.action === 'append' || texts.has(item.key) ? item.action : 'replace';
        if (emitirTexto(item.key, item.target, item.value, accion, item.valuePath)) conSegmentoTexto = true;
      }
      pendientes.length = 0;
    }

    /** Ruta de `remove` publicable: normalizada, o `s<longitud>` si no encaja. */
    function rutaRemove(target) {
      const normal = target.replace(/\d+/g, 'N');
      return /^\/message\/[A-Za-z_/]{1,56}$/.test(normal) ? normal : `s${target.length}`;
    }

    /** `m1:0` → `m1`. */
    function messageIdDe(key) {
      const corte = key.lastIndexOf(':');
      return corte < 0 ? key : key.slice(0, corte);
    }
    if (typeof json.p === 'string') pointer = json.p;
    if (typeof json.o === 'string') operation = json.o;
    if ('v' in json) {
      const antes = segments.length;
      readOperation(json, 'v', pointer, operation);
      // El `append` de texto llega ANTES del `remove` que levanta la marca en el
      // mismo evento: la decisión se toma con el estado al terminar el evento.
      aplicarPendientes();
      // Sólo cuando la ruta del evento apunta a una parte de texto: qué forma
      // traía `v` y si de ahí salió texto. Es el dato que separa «llegó en una
      // forma que no entiendo» de «llegó bien pero el mensaje estaba oculto».
      // Vale tanto si la ruta de texto es el `p` del evento como si va dentro
      // de los elementos del array de parches: es el mismo dato.
      if (PARTS_PATH.test(String(json.p || '')) || formaTexto.string || formaTexto.array ||
          formaTexto.object || formaTexto.otro) {
        if (typeof json.v === 'string') porEvento.string += 1;
        else if (Array.isArray(json.v)) porEvento.array += 1;
        else if (isPlainObject(json.v)) porEvento.object += 1;
        else porEvento.otro += 1;
        if (conSegmentoTexto || segments.length > antes) segmentos += 1;
      }
    }
    return result();
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

  return { name: 'chatgpt', state, read, write, pending,
    snapshot: () => captured ? [...texts.values()].join('') : null,
    model: () => model,
  };
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

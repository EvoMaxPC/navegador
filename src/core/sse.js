/**
 * Utilidades de Server-Sent Events (SSE).
 *
 * Todos los clientes de chat serios transmiten la respuesta como SSE o como
 * streams de líneas JSON. Para intervenir el texto antes de que se dibuje hay
 * que parsear ese flujo, extraer los deltas y volver a serializarlo sin romper
 * ninguna otra cosa que el cliente espere (ids, eventos de control, metadatos).
 */

import { tokensToSignature } from './text.js';

/**
 * Extrae eventos SSE completos de un buffer.
 * @param {string} buffer
 * @returns {{events: Array<{event: string, data: string, raw: string}>, rest: string}}
 */
export function parseSSE(buffer) {
  const events = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  let idx = normalized.indexOf('\n\n');
  let start = 0;
  while (idx !== -1) {
    const chunk = normalized.slice(start, idx);
    start = idx + 2;
    if (chunk.trim()) {
      // `raw` conserva el evento tal cual llegó (comentarios `: ping`, `retry:`,
      // `id:` y campos desconocidos incluidos) para poder reenviarlo sin tocarlo.
      const evt = { event: 'message', data: '', raw: chunk, hasData: false };
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          // La especificación SSE quita UN solo espacio inicial, no todos: con
          // `trimStart` una respuesta que empieza con sangría perdía caracteres.
          const value = line.slice(5);
          dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
        } else if (line.startsWith('event:')) evt.event = line.slice(6).trim();
        else if (line.startsWith('id:')) evt.id = line.slice(3).trim();
      }
      evt.hasData = dataLines.length > 0;
      evt.data = dataLines.join('\n');
      events.push(evt);
    }
    idx = normalized.indexOf('\n\n', start);
  }
  return { events, rest: normalized.slice(start) };
}

/** Serializa un evento SSE de vuelta al formato de cable. */
export function serializeSSE(evt) {
  const lines = [];
  if (evt.event && evt.event !== 'message') lines.push(`event: ${evt.event}`);
  if (evt.id) lines.push(`id: ${evt.id}`);
  const data = String(evt.data ?? '');
  for (const line of data.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Reescribe SOLO los datos de un evento recibido y conserva el resto de sus
 * líneas (nombre del evento, id, retry, comentarios) en su posición original.
 *
 * Reconstruirlo con `serializeSSE` perdía esa información: un `: ping` se
 * convertía en `data:` vacío y un `event: content_block_delta` podía cambiar de
 * lugar respecto de su `data:`.
 */
export function rewriteSSE(evt, data) {
  if (typeof evt.raw !== 'string') return serializeSSE({ ...evt, data });
  if (!evt.hasData) return `${evt.raw}\n\n`;
  const dataLines = String(data).split('\n').map((line) => `data: ${line}`);
  const out = [];
  let placed = false;
  for (const line of evt.raw.split('\n')) {
    if (line.startsWith('data:')) {
      if (!placed) {
        out.push(...dataLines);
        placed = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!placed) out.push(...dataLines);
  return `${out.join('\n')}\n\n`;
}

/** Reenvía un evento exactamente como llegó (latidos, `retry:`, comentarios). */
export function passthroughSSE(evt) {
  return typeof evt.raw === 'string' ? `${evt.raw}\n\n` : serializeSSE(evt);
}

const DELTA_KEYS = new Set([
  'delta', 'text', 'content', 'completion', 'response', 'token', 'chunk',
  'message', 'parts', 'v', 'output_text', 'answer', 'value',
]);
const SKIP_KEYS = new Set([
  'id', 'uuid', 'model', 'role', 'type', 'created', 'created_at', 'index',
  'conversation_id', 'message_id', 'parent_id', 'finish_reason', 'usage',
  'signature', 'csrf', 'token_count', 'stop_reason', 'event', 'status',
  'recipient', 'author', 'metadata', 'logprobs',
]);

/**
 * Extrae los fragmentos de texto de un evento JSON, sea cual sea su forma.
 *
 * La estrategia es deliberadamente genérica: se recorre el objeto y se aceptan
 * strings que cuelguen de claves típicas de delta. Si el sitio usa una forma
 * desconocida se puede pasar `hintPaths` con rutas explícitas.
 *
 * @param {any} json
 * @param {{hintPaths?: string[]|null}} [opts]
 * @returns {{texts: Array<{path: string, text: string}>, control: string|null}}
 */
export function extractDeltas(json, opts = {}) {
  const texts = [];
  const paths = opts.hintPaths;

  if (paths && paths.length) {
    for (const p of paths) {
      const val = getPath(json, p);
      if (typeof val === 'string' && val) texts.push({ path: p, text: val });
      else if (Array.isArray(val)) {
        // Cada elemento lleva su propia ruta con índice: escribir en la ruta del
        // array lo reemplazaría por un string y rompería el JSON que espera el
        // cliente (p. ej. `message.content.parts` pasaría a ser un texto suelto).
        val.forEach((item, i) => {
          if (typeof item === 'string' && item) texts.push({ path: `${p}.${i}`, text: item });
        });
      }
    }
    if (texts.length) return { texts, control: controlOf(json) };
  }

  walk(json, [], texts, 0);
  return { texts, control: controlOf(json) };
}

function walk(node, path, out, depth) {
  if (depth > 10 || node == null) return;
  if (typeof node === 'string') {
    const key = path[path.length - 1];
    const isMessageList = path.includes('messages');
    if (!isMessageList && DELTA_KEYS.has(String(key))) out.push({ path: path.join('.'), text: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, [...path, i], out, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k)) continue;
      walk(v, [...path, k], out, depth + 1);
    }
  }
}

function controlOf(json) {
  const candidates = [
    json?.type,
    json?.event,
    json?.choices?.[0]?.finish_reason,
    json?.stop_reason,
    json?.status,
  ].filter(Boolean);
  const stop = candidates.find((c) => /stop|end|done|complete|finish|message_stop|conversation_end/i.test(String(c)));
  return stop ? String(stop) : null;
}

/** Escribe un valor en una ruta con notación de punto. */
export function setPath(root, path, value) {
  if (!path) return false;
  const parts = Array.isArray(path)
    ? path
    : String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
  if (!parts.length) return false;
  let node = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (node == null) return false;
    node = node[parts[i]];
  }
  if (node == null) return false;
  node[parts[parts.length - 1]] = value;
  return true;
}

export function getPath(root, path) {
  if (!path) return undefined;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = root;
  for (const p of parts) {
    if (node == null) return undefined;
    node = node[p];
  }
  return node;
}

/**
 * Heurística de «¿esto es un stream de texto?».
 */
export function looksLikeStream(headers, url = '') {
  const ct = String(headers?.['content-type'] || headers?.get?.('content-type') || '');
  return /text\/event-stream|application\/x-ndjson|text\/plain/.test(ct) || /stream|sse/i.test(url);
}

/**
 * Localiza el texto completo del mensaje del usuario dentro de un cuerpo de
 * petición, para poder sustituirlo sin conocer el esquema exacto.
 */
export function guessUserText(body) {
  const found = [];
  walkAll(body, [], found, 0);
  const withSign = found
    .filter((f) => f.value.length > 2)
    .map((f) => ({ ...f, sign: tokensToSignature(f.value.toLowerCase().split(/\s+/)) }));
  return withSign;
}

function walkAll(node, path, out, depth) {
  if (depth > 8 || node == null) return;
  if (typeof node === 'string') {
    out.push({ path: [...path], value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkAll(v, [...path, i], out, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkAll(v, [...path, k], out, depth + 1);
  }
}

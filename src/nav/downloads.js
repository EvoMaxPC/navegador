/**
 * Descargas: modelo de estado, sin Electron.
 *
 * El proceso principal traduce los eventos de `will-download` a estas
 * transiciones; así la lógica (progreso, cancelación, reanudación) se prueba
 * sin abrir una ventana.
 */

import { hostOf } from './url.js';

export const DOWNLOAD_STATES = ['started', 'progress', 'completed', 'cancelled', 'interrupted'];

/** Quita rutas y caracteres que no pueden ir en un nombre de archivo. */
export function sanitizeFilename(name, fallback = 'descarga') {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base || fallback;
}

export class DownloadList {
  /**
   * @param {{
   *   storage?: {read: () => (string|null), write: (data: string) => void},
   *   now?: () => number,
   *   maxItems?: number
   * }} [opts]
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.now = opts.now || Date.now;
    this.maxItems = opts.maxItems ?? 300;
    /** @type {Array<object>} */
    this.items = [];
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.storage) return this;
    try {
      const raw = this.storage.read();
      if (!raw) return this;
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.items) ? parsed.items : [];
      this.items = list.map((item) => ({
        ...item,
        // Una descarga que quedó «en curso» cuando se cerró la aplicación ya no
        // lo está: se marca interrumpida en lugar de mentir con una barra quieta.
        state: item.state === 'started' || item.state === 'progress' ? 'interrupted' : item.state,
      }));
    } catch {
      this.items = [];
    }
    return this;
  }

  save({ force = false } = {}) {
    if (!this.storage) return false;
    if (!this.dirty && !force) return false;
    try {
      this.storage.write(JSON.stringify({ version: 1, savedAt: this.now(), items: this.items }));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  start({ id, url, filename, savePath = null, totalBytes = 0 } = {}) {
    const item = {
      id: String(id || `dl-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
      url: String(url || ''),
      host: hostOf(url),
      filename: sanitizeFilename(filename || url),
      savePath,
      state: 'started',
      receivedBytes: 0,
      totalBytes: Number(totalBytes) || 0,
      startedAt: this.now(),
      endedAt: null,
      error: null,
    };
    this.items.unshift(item);
    if (this.items.length > this.maxItems) this.items.length = this.maxItems;
    this.dirty = true;
    return item;
  }

  /** Actualiza progreso por id. Ignora ids desconocidos (eventos tardíos). */
  progress(id, { receivedBytes = 0, totalBytes = 0 } = {}) {
    const item = this.get(id);
    if (!item) return null;
    item.receivedBytes = Math.max(0, Number(receivedBytes) || 0);
    if (totalBytes) item.totalBytes = Number(totalBytes) || 0;
    item.state = 'progress';
    this.dirty = true;
    return item;
  }

  rename(id, filename) {
    const item = this.get(id);
    if (!item) return null;
    item.filename = sanitizeFilename(filename, item.filename);
    this.dirty = true;
    return item;
  }

  setSavePath(id, savePath) {
    const item = this.get(id);
    if (!item) return null;
    item.savePath = savePath;
    this.dirty = true;
    return item;
  }

  finish(id, { state = 'completed', savePath = null, error = null } = {}) {
    const item = this.get(id);
    if (!item) return null;
    item.state = DOWNLOAD_STATES.includes(state) ? state : 'completed';
    if (savePath) item.savePath = savePath;
    if (error) item.error = String(error);
    if (item.state === 'completed' && !item.totalBytes) item.totalBytes = item.receivedBytes;
    item.endedAt = this.now();
    this.dirty = true;
    return item;
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  list({ limit = 50 } = {}) {
    return this.items.slice(0, limit);
  }

  /** ¿Se puede abrir el archivo descargado? */
  isOpenable(id) {
    const item = this.get(id);
    return Boolean(item && item.state === 'completed' && item.savePath);
  }

  clearFinished() {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.state === 'started' || item.state === 'progress');
    if (this.items.length !== before) this.dirty = true;
    return { removed: before - this.items.length };
  }

  clearAll() {
    const removed = this.items.length;
    this.items = [];
    this.dirty = true;
    return { removed };
  }

  stats() {
    const active = this.items.filter((item) => item.state === 'started' || item.state === 'progress');
    return {
      total: this.items.length,
      active: active.length,
      completed: this.items.filter((item) => item.state === 'completed').length,
      failed: this.items.filter((item) => item.state === 'interrupted' || item.state === 'cancelled').length,
      activeBytes: active.reduce((acc, item) => acc + item.receivedBytes, 0),
    };
  }
}

/** Progreso 0..1, o null si no se conoce el total. */
export function progressOf(item) {
  if (!item || !item.totalBytes) return null;
  return Math.min(1, item.receivedBytes / item.totalBytes);
}

/** Texto legible del estado, para la interfaz. */
export function describeState(state) {
  return (
    {
      started: 'iniciando',
      progress: 'descargando',
      completed: 'completada',
      cancelled: 'cancelada',
      interrupted: 'interrumpida',
    }[state] || state
  );
}

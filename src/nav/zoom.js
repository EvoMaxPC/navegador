/**
 * Zoom por sitio.
 *
 * El zoom se recuerda por host: si agrandaste ChatGPT, no se agranda todo
 * Internet. Los pasos son fijos para que el cambio sea predecible.
 */

import { hostOf } from './url.js';

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
export const ZOOM_DEFAULT = 1;

export function clampZoom(level) {
  const value = Number(level);
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value.toFixed(2))));
}

export class ZoomStore {
  /**
   * @param {{
   *   storage?: {read: () => (string|null), write: (data: string) => void},
   *   defaults?: Record<string, number>
   * }} [opts]
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    /** @type {Map<string, number>} */
    this.levels = new Map();
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.storage) return this;
    try {
      const raw = this.storage.read();
      if (!raw) return this;
      const parsed = JSON.parse(raw);
      for (const [host, level] of Object.entries(parsed?.levels || {})) {
        const value = clampZoom(level);
        if (value !== ZOOM_DEFAULT) this.levels.set(host, value);
      }
    } catch {
      this.levels.clear();
    }
    return this;
  }

  save({ force = false } = {}) {
    if (!this.storage) return false;
    if (!this.dirty && !force) return false;
    try {
      this.storage.write(JSON.stringify({ version: 1, levels: Object.fromEntries(this.levels) }));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  /** Nivel efectivo de una URL o host. */
  get(target) {
    const host = resolveHost(target);
    return this.levels.get(host) ?? ZOOM_DEFAULT;
  }

  set(target, level) {
    const host = resolveHost(target);
    if (!host) return ZOOM_DEFAULT;
    const value = clampZoom(level);
    if (value === ZOOM_DEFAULT) this.levels.delete(host);
    else this.levels.set(host, value);
    this.dirty = true;
    return value;
  }

  /** Sube o baja un paso de la escala. */
  step(target, direction) {
    const current = this.get(target);
    const index = nearestIndex(current);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + Math.sign(direction)))];
    return this.set(target, next);
  }

  reset(target) {
    return this.set(target, ZOOM_DEFAULT);
  }

  /** Sitios con zoom propio, para mostrar en el panel. */
  list() {
    return [...this.levels.entries()]
      .map(([host, level]) => ({ host, level, percent: Math.round(level * 100) }))
      .sort((a, b) => a.host.localeCompare(b.host, 'es'));
  }

  clear() {
    const removed = this.levels.size;
    this.levels.clear();
    this.dirty = true;
    return { removed };
  }
}

function resolveHost(target) {
  const value = String(target || '');
  if (!value) return '';
  return value.includes('/') || value.includes(':') ? hostOf(value) : value.toLowerCase();
}

function nearestIndex(level) {
  let best = 0;
  let distance = Infinity;
  ZOOM_STEPS.forEach((step, index) => {
    const delta = Math.abs(step - level);
    if (delta < distance) {
      distance = delta;
      best = index;
    }
  });
  return best;
}

/** Texto para la interfaz: 100 %, 110 %, etc. */
export function zoomLabel(level) {
  return `${Math.round(clampZoom(level) * 100)} %`;
}

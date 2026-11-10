/**
 * Restauración de sesión.
 *
 * Guarda qué pestañas estaban abiertas y en qué orden, para volver al mismo
 * lugar después de cerrar. No guarda formularios, contraseñas ni estado interno
 * de los sitios: eso lo maneja Chromium con su propio perfil y no se toca.
 */

import { isInternal, normalizeUrl } from './url.js';

export const SESSION_VERSION = 1;

/**
 * Construye el objeto serializable de la sesión actual.
 *
 * @param {{
 *   windows: Array<{activeIndex?: number, tabs: Array<{url: string, title?: string, pinned?: boolean}>}>,
 *   now?: () => number
 * }} input
 */
export function captureSession({ windows = [], now = Date.now } = {}) {
  const clean = [];
  for (const window of windows) {
    const tabs = [];
    for (const tab of window.tabs || []) {
      const url = normalizeUrl(tab?.url);
      // Las páginas internas y las vacías no se restauran: abrirlas de nuevo no
      // devuelve al usuario a ningún lado útil.
      if (!url || isInternal(url)) continue;
      tabs.push({
        url,
        title: String(tab?.title || url).slice(0, 300),
        pinned: Boolean(tab?.pinned),
        ...(/^[a-z0-9-]{1,48}$/.test(tab?.workspaceId || '') && tab.workspaceId!=='main' ? {workspaceId:tab.workspaceId} : {}),
      });
    }
    if (!tabs.length) continue;
    const activeIndex = Math.min(Math.max(0, Number(window.activeIndex) || 0), tabs.length - 1);
    clean.push({ activeIndex, tabs });
  }
  return {
    version: SESSION_VERSION,
    savedAt: now(),
    windows: clean,
  };
}

/**
 * Valida y recorta una sesión guardada antes de reconstruir pestañas.
 *
 * @param {any} data
 * @param {{maxTabs?: number}} [opts]
 */
export function restoreSession(data, opts = {}) {
  const maxTabs = opts.maxTabs ?? 60;
  const result = { windows: [], restored: 0, skipped: 0, savedAt: null };
  if (!data || typeof data !== 'object') return result;

  const windows = Array.isArray(data.windows) ? data.windows : [];
  let budget = maxTabs;

  for (const window of windows) {
    if (budget <= 0) break;
    const tabs = [];
    for (const tab of Array.isArray(window?.tabs) ? window.tabs : []) {
      const url = normalizeUrl(tab?.url);
      if (!url || isInternal(url) || budget <= 0) {
        result.skipped += 1;
        continue;
      }
      tabs.push({ url, title: String(tab?.title || url).slice(0, 300), pinned: Boolean(tab?.pinned), ...(/^[a-z0-9-]{1,48}$/.test(tab?.workspaceId || '') && tab.workspaceId!=='main' ? {workspaceId:tab.workspaceId} : {}) });
      budget -= 1;
    }
    if (!tabs.length) continue;
    result.windows.push({
      activeIndex: Math.min(Math.max(0, Number(window?.activeIndex) || 0), tabs.length - 1),
      tabs,
    });
    result.restored += tabs.length;
  }

  result.savedAt = Number(data.savedAt) || null;
  return result;
}

/** ¿Vale la pena ofrecer «restaurar» con esta sesión? */
export function isRestorable(data, { minAgeMs = 1500 } = {}) {
  const parsed = restoreSession(data);
  return parsed.restored > 0 && Boolean(parsed.savedAt) && Date.now() - parsed.savedAt >= 0 && parsed.savedAt <= Date.now() + minAgeMs;
}

/**
 * Envoltorio de almacenamiento de la sesión: captura, guarda y devuelve lo que
 * hay que restaurar en el próximo arranque.
 */
export class SessionStore {
  /**
   * @param {{
   *   storage?: {read: () => (string|null), write: (data: string) => void},
   *   now?: () => number
   * }} [opts]
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.now = opts.now || Date.now;
    this.last = null;
    this.load();
  }

  load() {
    if (!this.storage) return this;
    try {
      const raw = this.storage.read();
      if (raw) this.last = JSON.parse(raw);
    } catch {
      this.last = null;
    }
    return this;
  }

  /** @param {Array<{tabs: Array<{url: string, title?: string}>, activeIndex?: number}>} windows */
  capture(windows) {
    const data = captureSession({ windows, now: this.now });
    this.last = data;
    this.persist();
    return data;
  }

  persist() {
    if (!this.storage || !this.last) return false;
    try {
      this.storage.write(JSON.stringify(this.last));
      return true;
    } catch {
      return false;
    }
  }

  /** Sesión lista para reconstruir, o null si no hay nada útil. */
  restore(opts = {}) {
    if (!this.last) return null;
    const parsed = restoreSession(this.last, opts);
    return parsed.restored ? parsed : null;
  }

  clear() {
    this.last = null;
    this.persist();
    return true;
  }
}

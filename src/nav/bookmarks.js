/**
 * Marcadores.
 *
 * Planos (sin árbol de carpetas) con una carpeta por defecto: menos interfaz,
 * menos fricción y más rápido de usar. La clave es la URL normalizada, así que
 * marcar dos veces la misma página no crea duplicados.
 */

import { hostOf, normalizeUrl, urlKey } from './url.js';
import { normalizeText } from './history.js';

export const DEFAULT_FOLDER = 'Favoritos';

export class BookmarkStore {
  /**
   * @param {{
   *   storage?: {read: () => (string|null), write: (data: string) => void},
   *   now?: () => number
   * }} [opts]
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.now = opts.now || Date.now;
    /** @type {Array<{id:string,url:string,key:string,title:string,host:string,folder:string,createdAt:number}>} */
    this.items = [];
    /** Caché de texto normalizado para la búsqueda de la barra. */
    this.index = null;
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
      this.items = list
        .filter((item) => item && typeof item.url === 'string')
        .map((item) => ({
          id: item.id || `bm-${Math.random().toString(36).slice(2, 10)}`,
          url: item.url,
          key: item.key || urlKey(item.url),
          title: item.title || item.url,
          host: item.host || hostOf(item.url),
          folder: item.folder || DEFAULT_FOLDER,
          createdAt: Number(item.createdAt) || this.now(),
        }));
    } catch {
      this.items = [];
    }
    this.index = null;
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

  /** @returns {{bookmark: object, created: boolean}|null} */
  add({ url, title, folder = DEFAULT_FOLDER } = {}) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    const key = urlKey(normalized);
    const existing = this.items.find((item) => item.key === key);
    if (existing) {
      if (title) existing.title = String(title).trim();
      this.dirty = true;
      this.index = null;
      return { bookmark: existing, created: false };
    }
    const bookmark = {
      id: `bm-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      url: normalized,
      key,
      title: String(title || normalized).trim(),
      host: hostOf(normalized),
      folder: folder || DEFAULT_FOLDER,
      createdAt: this.now(),
    };
    this.items.unshift(bookmark);
    this.dirty = true;
    this.index = null;
    return { bookmark, created: true };
  }

  /** Alterna el marcador de una URL: es lo que hace el botón de estrella. */
  toggle({ url, title } = {}) {
    const normalized = normalizeUrl(url);
    if (!normalized) return { added: false, bookmark: null };
    const key = urlKey(normalized);
    const existing = this.items.find((item) => item.key === key);
    if (existing) {
      this.remove(existing.id);
      return { added: false, bookmark: null };
    }
    const result = this.add({ url: normalized, title });
    return { added: true, bookmark: result?.bookmark || null };
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id && item.key !== id);
    if (this.items.length !== before) {
      this.dirty = true;
      this.index = null;
    }
    return this.items.length !== before;
  }

  removeByUrl(url) {
    return this.remove(urlKey(url));
  }

  isBookmarked(url) {
    const key = urlKey(url);
    return Boolean(key) && this.items.some((item) => item.key === key);
  }

  find(url) {
    const key = urlKey(url);
    return this.items.find((item) => item.key === key) || null;
  }

  list({ folder = null, query = '' } = {}) {
    let items = this.items;
    if (folder) items = items.filter((item) => item.folder === folder);
    const term = normalizeText(query);
    if (term) {
      // Texto normalizado una sola vez por marcador: esto se ejecuta en cada
      // tecla de la barra de direcciones.
      const search = this.#searchIndex();
      items = items.filter((item) => {
        const cached = search.get(item.key);
        return cached
          ? cached.title.includes(term) || cached.url.includes(term)
          : normalizeText(item.title).includes(term) || normalizeText(item.url).includes(term);
      });
    }
    return items
      .slice()
      .sort((a, b) => a.folder.localeCompare(b.folder, 'es') || a.title.localeCompare(b.title, 'es'));
  }

  /**
   * Texto normalizado por marcador, reconstruido sólo cuando cambia la lista.
   * @returns {Map<string, {title: string, url: string}>}
   */
  #searchIndex() {
    if (this.index && this.index.length === this.items.length) return this.index.map;
    const map = new Map();
    for (const item of this.items) {
      map.set(item.key, { title: normalizeText(item.title), url: normalizeText(item.url) });
    }
    this.index = { map, length: this.items.length };
    return map;
  }


  folders() {
    const counts = new Map();
    for (const item of this.items) counts.set(item.folder, (counts.get(item.folder) || 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count }));
  }

  renameFolder(from, to) {
    if (!to) return 0;
    let moved = 0;
    for (const item of this.items) {
      if (item.folder !== from) continue;
      item.folder = to;
      moved += 1;
    }
    if (moved) {
      this.dirty = true;
      this.index = null;
    }
    return moved;
  }

  clear() {
    const removed = this.items.length;
    this.items = [];
    this.dirty = true;
    this.index = null;
    return { removed };
  }

  get size() {
    return this.items.length;
  }

  /** Resultados para la barra: primero marcadores, después historial. */
  suggest(query, { limit = 6 } = {}) {
    const term = normalizeText(query);
    const items = term ? this.list({ query: term }) : this.items;
    return items
      .slice(0, limit)
      .map((item) => ({ url: item.url, title: item.title, kind: 'bookmark', host: item.host }));
  }
}

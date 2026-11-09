/**
 * Historial de navegación.
 *
 * Una fila por visita, con deduplicación de recargas inmediatas: el historial
 * tiene que servir para volver a algo, no para registrar cada parpadeo del DOM.
 *
 * El almacenamiento se inyecta (`{read, write}`) igual que en EVO MEMORY, así
 * que el mismo módulo funciona con archivo en disco o con memoria en pruebas.
 */

import { hostOf, isInternal, normalizeUrl, siteOf } from './url.js';

const DEDUPE_WINDOW_MS = 5_000;

export class HistoryStore {
  /**
   * @param {{
   *   storage?: {read: () => (string|null), write: (data: string) => void},
   *   now?: () => number,
   *   maxEntries?: number,
   *   maxAgeDays?: number
   * }} [opts]
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.now = opts.now || Date.now;
    this.maxEntries = opts.maxEntries ?? 20_000;
    this.maxAgeDays = opts.maxAgeDays ?? 90;
    /** @type {Array<{id:string,url:string,host:string,site:string,title:string,ts:number,transition:string}>} */
    this.entries = [];
    this.dirty = false;
    this.lastSavedAt = null;
    this.load();
  }

  load() {
    if (!this.storage) return this;
    try {
      const raw = this.storage.read();
      if (!raw) return this;
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
      this.entries = list
        .filter((entry) => entry && typeof entry.url === 'string')
        .map((entry) => ({
          id: entry.id || `${entry.ts}-${Math.random().toString(36).slice(2, 8)}`,
          url: entry.url,
          host: entry.host || hostOf(entry.url),
          site: entry.site || siteOf(entry.url),
          title: entry.title || entry.url,
          ts: Number(entry.ts) || this.now(),
          transition: entry.transition || 'link',
        }));
    } catch {
      // Archivo ilegible: se arranca vacío antes que romper el navegador.
      this.entries = [];
    }
    return this;
  }

  save({ force = false } = {}) {
    if (!this.storage) return false;
    if (!this.dirty && !force) return false;
    try {
      this.storage.write(JSON.stringify({ version: 1, savedAt: this.now(), entries: this.entries }));
      this.dirty = false;
      this.lastSavedAt = this.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Registra una visita.
   * @returns {object|null} la entrada guardada, o null si se ignoró
   */
  add({ url, title, transition = 'link', visitTime } = {}) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    // La propia aplicación no ensucia el historial.
    if (isInternal(normalized)) return null;

    const ts = Number(visitTime) || this.now();
    const host = hostOf(normalized);
    const site = siteOf(normalized);
    const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();

    const last = this.entries[0];
    if (last && last.url === normalized && ts - last.ts < DEDUPE_WINDOW_MS) {
      if (cleanTitle && cleanTitle !== last.title) {
        last.title = cleanTitle;
        this.dirty = true;
      }
      return last;
    }

    const entry = {
      id: `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      url: normalized,
      host,
      site,
      title: cleanTitle || normalized,
      ts,
      transition,
    };

    this.entries.unshift(entry);
    this.dirty = true;
    this.#enforceLimit();
    return entry;
  }

  /** Actualiza el título de la última visita a esta URL (cuando llega tarde). */
  retitle(url, title) {
    const normalized = normalizeUrl(url);
    if (!normalized) return false;
    const entry = this.entries.find((item) => item.url === normalized);
    if (!entry || !title) return false;
    const clean = String(title).replace(/\s+/g, ' ').trim();
    if (!clean || clean === entry.title) return false;
    entry.title = clean;
    this.dirty = true;
    return true;
  }

  recent({ limit = 100, offset = 0 } = {}) {
    return this.entries.slice(offset, offset + limit);
  }

  /**
   * Búsqueda con puntaje simple y explicable: título pesa más que URL,
   * la frecuencia de visitas al mismo sitio suma, y lo reciente desempata.
   */
  search(query, { limit = 50, host = null } = {}) {
    const term = normalizeText(query);
    const pool = host ? this.entries.filter((entry) => entry.host === host) : this.entries;
    if (!term) return pool.slice(0, limit);

    const words = term.split(' ').filter(Boolean);
    const scored = [];
    for (const entry of pool) {
      const title = normalizeText(entry.title);
      const url = normalizeText(entry.url);
      let score = 0;
      for (const word of words) {
        if (title.includes(word)) score += 3;
        if (url.includes(word)) score += 1;
      }
      if (!score) continue;
      // Desempate por cercanía temporal: hasta 1 punto por lo más reciente.
      const hoursAgo = Math.max(0, (this.now() - entry.ts) / 3_600_000);
      score += Math.max(0, 1 - hoursAgo / (24 * 30));
      scored.push({ entry, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  /** Sitios más visitados de los últimos días (para la página de inicio). */
  topSites({ limit = 8, days = 30 } = {}) {
    const since = this.now() - days * 86_400_000;
    const bySite = new Map();
    for (const entry of this.entries) {
      if (entry.ts < since) continue;
      const key = entry.site || entry.host;
      if (!key) continue;
      const current = bySite.get(key) || { site: key, host: entry.host, visits: 0, last: 0, url: entry.url, title: entry.title };
      current.visits += 1;
      if (entry.ts > current.last) {
        current.last = entry.ts;
        current.url = entry.url;
        current.title = entry.title;
      }
      bySite.set(key, current);
    }
    return [...bySite.values()].sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, limit);
  }

  /** Sugerencias para la barra: historial + lo que más se repite. */
  suggest(query, { limit = 8 } = {}) {
    const term = String(query || '').trim();
    if (!term) return this.topSites({ limit }).map((site) => ({ url: site.url, title: site.title, kind: 'top' }));
    const seen = new Set();
    const out = [];
    for (const entry of this.search(term, { limit: limit * 3 })) {
      const key = entry.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: entry.url, title: entry.title, kind: 'history', host: entry.host });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Borra historial.
   * `since` es el inicio del período a borrar: con `now - 24h` se elimina el
   * último día, que es lo que ofrece cualquier navegador.
   */
  clear({ since = null, host = null } = {}) {
    const before = this.entries.length;
    const everything = since === null && !host;
    if (everything) {
      this.entries = [];
    } else {
      this.entries = this.entries.filter((entry) => {
        if (since !== null && entry.ts >= since) return false;
        if (host && entry.host === host) return false;
        return true;
      });
    }
    if (this.entries.length !== before) this.dirty = true;
    return { removed: before - this.entries.length };
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length !== before) this.dirty = true;
    return this.entries.length !== before;
  }

  /** Descarta lo viejo y lo que excede el tope. */
  prune() {
    const cutoff = this.now() - this.maxAgeDays * 86_400_000;
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.ts >= cutoff);
    this.#enforceLimit();
    if (this.entries.length !== before) this.dirty = true;
    return { removed: before - this.entries.length };
  }

  #enforceLimit() {
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
  }

  get size() {
    return this.entries.length;
  }

  stats() {
    const hosts = new Map();
    for (const entry of this.entries) {
      const key = entry.site || entry.host;
      hosts.set(key, (hosts.get(key) || 0) + 1);
    }
    const top = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return {
      total: this.entries.length,
      sites: hosts.size,
      firstAt: this.entries.at(-1)?.ts ?? null,
      lastAt: this.entries[0]?.ts ?? null,
      top: top.map(([site, visits]) => ({ site, visits })),
    };
  }
}

/** Normaliza texto para comparar: sin acentos, minúsculas, sin signos. */
export function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü.\s:\/-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

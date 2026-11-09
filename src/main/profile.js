/**
 * Perfil del navegador: un solo lugar que reúne historial, marcadores,
 * descargas, sesión, permisos y zoom.
 *
 * No importa `electron` a propósito: así se puede probar entero desde node con
 * almacenamiento en memoria. El proceso principal es quien le pasa el directorio
 * del perfil.
 */

import { jsonStorage } from './files.js';
import { HistoryStore } from '../nav/history.js';
import { BookmarkStore } from '../nav/bookmarks.js';
import { DownloadList } from '../nav/downloads.js';
import { SessionStore } from '../nav/session.js';
import { PermissionPolicy } from '../nav/permissions.js';
import { ZoomStore } from '../nav/zoom.js';

/**
 * @param {{
 *   dir?: string,
 *   storageFor?: (name: string) => {read: () => (string|null), write: (data: string) => void},
 *   now?: () => number,
 *   maxHistory?: number
 * }} opts
 */
export function createProfile(opts = {}) {
  const { dir = null, now = Date.now, storageFor = null, maxHistory = 20_000 } = opts;

  const storage = (name) => {
    if (storageFor) return storageFor(name);
    if (!dir) return null;
    return jsonStorage(dir, name);
  };

  const profile = {
    dir,
    history: new HistoryStore({ storage: storage('history.json'), now, maxEntries: maxHistory }),
    bookmarks: new BookmarkStore({ storage: storage('bookmarks.json'), now }),
    downloads: new DownloadList({ storage: storage('downloads.json'), now }),
    session: new SessionStore({ storage: storage('session.json'), now }),
    permissions: new PermissionPolicy({ storage: storage('permissions.json') }),
    zoom: new ZoomStore({ storage: storage('zoom.json') }),

    /** Guarda todo lo que tenga cambios pendientes. */
    saveAll() {
      return {
        history: profile.history.save(),
        bookmarks: profile.bookmarks.save(),
        downloads: profile.downloads.save(),
        permissions: profile.permissions.save(),
        zoom: profile.zoom.save(),
      };
    },

    /** Resumen para el panel de estado. */
    stats() {
      return {
        history: profile.history.stats(),
        bookmarks: profile.bookmarks.size,
        downloads: profile.downloads.stats(),
        zoomSites: profile.zoom.list().length,
        permissionSites: profile.permissions.list().length,
        sessionSavedAt: profile.session.last?.savedAt ?? null,
      };
    },

    /**
     * Borra datos de navegación según el alcance pedido.
     * @param {{history?: boolean, bookmarks?: boolean, downloads?: boolean,
     *          session?: boolean, permissions?: boolean, zoom?: boolean, since?: number|null}} scope
     */
    clear(scope = {}) {
      const removed = {};
      if (scope.history) removed.history = profile.history.clear({ since: scope.since ?? null });
      if (scope.bookmarks) removed.bookmarks = profile.bookmarks.clear();
      if (scope.downloads) removed.downloads = profile.downloads.clearAll();
      if (scope.session) removed.session = profile.session.clear();
      if (scope.permissions) removed.permissions = profile.permissions.clearAll();
      if (scope.zoom) removed.zoom = profile.zoom.clear();
      profile.saveAll();
      return removed;
    },
  };

  return profile;
}

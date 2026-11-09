/**
 * Política de permisos por sitio.
 *
 * Regla de base: el navegador concede lo que un chat necesita para funcionar y
 * niega todo lo que puede espiar. El usuario puede cambiar el criterio por sitio
 * desde el panel, y el cambio se aplica en el acto.
 */

/** Permisos que Electron puede pedir, con su valor por defecto y su etiqueta. */
export const PERMISSION_CATALOG = {
  'clipboard-sanitized-write': { label: 'Copiar al portapapeles', default: 'allow' },
  'clipboard-read': { label: 'Leer el portapapeles', default: 'ask' },
  notifications: { label: 'Notificaciones', default: 'ask' },
  fullscreen: { label: 'Pantalla completa', default: 'allow' },
  pointerLock: { label: 'Bloquear el puntero', default: 'ask' },
  geolocation: { label: 'Ubicación', default: 'deny' },
  media: { label: 'Cámara y micrófono', default: 'ask' },
  midi: { label: 'Dispositivos MIDI', default: 'deny' },
  'display-capture': { label: 'Capturar la pantalla', default: 'deny' },
  openExternal: { label: 'Abrir aplicaciones externas', default: 'ask' },
  'mediaKeySystem': { label: 'Contenido protegido (DRM)', default: 'allow' },
};

export const DECISIONS = ['allow', 'deny', 'ask'];

/** Traduce la decisión final a booleano de Electron. «ask» resuelve a negar. */
export function toGranted(decision) {
  return decision === 'allow';
}

export class PermissionPolicy {
  /**
   * @param {{
   *   storage?: {read: () => (string|null), write: (data: string) => void},
   *   defaults?: Record<string, 'allow'|'deny'|'ask'>
   * }} [opts]
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.defaults = { ...defaultsOfCatalog(), ...(opts.defaults || {}) };
    /** @type {Map<string, Record<string, 'allow'|'deny'|'ask'>>} */
    this.rules = new Map();
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.storage) return this;
    try {
      const raw = this.storage.read();
      if (!raw) return this;
      const parsed = JSON.parse(raw);
      const rules = parsed?.rules && typeof parsed.rules === 'object' ? parsed.rules : {};
      for (const [host, values] of Object.entries(rules)) {
        if (values && typeof values === 'object') {
          this.rules.set(host, { ...values });
        }
      }
    } catch {
      this.rules.clear();
    }
    return this;
  }

  save({ force = false } = {}) {
    if (!this.storage) return false;
    if (!this.dirty && !force) return false;
    try {
      const rules = Object.fromEntries(this.rules);
      this.storage.write(JSON.stringify({ version: 1, rules }));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  /** Decisión para un host y permiso concretos. */
  decide(host, permission) {
    const cleanHost = String(host || '').toLowerCase();
    const rule = this.rules.get(cleanHost)?.[permission];
    if (rule && DECISIONS.includes(rule)) return rule;
    return this.defaults[permission] || 'deny';
  }

  /** Fija una decisión. `null` devuelve el permiso a su valor por defecto. */
  set(host, permission, decision) {
    const cleanHost = String(host || '').toLowerCase();
    if (!cleanHost) return false;
    const current = this.rules.get(cleanHost) || {};
    if (decision === null || decision === undefined || decision === 'default') {
      delete current[permission];
    } else {
      if (!DECISIONS.includes(decision)) return false;
      current[permission] = decision;
    }
    if (Object.keys(current).length) this.rules.set(cleanHost, current);
    else this.rules.delete(cleanHost);
    this.dirty = true;
    return true;
  }

  /** Reglas efectivas de un sitio, incluidas las heredadas del catálogo. */
  rulesFor(host) {
    const cleanHost = String(host || '').toLowerCase();
    return Object.entries(PERMISSION_CATALOG).map(([permission, meta]) => {
      const overridden = this.rules.get(cleanHost)?.[permission] || null;
      return {
        permission,
        label: meta.label,
        value: overridden || meta.default,
        isDefault: !overridden,
      };
    });
  }

  /** Sitios con alguna regla propia, para el panel. */
  list() {
    return [...this.rules.entries()].map(([host, rules]) => ({ host, rules: { ...rules } }));
  }

  clear(host) {
    const cleanHost = String(host || '').toLowerCase();
    const removed = this.rules.delete(cleanHost);
    if (removed) this.dirty = true;
    return removed;
  }

  clearAll() {
    const removed = this.rules.size;
    this.rules.clear();
    this.dirty = true;
    return { removed };
  }

  /** Anula las reglas de todos los hosts que coincidan con el sitio. */
  clearSite(site) {
    let removed = 0;
    for (const host of [...this.rules.keys()]) {
      if (host === site || host.endsWith(`.${site}`)) {
        this.rules.delete(host);
        removed += 1;
      }
    }
    if (removed) this.dirty = true;
    return { removed };
  }
}

function defaultsOfCatalog() {
  const out = {};
  for (const [permission, meta] of Object.entries(PERMISSION_CATALOG)) out[permission] = meta.default;
  return out;
}

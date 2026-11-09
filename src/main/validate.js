/**
 * Validación de lo que llega por IPC.
 *
 * El preload corre en un mundo aislado, pero lo que hay del otro lado —una
 * página de IA, con su JavaScript y sus errores— no es de confianza. Todo lo que
 * entra al proceso principal se recorta y se filtra acá antes de tocar disco,
 * `shell` o el motor.
 */

/** Esquemas que puede abrir el sistema operativo desde el navegador. */
export const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'];

/** Tipos de evento que la capa de mediación puede anunciar a la interfaz. */
export const EVENT_TYPES = [
  'outgoing',
  'incoming',
  'intervention',
  'memory',
  'error',
  'ready',
  'stream-end',
  // El corte de bucle lo anuncia la capa inyectada como `stream-stop` y tiene su
  // propio canal (`nexo:stream-stop`); sin figurar acá, el aviso se descartaba
  // en la validación y la interfaz nunca se enteraba del corte.
  'stream-stop',
];

const MAX_URL = 2048;

/** Recorta un texto arbitrario a un string limpio de longitud acotada. */
export function text(value, max = 300) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Número entero dentro de un rango, o el valor por defecto. */
export function integer(value, { min = 0, max = 1_000_000, fallback = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * URL que se puede entregar al sistema operativo.
 *
 * Sólo `http:`, `https:` y `mailto:`. Deja afuera `file:`, `smb:`, `ms-*:` y
 * cualquier esquema que registre una aplicación: `shell.openExternal` con una
 * URL arbitraria es ejecución de programas a pedido de una página.
 *
 * @returns {string|null} la URL normalizada, o `null` si no se permite.
 */
export function safeExternalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!EXTERNAL_SCHEMES.includes(url.protocol)) return null;
  // `https://usuario:clave@host` no aporta nada y confunde el destino real.
  if (url.username || url.password) return null;
  return url.toString();
}

/**
 * Evento que una pestaña anuncia a la interfaz.
 *
 * @param {unknown} input
 * @param {{ href?: string, maxPayload?: number }} [options]
 * @returns {{ type: string, payload: object, href: string }|null}
 */
export function eventMessage(input, options = {}) {
  const { href, maxPayload = 20_000 } = options;
  if (!input || typeof input !== 'object') return null;
  const type = text(input.type, 40);
  if (!EVENT_TYPES.includes(type)) return null;
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return null;
  }
  if (serialized.length > maxPayload) return null;
  // El proceso principal pasa el href real del remitente; si no lo tiene, se usa
  // el que anuncia la página, siempre que sea navegable.
  return { type, payload, href: safeExternalUrl(href || input.href) || '' };
}

/**
 * Sesión que la shell manda antes de cerrarse.
 *
 * `captureSession` ya normaliza cada pestaña; acá se acota el volumen para que
 * una pestaña comprometida no pueda inflar memoria ni el archivo en disco.
 *
 * @param {unknown} input
 * @param {{ maxWindows?: number, maxTabs?: number }} [options]
 */
export function sessionPayload(input, options = {}) {
  const { maxWindows = 8, maxTabs = 120 } = options;
  const windows = Array.isArray(input?.windows) ? input.windows : [];
  const clean = [];
  for (const window of windows.slice(0, maxWindows)) {
    const tabs = Array.isArray(window?.tabs) ? window.tabs.slice(0, maxTabs) : [];
    clean.push({
      activeIndex: integer(window?.activeIndex, { max: maxTabs - 1 }),
      tabs: tabs
        .map((tab) => ({
          url: typeof tab?.url === 'string' ? tab.url.slice(0, MAX_URL) : '',
          title: text(tab?.title, 300),
          pinned: tab?.pinned === true,
        }))
        .filter((tab) => tab.url),
    });
  }
  return { windows: clean.filter((window) => window.tabs.length) };
}

/** Permiso del catálogo, o `null` si no existe. */
export function permissionName(value, catalog) {
  const name = text(value, 60);
  return catalog && Object.hasOwn(catalog, name) ? name : null;
}

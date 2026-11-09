/**
 * Utilidades de URL del navegador.
 *
 * Isomorfas y sin dependencias: las usa el proceso principal, la interfaz y las
 * pruebas. Todo lo que decide «qué es una URL» vive acá, en un solo lugar.
 */

/** Esquemas que el navegador reconoce sin que el usuario escriba nada. */
export const KNOWN_SCHEMES = ['http:', 'https:', 'nexo:', 'file:', 'data:', 'about:', 'blob:'];

/** Hosts internos que nunca van al historial ni a las sugerencias. */
const INTERNAL_PREFIXES = ['nexo://'];

/**
 * Normaliza una URL para guardarla o compararla.
 * Devuelve null si no es navegable.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw === 'about:blank' || raw === 'about:srcdoc') return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    try {
      url = new URL(`https://${raw}`);
    } catch {
      return null;
    }
  }

  if (!KNOWN_SCHEMES.includes(url.protocol)) return null;
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    // El fragmento no identifica un recurso distinto: no ensucia el historial.
    url.hash = '';
    return url.toString();
  }
  return url.toString();
}

/** ¿Es una URL de la propia aplicación? */
export function isInternal(url) {
  return INTERNAL_PREFIXES.some((prefix) => String(url || '').startsWith(prefix));
}

/**
 * Host visible de una URL (`www.` afuera, en minúsculas).
 * @param {string} url
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Cómo se muestra una URL en la barra: sin esquema ni `www.` cuando es web. */
export function displayUrl(url) {
  const raw = String(url || '');
  if (isInternal(raw)) return raw.replace('nexo://app/', 'nexo://');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      const host = parsed.hostname.replace(/^www\./, '');
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return path === '/' ? host : `${host}${path}`;
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

/**
 * Convierte lo escrito en la barra de direcciones en una URL o en una búsqueda.
 *
 * @param {string} input
 * @param {{searchBase?: string}} [opts]
 */
export function resolveInput(input, opts = {}) {
  const value = String(input || '').trim();
  if (!value) return null;
  const searchBase = opts.searchBase || 'https://duckduckgo.com/?q=';

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('about:')) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value) && !/\s/.test(value)) return `https://${value}`;
  return searchBase + encodeURIComponent(value);
}

/**
 * Clave estable de una URL para deduplicar marcadores e historial.
 * @param {string} url
 */
export function urlKey(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return normalized;
  }
}

/** Extrae el dominio registrable aproximado (para agrupar por sitio). */
export function siteOf(url) {
  const host = hostOf(url);
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  // Heurística razonable sin lista pública de sufijos: dos etiquetas finales,
  // salvo casos conocidos de dos niveles.
  const twoLevel = ['com.ar', 'com.br', 'com.mx', 'co.uk', 'co.jp', 'com.au', 'co.es'];
  const lastTwo = parts.slice(-2).join('.');
  if (twoLevel.includes(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

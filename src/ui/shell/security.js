/** Datos de una página no se convierten en HTML ni en comandos de navegación. */
export function safeFaviconUrl(value) {
  if (typeof value !== 'string' || value.length > 32768) return null;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(value)) return value;
  } catch { /* icono no válido */ }
  return null;
}

export function navigationStatus(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'nexo:' && url.hostname === 'app') return { kind: 'local', label: 'Página local de Nexo' };
    if (url.protocol === 'https:') return { kind: 'encrypted', label: 'Conexión HTTPS cifrada; no garantiza que el sitio sea confiable' };
    if (url.protocol === 'http:') return { kind: 'unencrypted', label: 'Conexión HTTP no cifrada' };
  } catch { /* URL pendiente */ }
  return { kind: 'unknown', label: 'Sin información de conexión' };
}

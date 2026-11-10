/** Sólo recursos públicos del renderer; nunca main, preloads, perfil o repositorio. */
export function isPublicAssetPath(path) {
  if (typeof path !== 'string' || path.split('/').some((part) => part.startsWith('.') || !part)) return false;
  if (!/\.(?:html|css|js|mjs|svg|png|ico|woff2?)$/i.test(path)) return false;
  return /^(?:src\/(?:ui|nav|core|memory)\/|demo\/)/.test(path) || /^build\/icon\.(?:png|ico)$/.test(path);
}

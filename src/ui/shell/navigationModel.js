/** Modelo local de búsqueda. No lee contenido de páginas ni envía consultas. */
export const foldNavigationText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
export function navigationMatches(item, query, workspaceName = '') {
  const haystack = foldNavigationText(`${item.title || ''} ${item.url || ''} ${workspaceName}`);
  return foldNavigationText(query).trim().split(/\s+/).every(word => haystack.includes(word));
}
export function navigationTabs(tabs, { query = '', workspace = 'main', currentOnly = false, workspaceName = id => id } = {}) {
  return [...tabs].filter(tab => (!currentOnly || (tab.workspaceId || 'main') === workspace) &&
    navigationMatches(tab, query, workspaceName(tab.workspaceId || 'main')))
    .sort((a, b) => Number((b.workspaceId || 'main') === workspace) - Number((a.workspaceId || 'main') === workspace) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}
export function navigationLocation(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'nexo:') return 'Página interna de NEXO';
    if (!['https:', 'http:'].includes(url.protocol)) return 'Página local';
    return url.host + (url.pathname === '/' ? '' : url.pathname);
  } catch { return 'Sin dirección'; }
}
/** Orden circular coherente con las pestañas visibles, sin saltar de espacio. */
export function adjacentNavigationTab(ids, id, key) {
  if (!ids.length) return null;
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids.at(-1);
  const index = Math.max(0, ids.indexOf(id));
  return ids[(index + (key === 'ArrowLeft' ? -1 : 1) + ids.length) % ids.length];
}
/** Pestañas que un espacio de trabajo pone a la vista. */
export function workspaceScopedTabs(tabs, workspace = 'main') {
  return [...tabs].filter(tab => (tab.workspaceId || 'main') === workspace);
}

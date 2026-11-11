import {
  TOOLBAR_COMMANDS,
  COMMANDS,
  normalizeBinding,
  shortcutConflicts,
} from './shortcuts.js';
export const DEFAULT_BROWSER_PREFS = {
  rightMenuMode: 'auto',
  uiZoom: 1,
  toolbar: ['downloads', 'memory', 'workspaces'],
  shortcuts: {},
  search: 'duckduckgo',
  spellcheck: false,
  spellLanguages: ['es'],
  workspaces: [{ id: 'main', name: 'Principal' }],
};
export function browserPreferences(input = {}) {
  const toolbar = Array.isArray(input.toolbar)
    ? [
        ...new Set(input.toolbar.filter((id) => TOOLBAR_COMMANDS.includes(id))),
      ].slice(0, 12)
    : [...DEFAULT_BROWSER_PREFS.toolbar];
  const shortcuts = {};
  for (const [id, value] of Object.entries(input.shortcuts || {}).slice(0, 100))
    if (COMMANDS.includes(id) && normalizeBinding(value) !== null)
      shortcuts[id] = normalizeBinding(value);
  if (shortcutConflicts(shortcuts).length)
    throw Error(
      'Hay conflictos entre atajos. Quitá la combinación anterior antes de asignarla a otro comando.',
    );
  const workspaces = Array.isArray(input.workspaces)
    ? input.workspaces
        .filter(
          (w) =>
            w && /^[a-z0-9-]{1,48}$/.test(w.id) && typeof w.name === 'string',
        )
        .slice(0, 20)
        .map((w) => ({ id: w.id, name: w.name.slice(0, 50) }))
    : [];
  if (!workspaces.some((w) => w.id === 'main'))
    workspaces.unshift({ id: 'main', name: 'Principal' });
  return {
    rightMenuMode: input.rightMenuMode === 'fixed' ? 'fixed' : 'auto',
    uiZoom:
      typeof input.uiZoom === 'number' && Number.isFinite(input.uiZoom)
        ? Math.min(1.5, Math.max(0.75, Math.round(input.uiZoom * 100) / 100))
        : 1,
    toolbar,
    shortcuts,
    search: input.search === 'google' ? 'google' : 'duckduckgo',
    spellcheck: input.spellcheck === true,
    spellLanguages: Array.isArray(input.spellLanguages)
      ? input.spellLanguages
          .filter(
            (v) => typeof v === 'string' && /^[a-z]{2,3}(-[A-Z]{2})?$/.test(v),
          )
          .slice(0, 5)
      : ['es'],
    workspaces: [...new Map(workspaces.map((w) => [w.id, w])).values()],
  };
}

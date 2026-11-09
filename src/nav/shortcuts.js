/**
 * Atajos de teclado.
 *
 * Una sola tabla, pura y probable, que alimenta el menú nativo y el manejador
 * de teclas de la interfaz. Si un atajo aparece en dos lugares distintos, es
 * porque este archivo no se está usando.
 */

/** Comandos que la interfaz sabe ejecutar. */
export const COMMANDS = [
  'new-tab',
  'close-tab',
  'reopen-tab',
  'next-tab',
  'prev-tab',
  'focus-omnibox',
  'reload',
  'hard-reload',
  'back',
  'forward',
  'find',
  'find-next',
  'find-prev',
  'bookmark',
  'history',
  'downloads',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'toggle-sidebar',
  'toggle-engine',
  'settings',
  'memory',
  'escape',
];

const isMac = (platform) => platform === 'darwin';

/**
 * Traduce un evento de teclado a un comando.
 *
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} event
 * @param {{platform?: string}} [opts]
 * @returns {string|null}
 */
export function commandFor(event, opts = {}) {
  if (!event || !event.key) return null;
  const platform = opts.platform || 'linux';
  const mod = isMac(platform) ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  const key = normalizeKey(event.key);

  if (key === 'escape') return 'escape';
  if (!mod) return null;
  if (alt) {
    if (key === 'arrowleft') return 'back';
    if (key === 'arrowright') return 'forward';
    return null;
  }

  if (shift) {
    switch (key) {
      case 't':
        return 'reopen-tab';
      case 'i':
        return 'toggle-sidebar';
      case 'm':
        return 'toggle-engine';
      case 'r':
        return 'hard-reload';
      case 'tab':
        return 'prev-tab';
      case 'delete':
      case 'backspace':
        return null;
      case 'f':
        return 'find-prev';
      default:
        return digitOf(key) !== null ? `tab-${digitOf(key)}` : null;
    }
  }

  switch (key) {
    case 't':
      return 'new-tab';
    case 'w':
      return 'close-tab';
    case 'l':
      return 'focus-omnibox';
    case 'r':
      return 'reload';
    case 'f':
      return 'find';
    case 'd':
      return 'bookmark';
    case 'h':
      return 'history';
    case 'j':
      return 'downloads';
    case 'tab':
      return 'next-tab';
    case '=':
    case '+':
      return 'zoom-in';
    case '-':
      return 'zoom-out';
    case '0':
      return 'zoom-reset';
    case 'f3':
      return 'find-next';
    case ',':
      return 'settings';
    case 'y':
      return 'memory';
    default:
      return digitOf(key) !== null ? `tab-${digitOf(key)}` : null;
  }
}

function normalizeKey(key) {
  const value = String(key).toLowerCase();
  if (value === 'plus' || value === 'add') return '+';
  if (value === 'minus' || value === 'subtract') return '-';
  if (value === 'equals') return '=';
  if (value === 'tab') return 'tab';
  if (value === 'esc' || value === 'escape') return 'escape';
  if (value === 'left') return 'arrowleft';
  if (value === 'right') return 'arrowright';
  return value;
}

function digitOf(key) {
  if (/^[1-9]$/.test(key)) return Number(key);
  return null;
}

/** Etiqueta legible del atajo, para menús y ayuda. */
export function acceleratorFor(command, platform = 'linux') {
  const mod = isMac(platform) ? '⌘' : 'Ctrl+';
  const shift = isMac(platform) ? '⇧' : 'Shift+';
  const map = {
    'new-tab': `${mod}T`,
    'close-tab': `${mod}W`,
    'reopen-tab': `${mod}${shift}T`,
    'next-tab': `${mod}Tab`,
    'prev-tab': `${mod}${shift}Tab`,
    'focus-omnibox': `${mod}L`,
    reload: `${mod}R`,
    'hard-reload': `${mod}${shift}R`,
    back: `${mod}←`,
    forward: `${mod}→`,
    find: `${mod}F`,
    'find-next': 'F3',
    'find-prev': `${mod}${shift}F`,
    bookmark: `${mod}D`,
    history: `${mod}H`,
    downloads: `${mod}J`,
    'zoom-in': `${mod}+`,
    'zoom-out': `${mod}−`,
    'zoom-reset': `${mod}0`,
    'toggle-sidebar': `${mod}${shift}I`,
    'toggle-engine': `${mod}${shift}M`,
    settings: `${mod},`,
    memory: `${mod}Y`,
  };
  return map[command] || '';
}

/** Registro único de comandos y atajos. Sin Node; compartido por main y shell. */
export const COMMAND_DEFS = [
  ['new-tab', 'Nueva pestaña', 'Ctrl+T'],
  ['close-tab', 'Cerrar pestaña', 'Ctrl+W'],
  ['reopen-tab', 'Restaurar pestaña cerrada', 'Ctrl+Shift+T'],
  ['close-others', 'Cerrar otras pestañas no fijadas', ''],
  ['close-right', 'Cerrar pestañas a la derecha no fijadas', ''],
  ['move-workspace', 'Mover pestaña a otro espacio', ''],
  ['duplicate-tab', 'Duplicar pestaña', 'Ctrl+Shift+D'],
  ['next-tab', 'Siguiente pestaña', 'Ctrl+Tab'],
  ['prev-tab', 'Pestaña anterior', 'Ctrl+Shift+Tab'],
  ['focus-omnibox', 'Barra de direcciones', 'Ctrl+L'],
  ['home', 'Inicio', 'Alt+Home'],
  ['back', 'Atrás', 'Alt+Left'],
  ['forward', 'Adelante', 'Alt+Right'],
  ['reload', 'Recargar', 'Ctrl+R'],
  ['hard-reload', 'Recarga forzada', 'Ctrl+Shift+R'],
  ['command-center', 'Centro de comandos', 'Ctrl+K'],
  ['history', 'Historial', 'Ctrl+H'],
  ['downloads', 'Descargas', 'Ctrl+J'],
  ['bookmark', 'Agregar favorito', 'Ctrl+D'],
  ['bookmarks', 'Administrar favoritos', ''],
  ['bookmark-bar', 'Mostrar/ocultar barra de favoritos', 'Ctrl+Shift+B'],
  ['find', 'Buscar en la página', 'Ctrl+F'],
  ['find-next', 'Buscar siguiente', 'F3'],
  ['find-prev', 'Buscar anterior', 'Shift+F3'],
  ['print', 'Imprimir', 'Ctrl+P'],
  ['save-page', 'Guardar página', 'Ctrl+S'],
  ['zoom-in', 'Aumentar zoom', 'Ctrl+Plus'],
  ['zoom-out', 'Reducir zoom', 'Ctrl+Minus'],
  ['zoom-reset', 'Restablecer zoom', 'Ctrl+0'],
  ['fullscreen', 'Pantalla completa', 'F11'],
  ['memory', 'EVO MEMORY', 'Ctrl+Shift+M'],
  ['toggle-sidebar', 'Panel EVO', 'Ctrl+Shift+I'],
  ['toggle-engine', 'Alternar mediación', ''],
  ['screenshot', 'Capturar área visible', 'Ctrl+Shift+S'],
  ['screenshot-full', 'Capturar página completa', ''],
  ['screenshot-region', 'Capturar rectángulo', ''],
  ['screenshot-copy', 'Copiar área visible como imagen', ''],
  ['reader', 'Pantalla de lectura', 'Ctrl+Shift+F'],
  ['translate', 'Traducir página (Google, externo)', ''],
  ['split', 'Panel dividido', ''],
  ['user-understanding', 'Comprensión · optimización conversacional', ''],
  ['work-dossier', 'Expediente del objetivo · continuar trabajo', ''],
  ['workspaces', 'Espacios de trabajo', 'Ctrl+Shift+E'],
  ['workspace-new', 'Crear espacio de trabajo', ''],
  ['toolbar-settings', 'Personalizar barra', ''],
  ['keyboard-settings', 'Ajustes de teclado', ''],
  ['settings', 'Ajustes', 'Ctrl+Comma'],
  ['sites', 'Información y permisos del sitio', ''],
  ['activity', 'Actividad de IA', ''],
  ['copy-url', 'Copiar dirección', ''],
  ['share-page', 'Compartir página / copiar enlace', ''],
  ['view-source', 'Ver código DOM actual', ''],
  ['pin-tab', 'Fijar/desfijar pestaña', ''],
  ['mute-tab', 'Silenciar/activar sonido', ''],
  ...Array.from({ length: 9 }, (_, i) => [
    `tab-${i + 1}`,
    i === 8 ? 'Última pestaña' : `Ir a pestaña ${i + 1}`,
    `Ctrl+${i + 1}`,
  ]),
  ['escape', 'Cerrar herramienta', 'Escape'],
].map(([id, label, shortcut]) => ({ id, label, shortcut }));
export const COMMANDS = COMMAND_DEFS.map((c) => c.id);
export const DEFAULT_BINDINGS = Object.fromEntries(
  COMMAND_DEFS.filter((c) => c.shortcut).map((c) => [c.id, c.shortcut]),
);
export const TOOLBAR_COMMANDS = [
  'home',
  'downloads',
  'bookmarks',
  'history',
  'screenshot',
  'translate',
  'reader',
  'split',
  'memory',
  'workspaces',
  'work-dossier',
  'extensions',
  'settings',
];
const aliases = {
  arrowleft: 'Left',
  arrowright: 'Right',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  '+': 'Plus',
  add: 'Plus',
  plus: 'Plus',
  '=': 'Plus',
  equals: 'Plus',
  '-': 'Minus',
  subtract: 'Minus',
  minus: 'Minus',
  ',': 'Comma',
  comma: 'Comma',
};
function keyName(key) {
  const k = String(key || '').toLowerCase();
  return (
    aliases[k] ||
    (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(k)
      ? k.toUpperCase()
      : /^[a-z0-9]$/.test(k)
        ? k.toUpperCase()
        : null)
  );
}
export function bindingForEvent(event, platform = 'linux') {
  const key = keyName(event?.key);
  if (!key) return null;
  const ctrl = Boolean(
    platform === 'darwin'
      ? (event.metaKey ?? event.meta)
      : (event.ctrlKey ?? event.control),
  );
  const alt = Boolean(event.altKey ?? event.alt);
  const shift = Boolean(event.shiftKey ?? event.shift);
  if (ctrl && alt) return null; // AltGr pertenece a los campos de texto.
  // Plus ya incluye la tecla Shift en muchos teclados.
  return `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift && key !== 'Plus' ? 'Shift+' : ''}${key}`;
}
export function normalizeBinding(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 60) return null;
  const parts = value.split('+');
  const key = keyName(parts.pop());
  if (!key) return null;
  const modifiers = new Set(parts.map((p) => p.toLowerCase()));
  if ([...modifiers].some((m) => !['ctrl', 'alt', 'shift'].includes(m)))
    return null;
  if (modifiers.has('ctrl') && modifiers.has('alt')) return null;
  if (
    !modifiers.has('ctrl') &&
    !modifiers.has('alt') &&
    !['F3', 'F11', 'Escape'].includes(key)
  )
    return null;
  if (
    (modifiers.has('alt') && key === 'F4') ||
    (modifiers.has('ctrl') && key === 'Escape')
  )
    return null;
  if (
    modifiers.has('ctrl') &&
    ['C', 'V', 'X', 'A', 'Z', 'Y', 'Q'].includes(key)
  )
    return null;
  return `${modifiers.has('ctrl') ? 'Ctrl+' : ''}${modifiers.has('alt') ? 'Alt+' : ''}${modifiers.has('shift') && key !== 'Plus' ? 'Shift+' : ''}${key}`;
}
export function shortcutConflicts(overrides = {}) {
  const bindings = { ...DEFAULT_BINDINGS, ...overrides };
  const owners = new Map();
  const errors = [];
  for (const [command, raw] of Object.entries(bindings)) {
    if (!COMMANDS.includes(command)) {
      errors.push(`Comando desconocido: ${command}`);
      continue;
    }
    const key = normalizeBinding(raw);
    if (key === null) {
      errors.push(`Combinación no permitida: ${raw}`);
      continue;
    }
    if (!key) continue;
    if (owners.has(key)) errors.push(`${key}: ${owners.get(key)} / ${command}`);
    else owners.set(key, command);
  }
  return errors;
}
export function commandFor(event, opts = {}) {
  const binding = bindingForEvent(event, opts.platform);
  if (!binding) return null;
  const bindings = { ...DEFAULT_BINDINGS, ...opts.bindings };
  return (
    Object.keys(bindings).find(
      (id) => normalizeBinding(bindings[id]) === binding,
    ) || null
  );
}
export function acceleratorFor(command, platform = 'linux', overrides = {}) {
  const value = { ...DEFAULT_BINDINGS, ...overrides }[command] || '';
  const key = value.replace(/(^|\+)Comma$/, '$1,');
  return platform === 'darwin' ? key.replace(/^Ctrl\+/, 'Command+') : key;
}

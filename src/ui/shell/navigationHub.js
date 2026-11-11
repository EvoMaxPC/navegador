import { navigationTabs, navigationMatches, navigationLocation } from './navigationModel.js';

const MENU_SECTIONS = [
  ['NAVEGAR', [['new-tab', 'Nueva pestaña', 'Un nuevo lugar para explorar'], ['tab-search', 'Buscar pestañas', 'Encontrá cualquier página abierta'], ['reopen-tab', 'Reabrir pestaña cerrada', 'Volvé a donde estabas']]],
  ['TU BIBLIOTECA', [['bookmarks', 'Favoritos', 'Las páginas que querés conservar'], ['history', 'Historial', 'Retomá una visita anterior'], ['downloads', 'Descargas', 'Archivos, progreso y ubicación']]],
  ['TRABAJAR MEJOR', [['workspaces', 'Espacios de trabajo', 'Separá tus proyectos'], ['split', 'Vista dividida', 'Consultá dos pestañas a la vez'], ['reader', 'Modo lectura', 'Concentrate en el texto'], ['screenshot', 'Capturar página', 'Guardá el área visible']]],
  ['NEXO Y PREFERENCIAS', [['memory', 'EVO Memory', 'Tu memoria de conversación'], ['tokenizer', 'Tokenizador', 'Contá el texto localmente', 'panel'], ['command-center', 'Todos los comandos', 'Buscá herramientas y atajos'], ['settings', 'Ajustes', 'Personalizá tu navegador', 'panel']]],
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function action(label, className, callback) {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

/** Centro de navegación de la shell: usa las pestañas/acciones reales existentes. */
export function createNavigationHub({ state, createTab, activateTab, closeTab, runCommand, openPanel = () => {}, getWorkspace, workspaceName, shortcut, scheduleSessionCapture }) {
  const modal = element('dialog', 'navigation-hub');
  modal.id = 'navigationHub';
  modal.setAttribute('aria-labelledby', 'navigationHubTitle');
  document.body.append(modal);
  const trigger = document.getElementById('tabSearchButton');
  const menuTrigger = document.getElementById('browserMenuButton');
  let mode = 'tabs', query = '', currentOnly = false, closed = false, returnFocus = null, search, results, status;
  let renderPending = false;

  function close() { if (modal.open) modal.close(); }
  modal.addEventListener('close', () => {
    trigger.setAttribute('aria-expanded', 'false');
    menuTrigger.setAttribute('aria-expanded', 'false');
    if (returnFocus?.isConnected) returnFocus.focus();
  });
  modal.addEventListener('click', event => {
    if (event.target !== modal) return;
    const r = modal.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
  });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (document.activeElement === search && ['Home', 'End'].includes(event.key)) return;
    if (document.activeElement?.tagName === 'SELECT') return;
    const buttons = [...results.querySelectorAll('[data-result]')];
    if (!buttons.length) return;
    const active = document.activeElement;
    if (active !== search && !buttons.includes(active)) return;
    event.preventDefault();
    let index = buttons.indexOf(active);
    index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index].focus();
  });

  function execute(type) {
    close();
    runCommand({ type });
  }
  function header(title, subtitle) {
    const heading = element('header', 'hub-heading');
    const copy = element('div');
    copy.append(element('p', 'hub-eyebrow', 'NEXO / NAVIGATION'), element('h2', '', title));
    copy.querySelector('h2').id = 'navigationHubTitle';
    copy.append(element('p', 'hub-subtitle', subtitle));
    const dismiss = action('×', 'hub-dismiss', close);
    dismiss.setAttribute('aria-label', 'Cerrar centro de navegación');
    heading.append(copy, dismiss);
    modal.append(heading);
  }
  function emptyState(title, detail) {
    const empty = element('div', 'hub-empty');
    empty.append(element('strong', '', title), element('p', '', detail));
    results.append(empty);
  }
  function renderTabs() {
    const focused = document.activeElement;
    const focusedId = focused?.dataset?.tabId;
    const focusedAction = focused?.dataset?.rowAction;
    const previousIndex = [...results.querySelectorAll('[data-result]')].indexOf(focused);
    results.replaceChildren();
    const scope = getWorkspace();
    const records = closed ? [...state.closed].reverse().filter(tab => (!currentOnly || (tab.workspaceId || 'main') === scope) && navigationMatches(tab, query, workspaceName(tab.workspaceId || 'main'))) :
      navigationTabs(state.tabs.values(), { query, workspace: scope, currentOnly, workspaceName });
    status.textContent = `${records.length} ${closed ? 'cerradas recientemente' : 'pestañas encontradas'}${currentOnly ? ' en este espacio' : ' en todos los espacios'}`;
    if (!records.length) emptyState(query ? 'No encontramos esa pestaña' : closed ? 'No hay pestañas cerradas' : 'Un espacio para empezar', query ? 'Probá otro título, dirección o nombre de espacio.' : closed ? 'Las últimas 25 pestañas que cierres en esta sesión aparecerán aquí.' : 'Abrí una página con el botón Nueva pestaña.');
    for (const tab of records) {
      const row = element('div', `hub-tab-row${!closed && tab.id === state.activeId ? ' is-active' : ''}`);
      const pick = action('', 'hub-tab-main', () => {
        close();
        if (closed) {
          // La referencia, no el texto/URL, identifica el registro de cierre.
          const index = state.closed.indexOf(tab);
          if (index < 0) return;
          createTab(tab.url, { workspaceId: tab.workspaceId || 'main', pinned: tab.pinned });
          state.closed.splice(index, 1);
          scheduleSessionCapture();
        } else if (state.tabs.has(tab.id)) activateTab(tab.id);
      });
      pick.dataset.result = '';
      if (tab.id) pick.dataset.tabId = tab.id;
      const mark = element('span', 'hub-page-mark', closed ? '↶' : tab.pinned ? '◆' : (tab.title || 'N').slice(0, 1).toLocaleUpperCase());
      mark.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'hub-tab-copy');
      copy.append(element('strong', '', tab.title || 'Sin título'), element('small', '', navigationLocation(tab.url)));
      const meta = element('span', 'hub-tab-meta');
      meta.append(element('span', 'hub-space', workspaceName(tab.workspaceId || 'main')));
      if (!closed && tab.id === state.activeId) meta.append(element('span', 'hub-state', 'Actual'));
      if (tab.pinned) meta.append(element('span', 'hub-state', 'Fijada'));
      if (tab.muted) meta.append(element('span', 'hub-state', 'Sin sonido'));
      pick.append(mark, copy, meta);
      pick.title = `${tab.title || 'Sin título'} — ${navigationLocation(tab.url)}`;
      row.append(pick);
      if (!closed) {
        const dismiss = action('×', 'hub-row-close', () => {
          if (state.tabs.has(tab.id)) closeTab(tab.id);
          renderTabs();
        });
        dismiss.dataset.tabId = tab.id;
        dismiss.dataset.rowAction = 'close';
        dismiss.setAttribute('aria-label', `Cerrar ${tab.title || 'pestaña'}`);
        row.append(dismiss);
      }
      results.append(row);
    }
    if (focusedId) {
      const candidates = [...results.querySelectorAll(focusedAction ? '.hub-row-close' : '[data-result]')];
      (candidates.find(button => button.dataset.tabId === focusedId) || candidates[Math.max(0, Math.min(previousIndex, candidates.length - 1))] || search).focus();
    }
  }
  function showTabs() {
    header('Tus pestañas, en un lugar', 'Buscá, cambiá de espacio o recuperá una página cerrada.');
    const controls = element('div', 'hub-controls');
    const segments = element('div', 'hub-segments');
    segments.setAttribute('role', 'group');
    segments.setAttribute('aria-label', 'Tipo de pestañas');
    const opened = action('Abiertas', '', () => select(false));
    const recent = action('Cerradas recientemente', '', () => select(true));
    const select = value => {
      closed = value;
      opened.setAttribute('aria-pressed', String(!closed));
      recent.setAttribute('aria-pressed', String(closed));
      renderTabs();
    };
    segments.append(opened, recent);
    const scopeLabel = element('label', 'hub-scope');
    scopeLabel.append(element('span', '', 'Mostrar'));
    const scope = element('select');
    scope.setAttribute('aria-label', 'Filtrar pestañas por espacio');
    for (const [value, title] of [['all', 'Todos los espacios'], ['current', 'Este espacio']]) {
      const option = element('option', '', title); option.value = value; scope.append(option);
    }
    scope.value = currentOnly ? 'current' : 'all';
    scope.addEventListener('change', () => { currentOnly = scope.value === 'current'; renderTabs(); });
    scopeLabel.append(scope);
    controls.append(segments, scopeLabel);
    search = element('input', 'hub-search');
    search.type = 'search'; search.placeholder = 'Buscar por título, dirección o espacio…';
    search.setAttribute('aria-label', 'Buscar pestañas abiertas o cerradas');
    search.setAttribute('aria-controls', 'navigationHubResults');
    search.autocomplete = 'off'; search.spellcheck = false;
    search.addEventListener('input', () => { query = search.value; renderTabs(); });
    search.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); results.querySelector('[data-result]')?.click(); }
    });
    status = element('p', 'hub-result-count');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    results = element('div', 'hub-results'); results.id = 'navigationHubResults';
    const footer = element('footer', 'hub-footer');
    footer.append(element('span', '', '↑ ↓ recorrer · Enter abrir · Esc cerrar'), action('+ Nueva pestaña', 'hub-primary', () => execute('new-tab')));
    modal.append(controls, search, status, results, footer);
    select(false);
  }
  function showMenu() {
    header('Tu navegador, a mano', 'Las herramientas esenciales, sin buscar entre paneles.');
    search = null;
    results = element('div', 'hub-menu-grid');
    for (const [title, items] of MENU_SECTIONS) {
      const section = element('section', 'hub-menu-section');
      section.append(element('h3', '', title));
      for (const [type, label, detail, kind] of items) {
        if (kind === 'panel') {
          const item = action('', 'hub-menu-action', () => { close(); openPanel(type); });
          item.dataset.result = '';
          const copy = element('span');
          copy.append(element('strong', '', label), element('small', '', detail));
          item.append(copy);
          section.append(item);
          continue;
        }
        const item = action('', 'hub-menu-action', () => execute(type));
        item.dataset.result = '';
        const copy = element('span');
        copy.append(element('strong', '', label), element('small', '', detail));
        item.append(copy);
        const binding = shortcut(type);
        if (binding) item.append(element('kbd', '', binding.replace('Command', '⌘')));
        if (type === 'reopen-tab') item.disabled = !state.closed.length;
        if (['reader', 'screenshot'].includes(type)) item.disabled = !state.tabs.size;
        section.append(item);
      }
      results.append(section);
    }
    modal.append(results, element('footer', 'hub-footer', 'Las funciones usan este perfil local. Un espacio de trabajo no es una sesión privada.'));
  }
  function open(nextMode) {
    for (const other of document.querySelectorAll('dialog[open]')) if (other !== modal) other.close();
    if (modal.open) modal.close();
    returnFocus = document.activeElement;
    mode = nextMode; query = ''; closed = false;
    modal.replaceChildren();
    if (mode === 'tabs') showTabs(); else showMenu();
    modal.showModal();
    trigger.setAttribute('aria-expanded', String(mode === 'tabs'));
    menuTrigger.setAttribute('aria-expanded', String(mode === 'menu'));
    (search || results.querySelector('button'))?.focus();
  }
  function refresh() {
    const count = state.tabs.size;
    document.getElementById('tabCount').textContent = String(count);
    trigger.setAttribute('aria-label', `Buscar entre ${count} pestañas`);
    if (!modal.open || mode !== 'tabs' || renderPending) return;
    renderPending = true;
    queueMicrotask(() => { renderPending = false; if (modal.open && mode === 'tabs') renderTabs(); });
  }
  trigger.addEventListener('click', () => open('tabs'));
  menuTrigger.addEventListener('click', () => open('menu'));
  return {
    refresh,
    open,
    handle(command) {
      if (command.type === 'tab-search') { open('tabs'); return true; }
      if (command.type === 'browser-menu') { open('menu'); return true; }
      if (command.type === 'escape' && modal.open) { close(); return true; }
      // Los demás diálogos no deben quedar encima de este.
      if (modal.open && ['command-center', 'workspaces', 'workspace-new', 'toolbar-settings', 'keyboard-settings', 'reader', 'split'].includes(command.type)) close();
      return false;
    },
  };
}

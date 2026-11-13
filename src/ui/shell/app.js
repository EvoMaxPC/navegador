import { createTokenizerPanel } from './tokenizerPanel.js';
import { tokenCounterView } from './tokenCounterView.js';
import { createWormholeChrome } from './wormholeChrome.js';
import { createRepetitionView } from './repetition.js';
import { isEvoMemoryEnabled } from '../../core/settings.js';
import { createUnderstandingPanel } from './understandingPanel.js';
import { createWorkDossier } from './workDossier.js';
import { createBrowserTools } from './browserTools.js';
import { createNavigationHub } from './navigationHub.js';
import { createPromptLibrary } from './promptLibrary.js';
import { adjacentNavigationTab, workspaceScopedTabs } from './navigationModel.js';
import { createMemoryPanel, memoryReadout, setMemoryPanelAvailability } from './memoryPanel.js';
import { readMemoryConversation, sameConversationSource } from './chatgptDirect.js';
import { isChatGptMemoryUrl } from '../../core/chatgptConversation.js';
/**
 * Interfaz de navegador de Nexo.
 *
 * Las pestañas son `<webview>` reales de Chromium. La shell no habla con los
 * sitios: solo orquesta pestañas, ajustes y el panel de intervenciones que el
 * proceso principal le empuja por IPC.
 */

import { createFrameQueue } from './scheduler.js';
import { navigationStatus, safeFaviconUrl } from './security.js';
import { SITES } from '../../core/sites.js';
import { displayUrl, hostOf, resolveInput } from '../../nav/url.js';
import { ZOOM_STEPS, clampZoom, zoomLabel } from '../../nav/zoom.js';
import { acceleratorFor } from '../../nav/shortcuts.js';

const nexo = window.nexo;
const uiTasks = createFrameQueue();
const isPanelActive = (name) => els.browser.classList.contains('with-sidebar') && document.querySelector(`.stab[data-panel="${name}"]`)?.classList.contains('active');

const els = {
  browser: document.querySelector('.browser'),
  tabs: document.getElementById('tabs'),
  viewport: document.getElementById('viewport'),
  omnibox: document.getElementById('omnibox'),
  omniboxForm: document.getElementById('omniboxForm'),
  back: document.getElementById('back'),
  forward: document.getElementById('forward'),
  reload: document.getElementById('reload'),
  newTab: document.getElementById('newTab'),
  toggleSidebar: document.getElementById('toggleSidebar'),
  sites: document.getElementById('sites'),
  enginePill: document.getElementById('enginePill'),
  enginePillText: document.getElementById('enginePillText'),
  log: document.getElementById('log'),
  stats: {
    messages: document.getElementById('statMessages'),
    responses: document.getElementById('statResponses'),
    turnsCancelled: document.getElementById('statTurnsCancelled'),
    turnsFailed: document.getElementById('statTurnsFailed'),
    turnsPerformed: document.getElementById('statTurnsPerformed'),
    inTokens: document.getElementById('statInTokens'),
    outTokens: document.getElementById('statOutTokens'),
    interventions: document.getElementById('statInterventions'),
    capture: document.getElementById('captureLine'),
    coverage: document.getElementById('inputTokenCoverage'),
  },
  sidebar: document.getElementById('sidebar'),
  connection: document.getElementById('connectionIndicator'),
  panelTitle: document.getElementById('panelTitle'),
  closeSidebar: document.getElementById('closeSidebar'),
  suggestions: document.getElementById('suggestions'),
  bookmarkBtn: document.getElementById('bookmarkBtn'),
  findbar: document.getElementById('findbar'),
  findInput: document.getElementById('findInput'),
  findCount: document.getElementById('findCount'),
  findPrev: document.getElementById('findPrev'),
  findNext: document.getElementById('findNext'),
  findClose: document.getElementById('findClose'),
  historySearch: document.getElementById('historySearch'),
  historySearchForm: document.getElementById('historySearchForm'),
  historyList: document.getElementById('historyList'),
  historyRange: document.getElementById('historyRange'),
  historyClear: document.getElementById('historyClear'),
  historyNote: document.getElementById('historyNote'),
  bookmarkSearch: document.getElementById('bookmarkSearch'),
  bookmarkSearchForm: document.getElementById('bookmarkSearchForm'),
  bookmarkList: document.getElementById('bookmarkList'),
  bookmarkCurrent: document.getElementById('bookmarkCurrent'),
  downloadList: document.getElementById('downloadList'),
  downloadNote: document.getElementById('downloadNote'),
  downloadsClear: document.getElementById('downloadsClear'),
  siteHost: document.getElementById('siteHost'),
  permissionList: document.getElementById('permissionList'),
  zoomValue: document.getElementById('zoomValue'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  zoomReset: document.getElementById('zoomReset'),
  profileNote: document.getElementById('profileNote'),
  clearHistoryData: document.getElementById('clearHistoryData'),
  clearCookies: document.getElementById('clearCookies'),
  clearBookmarksData: document.getElementById('clearBookmarksData'),
  clearEverything: document.getElementById('clearEverything'),
};

const DEMO_URL = 'nexo://app/demo/index.html';
const START_URL = 'nexo://app/src/ui/start/index.html';
const SEARCH = 'https://duckduckgo.com/?q=';

let browserTools = null;
let workPanel = null;
let understandingPanel = null;
let visualChrome = null;
let navigationHub = null;
let promptLibrary = null;
const state = {
  tabs: new Map(),
  activeId: null,
  seq: 0,
  config: null,
  settings: null,
  logs: [],
  /** Pestañas cerradas, para reabrir con Ctrl+Shift+T. */
  closed: [],
  /** Última consulta de sugerencias, para no pisar respuestas viejas. */
  suggestToken: 0,
  find: { active: false, query: '' },
};

/* ------------------------------------------------------------------ */
/* utilidades                                                          */
/* ------------------------------------------------------------------ */

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// La resolución de lo escrito en la barra vive en `src/nav/url.js`: una sola
// implementación para la interfaz, el proceso principal y las pruebas.
const normalizeInput = (text) => resolveInput(text, { searchBase: browserTools?.searchBase || SEARCH });

const SITE_CHIPS = [
  { label: 'ChatGPT', url: 'https://chatgpt.com', color: '#10a37f' },
  { label: 'Claude', url: 'https://claude.ai', color: '#d97757' },
  { label: 'Gemini', url: 'https://gemini.google.com', color: '#4285f4' },
  { label: 'Perplexity', url: 'https://www.perplexity.ai', color: '#20b8cd' },
  { label: 'DeepSeek', url: 'https://chat.deepseek.com', color: '#4d6bfe' },
  { label: 'Copilot', url: 'https://copilot.microsoft.com', color: '#0f6cbd' },
  { label: 'Le Chat', url: 'https://chat.mistral.ai', color: '#fa520f' },
];

/* ------------------------------------------------------------------ */
/* pestañas                                                            */
/* ------------------------------------------------------------------ */

function createTab(url = START_URL, { activate = true, workspaceId = browserTools?.workspace || 'main', pinned = false } = {}) {
  workspaceId = browserTools?.resolveWorkspace(workspaceId) || workspaceId;
  const id = `tab-${(state.seq += 1)}`;

  const view = document.createElement('webview');
  view.className = 'hidden';
  view.setAttribute('partition', 'persist:nexo');
  view.setAttribute('allowpopups', 'true');
  view.setAttribute('src', url);
  if (state.config?.pagePreload) view.preload = state.config.pagePreload;
  els.viewport.appendChild(view);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.id = id;
  tabEl.id = `${id}-label`;
  tabEl.setAttribute('aria-keyshortcuts', 'Delete Control+w');
  tabEl.setAttribute('role', 'tab');
  tabEl.setAttribute('tabindex', '-1');
  tabEl.setAttribute('aria-selected', 'false');
  tabEl.setAttribute('aria-controls', `${id}-view`);
  view.id = `${id}-view`;
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', tabEl.id);
  tabEl.innerHTML = `
    <span class="favicon">◆</span>
    <span class="title">Cargando…</span>
    <span class="cut-dot" hidden></span>
    <span class="close" title="Cerrar pestaña (Supr o Ctrl+W)" aria-hidden="true">×</span>`;

  tabEl.addEventListener('click', (event) => {
    if (event.target.classList.contains('close')) return;
    activateTab(id);
  });
  tabEl.querySelector('.close').addEventListener('click', (event) => {
    event.stopPropagation();
    closeTab(id);
  });

  tabEl.addEventListener('keydown', (event) => {
    if (event.key === 'Delete') {
      event.preventDefault(); closeTab(id); activeTab()?.tabEl.focus(); return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (event.target.classList.contains('close')) return;
    event.preventDefault();
    // Recorre sólo las pestañas del espacio visible y en el orden que se ve,
    // no el orden de creación con pestañas de otros espacios mezcladas.
    const ids = (browserTools ? browserTools.visibleTabs() : workspaceScopedTabs(state.tabs.values())).map(t => t.id);
    const next = adjacentNavigationTab(ids, id, event.key);
    if (!next || !state.tabs.has(next)) return;
    activateTab(next);
    state.tabs.get(next)?.tabEl.focus();
  });
  els.tabs.appendChild(tabEl);

  const tab = { id, view, tabEl, url, title: 'Nueva pestaña', cut: 0, workspaceId, pinned, muted:false };
  tabEl.addEventListener('contextmenu', event => browserTools?.tabMenu(tab,event));
  state.tabs.set(id, tab);

  const titleEl = tabEl.querySelector('.title');
  const faviconEl = tabEl.querySelector('.favicon');
  const setTitle = (text) => {
    tab.title = text || 'Sin título';
    titleEl.textContent = tab.title;
    titleEl.title = tab.title;
    navigationHub?.refresh();
  };

  view.addEventListener('page-title-updated', (event) => setTitle(event.title));
  // Tiempo hasta que la pestaña está usable: es lo que el usuario espera ver.
  if (state.seq === 1) {
    view.addEventListener('dom-ready', () => reportarMedidas({ 'tab-dom': Number(performance.now().toFixed(1)) }));
    view.addEventListener('did-finish-load', () =>
      reportarMedidas({ 'tab-load': Number(performance.now().toFixed(1)) }),
    );
  }
  view.addEventListener('did-navigate', (event) => {
    tab.url = event.url;
    if (state.activeId === id) {
      els.omnibox.value = event.url; updateNavigation();
      if (isPanelActive('understanding')) understandingPanel?.changed();
      if (isPanelActive('memory')) uiTasks.schedule('memory', refreshMemory);
    }
  });
  view.addEventListener('did-navigate-in-page', (event) => {
    tab.url = event.url;
    if (state.activeId === id) {
      els.omnibox.value = event.url; updateNavigation();
      if (isPanelActive('understanding')) understandingPanel?.changed();
      if (isPanelActive('memory')) uiTasks.schedule('memory', refreshMemory);
    }
  });
  view.addEventListener('page-favicon-updated', (event) => {
    const icon = safeFaviconUrl(event.favicons?.[0]);
    if (!icon) { faviconEl.textContent = '◆'; return; }
    const image = document.createElement('img');
    image.alt = ''; image.referrerPolicy = 'no-referrer'; image.src = icon;
    image.addEventListener('error', () => { faviconEl.textContent = '◆'; }, { once: true });
    faviconEl.replaceChildren(image);
  });
  view.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return; // navegación cancelada
    setTitle('No se pudo cargar');
  });

  // Buscador en la página: el recuento lo informa el propio Chromium.
  view.addEventListener('found-in-page', (event) => {
    const result = event.result || {};
    if (result.matches === 0) els.findCount.textContent = 'sin resultados';
    else els.findCount.textContent = `${result.activeMatchOrdinal} de ${result.matches}`;
  });

  view.addEventListener('did-start-loading', () => {
    if(state.activeId===id)browserTools?.clearContext();
    tabEl.classList.add('loading');
    tabEl.classList.remove('loaded');
  });
  view.addEventListener('did-stop-loading', () => {
    tabEl.classList.remove('loading');
    tabEl.classList.add('loaded');
    if (state.activeId === id) {
      updateStar();
      if (isPanelActive('sites')) renderSitePanel();
      if (isPanelActive('understanding')) understandingPanel?.changed();
      if (isPanelActive('memory')) uiTasks.schedule('memory', refreshMemory);
    }
    scheduleSessionCapture();
  });

  view.addEventListener('did-navigate', () => scheduleSessionCapture());
  view.addEventListener('page-title-updated', () => scheduleSessionCapture());

  if (activate) activateTab(id);
  browserTools?.refreshLayout();
  navigationHub?.refresh();
  updateWelcome();
  return tab;
}

function activateTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  state.activeId = id;
  for (const [otherId, other] of state.tabs) {
    const active = otherId === id;
    other.tabEl.classList.toggle('active', active);
    other.tabEl.setAttribute('aria-selected', String(active));
    other.tabEl.tabIndex = active ? 0 : -1;
    other.view.classList.toggle('hidden', !active);
  }
  els.omnibox.value =
    tab.url === DEMO_URL ? 'Sala de pruebas de Nexo'
      : tab.url === START_URL ? ''
        : displayUrl(tab.url);
  tab.cut = 0;
  tab.tabEl.querySelector('.cut-dot').hidden = true;
  hideSuggestions();
  updateStar();
  updateNavigation();
  refreshFollowUp?.();
  if (isPanelActive('sites')) renderSitePanel();
  if (isPanelActive('memory')) uiTasks.schedule('memory', refreshMemory);
  browserTools?.activated(tab);
  workPanel?.workspaceChanged();
  understandingPanel?.changed();
  scheduleSessionCapture();
}

function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  state.closed.push({ url: tab.url, title: tab.title, workspaceId:tab.workspaceId, pinned:tab.pinned });
  if (state.closed.length > 25) state.closed.shift();
  tab.view.remove();
  tab.tabEl.remove();
  state.tabs.delete(id);

  if (state.activeId === id) {
    const next = browserTools ? browserTools.visibleTabs().at(-1)?.id : [...state.tabs.keys()].pop();
    if (next) activateTab(next);
    else state.activeId = null;
  }
  browserTools?.refreshLayout();
  navigationHub?.refresh();
  updateWelcome();
  scheduleSessionCapture();
}

/** Cambia de pestaña en orden circular. */
function cycleTab(delta) {
  const ids = browserTools ? browserTools.visibleTabs().map(t=>t.id) : [...state.tabs.keys()];
  if (ids.length < 2) return;
  const index = ids.indexOf(state.activeId);
  const next = ids[(index + delta + ids.length) % ids.length];
  activateTab(next);
}

/** Reabre la última pestaña cerrada (Ctrl+Shift+T). */
function reopenTab() {
  const last = state.closed.pop();
  if (!last) return null;
  return createTab(last.url,{workspaceId:last.workspaceId,pinned:last.pinned});
}

function activeTab() {
  return state.tabs.get(state.activeId) || null;
}

function updateWelcome() {
  const existing = els.viewport.querySelector('.welcome');
  if (state.tabs.size === 0 && !existing) {
    const div = document.createElement('div');
    div.className = 'welcome';
    div.innerHTML = `
      <div>
        <h1>Nexo</h1>
        <p>Elegí un sitio de IA en la barra superior o abrí la <b>sala de pruebas</b> para ver el motor en acción.</p>
      </div>`;
    els.viewport.appendChild(div);
  }
  if (state.tabs.size > 0 && existing) existing.remove();
}

function navigate(url) {
  const target = normalizeInput(url);
  if (!target) return;

  // Si no hay pestaña, `createTab` ya la abre en esa URL: cargarla otra vez
  // duplicaría la petición y el historial.
  if (!activeTab()) {
    createTab(target);
    return;
  }

  const tab = activeTab();
  tab.url = target;
  if (typeof tab.view.loadURL === 'function') tab.view.loadURL(target);
  else tab.view.setAttribute('src', target);
}

/* ------------------------------------------------------------------ */
/* navegación                                                          */
/* ------------------------------------------------------------------ */

els.omniboxForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const chosen = els.suggestions.querySelector('.suggestion.active');
  const target = chosen?.dataset.url || els.omnibox.value;
  els.omnibox.blur();
  hideSuggestions();
  navigate(target);
});

els.back.addEventListener('click', () => activeTab()?.view.canGoBack?.() && activeTab().view.goBack());
els.forward.addEventListener('click', () => activeTab()?.view.canGoForward?.() && activeTab().view.goForward());
els.reload.addEventListener('click', () => activeTab()?.view.reload());
els.newTab.addEventListener('click', () => createTab(START_URL));

els.toggleSidebar.addEventListener('click', () => {
  const open = !els.browser.classList.contains('with-sidebar');
  setSidebar(open);
});

function setSidebar(open) {
  if (!open && visualChrome?.mode === 'fixed') return;
  els.browser.classList.toggle('with-sidebar', open);
  els.toggleSidebar.setAttribute('aria-expanded', String(open));
  if (open) refreshActivePanel();
  browserTools?.refreshLayout();
}
els.closeSidebar.addEventListener('click', () => { setSidebar(false); els.toggleSidebar.focus(); });

function updateNavigation() {
  const tab = activeTab();
  els.back.disabled = !tab?.view.canGoBack?.();
  els.forward.disabled = !tab?.view.canGoForward?.();
  document.querySelector('[data-workspace-home]').classList.toggle('selected', tab?.url === START_URL);
  const status = navigationStatus(tab?.url);
  els.connection.dataset.kind = status.kind;
  els.connection.title = status.label;
  els.connection.setAttribute('aria-label', status.label);
}

/* ------------------------------------------------------------------ */
/* sitios                                                              */
/* ------------------------------------------------------------------ */

els.sites.innerHTML = SITE_CHIPS.map(
  (s) => `<button class="site-chip" data-url="${s.url}">
    <span class="mark" style="background:${s.color}"></span>${escapeHtml(s.label)}
  </button>`,
).join('');

els.sites.addEventListener('click', (event) => {
  const chip = event.target.closest('.site-chip');
  if (!chip) return;
  const url = chip.dataset.url;
  const tab = activeTab();
  if (tab) {
    tab.url = url;
    tab.view.loadURL ? tab.view.loadURL(url) : tab.view.setAttribute('src', url);
  } else {
    createTab(url);
  }
});

/* ------------------------------------------------------------------ */
/* navegador: historial, marcadores, descargas, sitio, zoom, sesión     */
/* ------------------------------------------------------------------ */

let sessionTimer = null;

/** La sesión se guarda con retardo: navegar no debe escribir en disco. */
function scheduleSessionCapture() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const tabs = [...state.tabs.values()].map((tab) => ({ url: tab.url, title: tab.title, pinned:tab.pinned, workspaceId:tab.workspaceId }));
    if (!tabs.length) return;
    const activeIndex = Math.max(0, [...state.tabs.keys()].indexOf(state.activeId));
    nexo.session.capture([{ tabs, activeIndex }]).catch(() => {});
  }, 500);
}

/* ---------------- barra: sugerencias ---------------- */

let suggestTimer = null;

function hideSuggestions() {
  state.suggestToken += 1;
  els.suggestions.hidden = true;
  els.omnibox.setAttribute('aria-expanded', 'false');
  els.omnibox.removeAttribute('aria-activedescendant');
  els.suggestions.innerHTML = '';
}

function renderSuggestions(items) {
  if (!items.length) return hideSuggestions();
  els.suggestions.innerHTML = items
    .map(
      (item, index) => `<button class="suggestion" data-url="${escapeHtml(item.url)}" data-index="${index}" id="suggestion-${index}" role="option" aria-selected="false">
        <span class="s-kicker">${item.kind === 'bookmark' ? '★' : item.kind === 'top' ? '↑' : '↺'}</span>
        <span class="s-title">${escapeHtml(item.title || item.url)}</span>
        <span class="s-url">${escapeHtml(displayUrl(item.url))}</span>
      </button>`,
    )
    .join('');
  els.suggestions.hidden = false;
  els.omnibox.setAttribute('aria-expanded', 'true');
}

async function loadSuggestions() {
  const query = els.omnibox.value.trim();
  if (!query) return hideSuggestions();
  const token = (state.suggestToken += 1);
  try {
    const items = await nexo.suggest(query);
    if (token !== state.suggestToken) return; // llegó tarde: no pisar
    renderSuggestions(items);
  } catch {
    hideSuggestions();
  }
}

els.omnibox.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(loadSuggestions, 120);
});

els.omnibox.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 140);
});

// Teclado en la barra: bajar a la lista, elegir y volver a escribir.
els.omnibox.addEventListener('keydown', (event) => {
  const options = [...els.suggestions.querySelectorAll('.suggestion')];
  if (!options.length) {
    if (event.key === 'Escape') hideSuggestions();
    return;
  }
  const activeIndex = options.findIndex((option) => option.classList.contains('active'));
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const next = (activeIndex + 1) % options.length;
    options.forEach((option, i) => { option.classList.toggle('active', i === next); option.setAttribute('aria-selected', String(i === next)); });
    els.omnibox.setAttribute('aria-activedescendant', options[next].id);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    const next = (activeIndex - 1 + options.length) % options.length;
    options.forEach((option, i) => { option.classList.toggle('active', i === next); option.setAttribute('aria-selected', String(i === next)); });
    els.omnibox.setAttribute('aria-activedescendant', options[next].id);
  } else if (event.key === 'Enter' && activeIndex >= 0) {
    event.preventDefault();
    els.omnibox.value = options[activeIndex].dataset.url;
    hideSuggestions();
    navigate(options[activeIndex].dataset.url);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    hideSuggestions();
  }
});

els.suggestions.addEventListener('mousedown', (event) => {
  const option = event.target.closest('.suggestion');
  if (!option) return;
  event.preventDefault();
  els.omnibox.value = option.dataset.url;
  hideSuggestions();
  navigate(option.dataset.url);
});

/* ---------------- marcadores ---------------- */

async function updateStar() {
  const tab = activeTab();
  const marked = tab && tab.url ? await nexo.bookmarks.is(tab.url) : false;
  els.bookmarkBtn.textContent = marked ? '★' : '☆';
  els.bookmarkBtn.classList.toggle('on', Boolean(marked));
  els.bookmarkBtn.setAttribute('aria-pressed', String(Boolean(marked)));
}

async function toggleBookmark() {
  const tab = activeTab();
  if (!tab || !tab.url) return;
  const result = await nexo.bookmarks.toggle({ url: tab.url, title: tab.title });
  await updateStar();
  renderBookmarks();
  if (result.added) pushLocalNotice(`Marcador guardado: ${tab.title}`);
}

function renderBookmarks() {
  const query = els.bookmarkSearch.value.trim();
  nexo.bookmarks.list(query ? { query } : {}).then((items) => {
    if (!items.length) {
      els.bookmarkList.innerHTML = '<li class="nav-empty">Sin marcadores todavía. Usá la estrella de la barra o Ctrl+D.</li>';
      return;
    }
    let folder = null;
    els.bookmarkList.innerHTML = items
      .map((item) => {
        const header = item.folder !== folder && !query ? `<li class="nav-folder">${escapeHtml(item.folder)}</li>` : '';
        folder = item.folder;
        return `${header}<li class="nav-item">
          <button class="nav-open" data-url="${escapeHtml(item.url)}" title="${escapeHtml(item.url)}">
            <span class="nav-title">${escapeHtml(item.title)}</span>
            <span class="nav-url">${escapeHtml(displayUrl(item.url))}</span>
          </button>
          <button class="nav-action" data-remove="${escapeHtml(item.id)}" title="Quitar marcador">×</button>
        </li>`;
      })
      .join('');
  });
}

/* ---------------- historial ---------------- */

function renderHistory() {
  const query = els.historySearch.value.trim();
  nexo.history.list({ query, limit: 200 }).then((items) => {
    if (!items.length) {
      els.historyList.innerHTML = '<li class="nav-empty">Sin resultados. Lo que navegues va a aparecer acá.</li>';
      els.historyNote.textContent = '';
      return;
    }
    const days = new Map();
    els.historyList.innerHTML = items
      .map((entry) => {
        const day = new Date(entry.ts).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
        const header = !query && !days.has(day) ? `<li class="nav-folder">${escapeHtml(day)}</li>` : '';
        days.set(day, true);
        const time = new Date(entry.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        return `${header}<li class="nav-item">
          <button class="nav-open" data-url="${escapeHtml(entry.url)}" title="${escapeHtml(entry.url)}">
            <span class="nav-title">${escapeHtml(entry.title)}</span>
            <span class="nav-url">${escapeHtml(displayUrl(entry.url))}</span>
          </button>
          <span class="nav-time">${time}</span>
        </li>`;
      })
      .join('');
    els.historyNote.textContent = `${items.length} ${items.length === 1 ? 'visita' : 'visitas'} mostradas.`;
  });
}

/* ---------------- descargas ---------------- */

function renderDownloads() {
  nexo.downloads.list().then((items) => {
    if (!items.length) {
      els.downloadList.innerHTML = '<li class="nav-empty">Sin descargas. Cuando bajes un archivo se va a ver acá con su progreso.</li>';
      els.downloadNote.textContent = '';
      return;
    }
    els.downloadList.innerHTML = items
      .map((item) => {
        const percent = item.totalBytes ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100)) : null;
        const label = item.paused ? 'pausada' : {
          started: 'iniciando',
          progress: item.paused ? 'pausada' : percent === null ? 'descargando' : `${percent} %`,
          completed: 'completada',
          cancelled: 'cancelada',
          interrupted: 'interrumpida',
        }[item.state];
        const actions = [];
        if(item.paused||item.canResume)actions.push(`<button class="nav-action" data-dl-operation="resume" data-id="${escapeHtml(item.id)}" title="Reanudar si el servidor lo permite">reanudar</button>`);
        else if(item.state==='started'||item.state==='progress')actions.push(`<button class="nav-action" data-dl-operation="pause" data-id="${escapeHtml(item.id)}" title="Pausar descarga">pausar</button>`);
        if(item.endedAt)actions.push(`<button class="nav-action" data-dl-operation="remove" data-id="${escapeHtml(item.id)}" title="Quitar del historial, sin borrar archivo">quitar</button>`);
        if (item.state === 'completed') {
          actions.push(`<button class="nav-action" data-open="${escapeHtml(item.id)}" title="Abrir archivo">abrir</button>`);
          actions.push(`<button class="nav-action" data-show="${escapeHtml(item.id)}" title="Mostrar en carpeta">carpeta</button>`);
        } else if (!item.endedAt) {
          actions.push(`<button class="nav-action" data-cancel="${escapeHtml(item.id)}" title="Cancelar">cancelar</button>`);
        }
        return `<li class="nav-item download ${escapeHtml(item.state)}">
          <div class="download-body">
            <span class="nav-title">${escapeHtml(item.filename)}</span>
            <span class="nav-url">${escapeHtml(item.host || '')} · ${escapeHtml(label)} · ${item.totalBytes ? (item.totalBytes/1048576).toFixed(2)+' MB' : 'tamaño desconocido'}</span>
            ${percent !== null && item.state !== 'completed' ? `<span class="bar"><span style="width:${percent}%"></span></span>` : ''}
          </div>
          <div class="download-actions">${actions.join('')}</div>
        </li>`;
      })
      .join('');
    els.downloadNote.textContent = 'Las descargas se ubican en la carpeta que elijas al bajarlas.';
  });
}

/* ---------------- transporte DOM compartido para EVO Memory ---------------- */
let memoryRefreshTicket = 0, memoryLiveRevision = 0;
function repetitionSource() {
  const tab = activeTab();
  if (!tab) return null;
  try {
    // El URL del webview es la fuente de verdad; tab.url puede quedar un evento
    // de navegación atrás y provocar que el snapshot no coincida.
    const href = tab.view.getURL();
    if (!isChatGptMemoryUrl(href)) return null;
    tab.url = href;
    return { webContentsId: tab.view.getWebContentsId(), href };
  } catch { return null; }
}
nexo.on('nexo:repetition-changed', (snapshot) => {
  const source = repetitionSource();
  // El mismo webContents puede cambiar hash/query durante el render de React.
  // La identidad de la pestaña es estable; validar además origen y ruta evita
  // aceptar un snapshot de otra conversación, sin perder el evento por esa carrera.
  if (!source || snapshot.webContentsId !== source.webContentsId) return;
  if (snapshot.href) {
    try {
      const incoming = new URL(snapshot.href);
      const current = new URL(source.href);
      if (incoming.origin !== current.origin || incoming.pathname !== current.pathname) return;
    } catch { return; }
  }
  memoryLiveRevision += 1;
  memState.liveSnapshot = isEvoMemoryEnabled(state.settings) && snapshot.href ? { ...snapshot, href: source.href } : null;
  if (isPanelActive('memory')) uiTasks.schedule('chat-capture', renderChatCapture);
});

/* ---------------- sitio actual: permisos y zoom ---------------- */

async function renderSitePanel() {
  const tab = activeTab();
  const host = tab && tab.url ? hostOf(tab.url) : '';
  els.siteHost.textContent = host || 'Ninguna página abierta';

  const level = tab ? await nexo.zoom.get(tab.url) : 1;
  els.zoomValue.textContent = zoomLabel(level);

  const rules = host ? await nexo.permissions.for(host) : [];
  els.permissionList.innerHTML = rules
    .map(
      (rule) => `<li class="perm-row">
        <span class="perm-label">${escapeHtml(rule.label)}</span>
        <select class="mini-select" data-permission="${escapeHtml(rule.permission)}" data-host="${escapeHtml(host)}">
          <option value="ask" ${rule.value === 'ask' ? 'selected' : ''}>preguntar</option>
          <option value="allow" ${rule.value === 'allow' ? 'selected' : ''}>permitir</option>
          <option value="deny" ${rule.value === 'deny' ? 'selected' : ''}>bloquear</option>
        </select>
      </li>`,
    )
    .join('');

  const stats = await nexo.profile.stats();
  if (stats) {
    els.profileNote.textContent =
      `${stats.history.total} visitas · ${stats.bookmarks} marcadores · ` +
      `${stats.downloads.total} descargas · ${stats.permissionSites} sitios con permisos propios.`;
  }
}

async function applyZoom(direction) {
  const tab = activeTab();
  if (!tab) return;
  const current = clampZoom(await nexo.zoom.get(tab.url));
  let next;
  if (direction === 0) {
    next = 1;
  } else {
    const index = ZOOM_STEPS.reduce((best, step, i) => (Math.abs(step - current) < Math.abs(ZOOM_STEPS[best] - current) ? i : best), 0);
    next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + Math.sign(direction)))];
  }
  await nexo.zoom.set(tab.url, next);
  try {
    tab.view.setZoomFactor(next);
  } catch {
    /* pestaña en carga */
  }
  els.zoomValue.textContent = zoomLabel(next);
}

/* ---------------- buscar en la página ---------------- */

function openFind() {
  els.findbar.hidden = false;
  state.find.active = true;
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) runFind(true);
}

function closeFind() {
  els.findbar.hidden = true;
  state.find.active = false;
  els.findCount.textContent = '';
  try {
    activeTab()?.view.stopFindInPage('clearSelection');
  } catch {
    /* nada que limpiar */
  }
}

function runFind(forward = true) {
  const tab = activeTab();
  const query = els.findInput.value;
  if (!tab || !query) {
    els.findCount.textContent = '';
    return;
  }
  try {
    tab.view.findInPage(query, { forward, findNext: true });
  } catch {
    els.findCount.textContent = '';
  }
}

/* ------------------------------------------------------------------ */
/* panel: registro                                                     */
/* ------------------------------------------------------------------ */

const KIND_LABEL = { sending: 'envío', receiving: 'recepción', context: 'contexto', system: 'sistema' };

function timeOf(ts) {
  try {
    return new Date(ts || Date.now()).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function interventionCount(entries) {
  // System/browser notices are not interventions in an AI conversation.
  return entries.filter((entry) => entry && entry.kind !== 'system').length;
}

function renderLog() {
  if (!state.logs.length) {
    els.log.innerHTML = '<li class="log-empty">Todavía no hubo intervenciones. Abrí un chat y escribí algo.</li>';
    return;
  }
  els.log.innerHTML = state.logs
    .slice(0, 80)
    .map(
      (e) => `<li class="log-item ${escapeHtml(e.severity || 'info')}">
        <div class="meta">
          <span class="kind ${escapeHtml(e.kind || '')}">${escapeHtml(KIND_LABEL[e.kind] || e.kind || 'nexo')}</span>
          <span class="time">${timeOf(e.ts)}</span>
        </div>
        <div class="title">${escapeHtml(e.title || e.code || '')}</div>
        ${e.detail ? `<div class="detail">${escapeHtml(e.detail)}</div>` : ''}
      </li>`,
    )
    .join('');
}

function pushLocalNotice(text, code = 'notice') {
  pushIntervention({
    kind: 'system',
    code,
    severity: 'info',
    title: text,
    ts: Date.now(),
  });
}

/**
 * Retira un aviso local ya mostrado.
 *
 * Se usa cuando la recuperación por DOM trae el texto del turno que se creía
 * cortado: el aviso dejó de ser cierto y no debe quedar en Actividad. No toca
 * las entradas del proceso principal (esas son su registro, no este aviso).
 */
function clearLocalNotice(code = 'notice') {
  const antes = state.logs.length;
  state.logs = state.logs.filter((entry) => !(entry.kind === 'system' && entry.code === code));
  if (state.logs.length === antes) return false;
  if (isPanelActive('activity')) uiTasks.schedule('log', renderLog);
  return true;
}

function pushIntervention(entry) {
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.length = 200;
  if (isPanelActive('activity')) uiTasks.schedule('log', renderLog);
  if (isPanelActive('memory')) uiTasks.schedule('memory', refreshMemory);

  // Marca la pestaña activa cuando hay un corte en vivo.
  if (entry.kind === 'receiving') {
    const tab = activeTab();
    if (tab) {
      tab.cut += 1;
      tab.tabEl.querySelector('.cut-dot').hidden = false;
    }
  }
}

// Un envío retenido es lo único que el usuario no puede deducir de la página:
// el mensaje no sale y no hay respuesta que lo explique. Se avisa en la franja
// de la shell, que nunca queda debajo del webview.
const AVISOS_RETENIDOS = new Set(['egress-net-block', 'egress-injected-block']);
const EGRESS_BAR_MS = 20_000;
let egressTimer = null;

function markActivityUnread() {
  const dot = document.querySelector('[data-activity-dot]');
  if (dot) dot.hidden = false;
}

function clearActivityUnread() {
  const dot = document.querySelector('[data-activity-dot]');
  if (dot) dot.hidden = true;
}

function dismissEgressNotice() {
  clearTimeout(egressTimer);
  egressTimer = null;
  const bar = document.getElementById('egressBar');
  if (bar) bar.hidden = true;
}

function showEgressNotice() {
  const bar = document.getElementById('egressBar');
  if (!bar) return;
  // Un bloqueo reemplaza al anterior: la barra es una sola y no se apila.
  bar.hidden = false;
  clearTimeout(egressTimer);
  egressTimer = setTimeout(dismissEgressNotice, EGRESS_BAR_MS);
}

document.getElementById('egressDismiss')?.addEventListener('click', dismissEgressNotice);

/** Formatea un número con separador de miles local (1.204, no 1204). */
function num(value) {
  return Number(value || 0).toLocaleString('es-AR');
}

/**
 * Una línea con lo que Nexo ve por sí mismo: si el vigilante de red está
 * registrado, cuántas peticiones pasaron y si el depurador está enganchado.
 * No son contadores de la conversación; son el estado del arnés de captura,
 * que es lo primero que hay que mirar cuando los contadores no suben.
 */
function captureLine(stats = {}) {
  const cap = stats.capture || {};
  const partes = [];
  if (cap.watcher) {
    partes.push(
      `red activa · ${num(cap.requests)} peticiones · ${num(cap.posts)} POST · ` +
        `${num(cap.chatRequests)} de conversación · ${num(cap.counted)} contadas`,
    );
    if (cap.blocked) partes.push(`${num(cap.blocked)} con el sitio apagado`);
  } else {
    partes.push('red sin registrar');
  }
  const tabs = Number(stats.cdpObserver?.tabs || 0);
  partes.push(tabs ? `CDP en ${tabs} ${tabs === 1 ? 'pestaña' : 'pestañas'}` : 'CDP sin pestañas');
  return `Captura — ${partes.join(' · ')}`;
}

let lastStats = {};
let statsRevision = 0;
function renderStats(next) {
  statsRevision += 1;
  const stats = { ...lastStats, ...next };
  lastStats = stats;
  // Los resultados de turno son exclusivos. Mensajes, respuestas, tokens y
  // actividad siguen siendo las métricas independientes del motor.
  els.stats.messages.textContent = num(stats.messages);
  els.stats.responses.textContent = num(stats.responses);
  for (const key of ['turnsCancelled', 'turnsFailed', 'turnsPerformed']) {
    els.stats[key].textContent = num(stats[key]);
  }
  const tokenView = tokenCounterView(stats);
  els.stats.inTokens.textContent = tokenView.input;
  els.stats.inTokens.title = tokenView.detail;
  els.stats.outTokens.textContent = tokenView.output;
  els.stats.outTokens.title = tokenView.detail;
  if (els.stats.coverage) els.stats.coverage.textContent = tokenView.detail;
  els.stats.interventions.textContent = num(stats.interventions);
  if (els.stats.capture) els.stats.capture.textContent = captureLine(stats);
}
async function refreshStats() {
  if (refreshStats.pending) return refreshStats.pending;
  const revision = statsRevision;
  refreshStats.pending = Promise.resolve(nexo.getStats()).then((stats) => { if (revision === statsRevision) renderStats(stats); }).catch(() => {}).finally(() => { refreshStats.pending = null; });
  return refreshStats.pending;
}

/* ------------------------------------------------------------------ */
/* panel: memoria (EVO MEMORY)                                         */
/* ------------------------------------------------------------------ */

const MEM = {
  items: document.getElementById('memItems'),
  tokens: document.getElementById('memTokens'),
  saved: document.getElementById('memSaved'),
  legend: document.getElementById('memLegend'),
  context: document.getElementById('memContext'),
  list: document.getElementById('memoryList'),
  conversations: document.getElementById('memoryConversations'),
  searchForm: document.getElementById('memSearchForm'),
  search: document.getElementById('memSearch'),
  handoff: document.getElementById('memHandoff'),
  copy: document.getElementById('memCopy'),
  packet: document.getElementById('memPacket'),
  importBtn: document.getElementById('memImport'),
  clear: document.getElementById('memClear'),
  file: document.getElementById('memFile'),
  captureStatus: document.getElementById('chatCaptureStatus'),
  captureCurrent: document.getElementById('chatCaptureCurrent'),
  captureSaved: document.getElementById('chatCaptureSaved'),
  captureConversations: document.getElementById('chatCaptureConversations'),
  captureDetail: document.getElementById('chatCaptureDetail'),
  captureDot: document.getElementById('chatCaptureDot'),
};

const MEM_KIND_LABEL = {
  goal: 'objetivo',
  decision: 'decisión',
  constraint: 'restricción',
  preference: 'preferencia',
  task: 'pendiente',
  issue: 'problema',
  fact: 'dato',
  entity: 'entidad',
  artifact: 'código',
  episode: 'episodios (resúmenes)',
  question: 'pregunta',
};

let memoryRegistryLoaded = false;
const memState = { items: [], stats: null, lastPacket: null, conversations: [], liveSnapshot: null };

const memoryLiveView = createRepetitionView({
  list: document.getElementById('memoryLiveConversation'),
  status: document.getElementById('memoryLiveStatus'),
  scroller: document.getElementById('memory-pane-conversation'),
});

function renderChatCapture() {
  if(!isEvoMemoryEnabled(state.settings)) { syncMemoryAvailability(); return; }
  const conversations = memState.conversations || [];
  const savedTurns = conversations.reduce((sum, entry) => sum + (entry.turns?.length || 0), 0);
  const live = sameConversationSource(memState.liveSnapshot, repetitionSource()) ? memState.liveSnapshot : null;
  document.getElementById('memoryLiveConversation').dataset.strategy = live?.strategy || 'none';
  const liveTurns = live?.turns || [];
  const readout = memoryReadout({ enabled: isEvoMemoryEnabled(state.settings), live, conversations, loaded: memoryRegistryLoaded });
  document.getElementById('memoryPersistence').dataset.state = readout.state;
  document.getElementById('memoryPersistenceTitle').textContent = readout.title;
  document.getElementById('memoryPersistenceDetail').textContent = readout.detail;
  memoryLiveView.render(live, 'Esperando los mensajes renderizados de esta pestaña…');
  const liveStatus = document.getElementById('memoryLiveStatus');
  if (liveTurns.length) liveStatus.textContent += live.strategy === 'direct-console-injection'
      ? ' · Lectura directa de respaldo en RAM; no confirma guardado local.'
      : ' · Vista en RAM inmediata; guardado local agrupado cada 500 ms.';
  const users = liveTurns.filter((turn) => turn.role === 'user').length;
  const assistants = liveTurns.filter((turn) => turn.role === 'assistant').length;
  MEM.captureCurrent.textContent = num(liveTurns.length);
  MEM.captureSaved.textContent = num(savedTurns);
  MEM.captureConversations.textContent = num(conversations.length);
  MEM.captureDot.dataset.active = String(Boolean(live?.href && liveTurns.length));
  if (live?.href && liveTurns.length) {
    MEM.captureStatus.textContent = live.streaming ? 'ChatGPT está generando; lectura en curso.' : 'ChatGPT detectado · lectura automática activa.';
    MEM.captureDetail.textContent = `En esta pestaña: ${users} mensajes tuyos y ${assistants} respuestas de ChatGPT${live.clipped ? ' · vista parcial: hay mensajes recortados u omitidos' : ''}. ${live.strategy === 'direct-console-injection' ? 'Respaldo directo del DOM; esta lectura no confirma persistencia.' : 'El historial guardado se actualiza automáticamente.'}`;
  } else {
    MEM.captureStatus.textContent = 'Esperando una conversación de ChatGPT…';
    MEM.captureDetail.textContent = 'Abrí un chat de ChatGPT en NEXO. Se mostrarán aquí los mensajes que estén cargados en pantalla.';
  }
}

function renderMemoryItems(entries) {
  if (!entries.length) {
    MEM.list.innerHTML = '<li class="empty">Todavía no hay nada memorable en este proyecto. Conversá y EVO irá destilando lo importante.</li>';
    return;
  }
  MEM.list.innerHTML = entries
    .map((item) => {
      const kind = MEM_KIND_LABEL[item.kind] || item.kind;
      const score = typeof item.score === 'number' ? `<span class="mem-score">${item.score.toFixed(3)}</span>` : '';
      // Un registro que no se puede leer se muestra como tal: el token crudo en
      // el panel no dice nada y parece un fallo del navegador.
      const texto = item.readable === false
        ? '<span class="mem-locked">Registro cifrado — no se puede leer. Vino así en un paquete importado; no se borra.</span>'
        : escapeHtml(item.text);
      return `<li class="${item.pinned ? 'pinned' : ''}" data-id="${escapeHtml(item.id)}">
        <div class="mem-head">
          <span class="mem-kind">${escapeHtml(kind)}</span>
          ${item.pinned ? '<span class="mem-kind">fijada</span>' : ''}
          ${score}
        </div>
        <div class="mem-text">${texto}</div>
        <div class="mem-meta">
          <button data-action="pin" data-id="${escapeHtml(item.id)}">${item.pinned ? 'soltar' : 'fijar'}</button>
          <button data-action="forget" data-id="${escapeHtml(item.id)}">olvidar</button>
          ${typeof item.uses === 'number' ? `<span>${item.uses} usos</span>` : ''}
        </div>
      </li>`;
    })
    .join('');
}

function syncMemoryAvailability(){
  const enabled=isEvoMemoryEnabled(state.settings);
  setMemoryPanelAvailability(document.getElementById('panel-memory'),enabled);
  if(enabled)return;
  memoryRefreshTicket++;memoryLiveRevision++;
  memState.items=[];memState.conversations=[];memState.liveSnapshot=null;memState.lastPacket=null;memState.stats={};memoryRegistryLoaded=false;
  MEM.list.replaceChildren();MEM.conversations.replaceChildren();MEM.packet.value='';
  memoryLiveView.render(null,'EVO Memory desactivada. Comprensión sigue activa.');
  MEM.items.textContent='0';MEM.tokens.textContent='0';MEM.saved.textContent='0 %';MEM.legend.replaceChildren();MEM.file.textContent='';
  if(MEM.context)MEM.context.textContent='EVO Memory desactivada; Comprensión sigue activa.';
  MEM.captureCurrent.textContent='0';MEM.captureSaved.textContent='0';MEM.captureConversations.textContent='0';MEM.captureDot.dataset.active='false';
  MEM.captureStatus.textContent='EVO Memory desactivada';MEM.captureDetail.textContent='No se muestran ni se guardan recuerdos. Comprensión sigue activa.';
  document.getElementById('memoryPersistence').dataset.state='disabled';
  document.getElementById('memoryPersistenceTitle').textContent='EVO Memory desactivada';
  document.getElementById('memoryPersistenceDetail').textContent='Comprensión sigue activa; los recuerdos anteriores no se borraron.';
}

async function refreshMemory() {
  if (!nexo.memory || !isEvoMemoryEnabled(state.settings)) { syncMemoryAvailability(); return; }
  const ticket = ++memoryRefreshTicket, source = repetitionSource(), tab = activeTab();
  if (!sameConversationSource(memState.liveSnapshot, source)) { memState.liveSnapshot = null; renderChatCapture(); }
  try {
    const stats=await nexo.memory.stats();
    if(ticket!==memoryRefreshTicket||!isEvoMemoryEnabled(state.settings))return;
    const items=await nexo.memory.list();
    if(ticket!==memoryRefreshTicket||!isEvoMemoryEnabled(state.settings))return;
    memState.stats=stats;memState.items=items;
    MEM.items.textContent = String(memState.stats.active ?? 0);
    MEM.tokens.textContent = String(memState.stats.tokens ?? 0);
    MEM.saved.textContent = `${memState.stats.savedPct ?? 0} %`;
    const leyenda = Object.entries(memState.stats.byKind || {})
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `<span>${escapeHtml(MEM_KIND_LABEL[kind] || kind)}: ${count}</span>`);
    if (memState.stats.encrypted > 0) {
      leyenda.push(`<span>cifradas, sin leer: ${memState.stats.encrypted}</span>`);
    }
    MEM.legend.innerHTML = leyenda.join(' · ');
    // Los tokens guardados y los que viajan en el contexto son dos cosas: la
    // memoria entera no se envía, se envía la parte que el motor elige.
    if (MEM.context) {
      const usados = Number(memState.stats.lastUsed || 0);
      MEM.context.textContent = usados
        ? `Contexto del último envío: ${usados} tokens de ${memState.stats.tokens} guardados.`
        : `Contexto: todavía no se envió nada. Hay ${memState.stats.tokens} tokens guardados en ${memState.stats.active} memorias.`;
    }
    MEM.file.textContent = memState.stats.file ? `Archivo: ${memState.stats.file}` : '';
    renderMemoryItems(memState.items.slice(0, 40));
    if (nexo.memory.conversations) {
      const conversations=await nexo.memory.conversations();
      if(ticket!==memoryRefreshTicket||!isEvoMemoryEnabled(state.settings))return;
      memState.conversations=conversations;
      memoryRegistryLoaded = true;
      const live = await readMemoryConversation({ source, tab,
        getSource: () => ticket === memoryRefreshTicket ? repetitionSource() : null,
        getCached: source => nexo.repetition.get(source),
        getLive: () => memState.liveSnapshot,
        getRevision: () => memoryLiveRevision,
      });
      if (ticket !== memoryRefreshTicket || !isEvoMemoryEnabled(state.settings)) return;
      if (live !== undefined) memState.liveSnapshot = live;
      if (live?.strategy === 'direct-console-injection' && source) {
        await nexo.domTokens?.observe({ ...live, webContentsId: source.webContentsId, href: source.href });
        if (ticket !== memoryRefreshTicket || !isEvoMemoryEnabled(state.settings)) return;
      }
      renderChatCapture();
      if (MEM.conversations?.closest('details')?.open) {
        MEM.conversations.innerHTML = memState.conversations.length ? memState.conversations.map((entry) =>
          `<li><details><summary>${escapeHtml(entry.conversationId)} · ${entry.turns.length} mensajes${entry.clipped ? ' (recortado)' : ''}</summary>${entry.turns.map((turn) =>
            `<p><b>${turn.role === 'user' ? 'Vos' : 'ChatGPT'}</b></p><pre class="mem-text">${escapeHtml(turn.content)}</pre>`).join('')}</details></li>`
        ).join('') : '<li class="empty">Todavía no se leyeron mensajes de ChatGPT.</li>';
      }
    }
  } catch {
    /* el panel de memoria es opcional frente al navegador */
  }
}

MEM.conversations.closest('details').addEventListener('toggle', () => { if (MEM.conversations.closest('details').open) refreshMemory(); });

MEM.list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !isEvoMemoryEnabled(state.settings)) return;
  const { id, action } = button.dataset;
  if (action === 'pin') {
    const current = memState.items.find((item) => item.id === id);
    await nexo.memory.pin(id, !current?.pinned);
  } else if (action === 'forget') {
    await nexo.memory.forget(id);
  }
  await refreshMemory();
});

MEM.searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if(!isEvoMemoryEnabled(state.settings))return;
  const query = MEM.search.value.trim();
  if (!query) return refreshMemory();
  const ticket=memoryRefreshTicket;
  const results = await nexo.memory.recall(query, 20);
  if(ticket===memoryRefreshTicket&&isEvoMemoryEnabled(state.settings))renderMemoryItems(results);
});

MEM.handoff.addEventListener('click', async () => {
  if(!isEvoMemoryEnabled(state.settings))return;
  const ticket=memoryRefreshTicket;
  const packet = await nexo.memory.handoff();
  if (ticket!==memoryRefreshTicket || !packet || !isEvoMemoryEnabled(state.settings)) return;
  memState.lastPacket = packet;
  MEM.packet.value = packet.markdown;
});

MEM.copy.addEventListener('click', async () => {
  if(!isEvoMemoryEnabled(state.settings))return;
  if (!MEM.packet.value) await MEM.handoff.click();
  if (!MEM.packet.value) return;
  try {
    await navigator.clipboard.writeText(MEM.packet.value);
    MEM.copy.textContent = 'Copiado';
    setTimeout(() => { MEM.copy.textContent = 'Copiar'; }, 1600);
  } catch {
    MEM.packet.select();
  }
});

MEM.importBtn.addEventListener('click', async () => {
  if(!isEvoMemoryEnabled(state.settings))return;
  const raw = MEM.packet.value.trim();
  if (!raw) return;
  let packet = memState.lastPacket;
  if (!packet || JSON.stringify(packet.markdown).slice(1, 80) !== JSON.stringify(raw).slice(1, 80)) {
    packet = { markdown: raw, items: parsePacketText(raw) };
  }
  const ticket=memoryRefreshTicket;
  const result = await nexo.memory.import(packet);
  if(ticket!==memoryRefreshTicket||!isEvoMemoryEnabled(state.settings))return;
  MEM.packet.value =
    `Importadas ${result.added}, fusionadas ${result.merged}.` +
    (result.ignored ? ` Sin leer (cifradas): ${result.ignored}.` : '');
  await refreshMemory();
});

MEM.clear.addEventListener('click', async () => {
  if (!window.confirm('¿Vaciar toda la memoria de este proyecto? Esta acción no se puede deshacer.')) return;
  await nexo.memory.clear();
  MEM.packet.value = '';
  await refreshMemory();
});

/** Convierte el texto pegado de un paquete en memorias importables. */
function parsePacketText(raw) {
  const items = [];
  let kind = 'fact';
  const map = { 'Decisiones tomadas': 'decision', 'Restricciones': 'constraint', 'Objetivos': 'goal', 'Pendientes': 'task', 'Problemas abiertos': 'issue', 'Datos y referencias': 'fact' };
  for (const line of raw.split('\n')) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      kind = map[heading[1].trim()] || 'fact';
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) items.push({ kind, text: bullet[1].trim() });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* panel: ajustes                                                      */
/* ------------------------------------------------------------------ */

const S = {
  enabled: document.getElementById('setEnabled'),
  protocol: document.getElementById('setProtocol'),
  threshold: document.getElementById('setThreshold'),
  autoContinue: document.getElementById('setAutoContinue'),
  budget: document.getElementById('setBudget'),
  keepRecent: document.getElementById('setKeepRecent'),
  reset: document.getElementById('resetSettings'),
  tokenModel: document.getElementById('setTokenModel'),
  sitesList: document.getElementById('sitesList'),
  clearLog: document.getElementById('clearLog'),
};

function fillSettings(settings) {
  state.settings = settings;
  S.tokenModel.value = settings.tokenCounting?.model || 'gpt-4o';
  S.enabled.checked = settings.enabled !== false;
  S.protocol.value = settings.protocol?.level || 'equilibrado';
  S.threshold.value = settings.receiving?.severityThreshold || 'medium';
  S.autoContinue.checked = (settings.receiving?.autoContinue ?? 0) > 0;
  S.budget.value = settings.context?.budgetTokens ?? 6000;
  S.keepRecent.value = settings.context?.keepRecentTurns ?? 6;
  updateEnginePill();
  syncMemoryAvailability();
}

function updateEnginePill() {
  const on = state.settings?.enabled !== false;
  els.enginePill.classList.toggle('off', !on);
  els.enginePillText.textContent = on ? 'Mediación activa' : 'Mediación desactivada';
}

function settingsStorageNotice(message = '') {
  const status = document.getElementById('settingsStorageStatus');
  status.textContent = message;
  status.hidden = !message;
  if (message) pushLocalNotice(message);
}

async function patchSettings(patch) {
  try {
    const next = await nexo.setSettings(patch);
    settingsStorageNotice();
    fillSettings(next);
  } catch (error) {
    fillSettings(state.settings);
    renderSitesList();
    settingsStorageNotice(`No se guardaron los ajustes: ${error.message}`);
  }
}

S.enabled.addEventListener('change', () => patchSettings({ enabled: S.enabled.checked }));
S.tokenModel.addEventListener('change', () => patchSettings({ tokenCounting: { model: S.tokenModel.value } }));
S.protocol.addEventListener('change', () => patchSettings({ protocol: { level: S.protocol.value } }));
S.threshold.addEventListener('change', () => patchSettings({ receiving: { severityThreshold: S.threshold.value } }));
S.autoContinue.addEventListener('change', () =>
  patchSettings({ receiving: { autoContinue: S.autoContinue.checked ? 2 : 0 } }),
);
S.budget.addEventListener('change', () => patchSettings({ context: { budgetTokens: Number(S.budget.value) || 6000 } }));
S.keepRecent.addEventListener('change', () =>
  patchSettings({ context: { keepRecentTurns: Number(S.keepRecent.value) || 6 } }),
);
S.reset.addEventListener('click', async () => {
  try {
    const next = await nexo.resetSettings();
    settingsStorageNotice();
    fillSettings(next);
    renderSitesList();
  } catch (error) {
    settingsStorageNotice(`No se restablecieron los ajustes: ${error.message}`);
  }
});
S.clearLog.addEventListener('click', async () => {
  try {
    state.logs = await nexo.clearLog();
    renderLog();
  } catch (error) {
    pushLocalNotice(`No se pudo limpiar el historial de intervenciones: ${error.message}`);
  }
});

function renderSitesList() {
  S.sitesList.innerHTML = SITES.map((site) => {
    const enabled = state.settings?.sites?.[site.id]?.enabled !== false;
    return `<li>
      <span class="name"><span class="mark" style="background:${site.accent}"></span>
        <span>${escapeHtml(site.label)}<br><span class="hosts">${escapeHtml((site.hosts[0] || ''))}</span></span>
      </span>
      <input type="checkbox" data-site="${site.id}" ${enabled ? 'checked' : ''} />
    </li>`;
  }).join('');
}

S.sitesList.addEventListener('change', (event) => {
  const id = event.target.dataset.site;
  if (!id) return;
  patchSettings({ sites: { [id]: { enabled: event.target.checked } } });
});

/* ------------------------------------------------------------------ */
/* pestañas del panel                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* eventos del navegador                                               */
/* ------------------------------------------------------------------ */

els.bookmarkBtn.addEventListener('click', toggleBookmark);
els.bookmarkCurrent.addEventListener('click', toggleBookmark);

// Abrir enlaces desde cualquier lista (historial, marcadores, sugerencias).
function openFromList(event) {
  const open = event.target.closest('.nav-open');
  if (open?.dataset.url) {
    navigate(open.dataset.url);
    setSidebar(false);
    return;
  }
}

els.historyList.addEventListener('click', openFromList);
els.bookmarkList.addEventListener('click', openFromList);

els.bookmarkList.addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove]');
  if (!remove) return;
  await nexo.bookmarks.remove(remove.dataset.remove);
  renderBookmarks();
  updateStar();
});

els.historySearchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  renderHistory();
});
els.historySearch.addEventListener('input', () => renderHistory());
els.historyClear.addEventListener('click', async () => {
  const range = els.historyRange.value;
  const result = await nexo.history.clear(range);
  renderHistory();
  pushLocalNotice(`Historial borrado (${result.removed} ${result.removed === 1 ? 'visita' : 'visitas'}).`);
});

els.bookmarkSearchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  renderBookmarks();
});
els.bookmarkSearch.addEventListener('input', () => renderBookmarks());

els.downloadList.addEventListener('click', async (event) => {
  const operation=event.target.closest('[data-dl-operation]');
  if(operation){const result=await nexo.advanced.action({action:'download-control',id:operation.dataset.id,operation:operation.dataset.dlOperation});if(!result?.ok)pushLocalNotice(result?.error||'Operación no disponible');renderDownloads();return;}
  const open = event.target.closest('[data-open]');
  const show = event.target.closest('[data-show]');
  const cancel = event.target.closest('[data-cancel]');
  if (open) {
    const result = await nexo.downloads.open(open.dataset.open);
    if (!result.ok) pushLocalNotice('No se pudo abrir el archivo descargado.');
  } else if (show) {
    await nexo.downloads.show(show.dataset.show);
  } else if (cancel) {
    await nexo.downloads.cancel(cancel.dataset.cancel);
    renderDownloads();
  }
});

els.downloadsClear.addEventListener('click', async () => {
  const result = await nexo.downloads.clear();
  renderDownloads();
  pushLocalNotice(`${result.removed} ${result.removed === 1 ? 'descarga quitada' : 'descargas quitadas'} de la lista.`);
});

els.permissionList.addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-permission]');
  if (!select) return;
  await nexo.permissions.set({
    host: select.dataset.host,
    permission: select.dataset.permission,
    value: select.value,
  });
  renderSitePanel();
});

els.zoomIn.addEventListener('click', () => applyZoom(1));
els.zoomOut.addEventListener('click', () => applyZoom(-1));
els.zoomReset.addEventListener('click', () => applyZoom(0));

els.clearHistoryData.addEventListener('click', async () => {
  const result = await nexo.history.clear('all');
  renderHistory();
  renderSitePanel();
  pushLocalNotice(`Historial vaciado (${result.removed} visitas).`);
});

els.clearCookies.addEventListener('click', async () => {
  const result = await nexo.data.clear({ cookies: true, cache: true });
  pushLocalNotice(
    result.ok
      ? 'Cookies, almacenamiento y caché borrados. Vas a tener que volver a iniciar sesión en los sitios.'
      : 'No se pudieron borrar los datos de navegación.',
  );
  renderSitePanel();
});

els.clearBookmarksData.addEventListener('click', async () => {
  const result = await nexo.bookmarks.clear();
  renderBookmarks();
  updateStar();
  pushLocalNotice(`${result.removed} marcadores borrados.`);
});

els.clearEverything.addEventListener('click', async () => {
  if (!window.confirm('¿Borrar historial, marcadores, descargas, sesión y datos de los sitios? No se puede deshacer. No elimina EVO MEMORY ni expedientes.')) return;
  await nexo.profile.clear({
    history: true,
    bookmarks: true,
    downloads: true,
    session: true,
    permissions: true,
    zoom: true,
    since: null,
  });
  await nexo.data.clear({ cookies: true, cache: true });
  state.closed = [];
  renderHistory();
  renderBookmarks();
  renderDownloads();
  renderSitePanel();
  pushLocalNotice('Datos de navegación borrados. EVO MEMORY y los expedientes no se eliminaron.');
});

/* ---------------- buscar en la página ---------------- */

els.findInput.addEventListener('input', () => runFind(true));
els.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runFind(!event.shiftKey);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeFind();
  }
});
els.findNext.addEventListener('click', () => runFind(true));
els.findPrev.addEventListener('click', () => runFind(false));
els.findClose.addEventListener('click', closeFind);

/* ---------------- avisos del proceso principal ---------------- */

nexo.on('nexo:downloads-changed', () => { if (isPanelActive('downloads')) uiTasks.schedule('downloads', renderDownloads); });
nexo.on('nexo:download-done', (payload) => {
  if (!payload) return;
  const state = payload.state === 'completed' ? 'completada' : payload.state;
  pushLocalNotice(`Descarga ${state}: ${payload.filename}`);
  if (isPanelActive('downloads')) uiTasks.schedule('downloads', renderDownloads);
});
nexo.on('nexo:bookmarks-changed', () => {
  if (isPanelActive('bookmarks')) uiTasks.schedule('bookmarks', renderBookmarks);
  if (isPanelActive('memory') && memoryPanel.selected === 'favorites') uiTasks.schedule('memory-favorites', renderMemoryFavorites);
  updateStar();
});
nexo.on('nexo:profile-changed', () => { if (isPanelActive('sites')) uiTasks.schedule('sites', renderSitePanel); });

// Al cerrar la ventana se guarda la sesión con los datos más frescos. Se usa
// `send` y no `invoke` porque en `beforeunload` no hay tiempo para una respuesta.
window.addEventListener('beforeunload', () => {
  const tabs = [...state.tabs.values()].map((tab) => ({ url: tab.url, title: tab.title, pinned:tab.pinned, workspaceId:tab.workspaceId }));
  if (!tabs.length) return;
  const activeIndex = Math.max(0, [...state.tabs.keys()].indexOf(state.activeId));
  nexo.session.saveNow([{ tabs, activeIndex }]);
});

// Accesos del nuevo espacio: delegan en las acciones existentes, sin otro IPC.
document.getElementById('homeButton').addEventListener('click', () => navigate(START_URL));
document.querySelector('[data-workspace-home]').addEventListener('click', () => navigate(START_URL));
document.querySelector('[data-launch-chatgpt]').addEventListener('click', () => navigate('https://chatgpt.com'));
document.querySelectorAll('[data-open-panel]').forEach((button) => {
  button.addEventListener('click', () => showPanel(button.dataset.openPanel));
});
let favoritesTicket = 0;
async function renderMemoryFavorites() {
  const list = document.getElementById('memoryFavorites');
  const ticket = ++favoritesTicket;
  list.setAttribute('aria-busy', 'true');
  try {
    const items = await nexo.bookmarks.list({});
    if (ticket !== favoritesTicket) return;
    list.innerHTML = items.length ? items.slice(0, 200).map((item) => `<li class="nav-item">
      <button class="nav-open" data-url="${escapeHtml(item.url)}" title="${escapeHtml(item.url)}">
        <span class="nav-title">${escapeHtml(item.title)}</span><span class="nav-url">${escapeHtml(displayUrl(item.url))}</span>
      </button></li>`).join('') : '<li class="nav-empty">Sin favoritos todavía. Guardá una página con la estrella de la barra.</li>';
  } catch {
    if (ticket === favoritesTicket) list.innerHTML = '<li class="nav-empty">No se pudieron consultar los favoritos. Volvé a abrir esta solapa para reintentar.</li>';
  } finally {
    if (ticket === favoritesTicket) list.setAttribute('aria-busy', 'false');
  }
}
const memoryPanel = createMemoryPanel({
  root: document.getElementById('panel-memory'), browser: els.browser,
  pin: document.getElementById('pinSidebar'),
  onSelect(name) {
    if (name === 'saved') {
      const saved = document.getElementById('savedConversations');
      if (!saved.open) saved.open = true;
      else refreshMemory();
    }
    if (name === 'favorites') renderMemoryFavorites();
  },
});
document.getElementById('memoryFavorites').addEventListener('click', openFromList);
document.getElementById('manageMemoryFavorites').addEventListener('click', () => showPanel('bookmarks'));
// navigator.onLine sólo informa conectividad del sistema, no velocidad ni protección.
function renderNetworkState() {
  document.getElementById('systemConnection').textContent = navigator.onLine
    ? 'Red disponible · sin medir velocidad' : 'Sin conexión de red';
}
window.addEventListener('online', renderNetworkState);
window.addEventListener('offline', renderNetworkState);
renderNetworkState();
// La altura sólo se actualiza cuando cambia el chrome; no hay bucle de medición.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--chrome-height', `${entry.target.getBoundingClientRect().height}px`);
}).observe(document.querySelector('.chrome'));

const tokenizerPanel = createTokenizerPanel({ root: document.getElementById('panel-tokenizer'), api: nexo.tokenizer });

function refreshActivePanel() {
  const current = document.querySelector('.stab.active')?.dataset.panel;
  const renders = { tokenizer: () => tokenizerPanel.refresh(), prompts: () => promptLibrary?.load(), activity: () => { renderLog(); refreshStats(); }, memory: refreshMemory,
    understanding:()=>understandingPanel?.refresh(), work: () => workPanel?.load(), history: renderHistory, bookmarks: renderBookmarks, downloads: renderDownloads, sites: renderSitePanel };
  if (els.browser.classList.contains('with-sidebar')) uiTasks.schedule(`panel-${current}`, renders[current] || (() => {}));
}
const panelTabs = [...document.querySelectorAll('.stab')];
panelTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    panelTabs.forEach((t) => { const active = t === tab; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); t.tabIndex = active ? 0 : -1; });
    document.querySelectorAll('.panel-view').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.panel));
    els.panelTitle.textContent = tab.getAttribute('aria-label');
    browserTools?.refreshLayout();
    document.querySelectorAll('.rail-item[data-open-panel]').forEach((item) => item.classList.toggle('selected', item.dataset.openPanel === tab.dataset.panel));
    document.querySelector('[data-workspace-home]').classList.remove('selected');
    if (tab.dataset.panel === 'activity') clearActivityUnread();
    refreshActivePanel();
  });
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? panelTabs.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + panelTabs.length) % panelTabs.length;
    panelTabs[next].focus(); panelTabs[next].click();
  });
});
function showPanel(name) {
  setSidebar(true);
  document.querySelector(`.stab[data-panel="${name}"]`)?.click();
}

// El proceso principal avisa cuando la memoria cambia por otra vía (importación,
// vaciado) para que el panel no muestre datos viejos.
nexo.on?.('nexo:memory-changed', () => {
  if (isPanelActive('memory')) uiTasks.schedule('memory', refreshMemory);
});

/* ------------------------------------------------------------------ */
/* eventos del proceso principal                                       */
/* ------------------------------------------------------------------ */

nexo.on('nexo:event', (message) => {
  if (message?.type === 'intervention' && message.payload) {
    pushIntervention(message.payload);
    refreshStats();
    // Sólo los bloqueos: un cierre de turno o una redacción no interrumpen.
    if (AVISOS_RETENIDOS.has(message.payload.code)) {
      if (!isPanelActive('activity')) markActivityUnread();
      showEgressNotice();
    }
  }
});

// Los contadores se refrescan también cuando el motor prepara un envío o cierra
// una respuesta, no sólo cuando llega una intervención: un turno mediado sin
// avisos dejaba el panel en cero.
nexo.on?.('nexo:stats-changed', (stats) => {
  if (stats) uiTasks.schedule('stats', () => renderStats(stats));
  else refreshStats();
});

nexo.on('nexo:settings-changed', (settings) => {
  fillSettings(settings);
  renderSitesList();
  if(isEvoMemoryEnabled(settings)&&isPanelActive('memory'))uiTasks.schedule('memory',refreshMemory);
});

/**
 * Siguiente paso tras cerrar un turno: reparaciones aplicadas, continuación
 * disponible y reintentos con otro enfoque. Todo se inserta en el cuadro del
 * sitio para revisarlo; nada se envía solo.
 */
nexo.onTurnFollowUp?.((payload) => {
  const id = Number(payload?.webContentsId);
  const tab = [...state.tabs.values()].find((t) => {
    try { return t.view.getWebContentsId() === id; } catch { return false; }
  });
  if (!tab) return;
  // El texto del turno llegó por otra vía: lo que se avisó como corte era
  // falso. Se retira el aviso y la acción de continuación, sin dejar rastro.
  if (payload?.cleared) {
    if (tab.followUp?.kind === 'continue') tab.followUp = null;
    clearLocalNotice('followup-truncated');
    if (tab.id === state.activeId) refreshFollowUp();
    return;
  }
  const touchesActive = tab.id === state.activeId;
  const fixes = Array.isArray(payload.fixes) ? payload.fixes : [];
  if (fixes.length) {
    tab.tabEl.classList.add('follow-up');
    tab.tabEl.title = `${tab.title} · respuesta reparada (${fixes.length})`;
  }
  if (!touchesActive) return;
  if (fixes.length) pushLocalNotice(`Respuesta reparada al vuelo: ${fixes.join(', ')}.`);
  if (payload.next?.prompt) {
    tab.followUp = { kind: 'continue', label: payload.next.label || 'Continuar la respuesta', prompt: payload.next.prompt };
    pushLocalNotice(`La respuesta quedó cortada. Menú del navegador → Continuar la respuesta para seguir donde terminó.`, 'followup-truncated');
  } else if (Array.isArray(payload.suggestions) && payload.suggestions.length) {
    tab.followUp = { kind: 'suggestion', ...payload.suggestions[0] };
  }
  refreshFollowUp();
});

/** Muestra u oculta la acción de continuación de la pestaña activa. */
function refreshFollowUp() {
  const bar = document.getElementById('followUpBar');
  if (!bar) return;
  const tab = activeTab();
  const follow = tab?.followUp;
  bar.hidden = !follow;
  if (!follow) return;
  bar.querySelector('[data-follow-label]').textContent = follow.label || 'Continuar';
  bar.querySelector('[data-follow-help]').textContent = follow.kind === 'continue'
    ? 'Se escribe en el cuadro del sitio; revisalo y enviá vos.'
    : 'Sugerencia del motor local; se escribe en el cuadro del sitio.';
}

document.getElementById('followUpInsert')?.addEventListener('click', () => {
  const tab = activeTab();
  if (!tab?.followUp) return;
  // Escribe en el cuadro del sitio sin enviar: la persona revisa y decide.
  nexo.advanced
    .action({ action: 'insert-text', webContentsId: tab.view.getWebContentsId?.(), text: tab.followUp.prompt })
    .then((result) => pushLocalNotice(result?.ok
      ? 'Texto escrito en el cuadro del sitio. Revisalo y enviá vos.'
      : (result?.error || 'No se pudo escribir en el cuadro del sitio.')))
    .catch(() => pushLocalNotice('No se pudo escribir en el cuadro del sitio.'));
  delete tab.followUp;
  refreshFollowUp();
});
document.getElementById('followUpDismiss')?.addEventListener('click', () => {
  const tab = activeTab();
  if (tab) {
    delete tab.followUp;
    tab.tabEl.classList.remove('follow-up');
    tab.tabEl.title = tab.title;
  }
  refreshFollowUp();
});

nexo.on('nexo:open-tab', ({ url }) => {
  if (url) createTab(url);
});

function runBrowserCommand(command) {
  if(command?.webContentsId){const tab=[...state.tabs.values()].find(t=>{try{return t.view.getWebContentsId()===command.webContentsId;}catch{return false;}});if(tab&&tab.id!==state.activeId)activateTab(tab.id);}
  if(navigationHub?.handle(command||{}))return;
  if(browserTools?.handle(command||{}))return;
  switch (command?.type) {
    case 'home':
      navigate(START_URL);
      break;
    case 'new-tab':
      createTab(START_URL);
      break;
    // Atajos de conversación: abrir la biblioteca o ejecutar uno por id
    // (el id lo aporta la propia lista del perfil, nunca una URL).
    case 'prompt-list':
      showPanel('prompts');
      break;
    case 'continue-response':
      navigationHub?.open('followup');
      break;
    case 'prompt-insert':
      promptLibrary?.runById(String(command.id || ''));
      break;
    case 'followup-insert':
      document.getElementById('followUpInsert')?.click();
      break;
    case 'close-tab':
      if (state.activeId) closeTab(state.activeId);
      break;
    case 'open':
      createTab(command.url || DEMO_URL);
      break;
    case 'toggle-engine':
      patchSettings({ enabled: state.settings?.enabled === false });
      break;
    case 'toggle-sidebar':
      setSidebar(!els.browser.classList.contains('with-sidebar'));
      break;
    case 'user-understanding':
      showPanel('understanding');
      break;
    case 'work-dossier':
      showPanel('work');
      break;
    case 'settings':
      showPanel('settings');
      break;
    case 'history':
      showPanel('history');
      break;
    case 'bookmarks':
      showPanel('bookmarks');
      break;
    case 'downloads':
      showPanel('downloads');
      break;
    case 'sites':
      showPanel('sites');
      break;
    case 'activity':
      showPanel('activity');
      break;
    case 'memory':
      showPanel('memory');
      break;
    case 'focus-omnibox':
      els.omnibox.focus();
      els.omnibox.select();
      break;
    case 'reopen-tab':
      reopenTab();
      break;
    case 'next-tab':
      cycleTab(1);
      break;
    case 'prev-tab':
      cycleTab(-1);
      break;
    case 'bookmark':
      toggleBookmark();
      break;
    case 'find':
      openFind();
      break;
    case 'find-next':
      runFind(true);
      break;
    case 'find-prev':
      runFind(false);
      break;
    case 'escape':
      if (state.find.active) closeFind();
      else hideSuggestions();
      break;
    case 'zoom-in':
      applyZoom(1);
      break;
    case 'zoom-out':
      applyZoom(-1);
      break;
    case 'zoom-reset':
      applyZoom(0);
      break;
    case 'reload':
      activeTab()?.view.reload?.();
      break;
    case 'hard-reload':
      activeTab()?.view.reloadIgnoringCache?.();
      break;
    case 'back':
      if (activeTab()?.view.canGoBack?.()) activeTab().view.goBack();
      break;
    case 'forward':
      if (activeTab()?.view.canGoForward?.()) activeTab().view.goForward();
      break;
    default:
      if (String(command?.type || '').startsWith('tab-')) {
        const index = Number(command.type.slice(4)) - 1;
        const ids = browserTools ? browserTools.visibleTabs().map(t=>t.id) : [...state.tabs.keys()];
        if (index === 8 && ids.length) activateTab(ids[ids.length - 1]);
        else if (ids[index]) activateTab(ids[index]);
      }
      break;
  }
}
nexo.on('nexo:command', runBrowserCommand);

document.getElementById('openDemo').addEventListener('click', () => createTab(DEMO_URL));

/* ------------------------------------------------------------------ */
/* arranque                                                            */
/* ------------------------------------------------------------------ */

/**
 * Manda las medidas de arranque al proceso principal.
 *
 * Nunca puede lanzar: medir el arranque no puede romper el arranque.
 * @param {Record<string, number>} marcas
 */
function reportarMedidas(marcas) {
  try {
    const datos = { ...marcas };
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      // Tiempos absolutos de la navegación: separan «cargar la página» de
      // «nuestro código haciendo cosas».
      datos['nav-red'] = Math.round(nav.responseEnd);
      datos['nav-dom'] = Math.round(nav.domInteractive);
      datos['nav-load'] = Math.round(nav.domComplete || nav.loadEventEnd);
    }
    const pintado = performance.getEntriesByName('first-contentful-paint')[0];
    if (pintado) datos['nav-pintado'] = Math.round(pintado.startTime);
    // Los tres recursos más lentos, con nombre: si el arranque se va en cargar
    // un archivo, hay que ver cuál.
    const recursos = performance
      .getEntriesByType('resource')
      .map((item) => ({ nombre: item.name.split('/').slice(-2).join('/'), ms: item.duration }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3)
      .map((item) => `${item.nombre} ${item.ms.toFixed(0)} ms`);
    if (recursos.length) datos.recursos = recursos.join(', ');
    datos['nav-recursos'] = performance.getEntriesByType('resource').length;
    nexo.perf?.(datos);
  } catch {
    // Sin medidas se arranca igual.
  }
}

/**
 * Arranque de la interfaz, en dos tiempos:
 *
 * 1. lo imprescindible para que haya una pestaña navegando (configuración y
 *    sesión, dos llamadas);
 * 2. todo lo demás —ajustes, registro, estadísticas, panel de sitios,
 *    historial, marcadores y descargas— después de eso.
 *
 * Antes se esperaba a todo antes de crear la primera pestaña: el usuario veía
 * el marco del navegador quieto mientras se serializaban 4 000 visitas, el
 * registro completo y la lista de memoria. La mediación no depende de nada de
 * eso, así que ahora la primera página empieza a cargar de inmediato.
 */
async function boot() {
  const t0 = performance.now();
  const marcas = {};
  const paso = (nombre) => {
    marcas[nombre] = Number((performance.now() - t0).toFixed(1));
  };

  state.config = await nexo.getConfig();
  await browserTools.load();
  document.getElementById('version').textContent = `v${state.config.version}`;
  document.getElementById('statusVersion').textContent = `v${state.config.version}`;
  paso('config');

  // Continuidad: si había pestañas guardadas, se reabren tal cual estaban.
  let restored = null;
  try {
    restored = await nexo.session.restore();
  } catch {
    restored = null;
  }
  paso('sesion');

  setSidebar(visualChrome?.mode === 'fixed');
  els.omnibox.focus();

  /**
   * Abre la primera pestaña.
   *
   * Se hace después del primer cuadro a propósito: crear un `<webview>` obliga a
   * Chromium a montar un proceso de invitado y su canal de composición, y
   * mientras eso ocurre la ventana no pinta nada. Medido en Windows: sin esta
   * espera el primer pintado llegaba a los 868 ms; con ella el marco del
   * navegador aparece de inmediato y la página arranca pocos milisegundos
   * después.
   */
  const abrirPrimera = () => {
    if (restored?.windows?.[0]?.tabs?.length) {
      const win = restored.windows[0];
      const ids = win.tabs.map((tab) => createTab(tab.url, { activate: false, pinned:tab.pinned, workspaceId:tab.workspaceId || 'main' }).id);
      activateTab(ids[Math.min(win.activeIndex, ids.length - 1)]);
      pushLocalNotice(`Se restauraron ${ids.length} ${ids.length === 1 ? 'pestaña' : 'pestañas'} de la sesión anterior.`);
    } else {
      createTab(START_URL);
    }
    paso('pestana');
    reportarMedidas(marcas);
  };

  // Dos cuadros: el primero se pinta con el marco ya armado, y la pestaña se
  // crea cuando ese cuadro ya está en pantalla. El temporizador es la red de
  // seguridad para ventanas ocultas, donde no hay cuadros.
  let abierta = false;
  const abrirUnaVez = () => {
    if (abierta) return;
    abierta = true;
    abrirPrimera();
  };
  requestAnimationFrame(() => {
    paso('primer-cuadro');
    requestAnimationFrame(abrirUnaVez);
  });
  setTimeout(abrirUnaVez, 200);

  // Desde acá el navegador ya es usable: se reporta el arranque percibido.
  reportarMedidas(marcas);

  // Segunda mitad: lo que se puede cargar sin retener la primera pintura.
  const [settings, logs] = await Promise.all([nexo.getSettings(), nexo.getLog()]);
  fillSettings(settings);
  renderSitesList();
  state.logs = logs;
  renderLog();

  const storageStatus = await nexo.getStorageStatus();
  if (storageStatus.state === 'recovered') settingsStorageNotice(`Perfil dañado: se conservaron sus bytes originales en ${storageStatus.backup}. Se cargaron ajustes predeterminados.`);
  if (['unreadable', 'recovery-blocked'].includes(storageStatus.state) || storageStatus.error) settingsStorageNotice(`Perfil no guardado: ${storageStatus.error || 'no se pudo preservar el original'}.`);

  await refreshStats();
  // Los paneles secundarios se cargan sólo cuando el usuario los abre.
  refreshActivePanel();
  paso('paneles');
  reportarMedidas(marcas);
}

navigationHub = createNavigationHub({state,createTab,activateTab,closeTab,runCommand:runBrowserCommand,openPanel:showPanel,searchTabs:()=>navigationHub.open('tabs'),insertPrompt:id=>promptLibrary?.runById(id),continueResponse:()=>navigationHub?.open('followup'),listPrompts:()=>nexo.prompts.list().then(r=>r?.ok?r.items:[]).catch(()=>[]),
  getWorkspace:()=>browserTools?.workspace || 'main',workspaceName:id=>browserTools?.workspaceName(id) || id,
  shortcut:id=>acceleratorFor(id,navigator.platform.includes('Mac')?'darwin':'linux'),
  scheduleSessionCapture});
browserTools = createBrowserTools({nexo,state,activeTab,createTab,activateTab,closeTab,navigate,runCommand:runBrowserCommand,notice:pushLocalNotice,scheduleSessionCapture,searchTabs:()=>navigationHub.open('tabs'),onPreferences:p=>{visualChrome?.apply(p.rightMenuMode);document.querySelectorAll('[data-ui-zoom-value]').forEach(e=>e.textContent=`${Math.round((p.uiZoom||1)*100)}%`);}});
promptLibrary = createPromptLibrary({root:document.getElementById('promptRoot'),nexo,activeTab,
  // Insertar es la acción nativa que escribe en el cuadro del sitio; nunca envía.
  insertText:text=>nexo.advanced.action({action:'insert-text',webContentsId:activeTab()?.view?.getWebContentsId?.(),text}),
  selectedText:async()=>{const r=await nexo.advanced.action({action:'selected-text',webContentsId:activeTab()?.view?.getWebContentsId?.()});return r?.ok?r.text:'';},
  notice:pushLocalNotice,onChanged:()=>{}});
workPanel = createWorkDossier({nexo,root:document.getElementById('panel-work'),
  getWorkspaceId:()=>browserTools.workspace,
  getWorkspaceName:id=>browserTools.workspaceName(id),
  activeTab,show:()=>showPanel('work'),notice:pushLocalNotice,
  openResource:(url,workspaceId)=>{
    const existing=[...state.tabs.values()].find(t=>t.url===url && (t.workspaceId||'main')===workspaceId);
    if(existing)activateTab(existing.id);else createTab(url,{workspaceId});
  }});
visualChrome=createWormholeChrome({browser:els.browser,leftButton:document.getElementById('toggleLeftMenu'),leftMenu:document.getElementById('leftMenu'),rightMenu:els.sidebar,modeInput:document.getElementById('rightMenuMode'),closeButton:els.closeSidebar,setSidebar,saveMode:mode=>browserTools.setRightMenuMode(mode)});
let uiZoomBusy=false;
document.querySelectorAll('[data-ui-zoom]').forEach(button=>button.addEventListener('click',async()=>{if(uiZoomBusy)return;uiZoomBusy=true;try{const steps=[.75,.8,.9,1,1.1,1.25,1.5],current=browserTools.uiZoom,index=steps.reduce((best,v,i)=>Math.abs(v-current)<Math.abs(steps[best]-current)?i:best,0);const next=button.dataset.uiZoom==='reset'?1:steps[Math.max(0,Math.min(steps.length-1,index+(button.dataset.uiZoom==='in'?1:-1)))];await browserTools.setUIZoom(next);}finally{uiZoomBusy=false;}}));
understandingPanel=createUnderstandingPanel({nexo,root:document.getElementById('panel-understanding'),activeTab,
  // Entrega explícita del contexto optimizado: escribe en el cuadro del sitio
  // sin enviar, o copia. El panel nunca reemplaza mensajes por su cuenta.
  insertText:text=>nexo.advanced.action({action:'insert-text',webContentsId:activeTab()?.view?.getWebContentsId?.(),text}),
  copyText:text=>navigator.clipboard.writeText(text)});
document.getElementById('commandsButton').addEventListener('click',()=>runBrowserCommand({type:'command-center'}));
document.getElementById('keyboardSettings').addEventListener('click',()=>runBrowserCommand({type:'keyboard-settings'}));
document.getElementById('toolbarSettings').addEventListener('click',()=>runBrowserCommand({type:'toolbar-settings'}));
boot();

// No registrar este aviso en Store: un fallo de disco no debe generar recursión.
nexo.on('nexo:storage-error', ({ message }) => settingsStorageNotice(message));

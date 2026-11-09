/**
 * Interfaz de navegador de Nexo.
 *
 * Las pestañas son `<webview>` reales de Chromium. La shell no habla con los
 * sitios: solo orquesta pestañas, ajustes y el panel de intervenciones que el
 * proceso principal le empuja por IPC.
 */

import { SITES } from '../../core/sites.js';
import { displayUrl, hostOf, resolveInput } from '../../nav/url.js';
import { ZOOM_STEPS, clampZoom, zoomLabel } from '../../nav/zoom.js';

const nexo = window.nexo;

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
  stats: { turns: document.getElementById('statTurns'), loops: document.getElementById('statLoops'), log: document.getElementById('statLog') },
  sidebar: document.getElementById('sidebar'),
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
const normalizeInput = (text) => resolveInput(text, { searchBase: SEARCH });

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

function createTab(url = START_URL, { activate = true } = {}) {
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
  tabEl.setAttribute('role', 'tab');
  tabEl.innerHTML = `
    <span class="favicon">◆</span>
    <span class="title">Cargando…</span>
    <span class="cut-dot" hidden></span>
    <button class="close" title="Cerrar pestaña" aria-label="Cerrar pestaña">×</button>`;

  tabEl.addEventListener('click', (event) => {
    if (event.target.classList.contains('close')) return;
    activateTab(id);
  });
  tabEl.querySelector('.close').addEventListener('click', (event) => {
    event.stopPropagation();
    closeTab(id);
  });

  els.tabs.appendChild(tabEl);

  const tab = { id, view, tabEl, url, title: 'Nueva pestaña', cut: 0 };
  state.tabs.set(id, tab);

  const titleEl = tabEl.querySelector('.title');
  const faviconEl = tabEl.querySelector('.favicon');
  const setTitle = (text) => {
    tab.title = text || 'Sin título';
    titleEl.textContent = tab.title;
    titleEl.title = tab.title;
  };

  view.addEventListener('page-title-updated', (event) => setTitle(event.title));
  view.addEventListener('did-navigate', (event) => {
    tab.url = event.url;
    if (state.activeId === id) els.omnibox.value = event.url;
  });
  view.addEventListener('did-navigate-in-page', (event) => {
    tab.url = event.url;
    if (state.activeId === id) els.omnibox.value = event.url;
  });
  view.addEventListener('page-favicon-updated', (event) => {
    const icon = event.favicons?.[0];
    if (icon) faviconEl.innerHTML = `<img src="${encodeURI(icon)}" alt="" />`;
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
    tabEl.classList.add('loading');
    tabEl.classList.remove('loaded');
  });
  view.addEventListener('did-stop-loading', () => {
    tabEl.classList.remove('loading');
    tabEl.classList.add('loaded');
    if (state.activeId === id) {
      updateStar();
      renderSitePanel();
    }
    scheduleSessionCapture();
  });

  view.addEventListener('did-navigate', () => scheduleSessionCapture());
  view.addEventListener('page-title-updated', () => scheduleSessionCapture());

  if (activate) activateTab(id);
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
  renderSitePanel();
  scheduleSessionCapture();
}

function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  state.closed.push({ url: tab.url, title: tab.title });
  if (state.closed.length > 25) state.closed.shift();
  tab.view.remove();
  tab.tabEl.remove();
  state.tabs.delete(id);

  if (state.activeId === id) {
    const next = [...state.tabs.keys()].pop();
    if (next) activateTab(next);
    else state.activeId = null;
  }
  updateWelcome();
  scheduleSessionCapture();
}

/** Cambia de pestaña en orden circular. */
function cycleTab(delta) {
  const ids = [...state.tabs.keys()];
  if (ids.length < 2) return;
  const index = ids.indexOf(state.activeId);
  const next = ids[(index + delta + ids.length) % ids.length];
  activateTab(next);
}

/** Reabre la última pestaña cerrada (Ctrl+Shift+T). */
function reopenTab() {
  const last = state.closed.pop();
  if (!last) return null;
  return createTab(last.url);
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
  els.browser.classList.toggle('with-sidebar');
});

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
    const tabs = [...state.tabs.values()].map((tab) => ({ url: tab.url, title: tab.title }));
    if (!tabs.length) return;
    const activeIndex = Math.max(0, [...state.tabs.keys()].indexOf(state.activeId));
    nexo.session.capture([{ tabs, activeIndex }]).catch(() => {});
  }, 500);
}

/* ---------------- barra: sugerencias ---------------- */

let suggestTimer = null;

function hideSuggestions() {
  els.suggestions.hidden = true;
  els.suggestions.innerHTML = '';
}

function renderSuggestions(items) {
  if (!items.length) return hideSuggestions();
  els.suggestions.innerHTML = items
    .map(
      (item, index) => `<button class="suggestion" data-url="${escapeHtml(item.url)}" data-index="${index}" role="option">
        <span class="s-kicker">${item.kind === 'bookmark' ? '★' : item.kind === 'top' ? '↑' : '↺'}</span>
        <span class="s-title">${escapeHtml(item.title || item.url)}</span>
        <span class="s-url">${escapeHtml(displayUrl(item.url))}</span>
      </button>`,
    )
    .join('');
  els.suggestions.hidden = false;
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
    options.forEach((option, i) => option.classList.toggle('active', i === next));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    const next = (activeIndex - 1 + options.length) % options.length;
    options.forEach((option, i) => option.classList.toggle('active', i === next));
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
        const label = {
          started: 'iniciando',
          progress: percent === null ? 'descargando' : `${percent} %`,
          completed: 'completada',
          cancelled: 'cancelada',
          interrupted: 'interrumpida',
        }[item.state];
        const actions = [];
        if (item.state === 'completed') {
          actions.push(`<button class="nav-action" data-open="${escapeHtml(item.id)}" title="Abrir archivo">abrir</button>`);
          actions.push(`<button class="nav-action" data-show="${escapeHtml(item.id)}" title="Mostrar en carpeta">carpeta</button>`);
        } else if (item.state === 'started' || item.state === 'progress') {
          actions.push(`<button class="nav-action" data-cancel="${escapeHtml(item.id)}" title="Cancelar">cancelar</button>`);
        }
        return `<li class="nav-item download ${escapeHtml(item.state)}">
          <div class="download-body">
            <span class="nav-title">${escapeHtml(item.filename)}</span>
            <span class="nav-url">${escapeHtml(item.host || '')} · ${escapeHtml(label)}</span>
            ${percent !== null && item.state !== 'completed' ? `<span class="bar"><span style="width:${percent}%"></span></span>` : ''}
          </div>
          <div class="download-actions">${actions.join('')}</div>
        </li>`;
      })
      .join('');
    els.downloadNote.textContent = 'Las descargas se ubican en la carpeta que elijas al bajarlas.';
  });
}

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

function renderLog() {
  els.stats.log.textContent = String(state.logs.length);
  if (!state.logs.length) {
    els.log.innerHTML = '<li class="log-empty">Todavía no hubo intervenciones. Abrí un chat y escribí algo.</li>';
    return;
  }
  els.log.innerHTML = state.logs
    .slice(0, 80)
    .map(
      (e) => `<li class="log-item ${e.severity || 'info'}">
        <div class="meta">
          <span class="kind ${e.kind}">${KIND_LABEL[e.kind] || e.kind || 'nexo'}</span>
          <span class="time">${timeOf(e.ts)}</span>
        </div>
        <div class="title">${escapeHtml(e.title || e.code || '')}</div>
        ${e.detail ? `<div class="detail">${escapeHtml(e.detail)}</div>` : ''}
      </li>`,
    )
    .join('');
}

function pushLocalNotice(text) {
  pushIntervention({
    kind: 'system',
    code: 'notice',
    severity: 'info',
    title: text,
    ts: Date.now(),
  });
}

function pushIntervention(entry) {
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.length = 200;
  renderLog();
  refreshMemory();

  // Marca la pestaña activa cuando hay un corte en vivo.
  if (entry.kind === 'receiving') {
    const tab = activeTab();
    if (tab) {
      tab.cut += 1;
      tab.tabEl.querySelector('.cut-dot').hidden = false;
    }
  }
}

async function refreshStats() {
  try {
    const stats = await nexo.getStats();
    els.stats.turns.textContent = String(stats.turns ?? 0);
    els.stats.loops.textContent = String(stats.loops ?? 0);
    els.stats.log.textContent = String(state.logs.length);
  } catch {
    /* la shell sigue funcionando sin estadísticas */
  }
}

/* ------------------------------------------------------------------ */
/* panel: memoria (EVO MEMORY)                                         */
/* ------------------------------------------------------------------ */

const MEM = {
  items: document.getElementById('memItems'),
  tokens: document.getElementById('memTokens'),
  saved: document.getElementById('memSaved'),
  legend: document.getElementById('memLegend'),
  list: document.getElementById('memoryList'),
  searchForm: document.getElementById('memSearchForm'),
  search: document.getElementById('memSearch'),
  handoff: document.getElementById('memHandoff'),
  copy: document.getElementById('memCopy'),
  packet: document.getElementById('memPacket'),
  importBtn: document.getElementById('memImport'),
  clear: document.getElementById('memClear'),
  file: document.getElementById('memFile'),
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
  episode: 'episodio',
  question: 'pregunta',
};

const memState = { items: [], stats: null, lastPacket: null };

function renderMemoryItems(entries) {
  if (!entries.length) {
    MEM.list.innerHTML = '<li class="empty">Todavía no hay nada memorable en este proyecto. Conversá y EVO irá destilando lo importante.</li>';
    return;
  }
  MEM.list.innerHTML = entries
    .map((item) => {
      const kind = MEM_KIND_LABEL[item.kind] || item.kind;
      const score = typeof item.score === 'number' ? `<span class="mem-score">${item.score.toFixed(3)}</span>` : '';
      return `<li class="${item.pinned ? 'pinned' : ''}" data-id="${escapeHtml(item.id)}">
        <div class="mem-head">
          <span class="mem-kind">${escapeHtml(kind)}</span>
          ${item.pinned ? '<span class="mem-kind">fijada</span>' : ''}
          ${score}
        </div>
        <div class="mem-text">${escapeHtml(item.text)}</div>
        <div class="mem-meta">
          <button data-action="pin" data-id="${escapeHtml(item.id)}">${item.pinned ? 'soltar' : 'fijar'}</button>
          <button data-action="forget" data-id="${escapeHtml(item.id)}">olvidar</button>
          ${typeof item.uses === 'number' ? `<span>${item.uses} usos</span>` : ''}
        </div>
      </li>`;
    })
    .join('');
}

async function refreshMemory() {
  if (!nexo.memory) return;
  try {
    memState.stats = await nexo.memory.stats();
    memState.items = await nexo.memory.list();
    MEM.items.textContent = String(memState.stats.active ?? 0);
    MEM.tokens.textContent = String(memState.stats.tokens ?? 0);
    MEM.saved.textContent = `${memState.stats.savedPct ?? 0} %`;
    MEM.legend.innerHTML = Object.entries(memState.stats.byKind || {})
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `<span>${escapeHtml(MEM_KIND_LABEL[kind] || kind)}: ${count}</span>`)
      .join(' · ');
    MEM.file.textContent = memState.stats.file ? `Archivo: ${memState.stats.file}` : '';
    renderMemoryItems(memState.items.slice(0, 40));
  } catch {
    /* el panel de memoria es opcional frente al navegador */
  }
}

MEM.list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
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
  const query = MEM.search.value.trim();
  if (!query) return refreshMemory();
  const results = await nexo.memory.recall(query, 20);
  renderMemoryItems(results);
});

MEM.handoff.addEventListener('click', async () => {
  const packet = await nexo.memory.handoff();
  if (!packet) return;
  memState.lastPacket = packet;
  MEM.packet.value = packet.markdown;
});

MEM.copy.addEventListener('click', async () => {
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
  const raw = MEM.packet.value.trim();
  if (!raw) return;
  let packet = memState.lastPacket;
  if (!packet || JSON.stringify(packet.markdown).slice(1, 80) !== JSON.stringify(raw).slice(1, 80)) {
    packet = { markdown: raw, items: parsePacketText(raw) };
  }
  const result = await nexo.memory.import(packet);
  MEM.packet.value = `Importadas ${result.added}, fusionadas ${result.merged}.`;
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
  sitesList: document.getElementById('sitesList'),
  clearLog: document.getElementById('clearLog'),
};

function fillSettings(settings) {
  state.settings = settings;
  S.enabled.checked = settings.enabled !== false;
  S.protocol.value = settings.protocol?.level || 'equilibrado';
  S.threshold.value = settings.receiving?.severityThreshold || 'medium';
  S.autoContinue.checked = (settings.receiving?.autoContinue ?? 0) > 0;
  S.budget.value = settings.context?.budgetTokens ?? 6000;
  S.keepRecent.value = settings.context?.keepRecentTurns ?? 6;
  updateEnginePill();
}

function updateEnginePill() {
  const on = state.settings?.enabled !== false;
  els.enginePill.classList.toggle('off', !on);
  els.enginePillText.textContent = on ? 'Mediación activa' : 'Mediación desactivada';
}

async function patchSettings(patch) {
  const next = await nexo.setSettings(patch);
  fillSettings(next);
}

S.enabled.addEventListener('change', () => patchSettings({ enabled: S.enabled.checked }));
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
  const next = await nexo.resetSettings();
  fillSettings(next);
});
S.clearLog.addEventListener('click', async () => {
  state.logs = await nexo.clearLog();
  renderLog();
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
    els.browser.classList.remove('with-sidebar');
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
  if (!window.confirm('¿Borrar historial, marcadores, descargas, sesión y datos de los sitios? No se puede deshacer.')) return;
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
  pushLocalNotice('Todos los datos locales del navegador fueron borrados.');
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

nexo.on('nexo:downloads-changed', () => renderDownloads());
nexo.on('nexo:download-done', (payload) => {
  if (!payload) return;
  const state = payload.state === 'completed' ? 'completada' : payload.state;
  pushLocalNotice(`Descarga ${state}: ${payload.filename}`);
  renderDownloads();
});
nexo.on('nexo:bookmarks-changed', () => {
  renderBookmarks();
  updateStar();
});
nexo.on('nexo:profile-changed', () => renderSitePanel());

// Al cerrar la ventana se guarda la sesión con los datos más frescos. Se usa
// `send` y no `invoke` porque en `beforeunload` no hay tiempo para una respuesta.
window.addEventListener('beforeunload', () => {
  const tabs = [...state.tabs.values()].map((tab) => ({ url: tab.url, title: tab.title }));
  if (!tabs.length) return;
  const activeIndex = Math.max(0, [...state.tabs.keys()].indexOf(state.activeId));
  nexo.session.saveNow([{ tabs, activeIndex }]);
});

document.querySelectorAll('.stab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.stab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel-view').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === tab.dataset.panel);
    });
    const panel = tab.dataset.panel;
    if (panel === 'memory') refreshMemory();
    if (panel === 'history') renderHistory();
    if (panel === 'bookmarks') renderBookmarks();
    if (panel === 'downloads') renderDownloads();
    if (panel === 'sites') renderSitePanel();
  });
});

/** Abre el panel lateral en la solapa pedida. */
function showPanel(name) {
  els.browser.classList.add('with-sidebar');
  document.querySelector(`.stab[data-panel="${name}"]`)?.click();
}

// El proceso principal avisa cuando la memoria cambia por otra vía (importación,
// vaciado) para que el panel no muestre datos viejos.
nexo.on?.('nexo:memory-changed', () => {
  if (document.querySelector('.stab[data-panel="memory"]')?.classList.contains('active')) refreshMemory();
});

/* ------------------------------------------------------------------ */
/* eventos del proceso principal                                       */
/* ------------------------------------------------------------------ */

nexo.on('nexo:event', (message) => {
  if (message?.type === 'intervention' && message.payload) {
    pushIntervention(message.payload);
    refreshStats();
  }
});

nexo.on('nexo:settings-changed', (settings) => {
  fillSettings(settings);
  renderSitesList();
});

nexo.on('nexo:open-tab', ({ url }) => {
  if (url) createTab(url);
});

nexo.on('nexo:command', (command) => {
  switch (command?.type) {
    case 'new-tab':
      createTab(START_URL);
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
      els.browser.classList.toggle('with-sidebar');
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
        const ids = [...state.tabs.keys()];
        if (ids[index]) activateTab(ids[index]);
        else if (index === 8) activateTab(ids[ids.length - 1]);
      }
      break;
  }
});

document.getElementById('openDemo').addEventListener('click', () => createTab(DEMO_URL));

/* ------------------------------------------------------------------ */
/* arranque                                                            */
/* ------------------------------------------------------------------ */

async function boot() {
  state.config = await nexo.getConfig();
  document.getElementById('version').textContent = `v${state.config.version}`;

  const settings = await nexo.getSettings();
  fillSettings(settings);
  renderSitesList();

  state.logs = await nexo.getLog();
  renderLog();
  refreshStats();
  refreshMemory();
  renderHistory();
  renderBookmarks();
  renderDownloads();

  // Continuidad: si había pestañas guardadas, se reabren tal cual estaban.
  let restored = null;
  try {
    restored = await nexo.session.restore();
  } catch {
    restored = null;
  }

  if (restored?.windows?.[0]?.tabs?.length) {
    const win = restored.windows[0];
    const ids = win.tabs.map((tab) => createTab(tab.url, { activate: false }).id);
    activateTab(ids[Math.min(win.activeIndex, ids.length - 1)]);
    pushLocalNotice(`Se restauraron ${ids.length} ${ids.length === 1 ? 'pestaña' : 'pestañas'} de la sesión anterior.`);
  } else {
    createTab(START_URL);
  }

  els.browser.classList.add('with-sidebar');
  els.omnibox.focus();
  renderSitePanel();
}

boot();

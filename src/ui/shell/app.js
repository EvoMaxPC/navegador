/**
 * Interfaz de navegador de Nexo.
 *
 * Las pestañas son `<webview>` reales de Chromium. La shell no habla con los
 * sitios: solo orquesta pestañas, ajustes y el panel de intervenciones que el
 * proceso principal le empuja por IPC.
 */

import { SITES } from '../../core/sites.js';

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
};

const DEMO_URL = 'nexo://app/demo/index.html';
const SEARCH = 'https://duckduckgo.com/?q=';

const state = {
  tabs: new Map(),
  activeId: null,
  seq: 0,
  config: null,
  settings: null,
  logs: [],
};

/* ------------------------------------------------------------------ */
/* utilidades                                                          */
/* ------------------------------------------------------------------ */

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

function normalizeInput(text) {
  const value = text.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('nexo://')) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)) return `https://${value}`;
  return SEARCH + encodeURIComponent(value);
}

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

function createTab(url = DEMO_URL, { activate = true } = {}) {
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
  els.omnibox.value = tab.url === DEMO_URL ? 'Sala de pruebas de Nexo' : tab.url;
  tab.cut = 0;
  tab.tabEl.querySelector('.cut-dot').hidden = true;
}

function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  tab.view.remove();
  tab.tabEl.remove();
  state.tabs.delete(id);

  if (state.activeId === id) {
    const next = [...state.tabs.keys()].pop();
    if (next) activateTab(next);
    else state.activeId = null;
  }
  updateWelcome();
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
  const tab = activeTab() || createTab(target);
  tab.url = target;
  if (tab.view.getURL?.() && tab.view.loadURL) tab.view.loadURL(target);
  else tab.view.setAttribute('src', target);
}

/* ------------------------------------------------------------------ */
/* navegación                                                          */
/* ------------------------------------------------------------------ */

els.omniboxForm.addEventListener('submit', (event) => {
  event.preventDefault();
  els.omnibox.blur();
  navigate(els.omnibox.value);
});

els.back.addEventListener('click', () => activeTab()?.view.canGoBack?.() && activeTab().view.goBack());
els.forward.addEventListener('click', () => activeTab()?.view.canGoForward?.() && activeTab().view.goForward());
els.reload.addEventListener('click', () => activeTab()?.view.reload());
els.newTab.addEventListener('click', () => createTab(DEMO_URL));

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

document.querySelectorAll('.stab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.stab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel-view').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === tab.dataset.panel);
    });
    if (tab.dataset.panel === 'memory') refreshMemory();
  });
});

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
      createTab(DEMO_URL);
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
      els.browser.classList.add('with-sidebar');
      document.querySelector('.stab[data-panel="settings"]')?.click();
      break;
    default:
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

  createTab(DEMO_URL);
  els.browser.classList.add('with-sidebar');
  els.omnibox.focus();
}

boot();

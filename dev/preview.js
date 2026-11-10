/** Adaptador de vista web. No se empaqueta ni sustituye Electron en producción. */
import { DEFAULT_SETTINGS, mergeSettings } from '/src/core/settings.js';
const listeners = new Map();
let settings = structuredClone(DEFAULT_SETTINGS);
const empty = async () => [];
const result = async () => ({ ok: true, removed: 0 });
window.nexo = {
  getConfig: async () => ({ version: '0.1.28 · vista web', pagePreload: null }),
  getSettings: async () => settings,
  setSettings: async (patch) => (settings = mergeSettings(settings, patch)),
  resetSettings: async () => (settings = structuredClone(DEFAULT_SETTINGS)),
  getLog: empty, clearLog: empty,
  getStats: async () => ({ messages: 0, responses: 0, inputTokens: 0, outputTokens: 0, interventions: 0, turnsCancelled: 0, turnsFailed: 0, turnsPerformed: 0 }),
  perf() {}, suggest: empty, openExternal: result,
  session: { restore: async () => null, capture: result, saveNow() {} },
  bookmarks: { list: empty, is: async () => false, toggle: result, remove: result, clear: result },
  history: { list: empty, clear: result, remove: result, top: empty },
  repetition: { get: async () => null },
  memory: { stats: async () => ({ active: 0, tokens: 0, savedPct: 0 }), list: empty, conversations: empty, recall: empty, handoff: async () => ({ markdown: 'Vista web: no hay memoria de Electron conectada.' }), import: result, clear: result, pin: result, forget: result },
  downloads: { list: empty, clear: result, open: result, show: result, cancel: result },
  zoom: { get: async () => 1, set: result },
  permissions: { for: empty, set: result },
  profile: { stats: async () => ({ history: { total: 0 }, bookmarks: 0, downloads: { total: 0 }, permissionSites: 0 }), clear: result }, data: { clear: result },
  on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
};
const create = document.createElement.bind(document);
document.createElement = function (tag, ...args) {
  if (tag !== 'webview') return create(tag, ...args);
  const frame = create('iframe');
  frame.title = 'Página de inicio de Nexo (vista web)';
  frame.classList.add('preview-webview');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  const set = frame.setAttribute.bind(frame);
  frame.setAttribute = (name, value) => {
    if (name === 'src') value = '/src/ui/start/index.html';
    set(name, value);
  };
  frame.loadURL = () => { frame.src = '/src/ui/start/index.html'; };
  frame.reload = () => frame.contentWindow?.location.reload();
  frame.canGoBack = frame.canGoForward = () => false;
  frame.addEventListener('load', () => {
    const event = new Event('page-title-updated'); event.title = 'Pestaña nueva'; frame.dispatchEvent(event);
    frame.dispatchEvent(new Event('did-stop-loading'));
    try { frame.contentDocument.addEventListener('click', (event) => { if (event.target.closest('a')) { event.preventDefault(); alert('Vista de interfaz: los sitios se abren en la aplicación Electron.'); } }); } catch { /* frame ajeno */ }
  });
  return frame;
};
const badge = create('div');
badge.textContent = 'VISTA UI · sin motor Electron · sin conversaciones reales';
badge.style.cssText = 'position:fixed;bottom:8px;left:12px;z-index:90;font:9px system-ui;color:#526b60;background:#f8faf4;border:1px solid #d8e1dc;border-radius:5px;padding:5px 8px;pointer-events:none';
document.body.append(badge);
const style = create('style');
style.textContent = '.viewport iframe{position:absolute;inset:0;width:100%;height:100%;border:0}.viewport iframe.hidden{display:none}';
document.head.append(style);
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const keys = { t: 'new-tab', w: 'close-tab', l: 'focus-omnibox' };
  const type = keys[event.key.toLowerCase()];
  if (type) { event.preventDefault(); listeners.get('nexo:command')?.({ type }); }
});

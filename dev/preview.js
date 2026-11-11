import {browserPreferences} from '/src/nav/browserPreferences.js';
/** Adaptador de vista web. No se empaqueta ni sustituye Electron en producción. */
import { DEFAULT_SETTINGS, mergeSettings } from '/src/core/settings.js';
const listeners = new Map();
let settings = structuredClone(DEFAULT_SETTINGS);
let previewPrefs;try{previewPrefs=browserPreferences(JSON.parse(localStorage.getItem('nexo-design-preview')||'{}'));}catch{previewPrefs=browserPreferences();}
document.documentElement.style.zoom=previewPrefs.uiZoom;
const empty = async () => [];
const result = async () => ({ ok: true, removed: 0 });
window.nexo = {
  // Atajos de conversación simulados en localStorage: la vista web no envía
  // texto a ningún sitio real ni conserva nada fuera del navegador.
  prompts: {
    list: async () => ({ ok: true, items: JSON.parse(localStorage.getItem('nexo-preview-prompts') || '[]') }),
    save: async (payload = {}) => {
      const items = JSON.parse(localStorage.getItem('nexo-preview-prompts') || '[]');
      const row = { id: payload.id || `p-${Date.now().toString(36)}`, title: String(payload.title || '').slice(0, 60), text: String(payload.text || '') };
      const at = items.findIndex((item) => item.id === row.id);
      if (at >= 0) items[at] = row; else items.push(row);
      localStorage.setItem('nexo-preview-prompts', JSON.stringify(items));
      return { ok: true, items };
    },
    remove: async (id) => {
      const items = JSON.parse(localStorage.getItem('nexo-preview-prompts') || '[]').filter((item) => item.id !== id);
      localStorage.setItem('nexo-preview-prompts', JSON.stringify(items));
      return { ok: true, items };
    },
    render: async () => ({ ok: true, text: '', missing: [] }),
  },
  domTokens: { observe: async () => ({ ok: false }) },
  tokenizer: { models: async () => ({ ok: false, error: 'El tokenizador local se ejecuta en la aplicación Electron; la vista web no simula el conteo.' }), count: async () => ({ ok: false, error: 'Abrí Nexo para contar con el tokenizador local.' }) },
  // Vista de demostración: el panel de Comprensión necesita una lectura real
  // del webview, que acá no existe. Se devuelve un resultado de ejemplo,
  // marcado como simulado, para revisar la presentación y la entrega del
  // contexto sin afirmar que se midió una conversación.
  understanding: {
    read: async () => ({
      ok: true,
      status: 'optimized',
      reason: 'Reconstrucción literal verificada.',
      original: 'Pregunta: ¿cómo resumo este documento?\nRespuesta: con tres pasos.',
      optimized: 'Pregunta: ¿cómo resumo este documento?\nRespuesta: con tres pasos.',
      metrics: { original: 92, optimized: 92, saved: 0, percent: 0, tokenizer: { estimated: false, encoding: 'o200k_base', model: 'gpt-4o' } },
    }),
    edit: async () => ({ ok: false, error: 'La comprensión persistente se ejecuta en Electron; esta vista no la simula.' }),
    recall: async () => [],
    contexts: async () => [],
    bind: async () => ({ ok: false, error: 'Sólo en Electron.' }),
    clear: async () => ({ ok: false, error: 'Sólo en Electron.' }),
  },
  work: Object.fromEntries(['read','mutate','attach','capture','clear','export'].map(k=>[k,async()=>({ok:false,error:'Los expedientes usan el almacenamiento local de Electron. No se simula persistencia en esta vista web.'})])),
  advanced: {preferences:async()=>previewPrefs,setPreferences:async next=>{previewPrefs=browserPreferences(next);localStorage.setItem('nexo-design-preview',JSON.stringify(previewPrefs));document.documentElement.style.zoom=previewPrefs.uiZoom;listeners.get('nexo:browser-prefs')?.(previewPrefs);return {ok:true,prefs:previewPrefs};},action:async()=>({ok:false,error:'Herramienta disponible sólo en la aplicación Electron.'}),context:async()=>({ok:false,error:'No hay un evento de contexto nativo en la vista UI.'})},
  getConfig: async () => ({ version: '0.1.33 · vista web', pagePreload: null }),
  getStorageStatus: async () => ({ state: 'preview', backup: null, error: null }),
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
  // Vista de interfaz: permite ver la barra de continuación sin motor real.
  onTurnFollowUp(handler) { listeners.set('nexo:turn-followup', handler); return () => listeners.delete('nexo:turn-followup'); },
  // Gancho de demostración (sólo esta vista): simula un cierre con reparación
  // y continuación para comprobar la barra, sin enviar ni insertar nada.
  demoFollowUp() {
    const frame = [...document.querySelectorAll('.viewport iframe')].at(-1);
    listeners.get('nexo:turn-followup')?.({ webContentsId: frame?.getWebContentsId?.(), fixes: ['Markdown reparado'], next: { type: 'continue', label: 'Continuar la respuesta', prompt: 'Continuá exactamente donde se cortó.' }, suggestions: [] });
  },
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
  // Identificador estable para la vista de interfaz: el código real compara
  // `getWebContentsId()` de cada pestaña con el evento del proceso principal.
  frame.getWebContentsId = () => (frame.__nexoId ||= 1000 + Math.floor(Math.random() * 100000));
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
badge.style.cssText = 'position:fixed;bottom:43px;left:12px;z-index:90;font:9px system-ui;color:#9eadbf;background:#101722;border:1px solid #26384b;border-radius:5px;padding:5px 8px;pointer-events:none';
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

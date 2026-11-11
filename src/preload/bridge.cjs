/**
 * Preload de las pestañas de IA.
 *
 * Corre en el mundo aislado, así que puede hablar con el proceso principal y a
 * la vez inyectar código en el mundo principal de la página. Es el puente entre
 * los dos mundos y el único punto con privilegios.
 */

const { ipcRenderer, webFrame } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { outgoingMetadata } = require('./token-metadata.cjs');

const INJECT_PATH = join(__dirname, '..', '..', 'build', 'inject.js');

let injected = false;
let injectSource = '';
let conversationReader = null;
let understandingReader = null;
function startUnderstandingReader() {
  if (understandingReader) return;
  if (typeof document === 'undefined' ||
    (typeof process !== 'undefined' && process.isMainFrame === false) ||
    !['chatgpt.com', 'chat.openai.com'].includes(location.hostname) || location.protocol !== 'https:') return;
  try {
    const { startUnderstandingReader } = require('../../build/understanding-reader.cjs');
    understandingReader = startUnderstandingReader({ document, window, ipcRenderer });
  } catch {
    console.warn('[nexo] no se pudo iniciar el lector independiente de Comprensión');
  }
}

function startConversationReader(config) {
  if (conversationReader) { conversationReader.updateSettings(config); return; }
  if (typeof document === 'undefined' ||
    (typeof process !== 'undefined' && process.isMainFrame === false) ||
    !['chatgpt.com', 'chat.openai.com'].includes(location.hostname) || location.protocol !== 'https:') return;
  try {
    const { startChatGptReader } = require('../../build/chatgpt-reader.cjs');
    conversationReader = startChatGptReader({ document, window, ipcRenderer, config: { ...config, understandingReaderActive: Boolean(understandingReader) } });
  } catch {
    console.warn('[nexo] no se pudo iniciar el lector aislado de ChatGPT');
  }
}


/**
 * Código de la capa de inyección, leído una vez por proceso de renderizado.
 * @returns {string}
 */
function readInjectSource() {
  if (injectSource) return injectSource;
  try {
    injectSource = readFileSync(INJECT_PATH, 'utf8');
  } catch (error) {
    console.warn('[nexo] falta build/inject.js — ejecutá «npm run build:inject»');
    injectSource = '';
  }
  return injectSource;
}

/**
 * Configuración del motor para este sitio. Se pide de forma SÍNCRONA: el
 * enganche de `fetch` tiene que estar instalado antes de que corra el primer
 * script de la página. Con una espera asíncrona (o esperando a
 * `DOMContentLoaded`) la aplicación del sitio ya habría guardado su propia
 * referencia a `window.fetch` y la mediación nunca vería los mensajes.
 */
function readConfigSync(host) {
  try {
    const config = ipcRenderer.sendSync('nexo:config-sync', { host, href: location.href });
    if (config && typeof config === 'object') return config;
  } catch (error) {
    console.warn('[nexo] configuración síncrona no disponible:', error.message);
  }
  return null;
}

/**
 * La lectura de ChatGPT no depende de la mediación.
 *
 * El bundle también alimenta la vista volátil de repetición aunque EVO MEMORY
 * esté apagada. El motor conserva state.enabled=false y no modifica envíos.
 * El watcher decide por separado si publica snapshots para persistencia.
 */
function shouldInject(config, host) {
  if (!config || config.profiled === false) return false;
  const isChatGpt = host === 'chatgpt.com' || host === 'chat.openai.com';
  // La repetición literal es de sólo lectura y no depende de EVO MEMORY.
  return config.enabled !== false || isChatGpt;
}

/** Inyecta la capa en el mundo principal de la página. */
function inject(config) {
  const source = readInjectSource();
  if (!source) return;
  const prelude = `window.__NEXO_CONFIG__ = ${JSON.stringify(config)};`;
  try {
    // Se lanza sin `await`: nada tiene que interponerse antes de los scripts del
    // sitio, y el error —si lo hubiera— se informa sin romper la página.
    webFrame.executeJavaScript(prelude + '\n;' + source, false).catch((error) => {
      console.warn('[nexo] fallo al inyectar:', error.message);
    });
  } catch (error) {
    console.warn('[nexo] fallo al inyectar:', error.message);
  }
}

function boot() {
  if (injected) return;
  injected = true;

  // Las páginas internas (sala de pruebas, interfaz) no se median.
  if (!/^https?:$/.test(location.protocol)) return;

  const host = location.hostname;
  const config = readConfigSync(host);
  // La vista RAM puede arrancar aun si la configuración aún no está disponible.
  startUnderstandingReader();
  startConversationReader(config || { settings: { memory: { enabled: false } } });
  if (config) {
    if (shouldInject(config, host)) inject(config);
    return;
  }

  // Sin canal síncrono queda el camino asíncrono. Llega tarde para algunos
  // sitios, pero es mejor que no mediar nada.
  ipcRenderer
    .invoke('nexo:config', { host, href: location.href })
    .then((asyncConfig) => {
      startConversationReader(asyncConfig);
      if (shouldInject(asyncConfig, host)) inject(asyncConfig);
    })
    .catch((error) => console.warn('[nexo] sin configuración:', error.message));
}

/* ------------------------------------------------------------------ */
/* puente de mensajes: mundo principal <-> proceso principal           */
/* ------------------------------------------------------------------ */

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || !data.__nexo) return;

  if (data.__nexo === 'call') {
    const { id, type, payload } = data;
    // Una página sólo puede solicitar mediación: no elegir un canal privilegiado
    // de la shell (borrar datos, leer memoria, modificar ajustes, etc.).
    if (type !== 'prepare') {
      window.postMessage({ __nexo: 'reply', id, error: 'canal-no-permitido' }, '*');
      return;
    }
    try {
      const result = await ipcRenderer.invoke('nexo:prepare', payload || {});
      window.postMessage({ __nexo: 'reply', id, payload: result }, '*');
    } catch (error) {
      window.postMessage({ __nexo: 'reply', id, error: String(error?.message || error) }, '*');
    }
    return;
  }

  // «La capa quedó instalada»: sin este aviso no había forma de distinguir una
  // página que nunca se medió de una página donde la inyección no corrió.
  if (data.__nexo === 'ready') {
    ipcRenderer.send('nexo:event', { type: 'ready', payload: data.payload || {}, href: location.href });
    return;
  }

  if (data.__nexo === 'event') {
    const { type, payload } = data;
    // Los snapshots privados sólo salen del lector aislado, no de postMessage de la web.
    if (type === 'conversation-repetition' || type === 'conversation-snapshot' || type === 'understanding-conversation') return;
    if (type === 'turn-result') {
      await ipcRenderer.invoke('nexo:turn-result', payload).catch((error) => console.warn('[nexo] resultado no notificado:', error.message));
      return;
    }
    if (type === 'stream-progress') {
      await ipcRenderer.invoke('nexo:stream-progress', payload).catch((error) => {
        console.warn('[nexo] progreso de tokens no notificado:', error.message);
      });
      return;
    }
    if (type === 'stream-end') {
      const action = await ipcRenderer.invoke('nexo:stream-end', payload).catch(() => null);
      if (action?.nextAction && payload?.stopped) {
        // La continuación automática solo se envía si el usuario la habilitó.
        const settings = await ipcRenderer.invoke('nexo:settings:get').catch(() => null);
        const allowed = (settings?.receiving?.autoContinue ?? 0) > 0;
        if (allowed) {
          window.postMessage({ __nexo: 'action', type: 'continue', payload: { prompt: action.nextAction.prompt } }, '*');
        }
      }
      return;
    }
    ipcRenderer.send('nexo:event', { type, payload: type === 'outgoing' ? outgoingMetadata(payload) : payload, href: location.href });
  }
});

// Acciones que llegan desde la interfaz (o desde el motor) hacia la página.
ipcRenderer.on('nexo:action', (_event, action) => {
  window.postMessage({ __nexo: 'action', ...action }, '*');
});

ipcRenderer.on('nexo:understanding-read', () => understandingReader?.read());

ipcRenderer.on('nexo:conversation-read', () => conversationReader?.read());

ipcRenderer.on('nexo:settings', (_event, payload) => {
  conversationReader?.updateSettings(payload);
  window.postMessage({ __nexo: 'action', type: 'settings', payload }, '*');
});

// Inmediato: el preload corre antes que cualquier script de la página.
boot();

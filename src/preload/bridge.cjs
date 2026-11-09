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

const INJECT_PATH = join(__dirname, '..', '..', 'build', 'inject.js');

let injected = false;

async function boot() {
  if (injected) return;
  injected = true;

  // Las páginas internas (sala de pruebas, interfaz) no se median.
  if (!/^https?:$/.test(location.protocol)) return;

  const host = location.hostname;

  let config;
  try {
    config = await ipcRenderer.invoke('nexo:config', { host, href: location.href });
  } catch (error) {
    console.warn('[nexo] sin configuración:', error.message);
    return;
  }

  if (!config || config.enabled === false) return;

  let source = '';
  try {
    source = readFileSync(INJECT_PATH, 'utf8');
  } catch (error) {
    console.warn('[nexo] falta build/inject.js — ejecutá «npm run build:inject»');
    return;
  }

  const prelude = `window.__NEXO_CONFIG__ = ${JSON.stringify(config)};`;
  try {
    // El mundo aislado puede ejecutar código en el mundo principal de la página.
    await webFrame.executeJavaScript(prelude + '\n;' + source, false);
  } catch (error) {
    console.warn('[nexo] fallo al inyectar:', error.message);
  }
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
    try {
      const result = await ipcRenderer.invoke(`nexo:${type}`, payload || {});
      window.postMessage({ __nexo: 'reply', id, payload: result }, '*');
    } catch (error) {
      window.postMessage({ __nexo: 'reply', id, error: String(error?.message || error) }, '*');
    }
    return;
  }

  if (data.__nexo === 'event') {
    const { type, payload } = data;
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
    ipcRenderer.send('nexo:event', { type, payload, href: location.href });
  }
});

// Acciones que llegan desde la interfaz (o desde el motor) hacia la página.
ipcRenderer.on('nexo:action', (_event, action) => {
  window.postMessage({ __nexo: 'action', ...action }, '*');
});

ipcRenderer.on('nexo:settings', (_event, payload) => {
  window.postMessage({ __nexo: 'action', type: 'settings', payload }, '*');
});

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

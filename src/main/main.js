import { DomTokenTotals } from './domTokenTotals.js';
import { tokenizerModels, calculateTokenizer } from './tokenizerCalculator.js';
import { ConversationOptimizer, installOptimizationIPC } from './conversationOptimizer.js';
import { installWorkDossier } from './workDossier.js';
import { installAdvancedBrowser } from './advancedBrowser.js';
import { PromptStore } from './promptStore.js';
import { MAX_PROMPTS, PROMPT_VARIABLES } from '../core/prompts.js';
import { repetitionSnapshot } from '../core/conversationRepetition.js';
import { isPublicAssetPath } from './internalAssets.js';
import { configForTab, settingsForTab } from './tabConfig.js';
import { createCaptureDiagnostic } from './captureDiagnostic.js';
import { isChatGptMemoryUrl } from '../core/chatgptConversation.js';
/**
 * Proceso principal de Nexo.
 *
 * Una ventana con la interfaz de navegador (pestañas al estilo Chromium) y una
 * `<webview>` por pestaña. Cada webview lleva el preload que inyecta la capa de
 * mediación en el sitio de IA.
 */

import { app, BrowserWindow, ipcMain, protocol, session, shell, webContents, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createMemory } from './memory.js';
import { CdpObserver } from './cdp.js';
import { isAiHost } from '../core/cdp.js';
import { detectSite, isAuthRequest, isMediable, isPreparationRequest, isResponseRequest, locateUserText } from '../core/sites.js';
import { createProfile } from './profile.js';
import { buildMenu } from './menu.js';
import { DEFAULT_SETTINGS, isEvoMemoryEnabled, settingsForHost } from '../core/settings.js';
import { createEgressGate } from './egressGate.js';
import { inspectOutgoing } from './egressNet.js';
import { normalizeEgress } from '../core/egressConfig.js';
import { fingerprint, gptModelFromRequest, userMessageIdentity } from '../core/text.js';
import { inputTokenMeasurement, countOutputTokens } from './tokens.js';
import gptTokens from '../core/gptTokens.cjs';
import { hostOf, isInternal } from '../nav/url.js';
import { commandFor } from '../nav/shortcuts.js';
import { sanitizeFilename } from '../nav/downloads.js';
import { runSmoke, report as reportSmoke, render as renderSmoke } from './smoke.js';
import { eventMessage, permissionName, safeExternalUrl, sessionPayload } from './validate.js';
import { PERMISSION_CATALOG } from '../nav/permissions.js';
import { absorb as absorbPerf, mark, set as setPerf, smokeReport } from './perf.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SHELL_PRELOAD = join(ROOT, 'src', 'preload', 'shell.cjs');
const PAGE_PRELOAD = join(ROOT, 'src', 'preload', 'bridge.cjs');

const isDev = process.argv.includes('--dev');

// Antes de crear la ventana: se apagan los servicios de Chromium que este
// navegador no usa (traducción, enrutado de medios, sugerencias de
// optimización). Cada uno cuesta un proceso o trabajo de red en segundo plano.
app.commandLine.appendSwitch(
  'disable-features',
  [
    'Translate', // no hay traducción en la interfaz
    'MediaRouter', // no hay Chromecast ni dispositivos de salida remotos
    'DialMediaRouteProvider',
    'OptimizationHints', // descarga de modelos de navegación que no se usan
    'InterestFeedContentSuggestions',
    'HeavyAdPrivacyMitigations',
  ].join(','),
);

mark('proceso');

/**
 * Chromium se presenta como «Electron» y con el nombre de la aplicación en el
 * `User-Agent`. Varios proveedores usan ese token para separar clientes
 * automatizados: la portada carga (viene de caché de CDN) pero las llamadas a la
 * API devuelven 403, o el desafío anti-bot de la portada no se resuelve y la
 * pestaña queda en blanco.
 *
 * Se deja un `User-Agent` de Chrome corriente. No se toca nada más del motor: el
 * resto de la huella (pistas de cliente, WebGL) es la de Chromium.
 */
function normalizeUserAgent() {
  const original = String(app.userAgentFallback || '');
  if (!original) return '';
  const clean = original
    .replace(/\s(Electron|Nexo)\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (clean && clean !== original) app.userAgentFallback = clean;
  return app.userAgentFallback;
}

const USER_AGENT = normalizeUserAgent();
/** `--smoke`: arranca, revisa la interfaz y sale. Lo usa el flujo de Windows. */
const isSmoke = process.argv.includes('--smoke') || process.env.NEXO_SMOKE === '1';
/**
 * Archivo donde la prueba de humo deja su informe. En Windows el ejecutable es
 * una aplicación de interfaz: lo que escribe en la consola no llega al proceso
 * que lo lanzó, así que el resultado también va a un archivo.
 */
const smokeOut = process.env.NEXO_SMOKE_OUT || null;

/** Evita que una excepción de apagado cambie un resultado ya escrito. */
let smokeDone = false;

if (isSmoke && smokeOut) {
  // Si el arranque revienta antes de la prueba, el archivo tiene que decirlo.
  const crash = (kind) => (error) => {
    if (smokeDone) {
      // Tarde: el informe ya está y el código de salida ya se decidió.
      appendFile(smokeOut, `\n· ${kind} durante el apagado: ${error?.message || error}\n`).catch(() => {});
      return;
    }
    appendFile(smokeOut, `\n✖ ${kind} al arrancar: ${error?.stack || error}\n`).finally(() =>
      app.exit(70),
    );
  };
  process.on('uncaughtException', crash('excepción'));
  process.on('unhandledRejection', crash('promesa rechazada'));
}

let win = null;
let advancedBrowser = null;
let workDossier = null;
let conversationOptimizer = null;
let promptStore = null;
let store = null;
let engine = null;
/**
 * Observación CDP: frames de WebSocket y respuestas JSON que el enganche de
 * `fetch` no alcanza. Es sólo lectura —no reescribe tráfico— y si no está
 * disponible, el navegador funciona igual.
 */
let cdp = null;
/**
 * Lo que Nexo vio por su cuenta, sin contar nada de la conversación: si el
 * vigilante de red está registrado, cuántas peticiones pasaron y cuántas eran
 * de conversación. Sirve para saber si el fallo está en la captura o después.
 */
const capture = {
  watcher: false,
  since: 0,
  requests: 0,
  posts: 0,
  chatRequests: 0,
  counted: 0,
  blocked: 0,
  lastRequestAt: 0,
};
/**
 * Canal `egress`: retiene o redacta datos sensibles antes de que salgan. El
 * modo por defecto es `off`, así que hoy no interviene ningún envío.
 */
let egressGate = null;
let memory = null;
/** Registro local de diagnóstico de captura: sólo metadatos, nunca texto de conversación. */
let captureDiagnosticFile = null;
let captureDiagnostic = null;
function writeCaptureTrace(stage, data = {}) {
  return captureDiagnostic?.write(stage, data);
}

// Vista volátil: nunca escribe conversaciones en logs, diagnóstico ni un archivo nuevo.
const repetitionSnapshots = new Map();
// Sólo snapshots del frame principal de un guest perteneciente a nuestra shell.
const domTokenSnapshots = new Map();
const domTokenTotals = new DomTokenTotals();
function publishRepetition(snapshot) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.getURL() === 'nexo://app/src/ui/shell/index.html') {
      window.webContents.send('nexo:repetition-changed', snapshot);
    }
  }
}
function clearRepetition(id) {
  repetitionSnapshots.delete(id);
  domTokenSnapshots.delete(id);
  publishRepetition({ webContentsId: id, href: null, turns: [] });
}

let profile = null;
/** Guardado diferido: navegar no debe escribir en disco en cada clic. */
let saveTimer = null;
/** Relación entre descargas de Chromium y entradas del perfil. */
const downloadItems = new Map();
/**
 * Recuperación de pestañas caídas: intentos por pestaña y temporizador que los
 * olvida cuando la página demuestra que se sostiene.
 */
const crashRecovery = new Map();
/** Cuánto tiene que aguantar una página cargada para olvidar el choque previo. */
const CRASH_WINDOW_MS = Number(process.env.NEXO_CRASH_WINDOW_MS) || 5000;
let downloadSeq = 0;

/**
 * Esquema propio para servir la interfaz y la sala de pruebas desde el disco.
 * Permite módulos ES (que `file://` bloquea por CORS) y funciona sin conexión.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nexo',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Sirve la interfaz y la sala de pruebas desde el disco (o desde el asar del
 * empaquetado, que `node:fs` lee de forma transparente).
 *
 * Se lee con `fs` en lugar de `net.fetch('file://…')` para controlar el
 * `Content-Type` —los módulos ES no cargan sin `text/javascript`— y para poder
 * decir «no encontrado» sin que Chromium lo interprete como un fallo de red.
 */
function registerProtocol() {
  // Cuánto cuesta servir los archivos de la interfaz: si el arranque se va en
  // esto, el problema es el protocolo y no la página.
  let pedidos = 0;
  let total = 0;
  const serveInternal = async (request) => {
    const t0 = performance.now();
    try {
      return await servirArchivo(request);
    } finally {
      pedidos += 1;
      total += performance.now() - t0;
      setPerf('proto-pedidos', pedidos);
      setPerf('proto-ms', total);
    }
  };
  protocol.handle('nexo', serveInternal);
  // Los protocolos son por sesión. Las pestañas usan esta partición, no la
  // sesión de la shell. Mismo handler y allowlist; no se amplían permisos.
  session.fromPartition('persist:nexo').protocol.handle('nexo', serveInternal);
}

/**
 * Responde un pedido `nexo://` con el archivo del proyecto.
 * @param {Request} request
 */
async function servirArchivo(request) {
    let pathname;
    try {
      const requested = new URL(request.url);
      if (requested.hostname !== 'app') return new Response('No encontrado', { status: 404 });
      pathname = decodeURIComponent(requested.pathname);
    } catch {
      return new Response('Pedido inválido', { status: 400 });
    }
    if (pathname.includes('\0')) return new Response('Pedido inválido', { status: 400 });
    if (pathname.endsWith('/') || pathname === '') pathname += 'index.html';
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT + sep)) {
      return new Response('Prohibido', { status: 403 });
    }
    if (!isPublicAssetPath(relative(ROOT, file).split(sep).join('/'))) return new Response('No encontrado', { status: 404 });
    try {
      const info = await stat(file);
      if (!info.isFile()) return new Response('No encontrado', { status: 404 });
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
          'content-length': String(info.size),
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('No encontrado', { status: 404 });
    }
}

/**
 * Deja una entrada de diagnóstico en el registro de actividad.
 *
 * Es el canal para lo que antes no se veía: páginas que no cargan, fallos de la
 * capa inyectada y respuestas HTTP fallidas de un proveedor. Se deduplica por
 * código y título en una ventana corta: una petición que se reintenta en bucle
 * no debe llenar el registro.
 */
const diagnosticSeen = new Map();
function noteDiagnostic({ code, title, detail, severity = 'warn', meta = {}, key: explicitKey = null }) {
  if (!store) return null;
  // La clave agrupa lo que es el mismo aviso. Por omisión, código y título; el
  // vigilante de red pasa una clave con la ruta, para que dos endpoints
  // distintos del mismo proveedor no se pisen.
  const key = explicitKey || `${code}|${title}`;
  const now = Date.now();
  if (now - (diagnosticSeen.get(key) || 0) < 30_000) return null;
  diagnosticSeen.set(key, now);
  if (diagnosticSeen.size > 200) {
    for (const [k, ts] of diagnosticSeen) if (now - ts > 120_000) diagnosticSeen.delete(k);
  }
  const entry = { kind: 'system', code, severity, title, detail, meta, ts: now };
  store.pushLog(entry);
  if (/^(cdp-|response-|chatgpt-|gpt-response|conversation-memory)/.test(String(code || ''))) {
    writeCaptureTrace('diagnostic', { code, detail: String(detail || '').slice(0, 240), host: meta?.host, url: meta?.url, chars: meta?.chars });
  }
  broadcast('nexo:event', { type: 'intervention', payload: entry });
  return entry;
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Hosts de inicio de sesión federado.
 *
 * «Continuar con Google» no es un enlace: el sitio abre una ventana con
 * `window.open` y después la vigila —lee `popup.closed`, escucha `postMessage`
 * y espera el `window.close()` del final del flujo—. Si esa ventana no existe y
 * `window.open` devuelve `null`, el botón queda girando para siempre y la
 * ventana emergente no aparece nunca.
 *
 * Por eso los flujos de acceso se abren como ventana real. El resto de los
 * `window.open` sigue convirtiéndose en pestaña, como hasta ahora.
 */
const AUTH_POPUP_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'github.com',
  'gitlab.com',
  'okta.com',
  'auth0.com',
];

/** ¿Este `window.open` es parte de un inicio de sesión? */
function isAuthPopup(url, fromAiSite = false) {
  const raw = String(url || '');
  // Casi todos los flujos arrancan en blanco y después le cambian la dirección
  // a la ventana. Negar `about:blank` es negar el flujo entero; se acepta sólo
  // cuando lo pide una pestaña de proveedor, para no cambiar el resto de la web.
  if (!raw || raw.startsWith('about:blank')) return fromAiSite;
  const host = hostOf(raw);
  if (!host) return false;
  return AUTH_POPUP_HOSTS.some((auth) => host === auth || host.endsWith(`.${auth}`));
}

function createWindow() {
  win = new BrowserWindow({
    title: 'NEXO AI',
    icon: join(ROOT, 'src/ui/assets/identity', process.platform === 'win32' ? 'NEXO-Wormhole.ico' : 'NEXO-Wormhole.png'),
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#07080c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // La ventana se muestra desde el principio. Esperar a «ready-to-show»
    // significa esperar al primer cuadro, y en una máquina sin aceleración por
    // hardware ese cuadro puede tardar casi un segundo: el usuario mira el
    // escritorio mientras el navegador ya está arrancado. Con el fondo oscuro
    // puesto desde la creación, el marco aparece de inmediato y el contenido se
    // dibuja encima, sin destello blanco.
    show: true,
    webPreferences: {
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.webContents.once('did-finish-load', () => win?.webContents.setZoomFactor(advancedBrowser?.preferences.uiZoom || 1));

  advancedBrowser?.attachShell(win.webContents);
  workDossier?.attachShell(win.webContents);

  // La shell privilegiada no navega a sitios ni abre ventanas remotas.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== 'nexo://app/src/ui/shell/index.html') event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mark('visible');
  if (isSmoke) {
    // En modo humo la ventana no puede quedar oculta más allá de esto: Chromium
    // pospone el trabajo de una ventana oculta y entonces lo que se mide no es
    // el arranque que ve el usuario. Se evita tomar el foco para no interferir
    // con el resto del runner.
    try {
      win.showInactive();
    } catch {
      // Sin escritorio no hay nada que mostrar.
    }
  }
  win.on('closed', () => {
    cdp?.releaseAll();
    win = null;
  });

  // Endurecimiento de cada webview antes de que se cree.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = PAGE_PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
    webPreferences.webSecurity = true;
    webPreferences.spellcheck = advancedBrowser?.preferences.spellcheck ?? false;
    if (!/^https?:/i.test(params.src || '') && !String(params.src || '').startsWith('nexo:')) {
      event.preventDefault();
    }
  });

  // Las pestañas no pueden abrir ventanas: se convierten en pestañas nuevas.
  win.webContents.on('did-attach-webview', (_event, contents) => {
    advancedBrowser?.attachGuest(contents, win.webContents);
    contents.once('destroyed',()=>conversationOptimizer?.release(contents));
    contents.setWindowOpenHandler(({ url }) => {
      if (isAuthPopup(url, isAiHost(hostOf(contents.getURL())))) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 680,
            parent: win,
            modal: false,
            autoHideMenuBar: true,
            title: 'Iniciar sesión',
            backgroundColor: '#ffffff',
            webPreferences: {
              // La misma partición que la pestaña: sin eso, las cookies del
              // proveedor no viajan y el acceso termina en una pantalla vacía.
              partition: 'persist:nexo',
              // Sin preload: en una pantalla de consentimiento no hay nada que
              // mediar, y la capa no tiene por qué correr en un tercero.
              preload: '',
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
              spellcheck: false,
            },
          },
        };
      }
      broadcast('nexo:open-tab', { url });
      return { action: 'deny' };
    });

    // Una ventana abierta por un flujo de acceso no abre más ventanas ni navega
    // fuera de http(s). Se cierra sola cuando el proveedor termina el flujo.
    contents.on('did-create-window', (child) => {
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.webContents.on('will-navigate', (event, url) => {
        if (!/^https?:/i.test(String(url || ''))) event.preventDefault();
      });
    });

    // Historial: se registra desde el proceso principal para que no dependa de
    // que el JavaScript de la interfaz esté vivo.
    const recordVisit = (url, transition = 'link') => {
      if (!profile || isInternal(url)) return;
      profile.history.add({ url, title: contents.getTitle() || url, transition });
      scheduleProfileSave();
    };
    contents.on('did-navigate', (_e, url) => recordVisit(url));
    contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) recordVisit(url, 'in-page');
    });
    contents.on('page-title-updated', (_e, title) => {
      const url = contents.getURL();
      if (profile && url) profile.history.retitle(url, title);
    });
    contents.on('did-finish-load', () => {
      applyZoom(contents);
    });

    // Navegación que no llega: sin esto, una pestaña en blanco no dice nada.
    // El código -3 es «cancelada» y es normal (redirecciones, enlaces abortados).
    contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      noteDiagnostic({
        code: 'load-failed',
        title: `No se pudo cargar ${hostOf(validatedURL) || validatedURL || 'la página'}`,
        detail: `${errorDescription || 'error de red'} (${errorCode}). URL: ${String(validatedURL || '').slice(0, 200)}`,
        meta: { url: validatedURL || '', errorCode, errorDescription: errorDescription || '' },
      });
    });

    // CDP: observar los canales que el enganche de `fetch` no ve (frames de
    // WebSocket y respuestas JSON sin streaming). Se adjunta sólo a los sitios
    // con perfil conocido y se suelta si la pestaña navega a otro lado.
    cdp?.sync(contents);
    // Relectura confirmada después de cargar/navegar: el snapshot inicial puede
    // llegar antes de que getURL() refleje la URL definitiva del webview.
    const requestConversationRead = () => {
      if (!contents.isDestroyed() && isChatGptMemoryUrl(contents.getURL())) contents.send('nexo:conversation-read');
    };
    contents.on('dom-ready', requestConversationRead);
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) requestConversationRead(); });
    contents.on('did-start-navigation', (_e, url, _inPage, isMainFrame) => {
      if (isMainFrame) {
        clearRepetition(contents.id);
        domTokenTotals.navigate(contents.id, url);
      }
      if (!isMainFrame || _inPage) return;
      engine?.onTurnInterrupted(contents.id);
      broadcast('nexo:stats-changed', statsSnapshot());
      if (cdp && CdpObserver.wants(url)) cdp.attach(contents, url);
      else cdp?.release(contents);
    });

    // Atajos del navegador aunque la página tenga el foco: los aceleradores del
    // menú no siempre ganan contra una webview, y Ctrl+F se lo come el sitio.
    const shellOwner = win.webContents;
    contents.on('before-input-event', (event, input) => {
      advancedBrowser?.handleInput(event, input, contents, shellOwner);
    });

    contents.on('destroyed', () => {
      clearRepetition(contents.id);
      domTokenTotals.dropTab(contents.id);
      cdp?.release(contents);
      engine?.dropTab(contents.id);
      broadcast('nexo:stats-changed', statsSnapshot());
      if (profile) profile.saveAll();
    });
    if (isDev) contents.on('console-message', (_e, level, message) => console.log('[pestaña]', message));
  });

  win.webContents.once('did-finish-load', () => mark('shell'));
  win.loadURL('nexo://app/src/ui/shell/index.html');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function domTokenModel() {
  const configured = store?.settings?.tokenCounting?.model;
  return tokenizerModels().models.some(item => item.id === configured) ? configured : tokenizerModels().defaultModel;
}
function observeDomTokens(sender, snapshot, source = 'isolated') {
  return domTokenTotals.observe({ ...snapshot, source, href: sender.getURL(), webContentsId: sender.id,
    projectId: store?.settings?.memory?.projectId || 'default' }, domTokenModel());
}
/** Nombres legibles por tipo; el resumen del diálogo nunca lleva el valor. */
const EGRESS_TYPE_LABELS = {
  card: 'Tarjeta bancaria',
  api_key: 'Clave de API',
  email: 'Correo electrónico',
  dni_es: 'DNI/NIE',
};
const EGRESS_BUTTONS = {
  redact: 'Redactar y enviar',
  cancel: 'Cancelar envío',
  send: 'Enviar igualmente',
};

/**
 * Pregunta al usuario qué hacer con un envío que lleva datos críticos.
 *
 * Devuelve siempre uno de `redact | cancel | send | timeout`; cualquier fallo
 * es `cancel` (falla cerrado). El `detail` va con tipos y cantidades: nunca el
 * valor detectado.
 */
async function askNativeEgress({ sender, summary, allowed, timeoutMs }) {
  const list = Array.isArray(allowed) && allowed.length ? allowed : ['cancel'];
  const owner = sender?.hostWebContents || null;
  if (!owner || (typeof owner.isDestroyed === 'function' && owner.isDestroyed())) {
    noteDiagnostic({ code: 'egress-sin-ventana', severity: 'warn',
      title: 'NEXO no pudo mostrar la confirmación',
      detail: 'No se encontró la ventana de la pestaña; el envío se bloqueó.' });
    return 'cancel';
  }
  const parent = BrowserWindow.fromWebContents(owner);
  if (!parent || parent.isDestroyed()) {
    noteDiagnostic({ code: 'egress-sin-ventana', severity: 'warn',
      title: 'NEXO no pudo mostrar la confirmación',
      detail: 'No se encontró la ventana de la pestaña; el envío se bloqueó.' });
    return 'cancel';
  }
  const buttons = list.map((choice) => EGRESS_BUTTONS[choice] || EGRESS_BUTTONS.cancel);
  const cancelId = Math.max(0, list.indexOf('cancel'));
  const detail = (Array.isArray(summary) ? summary : [])
    .map((s) => `• ${EGRESS_TYPE_LABELS[s?.type] || String(s?.type || 'dato')}: ${Number(s?.count) || 0}`)
    .join('\n');
  // Electron 45 admite `signal` en MessageBoxOptions: es el timeout real del
  // diálogo. Sin él, el cuadro queda abierto hasta que la persona decida.
  const controller = new AbortController();
  const ms = Number(timeoutMs);
  const timer = Number.isFinite(ms) && ms > 0
    ? setTimeout(() => controller.abort(), Math.min(ms, 600_000))
    : null;
  try {
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'NEXO',
      message: 'NEXO detectó datos sensibles en tu mensaje',
      detail,
      buttons,
      defaultId: cancelId,
      cancelId,
      noLink: true,
      signal: controller.signal,
    });
    // La doc de `signal` dice que el cuadro se comporta «como cancelado por el
    // usuario»: lo esperable es que RESUELVA con el botón de cancelar, no que
    // rechace (leído en electron.d.ts:23542-23547, no verificado en ejecución).
    // Por eso el timeout se mira antes que `response`; si igual rechaza, el
    // catch de abajo cubre el mismo caso.
    if (controller.signal.aborted) return 'timeout';
    return list[response] || 'cancel';
  } catch (error) {
    return controller.signal.aborted ? 'timeout' : 'cancel';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function statsSnapshot() {
  return {
    ...engine.stats(),
    domTokens: domTokenTotals.stats(store?.settings?.memory?.projectId || 'default', domTokenModel()),
    log: store.log.length,
    cdpObserver: cdp?.status() || null,
    captureDiagnosticFile,
    // Estado de la captura, para la línea de diagnóstico del panel. No son
    // contadores de la conversación: son hechos del propio vigilante.
    capture: { ...capture },
    egress: egressGate ? egressGate.stats() : null,
  };
}

function refreshGuestSettings() {
  for (const contents of webContents.getAllWebContents()) {
    const host = hostOf(contents.getURL());
    if (!contents.isDestroyed() && contents.getType() === 'webview' && isAiHost(host)) {
      contents.send('nexo:settings', engine.configFor(host));
    }
  }
}


/**
 * Resumen accionable del cierre de un turno, sólo si hay algo que ofrecer.
 * No incluye el texto de la respuesta ni datos del sitio: etiquetas, conteos
 * y el prompt sugerido por el motor local.
 */
function turnFollowUp(result) {
  if (!result || typeof result !== 'object') return null;
  const repaired = result.repaired || {};
  const fixes = Array.isArray(repaired.fixes) ? repaired.fixes.filter((x) => typeof x === 'string').slice(0, 8) : [];
  const suggestions = Array.isArray(result.suggestions)
    ? result.suggestions
      .filter((s) => s && typeof s.label === 'string' && typeof s.prompt === 'string' && s.prompt.trim() && s.prompt.length <= 2000)
      .slice(0, 4)
      .map((s) => ({ id: String(s.id || '').slice(0, 40), label: s.label.slice(0, 160), prompt: s.prompt }))
    : [];
  const next = result.nextAction && typeof result.nextAction.prompt === 'string'
    ? { type: String(result.nextAction.type || '').slice(0, 40),
        label: String(result.nextAction.label || '').slice(0, 160),
        prompt: result.nextAction.prompt.slice(0, 2000) } : null;
  if (!fixes.length && !suggestions.length && !next && !repaired.truncated && !repaired.refusal) return null;
  return { fixes, suggestions, next, truncated: Boolean(repaired.truncated), refusal: Boolean(repaired.refusal) };
}

function isShellRequest(event) {
  return Boolean(event?.sender && event.senderFrame===event.sender.mainFrame &&
    event.sender.getURL()==='nexo://app/src/ui/shell/index.html' &&
    BrowserWindow.getAllWindows().some(window=>window.webContents===event.sender));
}

function registerIpc() {
  ipcMain.handle('nexo:tokenizer:models', event => isShellRequest(event) ? tokenizerModels() : { ok: false, error: 'No autorizado.' });
  ipcMain.handle('nexo:tokenizer:count', (event, payload) => isShellRequest(event) ? calculateTokenizer(payload) : { ok: false, error: 'No autorizado.' });
  // La configuración que sale de acá la consume una pestaña: se recorta a lo que
  // la capa lee de verdad (`tabConfig.js`). El recorte va en el handler, no en
  // `engine.configFor`: el proceso principal —guardián y motor— la usa entera.
  ipcMain.handle('nexo:config', (_event, payload = {}) => configForTab(engine.configFor(payload.host || '')));

  // La misma configuración, pero síncrona: el preload de cada pestaña la
  // necesita ANTES de que la página registre su propio `fetch`. Es una llamada
  // de milisegundos y se paga una sola vez por documento.
  ipcMain.on('nexo:config-sync', (event, payload = {}) => {
    const host = typeof payload?.host === 'string' ? payload.host : '';
    try {
      event.returnValue = engine ? configForTab(engine.configFor(host)) : null;
    } catch (error) {
      // Un `sendSync` que se quede sin `returnValue` bloquea el renderer antes
      // de que la página exista: la pestaña se queda en blanco. Nunca se sale
      // de este manejador sin responder.
      console.warn('[nexo] configuración síncrona:', error?.message || error);
      event.returnValue = null;
    }
  });
  ipcMain.handle('nexo:prepare', (event, payload) => {
    const result = engine.prepare(event.sender.id, payload);
    // Lectura paralela, sin alterar el envío ni los motores de EVO.
    if(isUnderstandingSource(event)&&isChatGptMemoryUrl(event.sender.getURL())&&!isAuthRequest(String(payload?.url||'')))conversationOptimizer?.observePrompt(event.sender,payload?.prompt,payload?.model);
    // La capa de la página sólo pide mediación cuando ya reconoció una petición
    // de chat. Si el motor la descarta, es un dato: significa que el sitio no se
    // está mediando. Antes, ese silencio se veía como «0 turnos» y nada más.
    broadcast('nexo:stats-changed', statsSnapshot());
    if (result?.skipped === 'fuera-de-alcance') {
      const host = hostOf(String(payload?.url || '')) || String(payload?.site || 'sitio');
      noteDiagnostic({
        code: 'prepare-skipped',
        severity: 'info',
        key: `prepare-skipped|${host}`,
        title: `Mediación no aplicada en ${host}`,
        detail: `La petición ${String(payload?.url || '').slice(0, 160)} llegó como chat pero el motor no la medió.`,
        meta: { host, url: String(payload?.url || '').slice(0, 300), site: payload?.site || null },
      });
    }
    return result;
  });
  /*
   * Canal `egress`: la capa pregunta por un cuerpo que está a punto de salir.
   * Sólo lo puede pedir una pestaña de IA que pertenezca a esta ventana; el
   * resto cuenta como intento no autorizado. Con `mode:'off'` (por defecto)
   * responde `pass` sin leer nada.
   */
  ipcMain.handle('nexo:egress', async (event, payload) => {
    let host = '';
    try { host = new URL(event.sender?.getURL?.() || '').hostname; } catch { /* sin URL */ }
    if (!isUnderstandingSource(event) || !host || detectSite(host).id === 'generic') {
      egressGate?.noteUnauthorized();
      return { action: 'error', reason: 'emisor' };
    }
    if (!egressGate) return { action: 'error', reason: 'sin-puerta' };
    return egressGate.handle({ sender: event.sender, host, payload });
  });
  ipcMain.handle('nexo:turn-result', (event, payload) => {
    if (event.sender?.getType?.() !== 'webview' || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { skipped: 'resultado-invalido' };
    }
    if (payload.phase === 'started') return engine.onTurnStarted(event.sender.id, payload);
    const result = engine.onTurnResult(event.sender.id, payload);
    broadcast('nexo:stats-changed', statsSnapshot());
    return result;
  });
  ipcMain.handle('nexo:stream-progress', (event, payload) => {
    if (event.sender?.getType?.() !== 'webview' || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { skipped: 'progreso-invalido' };
    }
    const result = engine.onStreamProgress(event.sender.id, payload);
    broadcast('nexo:stats-changed', statsSnapshot());
    return result;
  });
  ipcMain.handle('nexo:stream-end', (event, payload) => {
    payload = { ...payload, documentUrl: event.sender?.getURL?.() || '' };
    // Texto tardío del mismo turno: reutilizar la absorción/deduplicación que
    // ya atiende CDP, sin volver a finalizar la memoria del guardián.
    const result = payload?.source === 'dom-recovery' && payload?.site === 'chatgpt'
      ? { counted: engine.onCdpCapture(event.sender.id, payload), nextAction: null }
      : engine.onStreamEnd(event.sender.id, payload);
    writeCaptureTrace('response-delivered', { capture: payload, source: payload?.source || 'request',
      memory: result?.memory || result?.counted?.memory || null,
      duplicate: Boolean(result?.counted?.duplicate) });
    const chars = Number(payload?.chars) || Number(payload?.deliveredChars) || 0;
    if (chars > 0 && !result?.counted?.duplicate) {
      const host = String(payload?.host || payload?.site || 'el sitio');
      const cortada = Boolean(payload?.stopped || payload?.truncated);
      const entry = {
        kind: 'receiving',
        code: 'incoming',
        severity: cortada ? 'warn' : 'info',
        title: `Respuesta ${payload?.stopped ? 'interrumpida' : 'recibida'} en ${host}`,
        detail: payload?.stopped
          ? `Se cortó un bucle antes de mostrarlo (${payload?.droppedChars || 0} caracteres descartados).`
          : payload?.truncated
            ? `No parece terminada (${chars} caracteres): es una heurística de cierre, no un corte confirmado por la red.`
            : `${chars} caracteres llegaron a la pantalla.`,
        meta: {
          host,
          site: payload?.site || null,
          messageId: payload?.messageId || null,
          conversationId: payload?.conversationId || null,
          chars,
          tokens: countOutputTokens(String(payload?.text || ''), payload?.model || '', host),
          stopped: Boolean(payload?.stopped),
          truncated: Boolean(payload?.truncated),
        },
        ts: Date.now(),
      };
      if (store) store.pushLog(entry);
      broadcast('nexo:event', { type: 'intervention', payload: entry });
    }
    broadcast('nexo:stats-changed', statsSnapshot());
    // Lo que el motor detectó al cerrar el turno (reparaciones, sugerencias y
    // continuación) se publica como evento: antes se calculaba y se descartaba
    // en la interfaz, que no tenía forma de ofrecer el siguiente paso.
    const followUp = turnFollowUp(result);
    if (followUp) broadcast('nexo:turn-followup', { webContentsId: event.sender.id, ...followUp });
    return result;
  });
  ipcMain.handle('nexo:stream-stop', (event, payload) => engine.onStreamStop(event.sender.id, payload));

  ipcMain.handle('nexo:tiktoken:count', (event, payload = {}) => {
    if (!isShellRequest(event)) return null;
    const text = typeof payload.text === 'string' ? payload.text : '';
    const model = typeof payload.model === 'string' ? payload.model : 'gpt-4o';
    if (text.length > 500000) throw new Error('El texto supera el límite de 500.000 caracteres.');
    return gptTokens.countGptTokens(text, model);
  });

  /* ---------------- Atajos de conversación (locales) ---------------- */
  // Sólo la shell puede listar y editar. Insertar el texto en el cuadro lo hace
  // la interfaz con la acción `insert-text`, que el preload valida.
  ipcMain.handle('nexo:prompts:list', (event) =>
    isShellRequest(event)
      ? { ok: true, items: promptStore.list, max: MAX_PROMPTS, variables: PROMPT_VARIABLES }
      : { ok: false, error: 'No autorizado.' });
  ipcMain.handle('nexo:prompts:save', (event, payload) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    try {
      // La shell recibe la lista actualizada en la misma respuesta; no hace
      // falta un evento global (y no se emite un canal sin consumidor).
      return promptStore.save(payload || {});
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('nexo:prompts:remove', (event, id) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    try {
      return promptStore.remove(id);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('nexo:prompts:render', (event, payload = {}) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    return promptStore.render(payload.id, payload.values || {});
  });

  // La shell lo usa completo para pintar Ajustes y para reenviar un parche. Una
  // pestaña lo pide para un solo dato —`receiving.autoContinue`
  // (preload/bridge.cjs:191-192)—: se le entrega recortado, sin atajos ni
  // preferencias de privacidad.
  ipcMain.handle('nexo:settings:get', (event) => (
    isShellRequest(event) ? store.settings : settingsForTab(store.settings)
  ));
  ipcMain.handle('nexo:storage:status', (event) => {
    if (!isShellRequest(event)) return { state: 'unauthorized' };
    return { ...store.loadStatus, error: store.lastError || store.loadError?.message || null };
  });
  ipcMain.handle('nexo:settings:set', (event, patch) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    if (patch?.tokenCounting?.model !== undefined && !tokenizerModels().models.some(item => item.id === patch.tokenCounting.model)) throw new Error('Elegí un modelo de tokenizador verificado.');
    const next = store.setSettings(patch);
    engine.refresh();
    refreshGuestSettings();
    broadcast('nexo:settings-changed', next);
    broadcast('nexo:stats-changed', statsSnapshot());
    return next;
  });
  ipcMain.handle('nexo:settings:reset', (event) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    const next = store.replaceSettings(DEFAULT_SETTINGS);
    engine.refresh();
    refreshGuestSettings();
    broadcast('nexo:settings-changed', next);
    broadcast('nexo:stats-changed', statsSnapshot());
    return next;
  });

  ipcMain.handle('nexo:log', () => store.log);
  ipcMain.handle('nexo:log:clear', (event) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    store.clearLog();
    return [];
  });
  // `cdp` son los contadores del motor (turnos observados y descartados);
  // `cdpObserver` es el estado del transporte. Van separados a propósito: uno
  // cuenta lo que se registró y el otro lo que se vio en el cable.
  ipcMain.handle('nexo:stats', statsSnapshot);

  // Estado de la observación CDP. La interfaz todavía no lo pide; existe para
  // diagnóstico, para el informe y para las pruebas de contrato.
  ipcMain.handle('nexo:cdp:stats', async () => {
    await captureDiagnostic?.flush();
    return { observer: cdp?.status() || { enabled: false, tabs: 0 },
      engine: engine ? engine.stats().cdp : null, diagnosticFile: captureDiagnosticFile,
      diagnosticError: captureDiagnostic?.status().error || null };
  });

  /* ---------------- Repetición de conversación (sólo lectura) ---------------- */
  ipcMain.handle('nexo:repetition:snapshot', (event, payload) => {
    const sender = event.sender;
    const href = sender?.getURL?.() || '';
    if (sender?.getType?.() !== 'webview' || !isChatGptMemoryUrl(href) || payload?.href !== href ||
      (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame)) return { ok: false };
    const snapshot = repetitionSnapshot(payload);
    if (!snapshot) return { ok: false };
    // Consumir la vista literal ya validada: existe aun con EVO desactivada.
    const next = { ...snapshot, href, webContentsId: sender.id };
    const previous = repetitionSnapshots.get(sender.id);
    repetitionSnapshots.set(sender.id, next);
    const ownedMainFrame = isUnderstandingSource(event);
    if (ownedMainFrame) domTokenSnapshots.set(sender.id, next);
    const domChanged = ownedMainFrame ? observeDomTokens(sender, next) : false;
    const progress = engine.onRenderedConversation(sender.id, next, previous);
    publishRepetition(next);
    if (domChanged || progress?.updated) broadcast('nexo:stats-changed', statsSnapshot());
    return { ok: true };
  });
  ipcMain.handle('nexo:dom-tokens:snapshot', (event, payload) => {
    if (!isShellRequest(event)) return { ok: false };
    const sender = advancedBrowser?.resolveGuest(event.sender, payload?.webContentsId);
    const href = sender?.getURL?.() || '';
    if (!sender || !isChatGptMemoryUrl(href)) return { ok: false };
    try {
      const current = new URL(href), incoming = new URL(payload?.href);
      if (current.origin !== incoming.origin || current.pathname !== incoming.pathname) return { ok: false };
    } catch { return { ok: false }; }
    const snapshot = repetitionSnapshot(payload);
    if (!snapshot) return { ok: false };
    const cached = domTokenSnapshots.get(sender.id);
    const sameDocument = cached?.href && new URL(cached.href).origin + new URL(cached.href).pathname === new URL(href).origin + new URL(href).pathname;
    const changed = sameDocument && cached.turns.length ? observeDomTokens(sender, cached) : observeDomTokens(sender, snapshot, 'direct');
    if (changed) broadcast('nexo:stats-changed', statsSnapshot());
    return { ok: true };
  });
  ipcMain.handle('nexo:repetition:get', (event, payload = {}) => {
    // Este canal contiene texto privado: exclusivamente para la shell conocida.
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return null;
    if (!BrowserWindow.getAllWindows().some((window) => window.webContents === event.sender &&
      window.webContents.getURL() === 'nexo://app/src/ui/shell/index.html')) return null;
    const snapshot = repetitionSnapshots.get(payload.webContentsId);
    if (!snapshot) {
      const contents = webContents.fromId(payload.webContentsId);
      if (contents?.getType() === 'webview' && contents.getURL() === payload.href && isChatGptMemoryUrl(payload.href)) {
        contents.send('nexo:conversation-read');
      }
    }
    return snapshot && snapshot.href === payload.href ? snapshot : null;
  });

  /* Canal DOM UUE propio: no consulta ni captura EVO, sin autoridad para la página. */
  ipcMain.handle('nexo:understanding:conversation', (event, payload) => {
    const href = event.sender?.getURL?.() || '';
    if (!isUnderstandingSource(event) || !isChatGptMemoryUrl(href) || !payload ||
      typeof payload.href !== 'string' || payload.href.length > 2048 || !isChatGptMemoryUrl(payload.href)) {
      return { ok: false, observed: false, code: 'unauthorized' };
    }
    try {
      const current = new URL(href), incoming = new URL(payload.href);
      if (current.origin !== incoming.origin || current.pathname !== incoming.pathname)
        return { ok: false, observed: false, code: 'conflict' };
      if (payload.ready === true) {
        conversationOptimizer.activate(event.sender);
        return { ok: true, ready: true };
      }
      return conversationOptimizer.receive(event.sender, payload);
    } catch {
      return { ok: false, observed: false, code: 'storage', error: 'No se pudo registrar la lectura local de Comprensión.' };
    }
  });

  /* ---------------- EVO MEMORY ---------------- */
  ipcMain.handle('nexo:conversation-snapshot', (event, payload) => {
    const href = event.sender?.getURL?.() || '';
    let snapshotUrl = null;
    try { snapshotUrl = new URL(String(payload?.href || '')); } catch { /* URL inválida */ }
    let pageUrl = null;
    try { pageUrl = new URL(href); } catch { /* pestaña sin URL */ }
    // ChatGPT puede actualizar query/hash durante una navegación SPA entre la
    // lectura del DOM y la llegada del IPC. Se valida origen y ruta, no la URL
    // textual completa, para no descartar respuestas reales por esa carrera.
    const sameDocument = Boolean(pageUrl && snapshotUrl &&
      snapshotUrl.origin === pageUrl.origin && snapshotUrl.pathname === pageUrl.pathname);
    if (event.sender?.getType?.() !== 'webview' || !isChatGptMemoryUrl(href) ||
      !sameDocument || !isChatGptMemoryUrl(payload?.href) ||
      (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) || !Array.isArray(payload?.turns) || payload.turns.length > 200) {
      return { ok: false, observed: false, skipped: 'snapshot-no-autorizado', hrefMatches: sameDocument };
    }
    if(!isEvoMemoryEnabled(store.settings))return {ok:true,observed:false,memoryDisabled:true,skipped:'evo-disabled'};
    const url = pageUrl;
    // Nunca confiar en el ID del documento para escribir otra conversación.
    const conversationId = url.pathname.includes('/c/') ? url.pathname
      : `${url.pathname}#tab-${event.sender.id}`;
    const result = memory.memory.captureConversation({ conversationId, url: `${url.origin}${url.pathname}`,
      turns: payload.turns, streaming: payload.streaming === true });
    if (!result.ok) noteDiagnostic({ code: 'conversation-memory-error', severity: 'warn',
      title: 'No se pudo guardar la conversación', detail: result.error });

    const userTurns = payload.turns.filter((turn) => turn?.role === 'user').length;
    const assistantTurns = payload.turns.filter((turn) => turn?.role === 'assistant').length;
    const assistantChars = payload.turns.reduce((sum, turn) =>
      sum + (turn?.role === 'assistant' ? String(turn.content || '').length : 0), 0);
    noteDiagnostic({
      code: 'chatgpt-conversation-read',
      key: 'chatgpt-conversation-read',
      severity: assistantTurns ? 'info' : 'warn',
      title: assistantTurns ? 'NEXO leyó la conversación de ChatGPT' : 'NEXO no encontró respuestas de ChatGPT en la conversación',
      detail: `DOM: ${userTurns} mensaje(s) de usuario, ${assistantTurns} respuesta(s) de GPT y ${assistantChars} caracteres de salida. ${payload.streaming ? 'La generación sigue activa; se espera el cierre para guardar la respuesta final.' : `Respuestas literales nuevas guardadas: ${(result.assistantCaptures || []).length}.`}`,
      meta: { userTurns, assistantTurns, assistantChars, streaming: payload.streaming === true,
        savedAssistantTurns: (result.assistantCaptures || []).length },
    });

    // Contabilización DOM en vivo: canal de repetición validado, independiente del guardado.
    writeCaptureTrace('conversation-read', { host: url.hostname, source: 'dom', chars: assistantChars,
      memory: { saved: result.ok === true, persisted: result.ok === true, chars: assistantChars } });
    if (result.changed) broadcast('nexo:memory-changed', engine.memoryStats());
    return { ...result, observed:false, assistantCaptures: undefined };
  });
  ipcMain.handle('nexo:memory:conversations', () => isEvoMemoryEnabled(store.settings) ? memory.memory.listConversations() : []);
  ipcMain.handle('nexo:memory:stats', () => ({ ...engine.memoryStats(), file: isEvoMemoryEnabled(store.settings) ? memory?.file || null : null }));
  ipcMain.handle('nexo:memory:list', () => engine.memoryList());
  ipcMain.handle('nexo:memory:recall', (_event, payload = {}) =>
    engine.memoryRecall(String(payload.query || ''), { limit: payload.limit || 12 }));
  ipcMain.handle('nexo:memory:pin', (_event, payload = {}) => engine.memoryPin(payload.id, payload.pinned !== false));
  ipcMain.handle('nexo:memory:forget', (_event, payload = {}) => engine.memoryForget(payload.id));
  ipcMain.handle('nexo:memory:handoff', () => engine.memoryHandoff());
  ipcMain.handle('nexo:memory:import', (_event, packet) => {
    const result = engine.memoryImport(packet);
    broadcast('nexo:memory-changed', engine.memoryStats());
    return result;
  });
  ipcMain.handle('nexo:memory:clear', () => {
    const result = engine.memoryClear();
    broadcast('nexo:memory-changed', engine.memoryStats());
    return result;
  });
  ipcMain.handle('nexo:shell:config', () => ({
    version: app.getVersion(),
    pagePreload: `file://${PAGE_PRELOAD}`,
    platform: process.platform,
  }));

  // Medidas de la interfaz: sólo las acepta la shell, y sólo números.
  ipcMain.on('nexo:perf', (event, data) => {
    if (event.sender?.getType?.() === 'webview') return;
    if (!data || typeof data !== 'object') return;
    absorbPerf(data);
  });

  // Sólo las pestañas pueden anunciar eventos, y sólo con la forma esperada:
  // sin esto, cualquier página podría inventar «intervenciones» en el panel.
  ipcMain.on('nexo:event', (event, message) => {
    if (event.sender?.getType?.() !== 'webview') return;
    const href = event.sender.getURL?.() || '';
    const clean = eventMessage(message, { href });
    if (!clean) return;

    // Un fallo de la capa inyectada tiene que verse. Antes se reenviaba a la
    // interfaz, que sólo escucha `intervention`, así que se perdía: el usuario
    // notaba el síntoma («no conecta») sin la causa.
    if (clean.type === 'error') {
      noteDiagnostic({
        code: 'page-error',
        severity: 'info',
        title: `Fallo de la mediación en ${hostOf(href) || 'la página'}`,
        detail: `${clean.payload.stage || 'capa'}: ${String(clean.payload.message || '').slice(0, 200)}`,
        meta: { stage: clean.payload.stage || '', message: String(clean.payload.message || '').slice(0, 400) },
      });
      return;
    }

    // La capa avisa al instalarse. Es la señal que separa «el sitio no se está
    // mediando» de «la inyección no llegó a correr».
    if (clean.type === 'ready') {
      // Instalarse no es capturar. La capa se marca viva cuando de verdad cuenta
      // un envío o una respuesta; si sólo se anuncia y después no captura nada,
      // CDP tiene que leer el stream igual o la respuesta no la cuenta nadie.
      const host = hostOf(href) || String(clean.payload.host || 'la página');
      noteDiagnostic({
        code: 'layer-active',
        severity: 'info',
        key: `layer-active|${host}`,
        title: `Capa de mediación activa en ${host}`,
        detail: `Perfil ${clean.payload.site || 'genérico'} · versión ${clean.payload.version || '0.1.0'}`,
        meta: { host, site: clean.payload.site || null, version: clean.payload.version || null },
      });
      return;
    }

    // Un envío reconocido se anota siempre, se haya mediado o no: es la prueba
    // de que el mensaje salió, y hasta ahora el panel sólo veía el caso en el
    // que el motor inyectaba algo.
    if (clean.type === 'outgoing') {
      // Metadato opcional: no depende de EVO ni afecta conteos o el cuerpo enviado.
      if(isUnderstandingSource(event)&&isChatGptMemoryUrl(href))conversationOptimizer?.setModel(event.sender,clean.payload.model);
      const host = String(clean.payload.host || clean.payload.site || 'el sitio');
      // Contador de mensajes del usuario: se cuenta acá, no en `prepare()`.
      const counted = engine.onUserMessage(event.sender.id, clean.payload);
      if (counted?.duplicate) { broadcast('nexo:stats-changed', statsSnapshot()); return; }
      writeCaptureTrace('request-detected', { ...clean.payload, duplicate: Boolean(counted?.duplicate) });
      const entry = {
        kind: 'sending',
        code: 'outgoing',
        severity: 'info',
        title: `Mensaje enviado en ${host}`,
        detail: clean.payload.mediated
          ? 'El texto salió mediado por el motor.'
          : clean.payload.textFound === false
            ? 'Envío contado: la petición salió, pero su texto no se pudo leer.'
            : 'El texto salió sin cambios: el motor no modificó este mensaje.',
        meta: {
          host,
          site: clean.payload.site || null,
          url: clean.payload.url || '',
          messageId: clean.payload.messageId || null,
          conversationId: clean.payload.conversationId || null,
          // `composer` = lo detectó el gesto de enviar; `request` = la petición.
          source: clean.payload.source || 'request',
          // Si no se pudo leer el texto del cuerpo, el mensaje se cuenta igual.
          textFound: clean.payload.textFound !== false,
          mediated: Boolean(clean.payload.mediated),
          chars: Number(clean.payload.chars) || 0,
          tokens: clean.payload.tokens ?? null,
          tokenExact: clean.payload.tokenExact === true,
          tokenEncoding: clean.payload.tokenEncoding || null,
          tokenMethod: clean.payload.tokenMethod || 'unverified',
          duplicate: Boolean(counted?.duplicate),
        },
        ts: Date.now(),
      };
      if (store) store.pushLog(entry);
      broadcast('nexo:event', { type: 'intervention', payload: entry });
      broadcast('nexo:stats-changed', statsSnapshot());
      return;
    }

    broadcast('nexo:event', clean);
  });

  ipcMain.handle('nexo:open-external', async (_event, url) => {
    const safe = safeExternalUrl(url);
    if (!safe) return { ok: false, error: 'esquema no permitido' };
    try {
      await shell.openExternal(safe);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || 'no se pudo abrir' };
    }
  });

  /* ---------------- navegador: perfil ---------------- */
  ipcMain.handle('nexo:profile:stats', () => profile?.stats() || null);
  ipcMain.handle('nexo:profile:clear', (event, scope = {}) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    const result = profile?.clear(scope) || {};
    broadcast('nexo:profile-changed', profile?.stats() || null);
    return result;
  });

  /* ---------------- historial ---------------- */
  ipcMain.handle('nexo:history:list', (_event, payload = {}) => {
    if (!profile) return [];
    const limit = Math.min(500, Number(payload.limit) || 100);
    return payload.query
      ? profile.history.search(payload.query, { limit })
      : profile.history.recent({ limit, offset: Number(payload.offset) || 0 });
  });
  ipcMain.handle('nexo:history:top', (_event, payload = {}) => profile?.history.topSites(payload) || []);
  ipcMain.handle('nexo:history:remove', (_event, id) => ({ ok: Boolean(profile?.history.remove(id)) }));
  ipcMain.handle('nexo:history:clear', (_event, payload = {}) => {
    const since = payload.range === 'all' ? null : Date.now() - rangeMs(payload.range);
    const result = profile?.history.clear({ since }) || { removed: 0 };
    profile?.history.save({ force: true });
    broadcast('nexo:profile-changed', profile?.stats() || null);
    return result;
  });
  ipcMain.handle('nexo:suggest', async (_event, payload = {}) => {
    if (!profile) return [];
    const query = String(payload.query || '');
    const bookmarks = profile.bookmarks.suggest(query, { limit: 4 });
    const history = profile.history.suggest(query, { limit: 6 });
    const seen = new Set();
    return [...bookmarks, ...history].filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    }).slice(0, 8);
  });

  /* ---------------- marcadores ---------------- */
  ipcMain.handle('nexo:bookmarks:list', (_event, payload = {}) => profile?.bookmarks.list(payload) || []);
  ipcMain.handle('nexo:bookmarks:folders', () => profile?.bookmarks.folders() || []);
  ipcMain.handle('nexo:bookmarks:is', (_event, url) => Boolean(profile?.bookmarks.isBookmarked(url)));
  ipcMain.handle('nexo:bookmarks:toggle', (_event, payload = {}) => {
    const result = profile?.bookmarks.toggle(payload) || { added: false, bookmark: null };
    profile?.bookmarks.save({ force: true });
    broadcast('nexo:bookmarks-changed', { url: payload.url, added: result.added });
    return result;
  });
  ipcMain.handle('nexo:bookmarks:clear', () => {
    const result = profile?.bookmarks.clear() || { removed: 0 };
    profile?.bookmarks.save({ force: true });
    broadcast('nexo:bookmarks-changed', {});
    return result;
  });
  ipcMain.handle('nexo:bookmarks:remove', (_event, id) => {
    const ok = Boolean(profile?.bookmarks.remove(id));
    profile?.bookmarks.save({ force: true });
    broadcast('nexo:bookmarks-changed', {});
    return { ok };
  });

  /* ---------------- descargas ---------------- */
  ipcMain.handle('nexo:downloads:list', (event) => isShellRequest(event) ? (profile?.downloads.list({ limit: 100 }) || []).map(entry=>{const live=downloadItems.get(entry.id)?.item;return {...entry,paused:Boolean(live?.isPaused?.()),canResume:Boolean(live?.canResume?.()||live?.isPaused?.())};}) : []);
  ipcMain.handle('nexo:downloads:open', async (event, id) => {
    if(!isShellRequest(event))return {ok:false};
    const item = profile?.downloads.get(id);
    if (!item?.savePath || item.state!=='completed') return { ok: false };
    const error = await shell.openPath(item.savePath);
    return { ok: !error, error: error || null };
  });
  ipcMain.handle('nexo:downloads:show', (event, id) => {
    if(!isShellRequest(event))return {ok:false};
    const item = profile?.downloads.get(id);
    if (!item?.savePath || item.state!=='completed') return { ok: false };
    shell.showItemInFolder(item.savePath);
    return { ok: true };
  });
  ipcMain.handle('nexo:downloads:cancel', (event, id) => {
    if(!isShellRequest(event))return {ok:false};
    const entry = downloadItems.get(id);
    if (!entry) return { ok: false };
    entry.item.cancel();
    return { ok: true };
  });
  ipcMain.handle('nexo:downloads:clear', (event) => {
    if(!isShellRequest(event))return {removed:0};
    const result = profile?.downloads.clearFinished() || { removed: 0 };
    profile?.downloads.save({ force: true });
    broadcast('nexo:downloads-changed', profile?.downloads.stats() || null);
    return result;
  });

  /* ---------------- permisos y zoom ---------------- */
  ipcMain.handle('nexo:permissions:for', (_event, host) => profile?.permissions.rulesFor(host) || []);
  ipcMain.handle('nexo:permissions:set', (_event, payload = {}) => {
    const permission = permissionName(payload.permission, PERMISSION_CATALOG);
    if (!permission) return { ok: false, error: 'permiso desconocido' };
    const ok = Boolean(profile?.permissions.set(payload.host, permission, payload.value));
    profile?.permissions.save({ force: true });
    return { ok };
  });
  ipcMain.handle('nexo:permissions:sites', () => profile?.permissions.list() || []);
  ipcMain.handle('nexo:permissions:clear', (_event, host) => {
    const result = profile?.permissions.clear(host);
    profile?.permissions.save({ force: true });
    return { ok: Boolean(result) };
  });
  ipcMain.handle('nexo:zoom:get', (_event, target) => profile?.zoom.get(target) ?? 1);
  ipcMain.handle('nexo:zoom:set', (_event, payload = {}) => {
    const level = profile?.zoom.set(payload.target, payload.level) ?? 1;
    profile?.zoom.save();
    return { level };
  });
  ipcMain.handle('nexo:zoom:list', () => profile?.zoom.list() || []);

  /* ---------------- datos del sitio ---------------- */
  ipcMain.handle('nexo:data:clear', async (event, scope = {}) => {
    if (!isShellRequest(event)) return { ok: false, error: 'No autorizado.' };
    const target = session.fromPartition('persist:nexo');
    const done = { ok: true, cookies: false, cache: false };
    try {
      if (scope.cookies) {
        await target.clearStorageData({
          storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
        });
        done.cookies = true;
      }
      if (scope.cache) {
        await target.clearCache();
        done.cache = true;
      }
    } catch (error) {
      done.ok = false;
      done.error = error.message;
    }
    return done;
  });

  /* ---------------- sesión ---------------- */
  ipcMain.handle('nexo:session:capture', (_event, payload = {}) => {
    profile?.session.capture(sessionPayload(payload).windows);
    return { ok: true };
  });
  ipcMain.handle('nexo:session:restore', () => profile?.session.restore() || null);
  ipcMain.on('nexo:session:save-now', (event, payload = {}) => {
    // Sin respuesta posible (`send`): un emisor ajeno se descarta con un retorno
    // temprano silencioso, igual que el resto de eventos que no exigen shell.
    if (!isShellRequest(event)) return;
    try {
      profile?.session.capture(sessionPayload(payload).windows);
    } catch (error) {
      console.error('[nexo] no se pudo guardar la sesión:', error.message);
    }
  });
  ipcMain.handle('nexo:session:clear', () => {
    profile?.session.clear();
    return { ok: true };
  });
}

/** La observación UUE nunca acepta autoridad desde una página ajena o un subframe. */
function isUnderstandingSource(event) {
  const sender=event.sender;
  if(sender?.getType?.()!=='webview'||!event.senderFrame||event.senderFrame!==sender.mainFrame)return false;
  return BrowserWindow.getAllWindows().some(w=>{try{return advancedBrowser?.resolveGuest(w.webContents,sender.id)===sender;}catch{return false;}});
}

/** Guarda el perfil poco después del último cambio, no en cada navegación. */
function scheduleProfileSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      profile?.saveAll();
    } catch (error) {
      console.error('[nexo] no se pudo guardar el perfil:', error.message);
    }
  }, 4000);
}

/** Milisegundos de los rangos de borrado que ofrece el historial. */
function rangeMs(range) {
  const hour = 3_600_000;
  switch (range) {
    case 'hour':
      return hour;
    case 'day':
      return 24 * hour;
    case 'week':
      return 7 * 24 * hour;
    case 'month':
      return 30 * 24 * hour;
    default:
      return 0;
  }
}

/** Aplica el zoom guardado del sitio a una pestaña. */
function applyZoom(contents) {
  if (!profile) return;
  try {
    const level = profile.zoom.get(contents.getURL());
    if (Math.abs(contents.getZoomFactor() - level) > 0.001) contents.setZoomFactor(level);
  } catch {
    /* una pestaña destruida no debería tumbar el proceso principal */
  }
}

// Un único perfil persistente: las sesiones de los sitios de IA sobreviven al
// cierre de la aplicación, igual que en un navegador normal.
/** Ruta corta de una URL, para el registro. */
function shortPath(url) {
  try {
    return new URL(url).pathname.slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * Vigilancia de red de los proveedores, **sólo lectura**.
 *
 * `webRequest.onCompleted` y `onErrorOccurred` son notificaciones: no pueden
 * modificar ni retener una petición, así que no cambian lo que el sitio ve. Y a
 * diferencia del observador CDP, no dependen de que la mediación esté encendida.
 *
 * Es la respuesta al caso que hasta ahora no dejaba rastro: ChatGPT cargando bien
 * pero contestando «No se pudo conectar» con la mediación apagada. El registro
 * dirá qué endpoint respondió qué código.
 */
const WATCHED_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'other']);

/**
 * Cuerpo de una petición POST, como texto.
 *
 * Electron entrega `uploadData` con los bytes del cuerpo. Devuelve `''` cuando
 * el cuerpo no viaja en memoria (un stream, un archivo): en ese caso este camino
 * no puede leerlo y lo resuelven la capa o CDP.
 */
function uploadText(uploadData) {
  if (!Array.isArray(uploadData) || !uploadData.length) return '';
  const partes = [];
  for (const trozo of uploadData) {
    if (!trozo?.bytes) return ''; // No presentar un cuerpo parcial como texto completo.
    try { partes.push(Buffer.from(trozo.bytes)); } catch { return ''; }
  }
  // Decodificar UNA vez: un trozo puede terminar en medio de un emoji UTF-8.
  return Buffer.concat(partes).toString('utf8');
}

/**
 * Respaldo del guardián de salida en la red.
 *
 * Devuelve `true` sólo si hay que cancelar la petición. Es la segunda barrera:
 * la primera es la capa inyectada, que sí dialoga con el usuario. Acá no hay
 * diálogo posible (la petición está en vuelo) y tampoco se puede reescribir el
 * cuerpo, así que la única decisión es frenar o dejar pasar.
 *
 * Falla abierto SIEMPRE: cualquier error, cualquier cuerpo que no se pueda leer
 * y cualquier modo que no sea `enforce` dejan pasar, igual que antes de existir
 * esta función.
 *
 * @param {object} details datos de `webRequest.onBeforeRequest`
 * @returns {boolean}
 */
function bloqueoDeRed(details = {}) {
  try {
    if (!engine || !store) return false;
    const url = String(details.url || '');
    const host = hostOf(url);
    if (!isAiHost(host)) return false;
    const method = String(details.method || 'GET').toUpperCase();
    if (method !== 'POST') return false;
    const site = detectSite(host);
    // Sólo peticiones de chat de un sitio con perfil. La ruta del canal de
    // respuestas (`/conversation/updates`) no lleva el prompt y se deja fuera.
    if (!isMediable(site, url, method)) return false;
    if (isResponseRequest(site, url, method)) return false;

    const config = normalizeEgress(settingsForHost(store.settings, host).egress);
    if (config.mode !== 'enforce') return false; // ni se lee el cuerpo
    const result = inspectOutgoing({ method, bodyText: uploadText(details.uploadData), config });
    if (!result.cancel) return false;

    const types = result.summary.map((s) => `${s.type}: ${s.count}`).join(', ');
    noteDiagnostic({
      code: 'egress-net-block',
      key: `egress-net-block|${host}`,
      severity: 'warn',
      title: 'NEXO frenó un envío con datos sensibles (respaldo)',
      detail: `Tipos: ${types}. Motivo: ${result.reason}.`,
      meta: { host, site: site.id, url: shortPath(url), method, summary: result.summary },
    });
    return true;
  } catch (error) {
    console.log('[red] respaldo del guardián:', error?.message || error);
    return false;
  }
}

/**
 * Mensaje del usuario, leído desde el proceso principal.
 *
 * Es el tercer camino (además de la capa y de CDP) y el más difícil de romper:
 * no depende de que la página ejecute nada nuestro ni de que el depurador esté
 * adjunto. Si el cuerpo trae el texto, el mensaje se cuenta; si no lo trae, no se
 * inventa nada y queda el rastro en el registro para saber por qué.
 */
function noteUserMessageFromNetwork(details = {}) {
  // `seen` es «era una petición de conversación», `counted` es «además sumó el
  // mensaje». Van separados para que el panel distinga «no llega nada» de
  // «llega y algo lo frena» — que es lo que hasta ahora no dejaba rastro.
  const no = { seen: false, counted: false, conversation: false };
  if (!engine) return no;
  const url = String(details.url || '');
  const host = hostOf(url);
  if (!isAiHost(host)) return no;
  const method = String(details.method || 'GET').toUpperCase();
  if (method !== 'POST') return no;
  const site = detectSite(host);
  capture.posts += 1;
  // El canal de respuestas (`/conversation/updates` en el cliente sin cuenta)
  // no lleva el prompt: se reconoce como tráfico de conversación para contar y
  // leer su respuesta, pero nunca se analiza como envío.
  if (isResponseRequest(site, url, method)) {
    return { seen: true, counted: false, conversation: true };
  }
  const webContentsId = Number(details.webContentsId);
  const tabId = Number.isFinite(webContentsId) ? webContentsId : -1;
  const cuerpo = uploadText(details.uploadData);
  let json = null;
  if (cuerpo) {
    try {
      json = JSON.parse(cuerpo);
    } catch {
      json = null;
    }
  }

  // La ruta declarada por el perfil no es la única prueba de que esto sea una
  // conversación: el cuerpo lo es. Un sitio puede cambiar de endpoint sin
  // avisar, y entonces ni la pregunta ni su respuesta se reconocían —el panel
  // mostraba «0 de conversación» con decenas de POST delante—. La forma del
  // cuerpo manda; la ruta se anota como evidencia.
  const rutaConocida = isMediable(site, url, method);
  const located = json ? locateUserText(json, site) : null;
  const textoCuerpo = located && typeof located.value === 'string' ? located.value : '';
  if (!rutaConocida) {
    if (!textoCuerpo || isPreparationRequest(site, url)) {
      // Un POST al proveedor que no es la ruta que conocemos y cuyo cuerpo no
      // trae un mensaje del usuario: se anota la ruta real, sin contarla.
      noteDiagnostic({
        code: 'chat-unmatched',
        key: `chat-unmatched|${host}|${shortPath(url)}`,
        severity: 'info',
        title: `${host}: petición POST fuera de la ruta conocida`,
        detail: `POST ${shortPath(url)} — no coincide con el patrón de conversación del perfil ${site.id}.`,
        meta: { host, site: site.id, url: shortPath(url), method },
      });
      return no;
    }
    noteDiagnostic({
      code: 'chat-ruta',
      key: `chat-ruta|${host}|${shortPath(url)}`,
      severity: 'info',
      title: `${host}: el mensaje viaja por una ruta nueva`,
      detail: `POST ${shortPath(url)} — el perfil ${site.id} declara otra ruta, pero el cuerpo trae el mensaje del usuario: se cuenta igual y se lee su respuesta.`,
      meta: { host, site: site.id, url: shortPath(url), method },
    });
    // Si en esa pestaña ya hay un mensaje esperando respuesta, el envío lo contó
    // otro camino (la capa o el gesto): contarlo otra vez sería sumar dos veces
    // la misma pregunta. La petición igual queda marcada como conversación, así
    // su respuesta se cuenta y se lee.
    const esperando = engine.currentSendId(tabId);
    if (esperando) return { seen: true, counted: false, conversation: true };
  }

  if (!engine.isEnabledFor(host)) {
    // El sitio está apagado en Ajustes: la petición de conversación se vio, pero
    // no se cuenta nada. Antes esto era indistinguible de «no llega nada».
    capture.blocked += 1;
    noteDiagnostic({
      code: 'chat-disabled',
      key: `chat-disabled|${host}`,
      severity: 'warn',
      title: `${host} está apagado en Ajustes`,
      detail: 'La petición de conversación llegó, pero el sitio está desactivado: no se cuenta ni se media.',
      meta: { host, site: site.id, url: shortPath(url) },
    });
    return { seen: true, counted: false, conversation: true };
  }

  // Regenerar o continuar no es un mensaje nuevo del usuario.
  // Regenerar es una petición de conversación, pero no un mensaje nuevo.
  if (typeof json?.action === 'string' && json.action && json.action !== 'next') {
    return { seen: true, counted: false, conversation: true, responseEligible: false };
  }

  const text = textoCuerpo;
  const model = gptModelFromRequest(json);

  if (!text) {
    // Petición de conversación sin texto legible: el mensaje se cuenta igual
    // (sin caracteres ni tokens inventados) y queda dicho en el registro.
    const entry = {
      kind: 'system',
      code: 'chat-request',
      severity: 'info',
      title: `Petición de conversación en ${host}`,
      detail: cuerpo
        ? 'El cuerpo se leyó pero no se reconoció el mensaje del usuario.'
        : 'El cuerpo de la petición no viajó en memoria: no se pudo leer el mensaje.',
      meta: { host, site: site.id, url: shortPath(url), method },
      ts: Date.now(),
    };
    if (store) store.pushLog(entry);
    broadcast('nexo:event', { type: 'intervention', payload: entry });
  }

  const measurement = located ? inputTokenMeasurement(text, model, site.id) : {tokens:null,tokenExact:false,tokenMethod:'unreadable',tokenEncoding:null,model};
  const counted = engine.onUserMessage(tabId, {
    messageId: `net-${details.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`}`,
    submissionId: userMessageIdentity(json),
    source: 'network',
    site: site.id,
    host,
    url,
    chars: text.length,
    tokenText: located ? text : undefined,
    ...measurement,
    model,
    promptHash: text ? fingerprint(text) : '',
    textFound: Boolean(text),
  });
  if (counted?.duplicate) {
    broadcast('nexo:stats-changed', statsSnapshot());
    return { seen: true, counted: false, conversation: true };
  }

  const entry = {
    kind: 'sending',
    code: 'outgoing-network',
    severity: 'info',
    title: `Mensaje enviado en ${host}`,
    detail: text
      ? 'Envío leído del cuerpo de la petición (proceso principal).'
      : 'Envío contado: la petición salió, pero su texto no se pudo leer.',
    meta: {
      host,
      site: site.id,
      url: shortPath(url),
      source: 'network',
      chars: text.length,
      ...measurement,
      conversationId: null,
    },
    ts: Date.now(),
  };
  if (store) store.pushLog(entry);
  broadcast('nexo:event', { type: 'intervention', payload: entry });
  broadcast('nexo:stats-changed', statsSnapshot());
  return { seen: true, counted: true, conversation: true };
}

function watchProviderNetwork(s) {
  const seen = new Map();
  const once = (key) => {
    const now = Date.now();
    if (now - (seen.get(key) || 0) < 60_000) return false;
    seen.set(key, now);
    if (seen.size > 200) seen.delete(seen.keys().next().value);
    return true;
  };
  // Relaciona el requestId de Electron entre onBeforeRequest y onCompleted.
  // Así la respuesta cierra el mensaje que originó ESA petición, aunque uno de
  // los dos eventos llegue sin webContentsId o la pestaña cambie de foco.
  const requestTurns = new Map();

  // El cuerpo de la petición de conversación trae el mensaje del usuario. Se
  // lee acá, en el proceso principal, antes de que salga: es el camino que no
  // depende de la capa de la página ni del depurador.
  capture.watcher = true;
  capture.since = Date.now();

  /**
   * Peticiones que ya se reconocieron como conversación, por identificador de
   * Chromium.
   *
   * `onCompleted` las necesita para saber que **esa** petición era la
   * conversación. Sin esto habría que volver a adivinar la ruta, que es
   * justamente lo que fallaba cuando el sitio cambió de endpoint.
   */
  const conversaciones = new Set();
  const MAX_CONVERSACIONES = 200;
  const recordarConversacion = (details) => {
    const id = details?.id;
    if (id === undefined || id === null) return;
    conversaciones.add(id);
    if (conversaciones.size > MAX_CONVERSACIONES) {
      conversaciones.delete(conversaciones.values().next().value);
    }
  };

  s.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details = {}, callback) => {
    capture.requests += 1;
    capture.lastRequestAt = Date.now();
    // Respaldo del guardián: si la capa no llegó a frenar el envío (no se
    // inyectó, su consulta se perdió, el sitio cambió), la red lo frena aquí.
    // Va ANTES de contar: un mensaje que no salió no puede sumar.
    if (bloqueoDeRed(details)) {
      callback({ cancel: true });
      return;
    }
    try {
      const note = noteUserMessageFromNetwork(details);
      if (note?.seen) capture.chatRequests += 1;
      if (note?.counted) capture.counted += 1;
      if (note?.conversation) recordarConversacion(details);
      const url = String(details.url || '');
      const host = hostOf(url);
      const requestId = String(details.id || '');
      if (
        requestId &&
        String(details.method || '').toUpperCase() === 'POST' &&
        isAiHost(host) &&
        (isMediable(detectSite(host), url, 'POST') || isResponseRequest(detectSite(host), url, 'POST')) &&
        note?.responseEligible !== false &&
        engine.isEnabledFor(host)
      ) {
        const rawId = Number(details.webContentsId);
        const tabId = Number.isFinite(rawId) ? rawId : -1;
        const messageId = engine.currentSendId(tabId);
        if (messageId) {
          requestTurns.set(requestId, { tabId, messageId, host, url });
          if (requestTurns.size > 500) requestTurns.delete(requestTurns.keys().next().value);
        }
      }
    } catch (error) {
      console.log('[red] al leer el envío:', error?.message || error);
    }
    // Sin `cancel` ni `redirect`: la petición sigue tal cual. Esto sólo mira.
    callback({});
  });

  /**
   * La respuesta contada desde la red.
   *
   * Cuando el POST de conversación termina bien, el modelo contestó. Se espera
   * un instante corto para que la capa o CDP cuenten primero (ellos traen el
   * texto y los tokens) y, si nadie lo hizo, se cuenta acá: +1 respuesta, +1
   * turno y +1 intervención, sin caracteres ni tokens inventados.
   */
  const RETRASO_RED_MS = Number(process.env.NEXO_NETRESP_MS) || 1500;
  s.webRequest.onCompleted({ urls: ['*://*/*'] }, (details = {}) => {
    const requestId = String(details.id || '');
    const asociada = requestId ? requestTurns.get(requestId) : null;
    if (requestId) requestTurns.delete(requestId);
    const url = String(details.url || '');
    const host = hostOf(url);
    if (!isAiHost(host)) return;
    const method = String(details.method || 'GET').toUpperCase();
    // La petición es de conversación si la ruta es la declarada, si es el canal
    // de respuestas del sitio, o si el envío se reconoció por su cuerpo al
    // salir (ruta nueva). Cuatro formas de decir lo mismo: es esta petición.
    const id = details.id;
    const yaReconocida = id !== undefined && id !== null && conversaciones.has(id);
    if (id !== undefined && id !== null) conversaciones.delete(id);
    const site = detectSite(host);
    if (
      method === 'POST' &&
      (yaReconocida ||
        Boolean(asociada) ||
        isMediable(site, url, method) ||
        isResponseRequest(site, url, method))
    ) {
      const status = Number(details.statusCode) || 0;
      if (status >= 400 && asociada) engine.onTurnResult(asociada.tabId, { ...asociada, outcome: 'failed' });
      if (status >= 200 && status < 300 && engine.isEnabledFor(host)) {
        const wcId = Number(details.webContentsId);
        const tabId = asociada?.tabId ?? (Number.isFinite(wcId) ? wcId : -1);
        const esperaba = asociada?.messageId || engine.currentSendId(tabId);
        if (esperaba) {
          setTimeout(() => {
            try {
              // Si en el medio llegó otra pregunta, este cierre ya no es suyo.
              // Cuando el cierre viene correlacionado por identificador de
              // petición, esa correlación ya resolvió el turno.
              if (!asociada && engine.currentSendId(tabId) !== esperaba) return;
              const contada = engine.onNetworkResponse(tabId, { host, url, messageId: esperaba });
              if (!contada?.counted) return;
              const entry = {
                kind: 'receiving',
                code: 'incoming-network',
                severity: 'info',
                title: `Respuesta recibida en ${host}`,
                detail:
                  'La petición de conversación terminó bien y el mensaje quedó contestado. El texto no se pudo leer todavía: si aparece un instante después, sus tokens se suman a esta misma respuesta.',
                meta: { host, url: shortPath(url), source: 'network', chars: 0, tokens: 0, messageId: contada.messageId },
                ts: Date.now(),
              };
              if (store) store.pushLog(entry);
              broadcast('nexo:event', { type: 'intervention', payload: entry });
              broadcast('nexo:stats-changed', statsSnapshot());
            } catch (error) {
              console.log('[red] al contar la respuesta:', error?.message || error);
            }
          }, RETRASO_RED_MS);
        }
      }
    }

    if (!WATCHED_RESOURCE_TYPES.has(String(details.resourceType || 'other'))) return;
    const status = Number(details.statusCode) || 0;
    if (status < 400) return;
    const path = shortPath(url);
    const key = `${host}|${status}|${path}`;
    if (!once(key)) return;
    noteDiagnostic({
      code: 'http-error',
      key: `http-error|${key}`,
      title: `${host} respondió ${status}`,
      detail: `${details.method || 'GET'} ${path}: el servidor del proveedor rechazó la petición.`,
      meta: { host, status, path, method: details.method || 'GET', resourceType: details.resourceType || null },
    });
  });

  s.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details = {}) => {
    const associated = details.id != null ? requestTurns.get(String(details.id)) : null;
    if (details.id != null) requestTurns.delete(String(details.id));
    if (associated) engine.onTurnResult(associated.tabId, { ...associated,
      outcome: String(details.error || '').includes('ERR_ABORTED') ? 'unknown' : 'failed' });
    const url = String(details.url || '');
    const host = hostOf(url);
    if (!isAiHost(host)) return;
    if (!WATCHED_RESOURCE_TYPES.has(String(details.resourceType || 'other'))) return;
    const error = String(details.error || '');
    // `net::ERR_ABORTED` es lo normal cuando el sitio cancela: no es un fallo.
    if (!error || error.includes('ERR_ABORTED')) return;
    const path = shortPath(url);
    const key = `${host}|${error}|${path}`;
    if (!once(key)) return;
    noteDiagnostic({
      code: 'net-failed',
      key: `net-failed|${key}`,
      title: `${host} no llegó a responder`,
      detail: `${details.method || 'GET'} ${path}: ${error}.`,
      meta: { host, error, path, method: details.method || 'GET', resourceType: details.resourceType || null },
    });
  });
}

function configureSession() {
  const s = session.fromPartition('persist:nexo');

  // Mismo `User-Agent` limpio que el resto de la aplicación: si la sesión
  // tuviera otro, las peticiones de las pestañas volverían a delatarse.
  if (USER_AGENT) s.setUserAgent(USER_AGENT);
  // Se anota el UA efectivo una vez: es el dato que permite comprobar, en el
  // registro, que la compilación que corre ya no lleva las marcas de Electron.
  noteDiagnostic({
    code: 'user-agent',
    severity: 'info',
    key: 'user-agent',
    title: 'Cliente que se presenta al sitio',
    detail: USER_AGENT || '(el de Chromium por omisión)',
    meta: { userAgent: USER_AGENT },
  });
  // `NEXO_NETWATCH=0` la apaga sin tocar nada más, para poder descartarla como
  // variable al comparar dos arranques.
  if (process.env.NEXO_NETWATCH !== '0') watchProviderNetwork(s);

  // Sin corrector ortográfico: Chromium levanta un proceso aparte y descarga
  // diccionarios por idioma. En un navegador de chat el texto que se escribe
  // son mensajes cortos en un campo que ya declara `spellcheck="false"`.
  s.setSpellCheckerEnabled(false);

  // Permisos por sitio: la política del perfil decide, y todo lo denegado queda
  // registrado para que el usuario sepa por qué un sitio no funciona como espera.
  s.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const host = hostOf(webContents?.getURL() || '') || hostOf(details?.requestingUrl || '');
    const decision = profile ? profile.permissions.decide(host, permission) : 'deny';
    const granted = decision === 'allow';
    // Sin host no hay nada que el usuario pueda habilitar en el panel: avisar
    // «no concedido a sitio desconocido» sólo llena el registro de ruido.
    if (!granted && profile && host) {
      const entry = {
        kind: 'system',
        code: 'permission-denied',
        severity: 'info',
        title: `Permiso «${permission}» no concedido a ${host || 'sitio desconocido'}`,
        detail: 'Podés habilitarlo en Panel → Sitios cuando quieras.',
        ts: Date.now(),
      };
      store.pushLog(entry);
      broadcast('nexo:event', { type: 'intervention', payload: entry });
    }
    callback(granted);
  });
  s.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!profile) return false;
    return profile.permissions.decide(hostOf(requestingOrigin), permission) === 'allow';
  });

  // Descargas: se reflejan en el gestor del perfil.
  s.on('will-download', (_event, item) => {
    if (!profile) return;
    item.setSaveDialogOptions?.({title:'Guardar archivo original',defaultPath:sanitizeFilename(item.getFilename())});
    downloadSeq += 1;
    const id = `dl-${Date.now().toString(36)}-${downloadSeq}`;
    const entry = profile.downloads.start({
      id,
      url: item.getURL(),
      filename: sanitizeFilename(item.getFilename()),
      totalBytes: item.getTotalBytes(),
    });
    downloadItems.set(id, { item, entry });
    broadcast('nexo:downloads-changed', profile.downloads.stats());

    item.on('updated', (_e, state) => {
      if (state === 'interrupted') {
        // Puede reanudarse mientras DownloadItem siga vivo; no marca fin aún.
        const entry=profile.downloads.get(id);if(entry){entry.state='interrupted';profile.downloads.dirty=true;}
      } else if (state === 'progressing') {
        profile.downloads.progress(id, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      }
      broadcast('nexo:downloads-changed', profile.downloads.stats());
    });

    item.once('done', (_e, state) => {
      const savePath = item.getSavePath() || null;
      profile.downloads.finish(id, {
        state: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
        savePath,
      });
      profile.downloads.save({ force: true });
      downloadItems.delete(id);
      broadcast('nexo:downloads-changed', profile.downloads.stats());
      broadcast('nexo:download-done', { id, state, filename: item.getFilename() });
    });
  });

  return s;
}

app.whenReady().then(async () => {
  mark('ready');
  store = new Store({ onLogError: (error) => {
    console.error('[nexo]', error.message);
    broadcast('nexo:storage-error', { message: error.message });
  } });
  mark('ajustes');
  const created = createMemory({
    dir: app.getPath('userData'),
    projectId: store.settings.memory?.projectId || 'default',
    projectName: store.settings.memory?.projectName || null,
    maxItems: store.settings.memory?.maxItems,
    episodeEvery: store.settings.memory?.episodeEvery,
  });
  memory = created;
  conversationOptimizer = new ConversationOptimizer({notify:broadcast});
  captureDiagnosticFile = join(app.getPath('documents'), 'NEXO-CAPTURE-DIAGNOSTIC.jsonl');
  captureDiagnostic = createCaptureDiagnostic(captureDiagnosticFile, {
    onError: (code) => console.warn('[nexo] diagnóstico de captura no escrito:', code),
  });
  writeCaptureTrace('app-start', { detail: 'NEXO ' + app.getVersion() + ' · diagnóstico sin contenido de conversaciones' });
  mark('memoria');
  profile = createProfile({ dir: app.getPath('userData') });
  mark('perfil');
  profile.history.prune();
  engine = new Engine({
    store,
    memory: created.memory,
    onEvent: (entry) => {
      broadcast('nexo:event', { type: 'intervention', payload: entry });
      if (entry.code === 'turn-result') broadcast('nexo:stats-changed', statsSnapshot());
    },
  });
  mark('motor');
  cdp = new CdpObserver({
    engine,
    log: (message) => console.log('[cdp]', message),
    // Sin depurador en este arranque (prueba de humo, CI sin WebContents
    // completo) la observación queda apagada y nada más cambia.
    enabled: process.env.NEXO_CDP !== '0',
    // Apagar un sitio en Ajustes apaga también su observación: no se adjunta el
    // depurador ni se lee el tráfico de un sitio que el usuario dejó en paz.
    // Se vuelve a consultar al leer cuerpos, por si el interruptor cambia con la
    // pestaña ya abierta.
    // La memoria habilitada autoriza observación pasiva de ChatGPT aunque la
    // mediación del sitio esté apagada, pero nunca con EVO global apagada. Sólo se lee la respuesta
    // para guardarla en EVO MEMORY. Para otros proveedores sigue mandando el
    // interruptor de mediación del sitio.
    contentAllowed: (host) => {
      const normalized = String(host || '').toLowerCase();
      const isChatGpt = normalized === 'chatgpt.com' || normalized.endsWith('.chatgpt.com') ||
        normalized === 'chat.openai.com' || normalized.endsWith('.chat.openai.com');
      return engine.isEnabledFor(host) || (isChatGpt && isEvoMemoryEnabled(store.settings));
    }, 
    // Lo que el depurador no pudo leer se ve en el registro: un cero sin causa
    // es lo que nos tuvo dando vueltas cuatro versiones.
    onDiagnostic: (diagnostico) => noteDiagnostic(diagnostico),
    // Lo que CDP cuenta se ve al instante y queda en el registro con su origen:
    // sin esto, una respuesta contada por observación no refrescaba el panel.
    onEvent: (id, event) => {
      try {
        if (event?.type === 'send') {
          if (event.duplicate) { broadcast('nexo:stats-changed', statsSnapshot()); return; }
          writeCaptureTrace('request-detected', { host: event.host, site: event.site, url: event.url,
            source: 'cdp', chars: event.chars, messageId: event.messageId, duplicate: Boolean(event.duplicate) });
          const entry = {
            kind: 'sending',
            code: 'outgoing-cdp',
            severity: 'info',
            title: `Mensaje enviado en ${event.host}`,
            detail: 'Envío leído de la petición del sitio (observación CDP).',
            meta: {
              host: event.host,
              site: event.site || null,
              url: event.url || '',
              source: 'cdp',
              chars: event.chars,
              tokens: event.tokens,
              tokenEncoding: event.tokenEncoding || null,
              tokenExact: event.tokenExact === true,
              tokenMethod: event.tokenMethod || 'unverified',
            },
            ts: Date.now(),
          };
          if (store) store.pushLog(entry);
          broadcast('nexo:event', { type: 'intervention', payload: entry });
        } else if (event?.type === 'capture') {
          const captureData = event.capture || {};
          writeCaptureTrace('response-delivered', {
            capture: captureData, duplicate: Boolean(event.duplicate), paired: Boolean(event.paired),
            messageId: event.messageId || captureData.messageId,
            memory: event.memory || null,
          });
          if (event.duplicate) {
            // La respuesta no es nueva, pero CDP pudo recuperar texto/tokens.
            broadcast('nexo:stats-changed', statsSnapshot());
            return;
          }
          const capture = event.capture || {};
          const host = capture.host || 'el sitio';
          const chars = String(capture.text || '').length;
          const entry = {
            kind: 'receiving',
            code: 'incoming-cdp',
            severity: 'info',
            title: `Respuesta recibida en ${host}`,
            detail:
              `${chars} caracteres leídos por ${capture.source === 'websocket' ? 'el socket' : capture.source === 'sse' ? 'el stream' : 'el cuerpo JSON'}` +
              `${event.paired ? ', asociados a su mensaje' : ''}.`,
            meta: {
              host,
              site: capture.site || null,
              url: capture.url || '',
              source: capture.source === 'websocket' ? 'cdp-ws' : capture.source === 'sse' ? 'cdp-sse' : 'cdp-json',
              messageId: event.messageId || null,
              paired: Boolean(event.paired),
              chars,
              tokens: countOutputTokens(String(capture.text || ''), capture.model || '', capture.host || ''),
              conversationId: capture.conversationId || null,
            },
            ts: Date.now(),
          };
          if (store) store.pushLog(entry);
          broadcast('nexo:event', { type: 'intervention', payload: entry });
        } else {
          return;
        }
        broadcast('nexo:stats-changed', statsSnapshot());
      } catch (error) {
        console.log('[cdp] al avisar:', error?.message || error);
      }
    },
  });
  registerProtocol();
  // Puerta de salida de datos (canal `egress`). Se crea antes de registrar los
  // canales; su modo por defecto es `off`, así que no interviene ningún envío.
  egressGate = createEgressGate({
    getConfig: (host) => settingsForHost(store.settings, host).egress,
    askUser: askNativeEgress,
    onDiagnostic: (entry) => noteDiagnostic(entry),
    onStats: () => broadcast('nexo:stats-changed', statsSnapshot()),
  });
  registerIpc();
  configureSession();
  // Una línea con la versión que corre y qué captura quedó armada. Sin esto,
  // un informe de «no cuenta nada» no distingue una falla de una build vieja.
  noteDiagnostic({
    code: 'app-version',
    key: `app-version|${app.getVersion()}`,
    severity: 'info',
    title: `Nexo ${app.getVersion()} — captura armada`,
    detail: `Red: ${process.env.NEXO_NETWATCH === '0' ? 'apagada' : 'activa'} · CDP: ${
      process.env.NEXO_CDP === '0' ? 'apagado' : 'activo'
    } · contadores en la sesión.`,
    meta: { version: app.getVersion(), netwatch: process.env.NEXO_NETWATCH !== '0', cdp: process.env.NEXO_CDP !== '0' },
  });
  promptStore = new PromptStore({ store });
  advancedBrowser = installAdvancedBrowser({getProfile:()=>profile,downloadItems,broadcast,
    onCaptureEvidence:(owner,contents,params)=>workDossier?.captureSelection(owner,contents,params),
    onPreferences:(prefs)=>buildMenu({send:(channel,payload)=>broadcast(channel,payload),bindings:prefs.shortcuts})});
  workDossier = installWorkDossier({app, ipcMain, BrowserWindow, dialog, broadcast,
    getWorkspaceIds:()=>advancedBrowser.preferences.workspaces.map(w=>w.id),
    resolveGuest:(owner,id)=>advancedBrowser.resolveGuest(owner,id)});
  installOptimizationIPC({service:conversationOptimizer,ipcMain,BrowserWindow,
    resolveGuest:(owner,id)=>advancedBrowser.resolveGuest(owner,id)});
  buildMenu({ send: (channel, payload) => broadcast(channel, payload),bindings:advancedBrowser.preferences.shortcuts });
  createWindow();
  mark('ventana');

  if (isSmoke) {
    // Sin ventana visible ni interacción: sólo comprobar que el paquete vivo
    // carga la shell desde el asar. Cualquier excepción debe terminar el
    // proceso, no dejarlo colgado en CI.
    const smoke = await runSmoke({ win }).catch((error) => ({
      ok: false,
      checks: [{ name: 'prueba de humo', ok: false, detail: error?.message || String(error) }],
    }));
    smokeDone = true;
    const code = reportSmoke(smoke);
    // El estado de la aceleración por hardware explica buena parte de los
    // tiempos de pintado: en un servidor sin GPU, Chromium rasteriza por
    // software y el primer cuadro tarda cientos de milisegundos.
    let gpu = 'sin datos';
    try {
      const estado = app.getGPUFeatureStatus?.() || {};
      gpu = `composición ${estado.gpu_compositing || 'n/d'}, webgl ${estado.webgl || 'n/d'}, rasterizado ${estado.rasterization || 'n/d'}`;
    } catch {
      // Sin información de GPU se informa igual.
    }
    if (smokeOut) {
      // `reportSmoke` ya escribió en consola; el archivo es la vía confiable.
      // Incluye las medidas de arranque y memoria: son los números que se
      // comparan entre compilaciones de Windows.
      const informe = smokeReport({ informe: renderSmoke(smoke), app, code, extra: { gpu } });
      await writeFile(smokeOut, informe, 'utf8').catch(() => {});
    }
    app.exit(code);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// La sesión y el perfil se guardan al salir, incluso si la ventana se cerró de
// golpe: son datos que el usuario espera recuperar.
app.on('before-quit', () => {
  void conversationOptimizer?.close();
  try {
    profile?.saveAll();
    memory?.flush?.();
  } catch (error) {
    console.error('[nexo] no se pudo guardar el perfil:', error.message);
  }
});

// Endurecimiento: ninguna pestaña puede pedir Node ni cambiar su preload.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });

  // Una pestaña que se cae (falta de memoria, choque del renderizador) se
  // recarga, pero una sola vez por choque seguido: un bucle de recargas sobre
  // una página que rompe el proceso de render deja la aplicación inusable.
  contents.on('render-process-gone', (_event, details) => {
    if (details?.reason === 'clean-exit') return;
    engine?.onTurnInterrupted(contents.id);
    const entry = crashRecovery.get(contents.id) || { attempts: 0, timer: null };
    entry.attempts += 1;
    console.error(`[nexo] la pestaña se cayó (${details?.reason || 'desconocido'})`);
    crashRecovery.set(contents.id, entry);
    if (entry.attempts > 1 || contents.isDestroyed?.()) return;
    setTimeout(() => {
      if (!contents.isDestroyed?.()) contents.reload();
    }, 400);
  });

  // Cargar no alcanza: la página tiene que sostenerse un rato para que el
  // próximo choque vuelva a tener derecho a una recarga.
  contents.on('did-finish-load', () => {
    const entry = crashRecovery.get(contents.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => crashRecovery.delete(contents.id), CRASH_WINDOW_MS);
    if (entry.timer.unref) entry.timer.unref();
  });

  contents.on('destroyed', () => {
    const entry = crashRecovery.get(contents.id);
    clearTimeout(entry?.timer);
    crashRecovery.delete(contents.id);
  });
});

export { ROOT, PAGE_PRELOAD, SHELL_PRELOAD };

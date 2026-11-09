/**
 * Prueba de humo del ejecutable ya empaquetado.
 *
 * `nexo.exe --smoke` abre la ventana real, pregunta a la interfaz qué ve y
 * escribe un informe; después sale con código 0 o 1. Sirve para comprobar en
 * Windows (o en CI) que el .exe arranca, que el protocolo `nexo://` sirve los
 * archivos desde el asar y que el preload llegó a la página.
 *
 * No abre pestañas de internet ni toca la red: es lo mínimo que distingue «se
 * empaquetó» de «funciona».
 */

/** Lo que se evalúa dentro de la ventana de la shell. */
const PROBE = `(() => {
  const out = {};
  try {
    out.protocol = location.protocol;
    out.title = document.title;
    out.readyState = document.readyState;
    const bridge = window.nexo;
    out.bridge = typeof bridge === 'object' && bridge !== null;
    out.bridgeKeys = out.bridge ? Object.keys(bridge).sort() : [];
    out.hasBridgeMethod = Boolean(out.bridge && typeof bridge.getSettings === 'function');
    out.omnibox = Boolean(document.querySelector('#omnibox'));
    out.tabStrip = Boolean(document.querySelector('#tabs'));
    out.webviews = document.querySelectorAll('webview').length;
    const style = getComputedStyle(document.body);
    out.background = style.backgroundColor;
    out.stylesheetLoaded = style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  } catch (error) {
    out.error = String(error && error.message ? error.message : error);
  }
  return JSON.stringify(out);
})()`;

/** Claves del puente que la shell necesita para considerarse completa. */
const REQUIRED_BRIDGE_KEYS = ['bookmarks', 'downloads', 'getSettings', 'history', 'profile'];

/**
 * Corre la prueba de humo contra una ventana ya creada.
 *
 * @param {{ win: Electron.BrowserWindow, timeout?: number }} options
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail?: string }> }>}
 */
export async function runSmoke({ win, timeout = 20000 }) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) });
  };

  if (!win || win.isDestroyed?.()) {
    check('ventana creada', false, 'no hay ventana');
    return { ok: false, checks };
  }
  check('ventana creada', true);

  const contents = win.webContents;
  if (!contents || typeof contents.executeJavaScript !== 'function') {
    check('página inspeccionable', false, 'la ventana no expone webContents');
    return { ok: false, checks };
  }

  let probe;
  try {
    const raw = await withTimeout(contents.executeJavaScript(PROBE), timeout);
    probe = JSON.parse(raw);
  } catch (error) {
    check('página inspeccionable', false, error?.message || String(error));
    return { ok: false, checks };
  }

  check('esquema nexo', probe.protocol === 'nexo:', probe.protocol);
  check('documento cargado', probe.readyState === 'complete' || probe.readyState === 'interactive', probe.readyState);
  check('título de la ventana', typeof probe.title === 'string' && probe.title.length > 0, probe.title);
  check('hoja de estilos aplicada', probe.stylesheetLoaded, probe.background);
  check('barra de direcciones', probe.omnibox);
  check('franja de pestañas', probe.tabStrip);
  check('preload expuesto', probe.bridge, probe.error);
  check(
    'puente completo',
    REQUIRED_BRIDGE_KEYS.every((key) => probe.bridgeKeys?.includes(key)),
    probe.bridgeKeys?.join(', '),
  );
  check('webview montada', probe.webviews >= 1, `${probe.webviews} webviews`);

  return { ok: checks.every((item) => item.ok), checks };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Imprime el informe y devuelve el código de salida. */
export function report({ ok, checks }, write = (line) => console.log(line)) {
  write('\n── prueba de humo ──────────────────────────────');
  for (const item of checks) {
    write(`${item.ok ? '✔' : '✖'} ${item.name}${item.detail ? ` · ${item.detail}` : ''}`);
  }
  write(`────────────────────────────────────────────────\n${ok ? '✔ arrancó y funciona' : '✖ algo falló'}\n`);
  return ok ? 0 : 1;
}

/**
 * Configuración del empaquetado, separada del script para poder probarla.
 *
 * La lista de exclusiones es la pieza más frágil de todo el empaquetado: si se
 * deja caer un archivo que la app necesita en tiempo de ejecución (el caso
 * clásico es `build/inject.js`), el .exe se genera igual y falla recién al
 * navegar. Por eso se verifica en `test/packaging.test.js`.
 */

export const APP_NAME = 'Nexo';
export const EXE_NAME = 'nexo';

/** Copyright que se escribe en el .exe. Cambialo si publicás con otro titular. */
export const COPYRIGHT = '© 2026 Nexo';

/**
 * Rutas que no viajan en la distribución. Las expresiones se aplican contra la
 * ruta relativa al proyecto empezando con «/».
 */
export const ignore = [
  /^\/\.git($|\/)/,
  /^\/\.github($|\/)/,
  /^\/test($|\/)/,
  /^\/docs($|\/)/,
  /^\/scripts($|\/)/,
  /^\/dev($|\/)/,
  /^\/dist($|\/)/,
  // Las dependencias de producción viajan; packager las filtra con prune:true.
  /^\/\.nexo-profile($|\/)/,
  /^\/\.cache($|\/)/,
  /^\/build\/icon\.png$/,
  /^\/build\/icon-256\.png$/,
  /^\/build\/icon\.ico$/,
  /^\/package-lock\.json$/,
  /^\/README\.md$/,
  /^\/\.gitignore$/,
  /\.log$/,
  /^\/\.DS_Store$/,
];

/**
 * Idiomas que se conservan de Chromium.
 *
 * Electron trae 60 archivos `.pak` de traducción de su interfaz (~9 MB). Este
 * navegador sólo muestra su propia interfaz, así que se queda con el español y
 * el inglés: `en-US` es obligatorio como respaldo interno de Chromium.
 */
export const KEEP_LOCALES = ['es', 'es-419', 'es-AR', 'en-US', 'en-GB'];

/**
 * Dado el contenido de `locales/`, devuelve qué archivos sacar.
 * Separado del empaquetado para poder probarlo sin Electron.
 *
 * @param {string[]} existing nombres de archivo, p. ej. `en-US.pak`
 * @param {string[]} [keep]
 * @returns {string[]}
 */
export function localesToPrune(existing, keep = KEEP_LOCALES) {
  const wanted = new Set(keep);
  return existing.filter((file) => {
    const name = String(file).replace(/\.pak$/i, '');
    return !wanted.has(name);
  });
}

/** Archivos que tienen que estar sí o sí dentro del asar. */
export const requiredAsarEntries = [
  'package.json',
  'src/main/main.js',
  'src/main/menu.js',
  'src/main/store.js',
  'src/main/engine.js',
  'src/main/tokens.js',
  'src/core/gptTokens.cjs',
  'src/preload/token-metadata.cjs',
  'node_modules/gpt-tokenizer/package.json',
  'node_modules/gpt-tokenizer/cjs/main.js',
  'node_modules/gpt-tokenizer/cjs/encoding/cl100k_base.js',
  'src/main/memory.js',
  'src/main/profile.js',
  'src/main/workDossier.js',
  'src/core/userUnderstanding.js',
  'src/core/userGoals.js',
  'src/core/userRules.js',
  'src/core/userTasks.js',
  'src/core/userProjects.js',
  'src/core/userProgress.js',
  'src/ui/shell/understandingProgress.js',
  'src/core/conversationObservation.js',
  'src/main/userUnderstanding.js',
  'src/ui/shell/understandingPanel.js',
  'src/ui/shell/understandingTasks.js',
  'src/ui/shell/understandingContexts.js',
  'src/ui/shell/understandingRefresh.js',
  'src/nav/workDossier.js',
  'src/ui/shell/workDossier.js',
  'src/ui/shell/workDossier.css',
  'src/main/files.js',
  'src/main/perf.js',
  'src/preload/shell.cjs',
  'src/preload/bridge.cjs',
  'src/ui/shell/index.html',
  'src/ui/shell/app.js',
  'src/ui/shell/styles.css',
  'src/ui/start/index.html',
  'src/nav/url.js',
  'src/nav/shortcuts.js',
  'src/core/settings.js',
  'build/inject.js',
  'build/chatgpt-reader.cjs',
  // La sala de pruebas de mediación se abre desde la barra de la shell.
  'demo/index.html',
  'demo/app.js',
  'demo/simulator.js',
  'demo/styles.css',
];

/** Prefijos que no deberían aparecer dentro del asar. */
export const forbiddenAsarPrefixes = ['test/', 'docs/', 'scripts/', 'dev/'];

/** ¿Esta ruta queda fuera del paquete? */
export function isIgnored(relativePath) {
  const path = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return ignore.some((pattern) => pattern.test(path));
}

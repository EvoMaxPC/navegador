/**
 * Cargador que reemplaza `electron` por el falso de `electron-stub.mjs`.
 *
 * Permite importar el proceso principal real (`src/main/main.js`) desde
 * `node:test`, sin display ni binario de Electron.
 */

// `new URL(...).href` ya es una URL de archivo válida en cualquier sistema:
// pasar por `pathToFileURL(new URL(...).pathname)` duplicaba la letra de unidad
// en Windows (`file:///D:/D:/…`).
const STUB = new URL('./electron-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

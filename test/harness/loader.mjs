/**
 * Cargador que reemplaza `electron` por el falso de `electron-stub.mjs`.
 *
 * Permite importar el proceso principal real (`src/main/main.js`) desde
 * `node:test`, sin display ni binario de Electron.
 */

import { pathToFileURL } from 'node:url';

const STUB = pathToFileURL(new URL('./electron-stub.mjs', import.meta.url).pathname).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

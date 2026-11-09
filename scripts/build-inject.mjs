/**
 * Empaqueta la capa de inyección en un único script IIFE.
 *
 * El resultado (`build/inject.js`) lo evalúa el preload de cada pestaña en el
 * mundo principal de la página. Se genera con esbuild para poder reutilizar los
 * módulos ESM del motor sin duplicar código.
 */

import { build } from 'esbuild';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'build/inject.js');

await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src/inject/index.js')],
  outfile,
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  platform: 'browser',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

const { size } = await stat(outfile);
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`inject.js listo · ${(size / 1024).toFixed(1)} kB · ${inputs} módulos`);

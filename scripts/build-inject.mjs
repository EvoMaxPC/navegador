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
// `--dev` deja el bundle legible: se evalúa en cada página, así que en
// producción conviene minificado (menos bytes que parsear antes de que la
// página responda a la primera tecla).
const dev = process.argv.includes('--dev') || process.env.NEXO_INJECT_DEV === '1';

await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src/inject/index.js')],
  outfile,
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  platform: 'browser',
  minify: !dev,
  // Sin escapar los acentos: en UTF-8 ocupan menos y el texto es español.
  charset: 'utf8',
  legalComments: 'none',
  keepNames: dev,
  logLevel: 'warning',
  metafile: true,
});

const { size } = await stat(outfile);
const inputs = Object.keys(result.metafile.inputs).length;
const { gzipSync } = await import('node:zlib');
const { readFile } = await import('node:fs/promises');
const gzip = gzipSync(await readFile(outfile)).length;
console.log(
  `inject.js listo · ${(size / 1024).toFixed(1)} kB (${(gzip / 1024).toFixed(1)} kB gzip) · ${inputs} módulos${dev ? ' · modo dev' : ''}`,
);

// El lector DOM se ejecuta desde el preload aislado, nunca como script de la web.
await build({
  entryPoints: [resolve(root, 'src/preload/chatgptReader.js')],
  outfile: resolve(root, 'build/chatgpt-reader.cjs'),
  bundle: true, format: 'cjs', platform: 'browser', target: ['chrome120'],
  minify: !dev, charset: 'utf8', legalComments: 'none', logLevel: 'warning',
});

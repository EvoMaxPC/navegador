/** Copia los derivados oficiales del PNG NEXO Wormhole suministrado por el usuario.
 * No dibuja otra identidad. ICO multirresolución 16–256 y PNG RGBA 512.
 * Los derivados versionados permiten generar iconos sin Pillow ni dependencias nuevas.
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function generateIcons(dir) {
  mkdirSync(dir, { recursive: true });
  const paths = {
    ico: resolve(dir, 'icon.ico'),
    png: resolve(dir, 'icon.png'),
    preview: resolve(dir, 'icon-256.png'),
  };
  for (const [key, source] of [
    ['ico', 'NEXO-Wormhole.ico'],
    ['png', 'NEXO-Wormhole.png'],
    ['preview', 'app-icon-256.png'],
  ])
    copyFileSync(resolve(root, 'src/ui/assets/identity', source), paths[key]);
  return paths;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  generateIcons(resolve(root, 'build'));
  console.log(
    'Iconos NEXO Wormhole oficiales listos · ICO 16, 24, 32, 48, 64, 128, 256 px · PNG 512 px',
  );
}

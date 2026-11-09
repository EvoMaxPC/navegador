/**
 * Empaquetador de Nexo para Windows.
 *
 * Toma el árbol del proyecto, lo mete en un asar y produce una carpeta
 * ejecutable con `nexo.exe` (el binario de Electron renombrado) más un ZIP
 * listo para repartir.
 *
 * Uso:
 *   npm run dist:win                 # win32 x64, asar, con ZIP
 *   npm run dist:win -- --arch=arm64 # otros procesadores
 *   npm run dist:win -- --no-asar    # si el ESM dentro del asar diera problemas
 *   npm run dist:win -- --electron-zip-dir=./cache  # sin bajar Electron
 *
 * Requisitos: `node_modules` instalado y `build/inject.js` generado
 * (`npm run build:inject`, lo hace `npm run verify`).
 *
 * El icono y los metadatos del .exe los escribe `resedit`, que es JS puro: el
 * resultado es el mismo empaquetando desde Windows, Linux o macOS.
 */

import { packager } from '@electron/packager';
import { listPackage } from '@electron/asar';
import { localesToPrune } from './packaging-config.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';
import { APP_NAME, EXE_NAME, COPYRIGHT, ignore, requiredAsarEntries, forbiddenAsarPrefixes } from './packaging-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- argumentos ---------------- */

function arg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const config = {
  arch: arg('arch', 'x64'),
  out: resolve(root, arg('out', 'dist')),
  asar: !flag('no-asar'),
  zip: !flag('no-zip'),
  electronZipDir: arg('electron-zip-dir', process.env.NEXO_ELECTRON_ZIP_DIR),
};

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const steps = [];
const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
};
const step = (label, ok = true) => {
  steps.push({ label, ok });
  if (!ok) process.exitCode = 1;
};

/* ---------------- comprobaciones previas ---------------- */

if (!['x64', 'arm64', 'ia32'].includes(config.arch)) fail(`arquitectura no soportada: ${config.arch}`);
if (!existsSync(join(root, 'build', 'inject.js'))) {
  fail('falta build/inject.js. Corré «npm run build:inject» (o «npm run verify») antes de empaquetar.');
}
if (!existsSync(join(root, 'build', 'icon.ico'))) {
  fail('falta build/icon.ico. Corré «npm run make:icon».');
}
if (!existsSync(join(root, pkg.main))) fail(`«main» apunta a ${pkg.main}, que no existe.`);

if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  fail(
    'hay dependencias de ejecución en package.json pero el empaquetado excluye node_modules. ' +
      'Quitá /^\\/node_modules/ de scripts/packaging-config.mjs antes de seguir.',
  );
}

const electronVersion = (pkg.devDependencies?.electron || '').replace(/^[^\d]*/, '');
if (!electronVersion) fail('no se pudo determinar la versión de Electron en package.json.');

/* ---------------- empaquetado ---------------- */

console.log(`\n▶ Empaquetando ${APP_NAME} ${version} · win32-${config.arch} · electron ${electronVersion}\n`);

await mkdir(config.out, { recursive: true });

const win32metadata = {
  CompanyName: 'Nexo',
  FileDescription: `${APP_NAME} — navegador con capa de mediación`,
  ProductName: APP_NAME,
  InternalName: EXE_NAME,
  OriginalFilename: `${EXE_NAME}.exe`,
};

let outputPaths;
try {
  outputPaths = await packager({
    dir: root,
    out: config.out,
    name: APP_NAME,
    executableName: EXE_NAME,
    appVersion: version,
    buildVersion: version,
    appCopyright: COPYRIGHT,
    platform: 'win32',
    arch: config.arch,
    overwrite: true,
    asar: config.asar,
    prune: true,
    quiet: true,
    // `resedit` (packager 20) es JS puro: el icono y los metadatos del .exe se
    // incrustan igual desde Linux o macOS, sin wine.
    icon: join(root, 'build', 'icon.ico'),
    win32metadata,
    ignore,
    electronZipDir: config.electronZipDir,
    derefSymlinks: true,
    tmpdir: false,
  });
} catch (error) {
  const message = String(error?.message || error);
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo/i.test(message)) {
    console.error(`\n✖ No se pudo descargar Electron ${electronVersion} para win32-${config.arch}.`);
    console.error('  El binario no viene en el paquete de npm: se baja de las releases de Electron.');
    console.error('  Alternativas:');
    console.error('   1. Correr el empaquetado en una máquina con acceso a github.com.');
    console.error(
      `   2. Copiar electron-v${electronVersion}-win32-${config.arch}.zip a una carpeta y usar`,
    );
    console.error('      npm run dist:win -- --electron-zip-dir=RUTA');
    console.error('   3. Usar el flujo de GitHub Actions (.github/workflows/compilar-windows.yml).\n');
    fail('empaquetado cancelado');
  }
  throw error;
}
step(`Electron ${electronVersion} win32-${config.arch} empaquetado`);

const appDir = resolve(String(outputPaths[0]));
const exePath = join(appDir, `${EXE_NAME}.exe`);

/* ---------------- idiomas ---------------- */
// Chromium se lleva un .pak por idioma: ~9 MB de traducciones que esta interfaz
// no muestra. Se conservan español e inglés.
const localesDir = join(appDir, 'locales');
if (existsSync(localesDir)) {
  const before = readdirSync(localesDir);
  const drop = localesToPrune(before);
  let freed = 0;
  for (const file of drop) {
    const full = join(localesDir, file);
    try {
      freed += statSync(full).size;
      rmSync(full, { force: true });
    } catch {
      // Si no se puede borrar, no es motivo para abortar la compilación.
    }
  }
  if (drop.length) {
    step(`idiomas: ${before.length} → ${before.length - drop.length} (se liberan ${(freed / 1024 / 1024).toFixed(1)} MB)`);
  }
}
const asarPath = join(appDir, 'resources', 'app.asar');

/* ---------------- verificación del resultado ---------------- */

if (!existsSync(exePath)) fail(`el empaquetado no produjo ${EXE_NAME}.exe en ${appDir}`);
step(`${EXE_NAME}.exe presente`);

if (config.asar) {
  if (!existsSync(asarPath)) fail('falta resources/app.asar');
  const entries = listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/').replace(/^\//, ''));
  const missing = requiredAsarEntries.filter((entry) => !entries.includes(entry));
  if (missing.length) fail(`faltan archivos en el asar: ${missing.join(', ')}`);

  const leaked = entries.filter((entry) =>
    forbiddenAsarPrefixes.some((prefix) => entry.startsWith(prefix)),
  );
  if (leaked.length) fail(`el asar arrastra archivos que no van: ${leaked.slice(0, 5).join(', ')}`);

  step(`asar con ${entries.length} entradas, sin tests ni documentación`);
}

const exeInfo = await stat(exePath);
step(`${EXE_NAME}.exe de ${(exeInfo.size / 1024 / 1024).toFixed(1)} MB`);

/* ---------------- ZIP ---------------- */

let zipPath = null;
if (config.zip) {
  zipPath = join(config.out, `${APP_NAME}-${version}-win32-${config.arch}.zip`);
  await rm(zipPath, { force: true });
  const { files, bytes } = await zipDirectory(appDir, zipPath, { root: config.out });
  const sha = createHash('sha256')
    .update(await readFile(zipPath))
    .digest('hex');
  step(`ZIP con ${files} archivos · ${(bytes / 1024 / 1024).toFixed(1)} MB · sha256 ${sha.slice(0, 16)}…`);
  console.log(`  ${zipPath}`);
}

/* ---------------- resumen ---------------- */

console.log('\n──────────────────────────────────────────────');
for (const item of steps) console.log(`${item.ok ? '✔' : '✖'} ${item.label}`);
console.log('──────────────────────────────────────────────');
console.log(`\nCarpeta lista para ejecutar: ${appDir}`);
if (process.platform !== 'win32') {
  console.log('Recordá: este árbol es para Windows, no se puede ejecutar en este sistema.');
  if (config.asar === false) console.log('Empaquetado sin asar (los archivos quedan sueltos en resources/app).');
}
console.log('');

/**
 * Pruebas del empaquetado.
 *
 * No pueden arrancar `nexo.exe` (no hay Windows acá), pero sí comprueban las
 * tres cosas que se rompen en silencio: que el paquete incluya lo que la app
 * necesita en ejecución, que el ZIP que generamos sea un ZIP de verdad y que el
 * icono tenga el formato que espera el sistema.
 *
 * La cadena completa (Electron + asar + .exe) se prueba aparte: si existe la
 * variable NEXO_ELECTRON_ZIP_DIR, `empaquetar.mjs` corre de verdad y el
 * resultado se inspecciona. Sin ella, esas pruebas se saltean.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import {
  APP_NAME,
  EXE_NAME,
  COPYRIGHT,
  isIgnored,
  ignore,
  requiredAsarEntries,
  forbiddenAsarPrefixes,
} from '../scripts/packaging-config.mjs';
import { generateIcons } from '../scripts/make-icon.mjs';
import { zipDirectory } from '../scripts/zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// `build/` está fuera de Git: en un clon recién bajado no existen ni el icono
// ni el bundle de inyección. Se generan acá para que «npm test» funcione solo.
const buildDir = join(root, 'build');
if (!existsSync(join(buildDir, 'icon.ico'))) generateIcons(buildDir);
if (!existsSync(join(buildDir, 'inject.js'))) {
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-inject.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, `no se pudo generar build/inject.js: ${built.stderr}`);
}

/* ---------------- configuración ---------------- */

test('el paquete incluye todo lo que la app necesita en ejecución', () => {
  for (const entry of requiredAsarEntries) {
    assert.ok(existsSync(join(root, entry)), `falta ${entry} en el repositorio`);
    assert.ok(!isIgnored(entry), `${entry} quedaría fuera del paquete`);
  }
});

test('las pruebas, la documentación y los scripts no viajan en el paquete', () => {
  for (const path of [
    'test/main-boot.test.js',
    'docs/NAVEGADOR.md',
    'scripts/empaquetar.mjs',
    'dev/serve.mjs',
    'node_modules/electron/package.json',
    'package-lock.json',
    'build/icon.png',
    'algo.log',
  ]) {
    assert.ok(isIgnored(path), `${path} no debería empaquetarse`);
  }
  assert.ok(!isIgnored('src/main/main.js'));
  assert.ok(!isIgnored('build/inject.js'), 'sin inject.js la mediación no existe');
  assert.ok(!isIgnored('demo/index.html'), 'la sala de pruebas se abre desde la barra');
  assert.deepEqual(forbiddenAsarPrefixes, ['test/', 'docs/', 'scripts/', 'dev/']);
});

test('la lista de exclusiones no se solapa con archivos requeridos', () => {
  const overlap = requiredAsarEntries.filter((entry) => ignore.some((re) => re.test(`/${entry}`)));
  assert.deepEqual(overlap, []);
});

test('el empaquetado excluye node_modules sólo si no hay dependencias de ejecución', () => {
  const hasDeps = Object.keys(pkg.dependencies || {}).length > 0;
  const excludesModules = ignore.some((re) => re.test('/node_modules/electron/index.js'));
  assert.equal(excludesModules, !hasDeps, 'node_modules debe seguir o salir según dependencies');
});

test('los nombres y la versión del empaquetado salen de un solo lugar', () => {
  assert.equal(APP_NAME, 'Nexo');
  assert.equal(EXE_NAME, 'nexo');
  assert.match(COPYRIGHT, /Nexo/);
  assert.equal(pkg.main, 'src/main/main.js', 'Electron arranca desde main');
  assert.ok(pkg.scripts['dist:win'].includes('empaquetar.mjs'));
});

/* ---------------- escritor de ZIP ---------------- */

/** Lector mínimo de ZIP, independiente del escritor, para no validarse a sí mismo. */
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'falta el fin del directorio central');
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const files = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50, 'firma del directorio central');
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(offset), 0x04034b50, `cabecera local de ${name}`);
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    files.push({ name, data, size, crc, method });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('el ZIP generado se puede leer y el contenido coincide', async () => {
  const work = mkdtempSync(join(tmpdir(), 'nexo-zip-'));
  try {
    const source = join(work, 'Nexo-win32-x64');
    await mkdir(join(source, 'resources'), { recursive: true });
    await mkdir(join(source, 'locales'), { recursive: true });

    const small = Buffer.from('hola ñandú\n');
    const big = Buffer.alloc(64 * 1024);
    for (let index = 0; index < big.length; index += 1) big[index] = (index * 7) % 251;
    const binary = Buffer.from([0x00, 0xff, 0x1a, 0x0d, 0x0a, 0x80]);

    writeFileSync(join(source, 'nexo.exe'), big);
    writeFileSync(join(source, 'resources', 'app.asar'), binary);
    writeFileSync(join(source, 'locales', 'es.pak'), small);

    const zipPath = join(work, 'salida.zip');
    const result = await zipDirectory(source, zipPath, { root: work });
    assert.equal(result.files, 3);

    const files = readZip(readFileSync(zipPath));
    assert.deepEqual(files.map((file) => file.name).sort(), [
      'Nexo-win32-x64/locales/es.pak',
      'Nexo-win32-x64/nexo.exe',
      'Nexo-win32-x64/resources/app.asar',
    ]);

    const exe = files.find((file) => file.name.endsWith('nexo.exe'));
    assert.equal(exe.crc, crc32(big), 'el CRC declarado debe ser el real');
    assert.deepEqual(exe.data, big);
    assert.equal(exe.method, 8, 'un archivo grande debe ir comprimido');

    const ico = files.find((file) => file.name.endsWith('app.asar'));
    assert.deepEqual(ico.data, binary, 'los bytes binarios deben sobrevivir intactos');

    const pak = files.find((file) => file.name.endsWith('es.pak'));
    assert.equal(pak.data.toString('utf8'), 'hola ñandú\n', 'los acentos se guardan en UTF-8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('el ZIP vacío también es un ZIP válido', async () => {
  const work = mkdtempSync(join(tmpdir(), 'nexo-zip-vacio-'));
  try {
    await mkdir(join(work, 'vacio'), { recursive: true });
    const zipPath = join(work, 'vacio.zip');
    await zipDirectory(join(work, 'vacio'), zipPath, { root: work });
    assert.deepEqual(readZip(readFileSync(zipPath)), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/* ---------------- icono ---------------- */

test('el icono es un ICO con los tamaños que usa Windows', () => {
  const icoPath = join(buildDir, 'icon.ico');
  assert.ok(existsSync(icoPath), 'falta build/icon.ico');
  const ico = readFileSync(icoPath);
  assert.equal(ico.readUInt16LE(0), 0, 'reservado');
  assert.equal(ico.readUInt16LE(2), 1, 'tipo icono');
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 6, 'Windows quiere varios tamaños');

  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(width, height);
    assert.ok(offset + bytes <= ico.length, `la entrada ${index} sale del archivo`);
    const png = ico.subarray(offset, offset + 8);
    assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG incrustado');
    assert.equal(ico.readUInt32BE(offset + 16), width, 'ancho real dentro del PNG');
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test('el icono grande es un PNG de 512 px', () => {
  const png = readFileSync(join(buildDir, 'icon.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[24], 8, '8 bits por canal');
  assert.equal(png[25], 6, 'RGBA');
});

/* ---------------- cadena completa (opcional) ---------------- */

const electronZipDir = process.env.NEXO_ELECTRON_ZIP_DIR;

test(
  'empaquetar.mjs produce un .exe con su asar',
  { skip: electronZipDir ? false : 'definí NEXO_ELECTRON_ZIP_DIR para probar la cadena completa' },
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'nexo-dist-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(root, 'scripts', 'empaquetar.mjs'),
          `--electron-zip-dir=${electronZipDir}`,
          `--out=${work}`,
          '--no-zip',
        ],
        { cwd: root, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const appDir = join(work, `${APP_NAME}-win32-x64`);
      const exe = join(appDir, `${EXE_NAME}.exe`);
      assert.ok(existsSync(exe), 'falta el ejecutable');
      assert.ok(statSync(exe).size > 0);

      const { listPackage } = await import('@electron/asar');
      const entries = listPackage(join(appDir, 'resources', 'app.asar')).map((entry) =>
        entry.replace(/\\/g, '/').replace(/^\//, ''),
      );
      for (const required of requiredAsarEntries) {
        assert.ok(entries.includes(required), `el asar no trae ${required}`);
      }
      for (const prefix of forbiddenAsarPrefixes) {
        assert.ok(!entries.some((entry) => entry.startsWith(prefix)), `el asar trae ${prefix}`);
      }
      assert.ok(!entries.some((entry) => entry.startsWith('node_modules/')), 'el asar trae node_modules');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

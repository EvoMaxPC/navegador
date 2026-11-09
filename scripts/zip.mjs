/**
 * Escritor de ZIP mínimo y determinista, sin dependencias.
 *
 * Se usa para armar la distribución descargable: `zip` no existe en Windows y
 * no queremos que empaquetar dependa de herramientas externas.
 *
 * Soporta lo que necesita una distribución de Electron: archivos y carpetas,
 * deflate o almacenamiento directo, y rutas con `/`. No soporta ZIP64, así que
 * corta con un error claro por encima de 4 GB.
 */

import { deflateRawSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { open } from 'node:fs/promises';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fecha de modificación en formato MS-DOS. */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const MAX = 0xffffffff;

/** Lista recursiva de archivos, con rutas relativas en formato ZIP. */
async function walk(root) {
  const files = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(root);
  return files;
}

/**
 * Comprime un directorio en un ZIP.
 *
 * @param {string} sourceDir  Directorio a comprimir.
 * @param {string} zipPath    Archivo de salida.
 * @param {{ root?: string, level?: number, onProgress?: (n: number, total: number) => void }} [options]
 * @returns {Promise<{ files: number, bytes: number }>}
 */
export async function zipDirectory(sourceDir, zipPath, options = {}) {
  const { root = sourceDir, level = 9, onProgress } = options;
  const files = await walk(sourceDir);

  const handle = await open(zipPath, 'w');
  const central = [];
  let offset = 0;

  try {
    for (const [index, file] of files.entries()) {
      const info = await stat(file);
      const data = await readFile(file);
      const name = relative(root, file).split(sep).join('/');
      const compressed = info.size > 512 ? deflateRawSync(data, { level }) : data;
      const stored = compressed.length >= data.length || info.size <= 512;
      const body = stored ? data : compressed;
      const method = stored ? 0 : 8;
      const { time, day } = dosDateTime(info.mtime);
      const nameBytes = Buffer.from(name, 'utf8');
      const crc = crc32(data);

      if (offset + body.length > MAX) throw new Error('la distribución supera 4 GB (sin ZIP64)');
      const localOffset = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // versión necesaria
      local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      local.writeUInt16LE(0, 28);

      await handle.write(local, 0, 30, offset);
      await handle.write(nameBytes, 0, nameBytes.length, offset + 30);
      if (body.length) await handle.write(body, 0, body.length, offset + 30 + nameBytes.length);
      offset += 30 + nameBytes.length + body.length;

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4); // versión con la que se creó
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(method, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(day, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(nameBytes.length, 28);
      entry.writeUInt16LE(0, 30); // extra
      entry.writeUInt16LE(0, 32); // comentario
      entry.writeUInt16LE(0, 34); // disco
      entry.writeUInt16LE(0, 36); // atributos internos
      entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // atributos externos: -rw-r--r--
      entry.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([entry, nameBytes]));

      onProgress?.(index + 1, files.length);
    }

    const directory = Buffer.concat(central);
    await handle.write(directory, 0, directory.length, offset);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    await handle.write(end, 0, 22, offset + directory.length);

    return { files: files.length, bytes: offset + directory.length + 22 };
  } finally {
    await handle.close();
  }
}

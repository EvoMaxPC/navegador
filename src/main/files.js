/**
 * Persistencia en disco para los datos del navegador.
 *
 * Escritura atómica (temporal + renombrado) porque un navegador se cierra de
 * golpe: si el archivo quedara a medias, el usuario perdería el historial justo
 * el día que más lo necesita.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Almacenamiento `{read, write}` sobre un archivo.
 * @param {string} file
 */
export function fileStorage(file) {
  let last = null;
  return {
    file,
    read() {
      try {
        if (!existsSync(file)) return null;
        last = readFileSync(file, 'utf8');
        return last;
      } catch {
        return null;
      }
    },
    write(data) {
      if (data === last) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, data, 'utf8');
        renameSync(tmp, file);
        last = data;
      } catch (error) {
        console.error('[nexo] no se pudo escribir', file, error.message);
      }
    },
    get path() {
      return file;
    },
  };
}

/**
 * Almacenamiento dentro de un directorio con un nombre fijo.
 * @param {string} dir
 * @param {string} name
 */
export function jsonStorage(dir, name) {
  return fileStorage(join(dir, name));
}

/** Almacenamiento en memoria: pruebas y entornos sin disco. */
export function memoryStorage(initial = null) {
  let data = initial;
  return {
    reads: 0,
    writes: 0,
    read() {
      this.reads += 1;
      return data;
    },
    write(next) {
      this.writes += 1;
      data = next;
    },
    get value() {
      return data;
    },
  };
}

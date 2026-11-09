/**
 * EVO MEMORY en el proceso principal: el motor con su almacenamiento real.
 *
 * La memoria vive en un archivo JSON dentro del directorio del perfil, junto a
 * los ajustes. Se escribe de forma atómica (archivo temporal + renombrado) para
 * que un cierre inesperado no deje el expediente a medias.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { EvoMemory } from '../memory/engine.js';

/**
 * Envoltorio de almacenamiento sobre un archivo del sistema.
 * @param {string} file
 */
export function fileStorage(file) {
  let lastSerialized = null;
  return {
    file,
    read() {
      try {
        if (!existsSync(file)) return null;
        lastSerialized = readFileSync(file, 'utf8');
        return lastSerialized;
      } catch {
        return null;
      }
    },
    write(data) {
      if (data === lastSerialized) return;
      const tmp = `${file}.tmp`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, data, 'utf8');
      renameSync(tmp, file);
      lastSerialized = data;
    },
  };
}

/**
 * Crea el motor EVO MEMORY listo para el proceso principal.
 *
 * @param {{
 *   dir: string, projectId?: string, projectName?: string,
 *   maxItems?: number, episodeEvery?: number, now?: () => number
 * }} opts
 */
export function createMemory(opts) {
  const dir = opts.dir;
  const projectId = opts.projectId || 'default';
  const file = join(dir, `evo-memory-${slug(projectId)}.json`);
  const storage = fileStorage(file);
  const memory = new EvoMemory({
    storage,
    projectId,
    projectName: opts.projectName || null,
    maxItems: opts.maxItems,
    episodeEvery: opts.episodeEvery,
    now: opts.now,
  });
  return { memory, file };
}

function slug(value) {
  return String(value || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

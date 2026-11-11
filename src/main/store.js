/** Persistencia local del perfil: ajustes e historial de intervenciones. */
import { app } from 'electron';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings } from '../core/settings.js';

export class Store {
  /** @param {{file?: string, maxLog?: number, fs?: object, onLogError?: Function}} [opts] */
  constructor(opts = {}) {
    this.file = opts.file || join(app.getPath('userData'), 'nexo-profile.json');
    this.maxLog = opts.maxLog ?? 400;
    this.fs = opts.fs || fs;
    this.onLogError = opts.onLogError || null;
    this.lastError = null;
    this.data = { settings: structuredClone(DEFAULT_SETTINGS), log: [] };
    this.loadStatus = { state: 'new', backup: null };
    this.loadError = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = this.fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      // EACCES/EIO no significan que el perfil esté vacío. No sobrescribirlo.
      this.loadError = error;
      this.loadStatus = { state: 'unreadable', backup: null };
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          (parsed.settings !== undefined && (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings))) ||
          (parsed.log !== undefined && !Array.isArray(parsed.log))) {
        throw new Error('Estructura de perfil inválida');
      }
      this.data = {
        settings: mergeSettings(DEFAULT_SETTINGS, parsed.settings || {}),
        log: (parsed.log || []).slice(0, this.maxLog),
      };
      this.loadStatus = { state: 'loaded', backup: null };
    } catch (error) {
      // Conservar los BYTES originales, no una reconstrucción del JSON roto.
      // Nombre único + EXCL: otro reinicio nunca pisa una recuperación anterior.
      const backup = `${this.file}.corrupt-${randomUUID()}.bak`;
      try {
        this.fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
        const fd = this.fs.openSync(backup, 'r');
        try { this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
        this.loadStatus = { state: 'recovered', backup };
      } catch (backupError) {
        this.loadError = backupError;
        this.loadStatus = { state: 'recovery-blocked', backup: null };
      }
    }
  }

  /** No publica el nuevo estado RAM hasta que el reemplazo termina con éxito. */
  save(next = this.data) {
    if (this.loadError) {
      throw new Error(`Perfil no guardado: no se pudo leer o preservar el original (${this.loadError.code || this.loadError.message}).`, { cause: this.loadError });
    }
    const encoded = JSON.stringify(next, null, 2);
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      this.fs.mkdirSync(dirname(this.file), { recursive: true });
      fd = this.fs.openSync(tmp, 'wx', 0o600);
      this.fs.writeFileSync(fd, encoded, 'utf8');
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      // Mismo directorio/volumen: nunca truncar el destino para reemplazarlo.
      this.fs.renameSync(tmp, this.file);
    } catch (error) {
      this.lastError = `No se pudo guardar el perfil: ${error.message}`;
      throw new Error(this.lastError, { cause: error });
    } finally {
      if (fd !== undefined) { try { this.fs.closeSync(fd); } catch { /* preservar el error original */ } }
      try { this.fs.unlinkSync(tmp); } catch { /* ya renombrado o no creado */ }
    }
    this.data = next;
    this.lastError = null;
    return true;
  }

  get settings() { return this.data.settings; }

  setSettings(patch) {
    this.save({ ...this.data, settings: mergeSettings(this.data.settings, patch) });
    return this.data.settings;
  }

  /** Restablecer reemplaza, no fusiona con las excepciones anteriores. */
  replaceSettings(next) {
    this.save({ ...this.data, settings: mergeSettings(DEFAULT_SETTINGS, next || {}) });
    return this.data.settings;
  }

  pushLog(entry) {
    try {
      this.save({ ...this.data, log: [entry, ...this.data.log].slice(0, this.maxLog) });
      return entry;
    } catch (error) {
      if (!this.onLogError) throw error;
      // La captura de red no debe derribar el navegador por un disco lleno.
      // El llamador de fondo recibe null y el aviso llega por una ruta sin log.
      this.onLogError(error);
      return null;
    }
  }

  get log() { return this.data.log; }

  clearLog() {
    this.save({ ...this.data, log: [] });
  }
}

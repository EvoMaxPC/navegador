/**
 * Persistencia local del perfil: ajustes e historial de intervenciones.
 *
 * Nada sale de esta máquina. El archivo vive en el directorio de usuario que
 * Chromium asigna a la aplicación.
 */

import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings } from '../core/settings.js';

export class Store {
  /** @param {{file?: string, maxLog?: number}} [opts] */
  constructor(opts = {}) {
    this.file = opts.file || join(app.getPath('userData'), 'nexo-profile.json');
    this.maxLog = opts.maxLog ?? 400;
    this.data = { settings: structuredClone(DEFAULT_SETTINGS), log: [] };
    this.load();
  }

  load() {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data.settings = mergeSettings(DEFAULT_SETTINGS, parsed.settings || {});
      this.data.log = Array.isArray(parsed.log) ? parsed.log.slice(0, this.maxLog) : [];
    } catch {
      // Primer arranque o archivo corrupto: se usan los valores por defecto.
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      console.error('[nexo] no se pudo guardar el perfil:', error.message);
    }
  }

  get settings() {
    return this.data.settings;
  }

  setSettings(patch) {
    this.data.settings = mergeSettings(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  /**
   * Reemplaza los ajustes por completo.
   *
   * `setSettings()` fusiona, que es lo correcto para un cambio puntual y lo
   * incorrecto para «restablecer»: al fusionar, un sitio apagado seguía apagado
   * después de restablecer, sin ningún aviso, y ese sitio no cuenta nada.
   */
  replaceSettings(next) {
    this.data.settings = mergeSettings(DEFAULT_SETTINGS, next || {});
    this.save();
    return this.data.settings;
  }

  pushLog(entry) {
    this.data.log.unshift(entry);
    if (this.data.log.length > this.maxLog) this.data.log.length = this.maxLog;
    this.save();
    return entry;
  }

  get log() {
    return this.data.log;
  }

  clearLog() {
    this.data.log = [];
    this.save();
  }
}

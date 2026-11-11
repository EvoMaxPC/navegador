/**
 * Atajos de conversación persistidos en el perfil local.
 *
 * Reutiliza la atomicidad de `Store` (temporal + fsync + rename) y nunca
 * publica un estado en RAM si el disco falló. El texto de un atajo no sale de
 * este proceso: no se manda a la página hasta que la persona lo inserta.
 */
import { randomUUID } from 'node:crypto';
import {
  MAX_PROMPTS,
  PROMPT_VARIABLES,
  fillPrompt,
  isPromptId,
  sanitizePrompts,
  validatePrompt,
} from '../core/prompts.js';

export class PromptStore {
  constructor({ store, now = Date.now, id = () => `p-${randomUUID().slice(0, 8)}` }) {
    this.store = store;
    this.now = now;
    this.newId = id;
  }
  get list() {
    return sanitizePrompts(this.store.settings?.prompts?.items);
  }
  #save(items) {
    const next = this.store.setSettings({ prompts: { items } });
    return { ok: true, items: sanitizePrompts(next.prompts?.items), max: MAX_PROMPTS, variables: PROMPT_VARIABLES };
  }
  save(payload = {}) {
    const valid = validatePrompt(payload);
    if (!valid.ok) return { ok: false, error: valid.error };
    const items = this.list;
    const id = isPromptId(payload.id) ? payload.id : this.newId();
    const existing = items.findIndex((item) => item.id === id);
    const row = { id, ...valid.value, updatedAt: this.now() };
    if (existing >= 0) items[existing] = row;
    else {
      if (items.length >= MAX_PROMPTS) return { ok: false, error: `Máximo ${MAX_PROMPTS} atajos.` };
      items.push(row);
    }
    return this.#save(items);
  }
  remove(id) {
    if (!isPromptId(id)) return { ok: false, error: 'Identificador inválido.' };
    const items = this.list;
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return { ok: false, error: 'El atajo ya no existe.' };
    return this.#save(next);
  }
  reorder(ids = []) {
    if (!Array.isArray(ids) || ids.some((id) => !isPromptId(id)) || new Set(ids).size !== ids.length)
      return { ok: false, error: 'Orden inválido.' };
    const items = this.list;
    if (ids.length !== items.length || ids.some((id) => !items.some((item) => item.id === id)))
      return { ok: false, error: 'El orden no coincide con los atajos guardados.' };
    return this.#save(ids.map((id) => items.find((item) => item.id === id)));
  }
  /**
   * Texto listo para insertar, con las variables que la interfaz pudo resolver.
   * Devuelve también lo que falta: nunca inventa valores ni deja huecos mudos.
   */
  render(id, values = {}) {
    if (!isPromptId(id)) return { ok: false, error: 'Identificador inválido.' };
    const item = this.list.find((row) => row.id === id);
    if (!item) return { ok: false, error: 'El atajo ya no existe.' };
    const safe = {};
    for (const name of PROMPT_VARIABLES) {
      const value = values?.[name];
      if (typeof value === 'string') safe[name] = value.slice(0, 20000);
    }
    const filled = fillPrompt(item.text, safe);
    return { ok: true, title: item.title, ...filled };
  }
}

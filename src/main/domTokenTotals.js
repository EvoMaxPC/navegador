import { calculateTokenizer, tokenizerModels } from './tokenizerCalculator.js';

/** Suma del texto literal del DOM con EXACTAMENTE la calculadora manual.
 * Los IDs separan mensajes: repetir un texto no lo deduplica. Un parcial con
 * el mismo ID reemplaza su aporte (no vuelve a sumarse entero).
 * RAM de sesión, por proyecto. Nunca modifica la memoria conversacional.
 */
export class DomTokenTotals {
  constructor() {
    this.projects = new Map();
    this.maxChars = 4_000_000;
    this.maxRecords = 10_000;
  }
  navigate(webContentsId, href) {
    // Un nuevo chat anónimo no puede reutilizar los IDs posicionales del anterior.
    const named = /^\/c\/[^/]+/.test(new URL(href).pathname);
    for (const project of this.projects.values()) {
      if (!named) project.tabs.delete(webContentsId);
    }
  }
  dropTab(webContentsId) {
    for (const project of this.projects.values()) project.tabs.delete(webContentsId);
  }
  project(id = 'default') {
    if (!this.projects.has(id)) this.projects.set(id, { records: new Map(), chars: 0, ready: false, partial: false, model: null, sources: new Map(), tabs: new Map(), generation: 0 });
    return this.projects.get(id);
  }
  observe({ projectId = 'default', webContentsId, href, turns = [], clipped = false, source = 'isolated' }, model = tokenizerModels().defaultModel) {
    const project = this.project(projectId);
    if (!turns.length) {
      const changed = !project.ready || (clipped && !project.partial);
      project.ready = true;
      if (clipped) project.partial = true;
      this.useModel(project, model);
      return changed;
    }
    const url = new URL(href);
    const named = /^\/c\/[^/]+/.test(url.pathname);
    const previousTab = project.tabs.get(webContentsId);
    const conversation = named ? url.origin + url.pathname : previousTab?.anonymous && previousTab.path === url.origin + url.pathname
      ? previousTab.conversation : `${url.origin}${url.pathname}#tab-${webContentsId}-${++project.generation}`;
    let changed = !project.ready;
    // El primer envío puede empezar en / y adquirir /c/id al guardarse.
    // Mover las identidades ya leídas, no sumar una copia de esos mensajes.
    const sharesIdentity = previousTab?.anonymous && turns.some(turn =>
      project.records.has(`${previousTab.conversation}\0${turn.role}\0${turn.id}`));
    if (named && sharesIdentity) {
      for (const [key, record] of [...project.records]) {
        if (record.conversation !== previousTab.conversation) continue;
        project.records.delete(key);
        const nextKey = `${conversation}\0${record.role}\0${record.id}`;
        const collision = project.records.get(nextKey);
        if (collision) project.chars -= collision.text.length;
        project.records.set(nextKey, { ...record, conversation });
      }
      project.sources.set(conversation, project.sources.get(previousTab.conversation));
      project.sources.delete(previousTab.conversation);
      changed = true;
    }
    project.tabs.set(webContentsId, { anonymous: !named, conversation, path: url.origin + url.pathname });
    if (project.sources.has(conversation) && project.sources.get(conversation) !== source) {
      // Las estrategias pueden asignar IDs diferentes al mismo DOM. Al pasar
      // del respaldo al lector aislado sustituir el documento, no duplicarlo.
      let removed = 0;
      for (const [key, record] of [...project.records]) if (record.conversation === conversation) {
        project.chars -= record.text.length; project.records.delete(key); removed++;
      }
      if (removed > turns.length) project.partial = true;
      changed = true;
    }
    project.sources.set(conversation, source);
    project.ready = true;
    if (clipped && !project.partial) { project.partial = true; changed = true; }
    for (const turn of turns) {
      const key = `${conversation}\0${turn.role}\0${turn.id}`;
      const previous = project.records.get(key);
      if (previous?.text === turn.content) continue;
      const chars = project.chars - (previous?.text.length || 0) + turn.content.length;
      if (chars > this.maxChars || (!previous && project.records.size >= this.maxRecords)) { project.partial = true; changed = true; continue; }
      const result = calculateTokenizer({ text: turn.content, model });
      if (!result.ok) { project.partial = true; changed = true; continue; }
      project.chars = chars;
      project.records.set(key, { id: turn.id, conversation, role: turn.role, text: turn.content, tokens: result.tokens });
      if (turn.clipped) project.partial = true;
      changed = true;
    }
    // Cambiar de referencia recalcula también el texto ya acumulado.
    this.useModel(project, model);
    return changed;
  }
  useModel(project, model) {
    if (project.model === model) return;
    const check = calculateTokenizer({ text: '', model });
    if (!check.ok) throw new Error(check.error);
    for (const record of project.records.values()) {
      const result = calculateTokenizer({ text: record.text, model });
      if (!result.ok) throw new Error(result.error);
      record.tokens = result.tokens;
    }
    project.model = model;
    project.encoding = check.encoding;
  }
  stats(projectId = 'default', model = tokenizerModels().defaultModel) {
    const project = this.project(projectId);
    this.useModel(project, model);
    let inputTokens = 0, outputTokens = 0, userMessages = 0, assistantMessages = 0;
    for (const record of project.records.values()) {
      if (record.role === 'user') { inputTokens += record.tokens; userMessages++; }
      else { outputTokens += record.tokens; assistantMessages++; }
    }
    return { inputTokens, outputTokens, userMessages, assistantMessages, ready: project.ready,
      partial: project.partial, model: project.model, encoding: project.encoding,
      method: 'dom-manual-tokenizer', scope: 'session-project-rendered-text', projectId };
  }
  /** Cuántas claves (`conversation\0role\0id`) hay guardadas: sólo número. */
  records(projectId = 'default') {
    return this.project(projectId).records.size;
  }
  /**
   * Claves que el acumulador usa para los turnos de un snapshot, en el mismo
   * orden en que las calcula `observe`. Sólo lectura y sólo para diagnóstico:
   * permite ver si el `id` cambia entre lecturas sin tocar los contadores.
   */
  keysFor({ projectId = 'default', webContentsId, href, turns = [] } = {}) {
    const project = this.project(projectId);
    const url = new URL(href);
    const named = /^\/c\/[^/]+/.test(url.pathname);
    const previousTab = project.tabs.get(webContentsId);
    const conversation = named ? url.origin + url.pathname : previousTab?.anonymous && previousTab.path === url.origin + url.pathname
      ? previousTab.conversation : `${url.origin}${url.pathname}#tab-${webContentsId}-${project.generation + 1}`;
    return turns.map((turn) => ({ role: turn.role, id: turn.id,
      chars: String(turn.content ?? '').length, clave: `${conversation}\u0000${turn.role}\u0000${turn.id}` }));
  }
}

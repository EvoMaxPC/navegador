import { calculateTokenizer, tokenizerModels } from './tokenizerCalculator.js';

/**
 * Huella de un turno: rol + longitud + resumen del texto.
 *
 * Sirve para reconocer «este turno ya estaba en pantalla en la conversación
 * anterior» aunque el sitio le haya cambiado el `id`. **Nunca se publica ni se
 * registra**: se queda en memoria y sólo se compara (ver `huerfana`).
 *
 * El resumen es una mezcla de 32 bits con dos semillas distintas: dos textos
 * distintos de la misma longitud casi nunca coinciden, y el coste es lineal.
 */
function huellaDe(role, content) {
  const texto = String(content ?? '');
  let a = 0x811c9dc5 | 0;
  let b = 0x1000193 | 0;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) | 0;
    b = Math.imul(b + c, 0x85ebca6b) | 0;
  }
  return `${role}:${texto.length}:${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/**
 * Ruta provisional: `/c/local-chatgpt:<uuid>`.
 *
 * ChatGPT abre el chat con esa identidad mientras la URL real no existe y
 * después la cambia a `/c/<id real>` **sin recargar**: los turnos siguen en
 * pantalla y son los mismos. Para el contador no es «otro chat», así que se
 * trata como la anónima: identidad provisional, migrable a la real.
 *
 * El prefijo se acepta codificado (`%3A`) o con los dos puntos literales, porque
 * es lo que puede entregar Chromium. Medido una sola vez, en un chat: si el
 * sitio dejara de usarlo, la ruta simplemente vuelve a ser un id normal.
 */
const PROVISIONAL_RE = /^\/c\/local-chatgpt(%3A|:)/i;
/** ¿La conversación tiene identidad provisional? (nunca la anónima `#tab-`) */
const esProvisional = (conversation) => PROVISIONAL_RE.test(new URL(conversation, 'https://x').pathname);

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
    const url = new URL(href);
    const named = /^\/c\/[^/]+/.test(url.pathname);
    if (named) return;
    const siguiente = url.origin + url.pathname;
    for (const project of this.projects.values()) {
      const tab = project.tabs.get(webContentsId);
      // `did-start-navigation` (main.js:677) llega ANTES de la lectura. Si sólo
      // se borra la entrada, se pierde lo que se sabía de la pantalla anterior y
      // el chat nuevo vuelve a sumar los turnos viejos que siguen visibles
      // (medido: 4 → 8 registros). Se conservan sus huellas para ignorarlos,
      // pero se invalida la identidad anónima: mismo `href` ⇒ ids posicionales
      // reutilizables (régimen del test de «volver a nuevo chat anónimo»).
      if (tab && tab.path !== siguiente) {
        project.tabs.set(webContentsId, { anonymous: false, conversation: tab.conversation,
          path: siguiente, heredadas: new Set(tab.heredadas || []), huellas: new Set() });
        continue;
      }
      project.tabs.delete(webContentsId);
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
      // Chat nuevo todavía vacío: la pantalla ya no es la conversación anterior,
      // así que sus totales no deben seguir viéndose. No se toca `tabs`: una
      // lectura vacía transitoria NO cambia la identidad de acumulación (es el
      // régimen de «/ a /c/id», que migra al llegar el texto). Sólo se mueve el
      // puntero de la conversación activa, y únicamente hacia una URL anónima.
      const url = new URL(href);
      if (!/^\/c\/[^/]+/.test(url.pathname) && project.activaPath !== url.pathname) {
        project.activa = `${url.origin}${url.pathname}#tab-${webContentsId}-${++project.generation}`;
        project.activaPath = url.pathname;
        project.ultima = { conversacion: project.activa, ruta: url.pathname, obsoletos: 0, migrados: 0 };
      }
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
    // Huellas de esta lectura, para reconocer lo que ya estaba en pantalla.
    const huellas = new Map(turns.map((turn) => [huellaDe(turn.role, turn.content), turn]));
    // El primer envío puede empezar en / y adquirir /c/id al guardarse.
    // Mover las identidades ya leídas, no sumar una copia de esos mensajes.
    //
    // Caso 1: la identidad anterior NO era el nombre del chat y pasar a
    // `/c/<id real>` es el mismo chat guardándose. Dos orígenes:
    //  - `anonima`: la `/` de esta pestaña. Se reconoce por `id` (lo de siempre)
    //    o por huella, que cubre el sitio renumerando los ids (visible-1 → visible-2).
    //  - `provisional`: `/c/local-chatgpt:<uuid>` → `/c/<id real>`, sin recargar.
    //    Sólo esa transición: provisional → provisional, o provisional → otra
    //    ruta anónima, no migran.
    const migrationOrigin = (previousTab?.anonymous ? 'anonima'
      : named && esProvisional(previousTab?.conversation ?? '') ? 'provisional' : null);
    const migraDesde = Boolean(migrationOrigin) && previousTab.conversation !== conversation &&
      turns.some((turn) => project.records.has(`${previousTab.conversation}\0${turn.role}\0${turn.id}`) ||
        (previousTab.huellas?.has(huellaDe(turn.role, turn.content)) ?? false))
      ? previousTab.conversation : null;
    let migrados = 0;
    const migradasClaves = [];
    if (migraDesde) {
      for (const [key, record] of [...project.records]) {
        if (record.conversation !== migraDesde) continue;
        project.records.delete(key);
        // El sitio renumera los ids al guardar el chat: se adopta el que muestra
        // ESTA lectura (`visible-1` → `visible-2`) para que la siguiente lo
        // reconozca directo y no lo sume otra vez.
        const id = huellas.get(huellaDe(record.role, record.text))?.id ?? record.id;
        const nextKey = `${conversation}\0${record.role}\0${id}`;
        const collision = project.records.get(nextKey);
        if (collision) project.chars -= collision.text.length;
        project.records.set(nextKey, { ...record, id, conversation });
        migradasClaves.push(nextKey);
        migrados += 1;
      }
      project.sources.set(conversation, project.sources.get(migraDesde));
      project.sources.delete(migraDesde);
      changed = true;
    }
    const sharesIdentity = Boolean(migraDesde);
    // Sólo los registros MIGRADOS en esta misma lectura pueden reutilizar su
    // clave por huella. Es la transición del Caso 1, donde el sitio renumera los
    // ids al guardar el chat. Fuera de ella se mantiene la regla de siempre:
    // texto idéntico con otro ID es otro mensaje.
    const huellasPrevias = new Map();
    for (const key of migradasClaves) {
      const record = project.records.get(key);
      if (record) huellasPrevias.set(huellaDe(record.role, record.text), record);
    }
    let identidadReusada = false;
    const claveDe = (turn) => {
      const directa = `${conversation}\0${turn.role}\0${turn.id}`;
      if (project.records.has(directa)) return directa;
      const igual = huellasPrevias.get(huellaDe(turn.role, turn.content));
      if (!igual) return directa;
      identidadReusada = true;
      return `${conversation}\0${igual.role}\0${igual.id}`;
    };
    // Caso 2: la conversación cambió y el DOM todavía muestra turnos de la
    // anterior. Se reconocen por huella y se ignoran. El conjunto heredado se
    // mantiene mientras alguna lectura siga trayendo alguna de sus huellas, y se
    // descarta en cuanto una lectura no trae ninguna (ya no hay nada viejo en
    // pantalla que confundir).
    const heredadas = previousTab?.heredadas;
    const aplicaHeredadas = Boolean(heredadas?.size) && (previousTab.anonymous || previousTab.conversation !== conversation) &&
      !(named && sharesIdentity);
    let obsoletos = 0;
    let heredadasNuevas = aplicaHeredadas ? new Set(heredadas) : new Set();
    if (aplicaHeredadas) {
      for (const huella of huellas.keys()) if (heredadas.has(huella)) obsoletos += 1;
      if (!obsoletos) heredadasNuevas = new Set();
    }
    // Turnos que se cuentan de verdad: ni heredados de la conversación anterior
    // ni los que ya estaban registrados bajo esa misma huella y conversación.
    const aceptados = [];
    for (const [huella, turn] of huellas) {
      if (aplicaHeredadas && heredadas.has(huella)) continue;
      aceptados.push(turn);
    }
    for (const turn of turns) heredadasNuevas.add(huellaDe(turn.role, turn.content));
    project.tabs.set(webContentsId, { anonymous: !named, conversation, path: url.origin + url.pathname,
      heredadas: heredadasNuevas, huellas: new Set([...huellas.keys()]) });
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
    for (const turn of aceptados) {
      const key = claveDe(turn);
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
    // Diagnóstico: qué conversación quedó activa y qué se descartó. Sólo cuenta
    // y ruta; el llamador decide si lo publica (main.js lo hace bajo NEXO_DIAG).
    project.activa = conversation;
    // Sólo la ruta: `origin` no aporta y la URL completa puede llevar query.
    project.activaPath = url.pathname;
    project.ultima = { conversacion: conversation, ruta: url.pathname, obsoletos, migrados };
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
  /**
   * Totales del proyecto. Con `soloActiva` cuenta únicamente los registros de
   * la conversación de la última lectura aceptada (`project.activa`), sin
   * borrar los de las demás: al volver a `/c/A` reaparecen sus totales.
   *
   * El valor por defecto sigue siendo acumulativo a propósito: es la serie
   * histórica del proyecto y la que consumen los llamadores que no piden
   * «activa». `statsSnapshot()` sí pide `soloActiva`.
   */
  stats(projectId = 'default', model = tokenizerModels().defaultModel, { soloActiva = false } = {}) {
    const project = this.project(projectId);
    this.useModel(project, model);
    let inputTokens = 0, outputTokens = 0, userMessages = 0, assistantMessages = 0;
    for (const record of project.records.values()) {
      if (soloActiva && project.activa && record.conversation !== project.activa) continue;
      if (record.role === 'user') { inputTokens += record.tokens; userMessages++; }
      else { outputTokens += record.tokens; assistantMessages++; }
    }
    return { inputTokens, outputTokens, userMessages, assistantMessages, ready: project.ready,
      partial: project.partial, model: project.model, encoding: project.encoding,
      method: 'dom-manual-tokenizer', scope: 'session-project-rendered-text', projectId };
  }
  /**
   * Lo que `diag-contadores` puede publicar de la última lectura: la ruta de la
   * conversación activa (sólo `pathname`), cuántos turnos se ignoraron por
   * heredados y cuántos registros se migraron. Nunca ids, texto ni huellas.
   */
  resumenActivo(projectId = 'default') {
    const project = this.project(projectId);
    // La ruta provisional lleva el uuid dentro del pathname: se publica la ruta
    // enmascarada, nunca el identificador. El resto de rutas, tal cual.
    const ruta = project.activaPath == null ? null
      : PROVISIONAL_RE.test(project.activaPath) ? '/c/<provisional>' : project.activaPath;
    return { ruta,
      obsoletos: project.ultima?.obsoletos ?? 0, migrados: project.ultima?.migrados ?? 0 };
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

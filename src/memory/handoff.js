/**
 * EVO MEMORY · Paquete de continuidad
 *
 * El problema que resuelve: cambiaste de modelo (o de proyecto, o de semana) y
 * tenés que empezar de cero. El paquete es un bloque autocontenido —texto plano
 * y JSON— con el estado del proyecto, listo para pegar en cualquier chat, sin
 * que ese chat sepa nada de EVO.
 *
 * Es la parte del sistema que no depende del navegador: se puede copiar a mano.
 */

import { KIND_META, salienceOf } from './item.js';

const SECTIONS = [
  { kind: 'goal', title: 'Objetivo' },
  { kind: 'decision', title: 'Decisiones tomadas' },
  { kind: 'constraint', title: 'Restricciones y límites' },
  { kind: 'preference', title: 'Preferencias de trabajo' },
  { kind: 'task', title: 'Pendientes' },
  { kind: 'issue', title: 'Problemas abiertos' },
  { kind: 'fact', title: 'Datos y valores' },
  { kind: 'artifact', title: 'Artefactos y comandos' },
  { kind: 'question', title: 'Preguntas abiertas' },
];

/**
 * Construye el paquete de continuidad de un proyecto.
 *
 * @param {{
 *   store: import('./store.js').MemoryStore,
 *   projectId?: string,
 *   projectName?: string|null,
 *   maxPerSection?: number,
 *   now?: number,
 *   language?: 'es'|'en'
 * }} input
 */
export function buildHandoff(input) {
  const {
    store,
    projectId = 'default',
    projectName = null,
    maxPerSection = 12,
    now = Date.now(),
    language = 'es',
  } = input;

  const items = store.all({ projectId, includeSuperseded: false });
  const sections = {};

  for (const { kind } of SECTIONS) {
    sections[kind] = items
      .filter((item) => item.kind === kind)
      .sort((a, b) => salienceOf(b, now) - salienceOf(a, now) || b.updatedAt - a.updatedAt)
      .slice(0, maxPerSection);
  }

  const packet = {
    version: 1,
    generator: 'EVO MEMORY',
    projectId,
    projectName,
    generatedAt: now,
    sections: Object.fromEntries(
      Object.entries(sections).map(([kind, list]) => [
        kind,
        list.map((item) => ({
          id: item.id,
          text: item.text,
          anchors: item.anchors,
          createdAt: item.createdAt,
          pinned: item.pinned,
        })),
      ]),
    ),
    counts: Object.fromEntries(Object.entries(sections).map(([kind, list]) => [kind, list.length])),
  };

  packet.markdown = handoffToMarkdown(packet, language);
  return packet;
}

/** Render en texto plano para pegar en cualquier modelo. */
export function handoffToMarkdown(packet, language = 'es') {
  const en = language === 'en';
  const title = packet.projectName || packet.projectId;
  const lines = [];

  lines.push(en ? `[EVO MEMORY · continuity packet · ${title}]` : `[EVO MEMORY · paquete de continuidad · ${title}]`);
  lines.push(
    en
      ? 'This block is the verified state of the project so far. Use it as ground truth; do not ask again for what is here.'
      : 'Este bloque es el estado verificado del proyecto. Tomalo como verdad de referencia y no vuelvas a preguntar lo que ya está acá.',
  );
  lines.push('');

  for (const { kind, title: sectionTitle } of SECTIONS) {
    const list = packet.sections[kind] || [];
    if (!list.length) continue;
    lines.push(`## ${sectionTitle}`);
    for (const entry of list) {
      lines.push(`- ${entry.text}`);
    }
    lines.push('');
  }

  const date = new Date(packet.generatedAt).toISOString().slice(0, 16).replace('T', ' ');
  lines.push(en ? `_Generated ${date} · ${packet.generator}_` : `_Generado ${date} · ${packet.generator}_`);
  return lines.join('\n');
}

/**
 * Prefijos que un paquete pegado a mano puede traer como `kind`, ya sin
 * minúsculas ni acentos, en el orden en que se prueban.
 *
 * El panel arma `{ markdown, items }` (`src/ui/shell/app.js:1209`) y su parser
 * copia el `kind` del encabezado (`:1231`): un paquete de la interfaz llega con
 * `items`, no con `sections`, y con encabezados que no siempre son los de este
 * archivo. Sin este puente, importar desde el panel no añadía nada.
 */
const PREFIJOS_DE_KIND = [
  ['decision', 'decision'], ['tarea', 'task'], ['pendiente', 'task'],
  ['restriccion', 'constraint'], ['preferencia', 'preference'],
  ['objetivo', 'goal'], ['meta', 'goal'], ['problema', 'issue'],
  ['issue', 'issue'], ['pregunta', 'question'], ['artefacto', 'artifact'],
];

/** `kind` normalizado: minúsculas, sin acentos y sin los espacios de los bordes. */
function kindNormalizado(valor) {
  return String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Un `kind` válido pasa tal cual; si no, se busca por prefijo. Lo desconocido y
 * lo que no trae encabezado se guarda como `fact`.
 * @param {unknown} valor `kind` declarado en el item
 */
export function kindDeItem(valor) {
  const kind = kindNormalizado(valor);
  if (KIND_META[kind]) return kind;
  const encontrado = PREFIJOS_DE_KIND.find(([prefijo]) => kind.startsWith(prefijo));
  return encontrado ? encontrado[1] : 'fact';
}

/**
 * Agrupa `items` por kind. Los items sin texto se ignoran: no son una memoria.
 * @param {unknown} items
 */
function sectionsDesdeItems(items) {
  const sections = {};
  for (const item of Array.isArray(items) ? items : []) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!text) continue;
    const kind = kindDeItem(item?.kind);
    (sections[kind] ||= []).push({ text, pinned: Boolean(item?.pinned) });
  }
  return sections;
}

/**
 * Reimporta un paquete (por ejemplo el que pegaste desde otro equipo o modelo).
 * @returns {{added: number, merged: number, superseded: number}}
 */
export function importHandoff(store, packet, { projectId = null } = {}) {
  const result = { added: 0, merged: 0, superseded: 0, ignored: 0 };
  if (!packet) return result;
  // La UI manda `{ markdown, items }`. Un paquete con `sections` sigue el camino
  // de siempre, sin tocarse.
  const sections = packet.sections || sectionsDesdeItems(packet.items);
  if (!sections) return result;

  for (const [kind, list] of Object.entries(sections)) {
    if (!KIND_META[kind]) continue;
    for (const entry of list) {
      if (!entry?.text) continue;
      const outcome = store.add({
        kind,
        text: entry.text,
        projectId: projectId || packet.projectId || 'default',
        confidence: 0.75,
        pinned: Boolean(entry.pinned),
      });
      if (outcome.action === 'created') result.added += 1;
      else if (outcome.action === 'merged') result.merged += 1;
      else if (outcome.action === 'superseded') result.superseded += 1;
      // Un registro cifrado no entra: se informa cuántos quedaron fuera para
      // que no parezca que el paquete se importó completo.
      else if (outcome.action === 'ignored') result.ignored += 1;
    }
  }
  return result;
}

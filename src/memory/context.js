/**
 * EVO MEMORY · Compilador de contexto
 *
 * Convierte «historial + memoria + pregunta» en el bloque de contexto que
 * realmente se envía, bajo un presupuesto de tokens explícito.
 *
 * El contexto no es una lista plana: es una jerarquía con presupuestos por capa.
 * Si el historial reciente ocupa poco, su presupuesto se redistribuye a memoria
 * recuperada; si ocupa mucho, el tramo viejo se comprime por niveles en lugar de
 * desaparecer. Nada se descarta sin dejar rastro.
 *
 *   ┌ capa ─────────── presupuesto ────────────────────────────────┐
 *   │ fijado          memorias marcadas por el usuario            │ 12 %
 *   │ proyecto        objetivos, decisiones, restricciones         │ 22 %
 *   │ episodios       resumen de lo ya hablado                     │ 10 %
 *   │ recuperado      memoria relevante para ESTA pregunta         │ 26 %
 *   │ trabajo         los últimos turnos literales                 │ 30 % ⟵ redistribuible
 *   └──────────────────────────────────────────────────────────────┘
 */

import { estimateTokens, excerpt } from '../core/text.js';
import { buildMemoryCard } from '../core/compaction.js';
import { isActive, KIND_META, looksEncrypted, salienceOf } from './item.js';
import { indexTerms, termJaccard } from './lexicon.js';
import { retrieve } from './rank.js';

export const LAYER_CAPS = {
  pinned: 0.12,
  project: 0.22,
  episodes: 0.1,
  retrieved: 0.26,
  working: 0.3,
};

const SECTION_TITLES = {
  goal: 'Objetivos',
  decision: 'Decisiones',
  constraint: 'Restricciones',
  preference: 'Preferencias',
  task: 'Pendientes',
  issue: 'Problemas abiertos',
  fact: 'Datos',
  entity: 'Entidades',
  artifact: 'Artefactos',
  question: 'Preguntas abiertas',
};

const KIND_ORDER = ['goal', 'decision', 'constraint', 'preference', 'task', 'issue', 'fact', 'entity', 'artifact', 'question'];

/**
 * Compila el contexto final.
 *
 * @param {{
 *   store: import('./store.js').MemoryStore,
 *   query: string,
 *   history?: Array<{role: string, content: string}>,
 *   projectId?: string,
 *   projectName?: string,
 *   budgetTokens?: number,
 *   now?: number,
 *   language?: 'es'|'en',
 *   header?: string|null,
 *   caps?: Partial<typeof LAYER_CAPS>
 * }} input
 */
export function compileContext(input) {
  const {
    store,
    query = '',
    history = [],
    projectId = 'default',
    projectName = null,
    budgetTokens = 6000,
    now = Date.now(),
    language = 'es',
    caps = {},
  } = input;

  const C = { ...LAYER_CAPS, ...caps };
  const budget = Math.max(200, Math.round(budgetTokens));
  const layers = {
    pinned: Math.round(budget * C.pinned),
    project: Math.round(budget * C.project),
    episodes: Math.round(budget * C.episodes),
    retrieved: Math.round(budget * C.retrieved),
    working: Math.round(budget * C.working),
  };

  const usedIds = new Set();
  const blocks = [];
  let usedTokens = 0;

  /* ---------------- 1. memoria de trabajo (turnos literales) ---------------- */

  const working = [];
  let workingTokens = 0;
  let foldedIndex = history.length;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    const cost = estimateTokens(`${turn.role}: ${turn.content}`) + 2;
    if (workingTokens + cost > layers.working && working.length >= 2) break;
    working.unshift(turn);
    workingTokens += cost;
    foldedIndex = i;
  }

  /* ---------------- 2. recuperación de memoria ---------------- */

  const workingTerms = indexTerms(working.map((t) => t.content).join(' '));
  const recuperadas = store
    ? retrieve(store, {
        query,
        projectId,
        now,
        limit: 60,
        excludeTerms: workingTerms,
        minScore: 0.05,
      })
    : [];
  // Un registro cifrado no se puede leer ni usar para responder: incluirlo en
  // el contexto gasta tokens en basura y arruina la respuesta. No se borra del
  // expediente; simplemente no viaja.
  const retrieved = recuperadas.filter((entry) => !looksEncrypted(entry.item?.text));

  /* ---------------- 3. presupuestos con redistribución ---------------- */

  // Lo que la memoria de trabajo no usa vuelve al fondo general.
  let spare = Math.max(0, layers.working - workingTokens);

  /* ---------------- 4. capas de memoria ---------------- */

  // Ninguna capa manda texto que no se pueda leer: ni fijado, ni de proyecto, ni
  // episodios. Si un expediente viejo tiene registros cifrados, se quedan ahí y
  // no gastan presupuesto del contexto.
  const legible = (item) => !looksEncrypted(item.text);

  const pinnedItems = store
    ? store.all({ projectId, includeSuperseded: false }).filter((item) => item.pinned && legible(item))
    : [];

  const projectItems = store
    ? store
        .all({ projectId, includeSuperseded: false, kinds: ['goal', 'decision', 'constraint', 'preference'] })
        .filter((item) => !item.pinned && legible(item))
        .sort((a, b) => salienceOf(b, now) - salienceOf(a, now))
    : [];

  const episodeItems = store
    ? store
        .all({ projectId, includeSuperseded: false, kinds: ['episode'] })
        .filter(legible)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];

  // Orden de prioridad: fijado → proyecto → recuperado → episodios.
  // Lo recuperado va ANTES que los episodios: la relevancia para esta pregunta
  // vale más que el relato de lo que ya pasó.
  const pinnedPack = pack(pinnedItems, layers.pinned + spare, usedIds);
  usedTokens += pinnedPack.tokens;
  spare = Math.max(0, layers.pinned + spare - pinnedPack.tokens);

  const projectPack = pack(projectItems, layers.project + spare, usedIds);
  usedTokens += projectPack.tokens;
  spare = Math.max(0, layers.project + spare - projectPack.tokens);

  const retrievedPack = pack(
    retrieved.filter((entry) => !usedIds.has(entry.item.id)).map((entry) => entry.item),
    layers.retrieved + spare,
    usedIds,
  );
  usedTokens += retrievedPack.tokens;
  spare = Math.max(0, layers.retrieved + spare - retrievedPack.tokens);

  // Los episodios solo aportan cuando hay turnos plegados: si el historial entra
  // completo, repetirlos sería pagar dos veces por la misma información.
  const episodeBudget = foldedIndex > 0 ? layers.episodes + spare : 0;
  const episodePack = episodeBudget > 0 ? pack(episodeItems, episodeBudget, usedIds) : { items: [], tokens: 0 };
  usedTokens += episodePack.tokens;
  spare = Math.max(0, episodeBudget - episodePack.tokens);

  /* ---------------- 5. render ---------------- */

  const header = input.header ?? defaultHeader(language, projectName);

  const pinnedBlock = renderItems('pinned', language === 'en' ? 'Pinned' : 'Memoria fija', pinnedPack.items, now, language);
  const projectBlock = renderItems('project', language === 'en' ? 'Project state' : 'Estado del proyecto', projectPack.items, now, language);
  const episodeBlock = renderEpisodes(episodePack.items, language);
  const retrievedBlock = renderItems('retrieved', language === 'en' ? 'Relevant memory' : 'Memoria relevante', retrievedPack.items, now, language);

  for (const block of [pinnedBlock, projectBlock, episodeBlock, retrievedBlock]) {
    if (block) blocks.push(block);
  }

  /* ---------------- 6. compresión de lo plegado ---------------- */

  let foldedBlock = null;
  if (foldedIndex > 0) {
    const folded = history.slice(0, foldedIndex);
    const card = buildMemoryCard(folded, { maxChars: Math.min(1200, Math.max(300, spare * 3.9)) });
    if (card.card) {
      // No se paga dos veces por lo mismo: se quitan del resumen las líneas que
      // ya viajan como memoria del proyecto.
      const renderedTerms = [...usedIds]
        .map((id) => store?.get(id))
        .filter(Boolean)
        .map((item) => item.terms);
      card.card = dropDuplicatedLines(card.card, renderedTerms);
      const text = language === 'en'
        ? `Earlier turns (auto-compressed):\n${card.card}`
        : `Turnos anteriores (comprimidos):\n${card.card}`;
      const tokens = estimateTokens(text);
      if (usedTokens + tokens <= budget) {
        foldedBlock = {
          id: 'folded',
          layer: 'episodes',
          label: language === 'en' ? 'Earlier turns' : 'Turnos anteriores',
          text,
          tokens,
          itemIds: [],
        };
        blocks.push(foldedBlock);
        usedTokens += tokens;
      }
    }
  }

  /* ---------------- 7. ensamblado ---------------- */

  const memoryText = blocks.map((b) => b.text).join('\n\n');
  const payload = memoryText ? `${header}\n${memoryText}\n[/EVO]` : '';

  // Línea base honesta: lo que costaría pegar todo el historial disponible.
  const baselineTokens = history.reduce(
    (acc, turn) => acc + estimateTokens(`${turn.role}: ${turn.content}`) + 2,
    0,
  );
  const usedNow = estimateTokens(payload);

  return {
    blocks,
    header,
    payload,
    memoryIds: [...usedIds],
    working,
    retrieved: retrieved.slice(0, 20).map((entry) => ({
      id: entry.item.id,
      kind: entry.item.kind,
      text: entry.item.text,
      score: entry.score,
      parts: entry.parts,
    })),
    stats: {
      budget,
      used: estimateTokens(payload),
      remaining: Math.max(0, budget - estimateTokens(payload)),
      layerTokens: blocks.reduce((acc, b) => {
        acc[b.layer] = (acc[b.layer] || 0) + b.tokens;
        return acc;
      }, {}),
      retrieved: retrievedPack.items.length,
      candidates: retrieved.length,
      dropped: Math.max(0, retrieved.length - retrievedPack.items.length),
      workingTurns: working.length,
      foldedTurns: foldedIndex,
      baselineTokens,
      savedTokens: Math.max(0, baselineTokens - usedNow),
      overheadTokens: Math.max(0, usedNow - baselineTokens),
      savedPct: baselineTokens && usedNow ? Math.max(0, Math.round((1 - usedNow / baselineTokens) * 100)) : 0,
      compression: usedNow ? Number((baselineTokens / usedNow).toFixed(2)) : null,
    },
  };
}

/** Elimina del resumen las líneas redundantes respecto de la memoria ya incluida. */
function dropDuplicatedLines(card, renderedTerms) {
  if (!renderedTerms.length) return card;
  const kept = [];
  for (const line of card.split('\n')) {
    const clean = line.replace(/^-\s*(\([UA]\)\s*)?/, '').trim();
    if (clean.length > 20) {
      const terms = indexTerms(clean);
      const duplicated = renderedTerms.some((other) => termJaccard(terms, other) > 0.78);
      if (duplicated) continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

function defaultHeader(language, projectName) {
  const name = projectName ? ` «${projectName}»` : '';
  return language === 'en' ? `[EVO · project memory${name}]` : `[EVO · memoria del proyecto${name}]`;
}

/** Empaquetado con presupuesto: entra lo que cabe, en orden de ranking. */
function pack(items, cap, usedIds) {
  const picked = [];
  let tokens = 0;
  for (const item of items) {
    if (usedIds.has(item.id)) continue;
    const cost = item.tokens + 3;
    if (tokens + cost > cap) continue;
    picked.push(item);
    usedIds.add(item.id);
    tokens += cost;
  }
  return { items: picked, tokens };
}

function renderItems(layer, title, items, now, language) {
  if (!items.length) return null;

  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.kind)) groups.set(item.kind, []);
    groups.get(item.kind).push(item);
  }

  const lines = [];
  for (const kind of KIND_ORDER) {
    const group = groups.get(kind);
    if (!group) continue;
    const label = SECTION_TITLES[kind] || kind;
    lines.push(`${label}:`);
    for (const item of group) {
      lines.push(`- ${renderItemText(item, now, language)}`);
    }
  }

  if (!lines.length) return null;
  const text = `## ${title}\n${lines.join('\n')}`;
  const itemTokens = items.reduce((acc, item) => acc + item.tokens + 3, 0);
  return {
    id: `block-${layer}`,
    layer,
    label: title,
    text,
    tokens: itemTokens,
    itemIds: items.map((item) => item.id),
  };
}

function renderEpisodes(items, language) {
  if (!items.length) return null;
  const lines = items.map((item) => `- ${item.text}`);
  const text = `## ${language === 'en' ? 'Earlier episodes' : 'Episodios anteriores'}\n${lines.join('\n')}`;
  return {
    id: 'block-episodes',
    layer: 'episodes',
    label: language === 'en' ? 'Episodes' : 'Episodios',
    text,
    tokens: items.reduce((acc, item) => acc + item.tokens + 3, 0),
    itemIds: items.map((item) => item.id),
  };
}

/**
 * Cada línea cuesta tokens: se añade la fecha solo cuando la antigüedad importa
 * (más de una semana) y se recortan los textos desmesurados.
 */
function renderItemText(item, now, language) {
  const meta = KIND_META[item.kind] || KIND_META.fact;
  const ageDays = (now - item.updatedAt) / 86_400_000;
  const body = item.text.length > 260 ? excerpt(item.text, 250) : item.text;
  if (ageDays > 7) {
    const date = new Date(item.updatedAt).toISOString().slice(0, 10);
    return language === 'en' ? `${body} (${date})` : `${body} (${date})`;
  }
  return meta.short ? body : body;
}

export { SECTION_TITLES };

/**
 * Motor de intervención SALIENTE: todo lo que ocurre entre pulsar «enviar» y
 * que el texto llegue al modelo.
 *
 * Reglas aplicadas, en orden:
 *   1. limpieza         — espacios, invisibles, líneas duplicadas
 *   2. higiene de pegado— bloques gigantes etiquetados para que el modelo los lea
 *   3. contradicciones  — instrucciones incompatibles en el mismo mensaje
 *   4. ambigüedad       — referencias sin antecedente («hazlo», «eso», «sigue»)
 *   5. presupuesto      — pliegue de turnos antiguos en una tarjeta de memoria
 *   6. protocolo        — bloque anti-bucle / anti-invención
 *
 * Cada regla es pura y devuelve hallazgos; el ensamblado final es explícito para
 * que la UI pueda mostrar exactamente qué se va a enviar.
 */

import { buildMemoryHeader, buildProtocolBlock, detectLanguage, MARKERS } from './protocol.js';
import { planBudget, renderMemoryBlock } from './compaction.js';
import { DEFAULT_SETTINGS, mergeSettings } from './settings.js';
import {
  canonical,
  collapseBlankLines,
  estimateTokens,
  excerpt,
  fingerprint,
  jaccard,
  tokenize,
} from './text.js';

const ANAPHORA = /^(y\s+)?(hazlo|hazlo\s+ya|eso|esto|aquello|lo\s+mismo|igual|sigue|contin[uú]a|ahora|entonces|y\s+ahora|más|mas|dale|ok|vale|perfecto|go\s+on|continue|more|next)\b/i;
const CONTINUATION = /^(contin[uú]a|continua|sigue|retoma|go on|continue|keep going)\b/i;

const CONTRADICTIONS = [
  {
    id: 'length',
    a: /\b(breve|conciso|resumido|en pocas palabras|short|brief|concise)\b/i,
    b: /\b(detallad|exhaustiv|paso a paso|completo|extenso|en profundidad|detailed|thorough|step by step)\b/i,
    title: 'Longitud contradictoria',
    hint: 'Pediste brevedad y detalle a la vez. El modelo suele resolverlo repitiendo: elige una y deja la otra para un segundo mensaje.',
  },
  {
    id: 'code-vs-explanation',
    a: /\b(solo el c[oó]digo|solo c[oó]digo|sin explicaciones|only code|no explanations)\b/i,
    b: /\b(expl[ií]came|explica|explicaci[oó]n|por qu[eé]|explain|why)\b/i,
    title: 'Código sin explicación vs. explicación',
    hint: '«Solo código» y «explícame» se anulan. Separa la petición en dos turnos.',
  },
  {
    id: 'language',
    a: /\b(en espa[ñn]ol|escribe en espa[ñn]ol|in spanish)\b/i,
    b: /\b(in english|en ingl[eé]s|write in english)\b/i,
    title: 'Idioma contradictorio',
    hint: 'Hay dos idiomas pedidos en el mismo mensaje; el modelo puede alternarlos a mitad de respuesta.',
  },
  {
    id: 'format',
    a: /\b(sin tablas|no uses tablas|sin listas|no uses listas|no bullets|plain text)\b/i,
    b: /\b(tabla|en una tabla|lista|bullets|listado|table)\b/i,
    title: 'Formato contradictorio',
    hint: 'Pediste evitar y usar el mismo formato. La regla que gana es la última; conviene dejarla sola.',
  },
  {
    id: 'one-shot',
    a: /\b(una sola respuesta|todo de una vez|no me preguntes|in one go|single answer|don't ask)\b/i,
    b: /\b(por partes|poco a poco|preg[uú]ntame|step by step|one at a time|ask me)\b/i,
    title: 'Entrega única vs. por partes',
    hint: '«Todo de una vez» y «por partes» juntos producen respuestas que se reinician a mitad de camino.',
  },
];

/** Quita los bloques que Nexo inyectó, para mostrar el texto real del usuario. */
export function stripNexoBlocks(text) {
  if (!text) return '';
  return text
    .replace(/\[Protocolo de continuidad · Nexo\][\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\[Memoria de la conversación · Nexo\][\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\[Continuación automática · Nexo\][\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\[Aclaración · Nexo\][\s\S]*?(?=\n\n|$)/g, '')
    .trim();
}

/** 1 + 2. Limpieza y deduplicación de líneas repetidas. */
export function cleanPrompt(text, opts = {}) {
  const { dedupeLines = true } = opts;
  let out = canonical(text).replace(/[ \t]{2,}/g, ' ').trim();
  const findings = [];

  if (dedupeLines) {
    const lines = out.split('\n');
    const seen = new Set();
    const kept = [];
    let removed = 0;
    let inFence = false;
    for (const line of lines) {
      // Dentro de un bloque de código no se toca nada: repetir una línea
      // (un `return`, una llave) es normal y borrarla rompería el código.
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        kept.push(line);
        continue;
      }
      if (inFence) {
        kept.push(line);
        continue;
      }
      const norm = line.trim().toLowerCase();
      // Solo se deduplican líneas con contenido real (los separadores se respetan).
      if (norm.length > 12 && !/^([-*+•]|\d+[.)])\s/.test(norm)) {
        if (seen.has(norm)) {
          removed += 1;
          continue;
        }
        seen.add(norm);
      }
      kept.push(line);
    }
    if (removed > 0) {
      out = kept.join('\n');
      findings.push({
        id: 'dedupe-lines',
        level: 'info',
        title: `Se quitaron ${removed} línea(s) repetida(s)`,
        detail: 'El texto tenía líneas idénticas; repetirlas empuja al modelo a repetir también su respuesta.',
      });
    }
  }

  out = collapseBlankLines(out);
  return { text: out, findings };
}

/** 3. Contradicciones explícitas. */
export function detectContradictions(text) {
  const found = [];
  for (const rule of CONTRADICTIONS) {
    if (rule.a.test(text) && rule.b.test(text)) {
      found.push({ id: `contradiction-${rule.id}`, level: 'warn', title: rule.title, detail: rule.hint });
    }
  }
  return found;
}

/** 4. Ambigüedad por referencia sin antecedente. */
export function detectAmbiguity(text, history = []) {
  const trimmed = text.trim();
  const findings = [];
  const short = trimmed.length < 60;
  const anaphoric = ANAPHORA.test(trimmed);
  const hasHistory = history.some((t) => (t.content || '').trim().length > 0);

  if (anaphoric && !hasHistory) {
    findings.push({
      id: 'ambiguity-no-context',
      level: 'warn',
      title: 'Referencia sin antecedente',
      detail: 'El mensaje empieza con «' + trimmed.split(/\s+/)[0] + '» pero no hay conversación previa. Es la causa número uno de respuestas que arrancan mal y se corrigen solas.',
      suggestion: 'Añadí el objeto concreto de la petición (qué, sobre qué, con qué límites).',
      injectClarifier: true,
    });
  } else if (anaphoric && short && hasHistory) {
    const lastUser = [...history].reverse().find((t) => t.role === 'user');
    const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant');
    const overlap = lastAssistant
      ? jaccard(tokenize(trimmed), tokenize(lastAssistant.content || ''))
      : 0;
    if (overlap < 0.08 && lastUser) {
      findings.push({
        id: 'ambiguity-low-overlap',
        level: 'info',
        title: 'Petición muy corta para un contexto largo',
        detail: `«${excerpt(trimmed, 40)}» se parece poco a lo último que se habló. Nexo añadirá una línea para que el modelo confirme qué va a hacer antes de hacerlo.`,
        injectClarifier: true,
      });
    }
  }
  return findings;
}

/** 2b. Bloques pegados enormes. */
export function wrapLongPaste(text) {
  if (text.length < 2400) return { text, wrapped: false };
  const blocks = text.split(/\n{2,}/);
  const huge = blocks.filter((b) => b.length > 1500);
  if (huge.length === 0) return { text, wrapped: false };
  const rebuilt = blocks
    .map((b) =>
      b.length > 1500
        ? `[Texto pegado por el usuario · ${b.length} caracteres · leelo completo antes de responder]\n${b}\n[Fin del texto pegado]`
        : b,
    )
    .join('\n\n');
  return { text: rebuilt, wrapped: true };
}

const CLARIFIER_ES =
  '[Aclaración · Nexo] Antes de desarrollar, escribe una frase con lo que entendiste de la petición. Si es ambigua, pregunta una sola cosa concreta.';
const CLARIFIER_EN =
  '[Clarification · Nexo] Before elaborating, state in one sentence what you understood. If it is ambiguous, ask exactly one specific question.';

/**
 * Intervención completa antes de enviar.
 *
 * @param {{
 *   prompt: string,
 *   history?: Array<{role: string, content: string}>,
 *   host?: string,
 *   settings?: object,
 *   forceProtocol?: boolean
 * }} input
 */
export function enhancePrompt(input) {
  const settings = mergeSettings(DEFAULT_SETTINGS, input.settings || {});
  const history = input.history || [];
  const rawPrompt = String(input.prompt ?? '');
  const lang = settings.protocol.lang === 'auto' ? detectLanguage(rawPrompt) : settings.protocol.lang;

  const findings = [];
  const blocks = [];

  if (!settings.enabled || !settings.sending.enabled) {
    return {
      original: rawPrompt,
      enhanced: rawPrompt,
      changed: false,
      skipped: true,
      blocks,
      findings,
      lang,
      stats: buildStats(rawPrompt, rawPrompt, 0),
      context: null,
    };
  }

  // 1) limpieza
  let text = rawPrompt;
  if (settings.sending.cleanWhitespace || settings.sending.dedupeLines) {
    const cleaned = cleanPrompt(rawPrompt, { dedupeLines: settings.sending.dedupeLines });
    text = cleaned.text;
    findings.push(...cleaned.findings);
  }

  // 2) pegado
  if (settings.sending.wrapLongPaste) {
    const wrapped = wrapLongPaste(text);
    if (wrapped.wrapped) {
      text = wrapped.text;
      findings.push({
        id: 'wrap-paste',
        level: 'info',
        title: 'Bloque pegado delimitado',
        detail: 'Se marcaron los bloques largos con inicio y fin para que el modelo no confunda tu texto con sus instrucciones.',
      });
    }
  }

  // 3) contradicciones
  if (settings.sending.detectContradictions) findings.push(...detectContradictions(text));

  // 4) ambigüedad
  if (settings.sending.resolveAmbiguity) {
    const ambiguity = detectAmbiguity(text, history);
    findings.push(...ambiguity);
    if (ambiguity.some((f) => f.injectClarifier)) {
      blocks.push({
        id: 'clarifier',
        label: lang === 'en' ? 'Aclaración previa' : 'Aclaración previa',
        text: lang === 'en' ? CLARIFIER_EN : CLARIFIER_ES,
        reason: 'La petición puede interpretarse de más de una forma.',
      });
    }
  }

  // 5) presupuesto de contexto
  let context = null;
  if (settings.context.enabled && history.length) {
    const plan = planBudget(history, {
      budgetTokens: settings.context.budgetTokens,
      keepRecent: settings.context.keepRecentTurns,
    });
    if (plan.card && plan.card.card) {
      const memoryBlock = renderMemoryBlock(plan.card, buildMemoryHeader(lang));
      blocks.push({
        id: 'memory',
        label: 'Memoria de la conversación',
        text: memoryBlock,
        reason: `Se plegaron ${plan.fold.length} turnos antiguos (${plan.tokensBefore} → ${plan.tokensAfter} tokens).`,
      });
      findings.push({
        id: 'context-folded',
        level: 'info',
        title: `Contexto compactado: ${plan.fold.length} turno(s) → tarjeta de memoria`,
        detail: `Se liberaron ~${Math.max(0, plan.tokensBefore - plan.tokensAfter)} tokens de ventana sin perder decisiones ni pendientes.`,
      });
      context = {
        foldedTurns: plan.fold.length,
        keptTurns: plan.keep.length,
        tokensBefore: plan.tokensBefore,
        tokensAfter: plan.tokensAfter,
        card: plan.card.card,
      };
    }
  }

  // 6) protocolo
  const level = settings.protocol.level;
  let protocolText = '';
  if (level !== 'off') {
    protocolText = buildProtocolBlock({ level, lang });
    if (protocolText) {
      blocks.push({
        id: 'protocol',
        label: `Protocolo de continuidad (${level})`,
        text: protocolText,
        reason: 'Reglas anti-repetición, anti-invención y de aclaración.',
      });
    }
  }

  // Ensamblado
  const userText = text.trim();
  const blockTexts = blocks.map((b) => b.text);
  const placement = settings.protocol.placement;
  const parts = [];
  if (placement === 'prefix' || placement === 'both') parts.push(...blockTexts, userText);
  else if (placement === 'suffix') parts.push(userText, ...blockTexts);
  else parts.push(...blockTexts, userText);

  const enhanced = parts.filter(Boolean).join('\n\n');
  const isContinuation = CONTINUATION.test(userText);

  return {
    original: rawPrompt,
    enhanced,
    userText,
    changed: enhanced !== rawPrompt,
    skipped: false,
    isContinuation,
    blocks,
    findings,
    lang,
    context,
    protocolLevel: level,
    stats: buildStats(rawPrompt, enhanced, blocks.length),
  };
}

function buildStats(before, after, blockCount) {
  return {
    charsIn: before.length,
    charsOut: after.length,
    tokensIn: estimateTokens(before),
    tokensOut: estimateTokens(after),
    injectedTokens: Math.max(0, estimateTokens(after) - estimateTokens(before)),
    blocks: blockCount,
    deltaChars: after.length - before.length,
  };
}

/**
 * Construye el mensaje de continuación automática cuando la respuesta se cortó
 * o el centinela detuvo un bucle.
 */
export function buildContinuation({ reason, deliveredText, loopUnit, lang = 'es' }) {
  const lastWords = (deliveredText || '').trim().split(/\s+/).slice(-12).join(' ');
  return {
    reason,
    lang,
    lastWords,
    loopUnit: loopUnit ? excerpt(loopUnit, 120) : '',
  };
}

export { MARKERS };

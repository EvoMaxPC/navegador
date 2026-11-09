/**
 * EVO MEMORY · Extracción
 *
 * La memoria no se construye guardando todo: guardar todo es exactamente el
 * problema que la ventana de contexto ya tiene. Se construye decidiendo qué
 * merece sobrevivir a la conversación.
 *
 * Cada candidato lleva su motivo (`reason`), para que el panel pueda explicar
 * por qué una frase terminó en memoria y otra no.
 */

import { canonical, sentences } from '../core/text.js';
import { anchors, isNegated } from './lexicon.js';

/**
 * Reglas de clasificación. El orden importa: gana la primera que coincide.
 * Cada patrón está pensado para frases en primera persona de una conversación
 * de trabajo, que es donde aparece la información que luego falta.
 */
const RULES = [
  {
    kind: 'decision',
    confidence: 0.92,
    reason: 'marca explícita de decisión',
    re: /\b(decidimos|decidí|hemos decidido|vamos con|vayamos con|usaremos|usaré|elegimos|elegí|optamos|la decisi[oó]n es|quedamos en|we decided|we'?ll use|let'?s go with|we chose|going with)\b/i,
  },
  {
    kind: 'constraint',
    confidence: 0.9,
    reason: 'marca explícita de restricción',
    re: /\b(no podemos|no se puede|no debemos|no debo|no hay que|tiene que|tienen que|hay que|requiere|requisito|restricci[oó]n|l[ií]mite|como m[aá]ximo|como m[ií]nimo|sin superar|obligatorio|must not|must|shall not|requirement|constraint|cannot|can'?t)\b/i,
  },
  {
    kind: 'preference',
    confidence: 0.85,
    reason: 'preferencia declarada',
    re: /\b(prefiero|preferir[ií]a|siempre uso|siempre hacemos|me gusta|no me gusta|evit[aá]|evitar|nunca uso|prefer|i like|i hate|always use|never use)\b/i,
  },
  {
    kind: 'issue',
    confidence: 0.88,
    reason: 'fallo observado',
    // Solo fallos constatados: una hipótesis («si pasa esto se rompe») no es un
    // problema abierto, y un fallo ya resuelto tampoco.
    re: /\b(excepci[oó]n|traceback|stack ?trace|timeout|segfault|crash|no funciona|dej[oó] de funcionar|tira (un )?error|arroj[oó] (un )?error|fall[oó]|falla al|el error|ese error|este error|el bug|ese bug|rechaza|denegado|regresi[oó]n|rompi[oó]|se cae|fails?|throws?)\b/i,
    not: /\b(se (arregla|resuelve|corrige|soluciona)|solucionad[oa]|arreglad[oa]|c[oó]mo (arreglar|evitar|resolver))\b/i,
  },
  {
    kind: 'task',
    confidence: 0.86,
    reason: 'trabajo pendiente',
    re: /\b(pendiente|queda pendiente|falta|por hacer|pr[oó]ximo paso|siguiente paso|todo:|falta definir|sin terminar|a medias|to-?do|next step|remaining|still need|left to do)\b/i,
  },
  {
    kind: 'goal',
    confidence: 0.84,
    reason: 'objetivo del proyecto',
    re: /\b(el objetivo|mi objetivo|nuestro objetivo|la meta|el plan es|queremos|quiero lograr|necesitamos|necesito|voy a construir|we need to|the goal|aim is|we want to|i want to)\b/i,
  },
];

const NOISE = [
  /^(hola|buenas|buenos d[ií]as|gracias|perfecto|genial|ok|dale|claro|entendido|hello|hi|thanks|great|sure)[.!]?$/i,
  /\b(como (un )?modelo de lenguaje|as an ai|no tengo acceso a|i don'?t have access)\b/i,
  /^\s*$/,
];

const MIN_LENGTH = 24;
// Arranques interrogativos sin signo de apertura (los asistentes a veces los omiten).
const QUESTION_START = /^(qu[eé]|cu[aá]l(es)?|c[oó]mo|d[oó]nde|cu[aá]ndo|qui[eé]n(es)?|por ?qu[eé]|para qu[eé]|cu[aá]nto(s|as)?|pod[eé]s|podr[ií]as|what|which|how|where|when|who|why)\b/i;
const MAX_LENGTH = 400;

/**
 * Extrae memorias candidatas de un turno.
 *
 * @param {{role: 'user'|'assistant', content: string}} turn
 * @param {{projectId?: string, conversationId?: string, source?: object, now?: number}} [ctx]
 * @returns {Array<{kind: string, text: string, confidence: number, reason: string, projectId: string, conversationId: string|null, source: object}>}
 */
export function extractFromTurn(turn, ctx = {}) {
  const content = canonical(turn?.content || '');
  if (!content.trim()) return [];

  const role = turn.role === 'assistant' ? 'assistant' : 'user';
  const candidates = [];
  const seen = new Set();

  const base = {
    projectId: ctx.projectId || 'default',
    conversationId: ctx.conversationId || null,
    source: { role, model: ctx.source?.model || null, url: ctx.source?.url || null },
    now: ctx.now,
  };

  // 1. Bloques de código y comandos: son artefactos, no prosa.
  for (const block of codeBlocks(content)) {
    const text = block.content.trim();
    // Un comando de 25 caracteres vale tanto como un archivo entero: el umbral
    // bajo es deliberado, los bloques de código son densos en información.
    if (text.length < 12) continue;
    const firstLine = text.split('\n')[0].slice(0, 80);
    const body =
      text.length <= 160
        ? text.replace(/\n+/g, ' ⏎ ')
        : `${firstLine} … (${text.length} caracteres, ${text.split('\n').length} líneas)`;
    push(candidates, seen, {
      ...base,
      kind: 'artifact',
      text: `Código (${block.language || 'sin lenguaje'}): ${body}`,
      confidence: 0.72,
      reason: 'bloque de código reutilizable',
    });
  }

  // 2. Frases con intención explícita.
  for (const sentence of sentences(content)) {
    const text = sentence.trim();
    if (!usable(text)) continue;

    // Una pregunta no es una afirmación: «¿qué decidimos?» no es una decisión.
    // Si el turno del usuario pregunta, solo puede convertirse en hilo abierto.
    const isQuestion = /[?¿]/.test(text) || QUESTION_START.test(text);
    if (isQuestion) {
      if (role === 'user' && text.length >= MIN_LENGTH) {
        push(candidates, seen, {
          ...base,
          kind: 'question',
          text: trimSentence(text),
          confidence: 0.6,
          reason: 'pregunta abierta',
        });
      }
      continue;
    }

    let matched = false;
    for (const rule of RULES) {
      if (!rule.re.test(text)) continue;
      if (rule.not && rule.not.test(text)) continue;
      push(candidates, seen, {
        ...base,
        kind: rule.kind,
        text: trimSentence(text),
        confidence: rule.confidence,
        reason: rule.reason,
      });
      matched = true;
      break;
    }
    if (matched) continue;

    // 3. (las preguntas ya quedaron filtradas arriba)

    // 4. Dato con ancla dura (número, ruta, URL, versión): lo que un resumen pierde.
    const hardAnchors = anchors(text);
    if (hardAnchors.length && wordCount(text) >= 6 && role === 'user') {
      push(candidates, seen, {
        ...base,
        kind: 'fact',
        text: trimSentence(text),
        confidence: 0.58,
        reason: `contiene ${hardAnchors.slice(0, 2).join(', ')}`,
      });
    }
  }

  return candidates;
}

/**
 * Resume un tramo de conversación en un episodio: qué se hizo, qué quedó abierto.
 * Es extractivo y determinista, igual que el resto del motor.
 */
export function summarizeEpisode(turns, opts = {}) {
  const { maxChars = 600 } = opts;
  const parts = [];

  for (const turn of turns) {
    const content = canonical(turn.content || '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const first = sentences(content)[0] || content;
    const prefix = turn.role === 'user' ? 'El usuario planteó' : 'Se respondió';
    parts.push(`${prefix}: ${first.slice(0, 180)}`);
    if (parts.join(' ').length > maxChars) break;
  }

  let text = parts.join(' · ');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}

/* ------------------------------------------------------------------ */
/* utilidades internas                                                 */
/* ------------------------------------------------------------------ */

function push(list, seen, candidate) {
  const text = canonical(candidate.text || '').trim();
  if (!text || text.length < MIN_LENGTH) return;
  const key = text.toLowerCase().replace(/\s+/g, ' ');
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ ...candidate, text });
}

function usable(text) {
  if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return false;
  if (NOISE.some((re) => re.test(text))) return false;
  if (/^[#>*\-|]/.test(text) && wordCount(text) < 5) return false;
  return true;
}

function trimSentence(text) {
  return text.replace(/\s+/g, ' ').replace(/^[-*•]\s+/, '').trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Extrae bloques ``` ... ``` con su lenguaje. */
export function codeBlocks(text) {
  const blocks = [];
  const re = /```([\w+-]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    blocks.push({ language: match[1], content: match[2] });
  }
  return blocks;
}

/**
 * ¿La frase aporta algo nuevo respecto de lo ya conocido?
 * Se usa antes de escribir para no llenar la memoria de sinónimos.
 */
export function isInformative(text, knownTerms = []) {
  if (isNegated(text) && wordCount(text) < 5) return false;
  if (knownTerms.length && wordCount(text) < 4) return false;
  return true;
}

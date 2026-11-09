/**
 * Motor de intervención ENTRANTE: reparación de la respuesta ya recibida.
 *
 * El centinela de streaming corta los bucles; este módulo arregla lo que queda
 * cuando la respuesta termina: markdown roto, tokens especiales filtrados,
 * párrafos duplicados, negativas del modelo y cortes a mitad de frase.
 */

import { detectTruncation } from './analysis.js';
import {
  canonical,
  codeFenceState,
  collapseBlankLines,
  excerpt,
  fingerprint,
  paragraphs,
  tokenize,
  distinctRatio,
} from './text.js';

const LEAKED_TOKENS = [
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  /<\|endoftext\|>/g,
  /<\|start_header_id\|>/g,
  /<\|end_header_id\|>/g,
  /<\|eot_id\|>/g,
  /<\/s>/g,
  /<\|assistant\|>/g,
  /<\|user\|>/g,
  /\[INST\]/g,
  /\[\/INST\]/g,
  /<<SYS>>/g,
  /<<\/SYS>>/g,
  /<end_of_turn>/g,
  /<start_of_turn>/g,
];

const REFUSAL_PATTERNS = [
  /\blo siento[,\s]+(pero\s+)?no puedo\b/i,
  /\bno puedo ayudar(te)? con (eso|esto)\b/i,
  /\bcomo (un )?modelo de lenguaje\b/i,
  /\bas an ai( language model)?\b/i,
  /\bi (cannot|can't|am unable to) (help|assist) with that\b/i,
  /\bi'm sorry,? but i (can't|cannot)\b/i,
];

const META_PATTERNS = [
  /\bno tengo acceso a\b/i,
  /\bmi entrenamiento (termina|acaba)\b/i,
  /\bno puedo navegar por internet\b/i,
];

/**
 * Aplica todas las reparaciones sobre un texto.
 *
 * @param {string} input
 * @param {{settings?: object, lang?: 'es'|'en', truncated?: boolean}} [opts]
 * @returns {{
 *   text: string,
 *   fixes: Array<{id: string, label: string, detail?: string}>,
 *   truncated: boolean,
 *   truncationReason: string|null,
 *   needsContinue: boolean,
 *   refusal: boolean,
 *   meta: boolean,
 *   empty: boolean,
 *   health: object
 * }}
 */
export function repairResponse(input, opts = {}) {
  const settings = {
    repairMarkdown: true,
    stripLeakedTokens: true,
    detectRefusal: true,
    ...(opts.settings?.receiving || {}),
  };
  const fixes = [];
  let text = String(input ?? '');

  if (!text.trim()) {
    return {
      text: '',
      fixes: [],
      truncated: false,
      truncationReason: null,
      needsContinue: true,
      refusal: false,
      meta: false,
      empty: true,
      health: { chars: 0, tokens: 0, diversity: 0 },
    };
  }

  text = canonical(text);

  // 1) Tokens especiales filtrados (el modelo "escupió" su plantilla).
  if (settings.stripLeakedTokens) {
    let stripped = text;
    for (const re of LEAKED_TOKENS) stripped = stripped.replace(re, '');
    if (stripped !== text) {
      fixes.push({
        id: 'leaked-tokens',
        label: 'Tokens de plantilla eliminados',
        detail: 'Aparecieron marcas internas del modelo (<|im_end|>, [INST]…); se quitaron antes de mostrarlas.',
      });
      text = stripped.replace(/\n{3,}/g, '\n\n');
    }
  }

  // 2) Prefijo hablado: «Assistant:», «Respuesta:» al inicio.
  const prefixMatch = text.match(/^\s*(assistant|asistente|respuesta|answer)\s*:\s*/i);
  if (prefixMatch) {
    text = text.slice(prefixMatch[0].length);
    fixes.push({ id: 'strip-role-prefix', label: 'Prefijo de rol eliminado' });
  }

  // 3) Párrafo final idéntico al anterior (cierre que se reescribe).
  const blocks = paragraphs(text);
  if (blocks.length >= 2) {
    const last = blocks[blocks.length - 1];
    const prev = blocks[blocks.length - 2];
    if (last.length > 40 && fingerprint(last) === fingerprint(prev)) {
      const idx = text.lastIndexOf(last);
      text = `${text.slice(0, idx).trimEnd()}`;
      fixes.push({
        id: 'duplicate-tail',
        label: 'Párrafo final duplicado eliminado',
        detail: excerpt(last, 90),
      });
    }
  }

  // 4) Encabezados duplicados consecutivos.
  if (settings.repairMarkdown) {
    const headingDup = text.replace(/^(#{1,6}\s+.*)\n\1$/gm, '$1');
    if (headingDup !== text) {
      text = headingDup;
      fixes.push({ id: 'duplicate-heading', label: 'Encabezado duplicado eliminado' });
    }
  }

  // 5) Bloques de código sin cerrar.
  let truncationReason = null;
  const fence = codeFenceState(text);
  if (fence.open) {
    text = `${text.replace(/\s+$/, '')}\n${fence.fence}`;
    truncationReason = 'code-fence-open';
    fixes.push({
      id: 'close-fence',
      label: 'Bloque de código cerrado',
      detail: `El bloque «${fence.lang || 'sin lenguaje'}» quedó abierto; se cerró para no romper el resto de la conversación.`,
    });
  }

  // 6) Negritas/cursivas desbalanceadas en la última línea.
  if (settings.repairMarkdown) {
    const lastLine = text.slice(text.lastIndexOf('\n') + 1);
    const bold = (lastLine.match(/\*\*/g) || []).length;
    if (bold % 2 === 1) {
      text += '**';
      fixes.push({ id: 'balance-bold', label: 'Marcador ** balanceado' });
    }
  }

  // 7) Espacios y líneas en blanco.
  const tidy = collapseBlankLines(text).replace(/[ \t]+$/gm, '').replace(/^\s+/, '');
  if (tidy !== text) {
    text = tidy;
    fixes.push({ id: 'tidy-whitespace', label: 'Espaciado normalizado' });
  }

  // 8) ¿Se cortó? (el bloque abierto detectado antes también cuenta)
  const trunc = detectTruncation(text);
  const truncated = opts.truncated ?? (truncationReason ? true : trunc.truncated);
  if (truncated && !truncationReason) truncationReason = trunc.reason;

  // 9) ¿Es una negativa?
  const refusal = settings.detectRefusal && REFUSAL_PATTERNS.some((re) => re.test(text.slice(0, 600)));
  const meta = META_PATTERNS.some((re) => re.test(text));

  // 10) Respuesta degenerada: muy larga y con vocabulario repetitivo.
  const tokens = tokenize(text);
  const diversity = distinctRatio(tokens);
  if (tokens.length > 100 && diversity < 0.18) {
    fixes.push({
      id: 'low-diversity',
      label: 'Respuesta con vocabulario degenerado',
      detail: `Diversidad léxica ${(diversity * 100).toFixed(0)} %. Conviene regenerar pidiendo otro enfoque.`,
    });
  }

  return {
    text,
    fixes,
    truncated,
    truncationReason,
    needsContinue: truncated,
    refusal,
    meta,
    empty: text.trim().length === 0,
    health: {
      chars: text.length,
      tokens: tokens.length,
      diversity: Number(diversity.toFixed(3)),
      sentences: (text.match(/[.!?…]+/g) || []).length,
    },
  };
}

/**
 * Sugerencias cuando la respuesta es una negativa o una respuesta vacía.
 */
export function recoverySuggestions(result, lang = 'es') {
  const tips = [];
  if (result.empty) {
    tips.push({
      id: 'empty',
      action: 'regenerate',
      label: lang === 'en' ? 'Regenerate with a different angle' : 'Regenerar con otro enfoque',
      prompt:
        lang === 'en'
          ? 'Give me a complete answer. If something is blocked, explain exactly which part and offer an alternative.'
          : 'Dame una respuesta completa. Si algo está bloqueado, explícame exactamente qué parte y ofréceme una alternativa.',
    });
  }
  if (result.refusal) {
    tips.push({
      id: 'refusal',
      action: 'rephrase',
      label: lang === 'en' ? 'Reframe the request' : 'Reformular la petición',
      prompt:
        lang === 'en'
          ? 'Answer from the technical/educational angle: explain the concept, the general approach and the risks, without operational detail.'
          : 'Responde desde el ángulo técnico/educativo: explica el concepto, el enfoque general y los riesgos, sin detalle operativo.',
    });
  }
  if (result.meta) {
    tips.push({
      id: 'meta',
      action: 'ground',
      label: lang === 'en' ? 'Ask for what it can do' : 'Pedir lo que sí puede hacer',
      prompt:
        lang === 'en'
          ? 'Tell me what you CAN do with what I gave you, step by step.'
          : 'Dime qué SÍ puedes hacer con lo que te di, paso a paso.',
    });
  }
  if (result.needsContinue) {
    tips.push({
      id: 'continue',
      action: 'continue',
      label: lang === 'en' ? 'Continue where it stopped' : 'Continuar donde se cortó',
    });
  }
  return tips;
}

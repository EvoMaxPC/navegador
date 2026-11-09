/**
 * Protocolos de continuidad.
 *
 * Son bloques cortos de instrucciones que se añaden al mensaje del usuario
 * ANTES de enviarlo. No intentan "ser el prompt del sistema": son parches
 * quirúrgicos contra los fallos conocidos de los modelos conversacionales
 * (repetición, reinicio de la respuesta, invención de datos, respuestas
 * cortadas a mitad, cambios de idioma y de formato a mitad de la charla).
 *
 * Mantenerlos breves es parte del diseño: cada token aquí compite con el
 * contexto útil de la conversación.
 */

export const PROTOCOL_LEVELS = ['off', 'suave', 'equilibrado', 'agresivo'];

const BASE_ES = [
  'No repitas frases, listas ni párrafos que ya escribiste en esta respuesta.',
  'No reinicies la respuesta ni repitas el enunciado del usuario.',
  'Si no sabes algo, dilo y propón cómo verificarlo; no inventes datos ni fuentes.',
  'Si falta un dato imprescindible, haz una sola pregunta concreta antes de responder.',
];

const BASE_PREFIX_ES = 'Responde completo pero sin redundancia.';

const BASE_EN = [
  'Do not repeat sentences, lists or paragraphs already written in this answer.',
  'Do not restart the answer or restate the user prompt.',
  'If you are unsure, say so and propose how to verify it; never invent data or sources.',
  'If a critical detail is missing, ask exactly one specific question before answering.',
];

const BASE_PREFIX_EN = 'Answer completely but without redundancy.';

const LEVELS = {
  suave: {
    es: [BASE_PREFIX_ES, BASE_ES[0], BASE_ES[2]],
        en: [BASE_PREFIX_EN, BASE_EN[0], BASE_EN[2]],
  },
  equilibrado: {
    es: BASE_ES,
    en: BASE_EN,
  },
  agresivo: {
    es: [
      ...BASE_ES,
      'Escribe en párrafos cortos y avanza siempre con información nueva.',
      'Si llevas más de 400 palabras, cierra la idea y pregunta «¿Continúo?».',
      'Prohibido cerrar con resúmenes de lo que acabas de decir.',
      'Mantén el idioma y el formato que ya usa la conversación.',
    ],
    en: [
      ...BASE_EN,
      'Use short paragraphs and always advance with new information.',
      'Past 400 words, finish the idea and ask "Shall I continue?".',
      'Never close with a summary of what you just wrote.',
      'Keep the language and format the conversation is already using.',
    ],
  },
};

/** Elige el idioma del protocolo a partir del texto del usuario. */
export function detectLanguage(text) {
  const sample = (text || '').slice(0, 400);
  const es = (sample.match(/\b(el|la|los|las|que|de|para|con|una|un|por|es|y|no|como|más|pero|esto|qué|cómo)\b/gi) || []).length;
  const en = (sample.match(/\b(the|and|for|with|that|this|you|are|is|of|to|how|what|but|not)\b/gi) || []).length;
  return en > es * 1.25 ? 'en' : 'es';
}

/**
 * Construye el bloque de protocolo.
 * @param {{level?: string, lang?: 'es'|'en', includeContinuity?: boolean}} opts
 * @returns {string} bloque listo para insertar, o '' si está desactivado.
 */
export function buildProtocolBlock(opts = {}) {
  const { level = 'equilibrado', lang = 'es', includeContinuity = true } = opts;
  if (level === 'off') return '';
  const rules = LEVELS[level]?.[lang] ?? LEVELS.equilibrado[lang];
  const header = lang === 'en' ? '[Continuity protocol · Nexo]' : '[Protocolo de continuidad · Nexo]';
  const body = rules.map((r) => `- ${r}`).join('\n');
  const closure = includeContinuity
    ? lang === 'en'
      ? '- If the user says "continue", resume exactly where the last answer stopped.'
      : '- Si el usuario dice «continúa», retoma exactamente donde se cortó la respuesta anterior.'
    : '';
  return [header, body, closure].filter(Boolean).join('\n');
}

/**
 * Encabezado para la tarjeta de memoria que reemplaza turnos antiguos.
 */
export function buildMemoryHeader(lang = 'es') {
  return lang === 'en'
    ? '[Conversation memory · Nexo]\n(Automatic summary of earlier turns)'
    : '[Memoria de la conversación · Nexo]\n(Resumen automático de turnos anteriores)';
}

/**
 * Instrucción de continuación automática (cuando la respuesta se cortó o
 * cuando el centinela de bucle detuvo la generación).
 * @param {{reason?: string, lastWords?: string, avoid?: string, lang?: string}} opts
 */
export function buildContinuationPrompt(opts = {}) {
  const { reason = 'truncated', lastWords = '', avoid = '', lang = 'es' } = opts;
  if (lang === 'en') {
    const why =
      reason === 'loop'
        ? 'The previous answer started repeating itself and was stopped on purpose.'
        : 'The previous answer was cut off before finishing.';
    return [
      '[Automatic continuation · Nexo]',
      why,
      'Continue exactly from where it stopped. Do not repeat anything already written.',
      avoid ? `Do not reuse this fragment: "${avoid}".` : '',
      lastWords ? `Last delivered words: "...${lastWords}".` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const why =
    reason === 'loop'
      ? 'La respuesta anterior entró en un bucle de repetición y se detuvo a propósito.'
      : 'La respuesta anterior se cortó antes de terminar.';
  return [
    '[Continuación automática · Nexo]',
    why,
    'Continúa exactamente donde se detuvo. No repitas nada de lo ya escrito.',
    avoid ? `No reutilices este fragmento: «${avoid}».` : '',
    lastWords ? `Últimas palabras entregadas: «…${lastWords}».` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Delimitadores usados para poder separar lo inyectado de lo escrito por el usuario. */
export const MARKERS = {
  protocol: { open: '[Protocolo de continuidad · Nexo]', close: '[/Protocolo de continuidad · Nexo]' },
  memory: { open: '[Memoria de la conversación · Nexo]', close: '[/Memoria de la conversación · Nexo]' },
  continuation: { open: '[Continuación automática · Nexo]', close: '' },
};

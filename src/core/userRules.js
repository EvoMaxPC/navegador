/** Gramática local acotada. Categorizar no ejecuta ni verifica decisiones. */
export const RULE_FIELDS = Object.freeze([
  'explicit_constraints',
  'active_instructions',
  'preferences',
  'confirmed_decisions',
]);
export const DECISION_CANDIDATE_LIMIT = 30;
const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim();

/** Sólo compara dimensiones inequívocas; null no significa compatibilidad probada. */
export function ruleValueKey(text) {
  const n = norm(text).replace(
    /^(?:preferencia\s*:\s*|prefiero\s+|preferiria\s+|i prefer\s+)/,
    '',
  );
  let m = n.match(
    /^(?:(?:respuestas?|responses?)\s+(?:en\s+)?|(?:usar?|use|utiliza|responde|respond)\s+(?:en\s+)?|(?:idioma|language)\s*:\s*)(espanol|spanish|ingles|english)$/,
  );
  if (m)
    return {
      key: 'response-language',
      value: /^(espanol|spanish)$/.test(m[1]) ? 'es' : 'en',
    };
  m = n.match(
    /^(?:respuestas?|responses?)\s+(breves?|cortas?|concisas?|short|largas?|detalladas?|detailed|long)$/,
  );
  if (m)
    return {
      key: 'response-length',
      value: /^(brev|cort|concis|short)/.test(m[1]) ? 'short' : 'detailed',
    };
  m = n.match(
    /^(?:(?:formato|format)\s*:\s*|(?:usar?|use|responde en)\s+)(json|markdown|texto plano|plain text)$/,
  );
  if (m)
    return {
      key: 'response-format',
      value: m[1] === 'texto plano' ? 'plain text' : m[1],
    };
  return null;
}

/** Se llama únicamente con segmentos propios, después de filtrar citas/código. */
export function ruleSegment(line) {
  if (
    /^\s*(?:s[oó]lo esta vez|s[oó]lo para (?:este mensaje|esta respuesta)|for this (?:turn|message|response))\s*:/i.test(
      line,
    )
  )
    return { ambiguous: true };
  let text = line,
    scope = 'project',
    updating = false,
    explicitScope = null;
  let m = text.match(
    /^\s*(?:s[oó]lo (?:por |para )?(?:esta |la )?sesi[oó]n|temporarily|for this session)\s*:\s*(.+)$/i,
  );
  if (m) {
    text = m[1];
    scope = 'session';
    explicitScope = scope;
  } else {
    m = text.match(
      /^\s*(?:de ahora en m[aá]s|a partir de ahora|from now on)\s*[:,]?\s+(.+)$/i,
    );
    if (m) {
      text = m[1];
      updating = true;
      explicitScope = 'project';
    }
  }
  m = text.match(
    /^\s*(instrucci[oó]n|restricci[oó]n|preferencia|decisi[oó]n confirmada)\s+(temporal|permanente)\s*:\s*(.+)$/i,
  );
  if (m) {
    scope = m[2].toLowerCase() === 'temporal' ? 'session' : 'project';
    if (explicitScope && explicitScope !== scope) return { ambiguous: true };
    text = `${m[1]}: ${m[3]}`;
  }
  const n = norm(text);
  let field = null,
    value = text,
    proposal = false;
  if (
    /^(?:propuesta(?: de decisi[oó]n)?|sugerencia|decision proposal|suggestion)\s*:/i.test(
      text,
    )
  ) {
    proposal = true;
    value = text.slice(text.indexOf(':') + 1).trim();
  } else if (/^(?:podriamos|sugiero|propongo|we could|i suggest)\s+/.test(n)) {
    proposal = true;
  } else if (
    /^(?:decision confirmada|decidimos|decision|confirmed decision)\s*:/.test(n)
  ) {
    field = 'confirmed_decisions';
    value = text.slice(text.indexOf(':') + 1).trim();
  } else if (/^(?:preferencia|prefiero|preferiria|i prefer)\b/.test(n))
    field = 'preferences';
  else if (/^(?:restriccion|obligatorio|constraint|mandatory)\s*:/.test(n)) {
    field = 'explicit_constraints';
    value = text.slice(text.indexOf(':') + 1).trim();
  } else if (
    /^(?:instruccion|resultado esperado|prioridad|instruction)\s*:/.test(n)
  ) {
    field = 'active_instructions';
    value = text.slice(text.indexOf(':') + 1).trim();
  } else if (
    /^(?:no|nunca|never|do not|don't)\s+(?:modifi\w*|cambi\w*|ejecut\w*|borr\w*|elimin\w*|reescrib\w*|invent\w*|alter\w*|uses?|utilic\w*|hagas?|tom\w*|edit\w*|run|delet\w*)\b/.test(
      n,
    )
  )
    field = 'explicit_constraints';
  else if (
    /^(?:ahora\s+(?:si\s+)?)?(?:usa|use|utiliza|responde|escribi|escribe|modifica|ejecuta|mejora|analiza|implementa|crea|conserva|mantene|prioriza|respeta|debes|tene en cuenta)\b/.test(
      n,
    )
  )
    field = 'active_instructions';
  if (!field && !proposal) return null;
  // Una condición o alternativa explícita no se vuelve obligación incondicional.
  if (
    !proposal &&
    (/\b(?:si|cuando|hasta|durante|mientras|salvo|excepto|if|when|until|while|unless)\b/.test(
      norm(value).replace(/^ahora si /, ''),
    ) ||
      /[?¿]/.test(text) ||
      /\b(?:solo esta vez|esta respuesta|este mensaje)\b/.test(norm(value)))
  )
    return { ambiguous: true };
  return {
    field,
    value,
    scope,
    updating: updating || /^ahora\b/.test(n),
    proposal,
    taskRequested:
      field === 'active_instructions' &&
      /^(?:ahora\s+)?(?:modifica|ejecuta|mejora|analiza|implementa|crea)\b/.test(
        n,
      ),
  };
}

export function ruleRetirement(text) {
  const m = text.match(
    /^\s*(?:retira|retir[aá]|retirar|deja sin efecto|retire)\s+(?:(?:la|el)\s+)?(?:instrucci[oó]n|restricci[oó]n|preferencia|decisi[oó]n|regla|rule)\s+[«“"]([^»”"]+)[»”"]\s*[.!]?\s*$/i,
  );
  return m ? m[1] : null;
}

/** Análisis local acotado de actos conversacionales. No es un clasificador de verdad.
 * Sus etiquetas son internas, efímeras y nunca autorizan borrar una afirmación.
 */
const DIRECTIVE =
  /\b(no (?:modifiques|cambies|elimines|borres)|no debes|nunca|prohibido|conserva|preserva|mant[eé]n|debes|necesito|quiero|must|do not|never|preserve|keep|please)\b/iu;
const CHANGE =
  /\b(en lugar de|reemplaza|corrijo|correcci[oó]n|ahora (?:usa|quiero)|ya no|instead of|replace|correction|no longer)\b/iu;
const PROPOSAL =
  /\b(propongo|podr[ií]a|quiz[aá]|hip[oó]tesis|sugiero|propuesta|perhaps|might|suggest|hypothesis|propose)\b/iu;
const DECISION =
  /\b(decisi[oó]n confirmada|he decidido|confirmo (?:que|usar)|confirmed decision|i have decided)\b/iu;
const RESULT =
  /\b(resultado|ejecutado|probado|pruebas|error|fall[oó]|bloqueado|result|executed|tested|failed|blocked)\b/iu;
export function conversationalAct(role, text) {
  // Incluso «probado»/«confirmado» en el DOM sólo es una declaración de su emisor.
  const status = PROPOSAL.test(text)
    ? 'proposal-or-hypothesis'
    : 'reported-not-verified';
  const kind = CHANGE.test(text)
    ? 'explicit-change'
    : role === 'user' && DECISION.test(text)
      ? 'user-declared-decision'
      : DIRECTIVE.test(text)
        ? 'directive'
        : RESULT.test(text)
          ? 'reported-result-or-problem'
          : 'context';
  return {
    role,
    kind,
    status,
    authority:
      role === 'user'
        ? 'user-statement'
        : 'assistant-data-not-user-instruction',
  };
}
export function analyzeRelations(messages) {
  // Conservar orden y todas las formulaciones, también contradicciones y modificaciones.
  // No hay evidencia suficiente para invalidar automáticamente mensajes anteriores.
  return messages.map((m, index) => ({
    index,
    ...conversationalAct(m.role, m.content),
    supersession: 'not-assumed',
  }));
}
export function textUnits(text) {
  // Separadores preservados exactamente: también dentro de código y datos técnicos.
  return text
    .split(/(\n[\t ]*\n|(?<=[.!?;])[\t ]+(?=[A-ZÁÉÍÓÚÜÑ¿¡]))/u)
    .filter(Boolean);
}

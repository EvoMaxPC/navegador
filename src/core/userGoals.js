/** Bloque 2: gramática acotada de declaraciones de objetivos; no un modelo semántico. */
export const GOAL_LIMITS = Object.freeze({
  independent: 20,
  candidates: 30,
  events: 200,
});
export const goalKey = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '');
export function goalDirective(text) {
  let m = text.match(
    /^\s*(?:nuevo objetivo independiente|otro objetivo independiente|objetivo independiente|independent goal)\s*:\s*([\s\S]+)$/i,
  );
  if (m) return { type: 'independent', texts: [m[1]] };
  m = text.match(
    /^\s*(?:objetivos independientes|independent goals)\s*:\s*\n([\s\S]+)$/i,
  );
  if (m) {
    const lines = m[1].split('\n').filter((l) => l.trim());
    if (
      !lines.length ||
      lines.length > 10 ||
      lines.some((l) => !/^\s*[-*]\s+\S/.test(l))
    )
      return {
        type: 'ambiguous',
        question:
          'Especificá de 1 a 10 objetivos independientes, uno por línea con guion. No los convertiré en un único objetivo.',
      };
    return {
      type: 'independent',
      texts: lines.map((l) => l.replace(/^\s*[-*]\s+/, '')),
    };
  }
  m = text.match(
    /^\s*(?:objetivo|goal)\s+[«“"]([^»”"]+)[»”"]\s+(completado|terminado|cancelado|completed|cancelled)\s*[.!]?\s*$/i,
  );
  if (m)
    return {
      type: 'transition',
      target: m[1],
      status: /^(complet|termin)/i.test(m[2]) ? 'completed' : 'cancelled',
    };
  if (
    /^\s*(?:(?:mi |el )?objetivo(?: principal)? (?:completado|terminado)|(?:he completado|complet[eé]|termin[eé]) (?:el|mi) objetivo(?: principal)?|(?:my |the )?goal completed)\s*[.!]?\s*$/i.test(
      text,
    )
  )
    return { type: 'transition', status: 'completed' };
  if (
    /^\s*(?:(?:mi |el )?objetivo(?: principal)? cancelado|(?:cancelo|cancel[aá]) (?:el|mi) objetivo(?: principal)?|(?:my |the )?goal cancelled)\s*[.!]?\s*$/i.test(
      text,
    )
  )
    return { type: 'transition', status: 'cancelled' };
  m = text.match(
    /^\s*(?:retomar|retomemos|reabrir|reabr[ií]|resume|reopen) (?:el )?(?:objetivo|goal)\s+[«“"]([^»”"]+)[»”"]\s*[.!]?\s*$/i,
  );
  if (m) return { type: 'transition', target: m[1], status: 'active' };
  if (
    /^\s*(?:retomar|retomemos|reabrir|reabr[ií]) (?:el|mi) objetivo principal\s*[.!]?\s*$/i.test(
      text,
    )
  )
    return { type: 'transition', status: 'active' };
  return null;
}
export function possibleGoal(text) {
  // Una petición operativa («quiero revisar ese archivo») no se eleva a objetivo.
  if (/[?¿]/.test(text) || /^\s*(?:>|```|~~~)/.test(text)) return null;
  return /^\s*(?:(?:quiero|necesito|me gustar[ií]a)\s+(?:crear|construir|desarrollar|lanzar|lograr|conseguir|migrar)\b|(?:I want to|I'd like to|I need to)\s+(?:build|create|develop|launch|achieve|migrate)\b)/i.test(
    text,
  )
    ? {
        text,
        reason:
          'Deseo de resultado reconocido sin declaración inequívoca de objetivo principal. Requiere confirmación del usuario.',
      }
    : null;
}

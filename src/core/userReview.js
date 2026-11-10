/** Revisión humana de interpretaciones locales. No autoriza ni ejecuta acciones. */
export const REVIEW_LIMIT = 100;
export const REVIEW_INTENTS = Object.freeze([
  'request',
  'question',
  'clarification',
  'correction',
  'continuation',
  'independent',
  'approval',
  'rejection',
  'unknown',
]);
export const REVIEW_RELATIONS = Object.freeze([
  'current-work',
  'independent',
  'unresolved-reference',
  'unknown',
]);
const text = (s, max) => typeof s === 'string' && !!s.trim() && s.length <= max;
const origin = (o) =>
  o &&
  o.role === 'user' &&
  typeof o.channel === 'string' &&
  o.channel.length <= 100 &&
  typeof o.message_id === 'string' &&
  o.message_id.length <= 200 &&
  typeof o.url === 'string' &&
  o.url.length <= 2048;
const actions = [
  'request-confirmed',
  'request-corrected',
  'request-rejected',
  'entry-corrected',
  'interaction-corrected',
];
export function validateReview(s, fail) {
  const events = s.review_events === undefined ? [] : s.review_events;
  if (!Array.isArray(events) || events.length > REVIEW_LIMIT)
    fail('Historia de revisión inválida');
  const ids = new Set();
  const entries = [
    s.current_task,
    ...s.instruction_history,
    ...s.subgoals,
    ...s.relevant_context,
    ...s.progress,
  ].filter(Boolean);
  const sameOrigin = (a, b) =>
    ['role', 'channel', 'message_id', 'url'].every((k) => a?.[k] === b?.[k]);
  for (const e of events) {
    if (
      !e ||
      !text(e.id, 150) ||
      ids.has(e.id) ||
      !actions.includes(e.action) ||
      !text(e.target_id, 200) ||
      !(e.replacement_id === null || text(e.replacement_id, 150)) ||
      !text(e.reason, 10000) ||
      !text(e.before_label, 2000) ||
      !text(e.after_label, 2000) ||
      !origin(e.origin) ||
      !origin(e.source_origin) ||
      !Number.isFinite(e.at) ||
      e.verified !== false
    )
      fail('Evento de revisión inválido');
    if (e.action !== 'interaction-corrected') {
      const target = entries.find((v) => v.id === e.target_id);
      if (
        !target ||
        !sameOrigin(e.source_origin, target.origin) ||
        (e.replacement_id !== null &&
          !entries.some((v) => v.id === e.replacement_id)) ||
        (e.action === 'request-rejected'
          ? e.replacement_id !== null
          : e.replacement_id === null) ||
        (e.action === 'request-confirmed' && e.replacement_id !== e.target_id)
      )
        fail('Referencia histórica de revisión inválida');
    }
    ids.add(e.id);
  }
  const r = s.interaction_review;
  if (
    r !== undefined &&
    r !== null &&
    (!r ||
      !s.last_interaction ||
      r.source_message_id !== s.last_interaction.origin.message_id ||
      r.source_at !== s.last_interaction.at ||
      !REVIEW_INTENTS.includes(r.intent) ||
      !REVIEW_RELATIONS.includes(r.relation) ||
      !text(r.reason, 10000) ||
      !origin(r.origin) ||
      !Number.isFinite(r.at) ||
      r.verified !== false)
  )
    fail('Corrección de intención inválida');
  if (
    r &&
    !events.some(
      (e) =>
        e.action === 'interaction-corrected' &&
        e.at === r.at &&
        e.reason === r.reason &&
        e.source_origin.message_id === r.source_message_id &&
        sameOrigin(e.origin, r.origin) &&
        e.after_label ===
          JSON.stringify({ intent: r.intent, relation: r.relation }),
    )
  )
    fail('Falta historia de la corrección de intención');
}
export function appendReview(s, values, { makeEntry, fail, origin, now }) {
  s.review_events ||= [];
  if (s.review_events.length >= REVIEW_LIMIT)
    fail('Límite de revisiones; no se podará la historia', 'limit');
  if (!text(values.reason, 10000))
    fail('Motivo requerido; máximo 10.000 caracteres');
  const e = makeEntry('revisión humana');
  s.review_events.push({
    id: `re-${e.id}`,
    ...values,
    origin,
    at: now,
    verified: false,
  });
}

/** Seguimiento y evidencia declarados. Nunca certifica ejecución ni concede autoridad. */
export const WORK_LIMITS = Object.freeze({
  records: 100,
  evidence: 150,
  events: 300,
  text: 10000,
});
export const WORK_KINDS = Object.freeze([
  'advance',
  'result',
  'error',
  'blocker',
  'proposal',
]);
export const WORK_OPERATIONS = Object.freeze([
  'work-add',
  'work-transition',
  'work-evidence',
  'work-evidence-withdraw',
]);
const statuses = {
  advance: ['open', 'withdrawn'],
  result: ['open', 'withdrawn'],
  error: ['open', 'resolved', 'withdrawn'],
  blocker: ['open', 'resolved', 'withdrawn'],
  proposal: ['open', 'accepted', 'rejected', 'withdrawn'],
};
const outcomes = ['success', 'partial', 'failure', 'unknown'];
const text = (v, max = WORK_LIMITS.text) =>
  typeof v === 'string' && !!v.trim() && v.length <= max;
const id = (v) => text(v, 150);
const origin = (o) =>
  o &&
  o.role === 'user' &&
  typeof o.channel === 'string' &&
  o.channel.length <= 100 &&
  typeof o.message_id === 'string' &&
  o.message_id.length <= 200 &&
  typeof o.url === 'string' &&
  o.url.length <= 2048;
const goals = (s) =>
  [
    s.user_goal,
    ...(s.independent_goals || []),
    ...(s.goal_history || []),
  ].filter(Boolean);
const sourceOK = (s) =>
  s &&
  (s.role === 'user'
    ? origin(s)
    : s.role === 'assistant' &&
      s.channel === 'conversation-read' &&
      text(s.message_id, 256) &&
      text(s.context_id, 150) &&
      /^[a-f0-9]{64}$/.test(s.digest) &&
      typeof s.url === 'string' &&
      s.url.length <= 2048 &&
      Number.isSafeInteger(s.observation_revision) &&
      s.observation_revision >= 0 &&
      Number.isFinite(s.observed_at));
export function validateWork(state, fail) {
  const records = state.work_records === undefined ? [] : state.work_records,
    evidence = state.work_evidence === undefined ? [] : state.work_evidence,
    events = state.work_events === undefined ? [] : state.work_events;
  if (
    !Array.isArray(records) ||
    records.length > WORK_LIMITS.records ||
    !Array.isArray(evidence) ||
    evidence.length > WORK_LIMITS.evidence ||
    !Array.isArray(events) ||
    events.length > WORK_LIMITS.events
  )
    fail('Registro de seguimiento inválido');
  const ids = new Set(),
    recordIds = new Set(records.map((r) => r?.id)),
    evidenceIds = new Set(evidence.map((e) => e?.id));
  const unique = (v) => {
    if (!id(v) || ids.has(v)) fail('Identidad de seguimiento inválida');
    ids.add(v);
  };
  for (const r of records) {
    unique(r?.id);
    if (
      !WORK_KINDS.includes(r.kind) ||
      !statuses[r.kind].includes(r.status) ||
      !text(r.text) ||
      r.verified !== false ||
      r.authority !== 'tracking-data-only' ||
      !origin(r.origin) ||
      !sourceOK(r.source) ||
      !Number.isFinite(r.created_at) ||
      !Number.isFinite(r.updated_at) ||
      r.updated_at < r.created_at ||
      !(
        r.task_id === null ||
        (state.tasks || []).some((t) => t.id === r.task_id)
      ) ||
      !(r.goal_id === null || goals(state).some((g) => g.id === r.goal_id)) ||
      !(r.kind === 'result'
        ? outcomes.includes(r.outcome)
        : r.outcome === null) ||
      r.certainty !==
        (r.source.role === 'assistant'
          ? 'observed-not-verified'
          : 'explicit') ||
      (r.source.role === 'assistant' &&
        (!['proposal', 'result'].includes(r.kind) || r.text.length > 1000))
    )
      fail('Entrada de seguimiento inválida');
  }
  for (const e of evidence) {
    unique(e?.id);
    if (
      !recordIds.has(e.record_id) ||
      !text(e.text) ||
      !['user-report', 'supplied-artifact'].includes(e.kind) ||
      !(e.locator === null || text(e.locator, 2048)) ||
      !['active', 'withdrawn'].includes(e.status) ||
      !origin(e.origin) ||
      !Number.isFinite(e.created_at) ||
      !Number.isFinite(e.updated_at) ||
      e.updated_at < e.created_at ||
      e.verified !== false ||
      e.authority !== 'evidence-data-only'
    )
      fail('Evidencia declarada inválida');
  }
  for (const e of events) {
    unique(e?.id);
    const r = records.find((r) => r.id === e.target_id),
      isRecord = !!r;
    const allowed = isRecord ? statuses[r.kind] : ['active', 'withdrawn'];
    if (
      (!recordIds.has(e.target_id) && !evidenceIds.has(e.target_id)) ||
      !['created', 'transition'].includes(e.action) ||
      !origin(e.origin) ||
      !Number.isFinite(e.at) ||
      !text(e.reason) ||
      !allowed.includes(e.to) ||
      (e.action === 'created'
        ? e.from !== null
        : !allowed.includes(e.from) ||
          e.from === e.to ||
          e.from === 'withdrawn' ||
          (r?.kind === 'proposal' && e.from !== 'open' && e.to !== 'withdrawn'))
    )
      fail('Evento de seguimiento inválido');
  }
  // La historia y el estado actual deben coincidir; nunca se podan eventos.
  for (const r of [...records, ...evidence]) {
    const chain = events.filter((e) => e.target_id === r.id);
    let current = null;
    let lastAt = r.created_at;
    for (const [i, e] of chain.entries()) {
      if (
        (i === 0 ? e.action !== 'created' : e.action !== 'transition') ||
        e.from !== current ||
        e.at < lastAt ||
        (i === 0 &&
          (e.at !== r.created_at ||
            e.to !== (recordIds.has(r.id) ? 'open' : 'active')))
      )
        fail('Historia de seguimiento incompatible');
      current = e.to;
      lastAt = e.at;
    }
    if (!chain.length || current !== r.status || lastAt !== r.updated_at)
      fail('Historia de seguimiento incompleta');
  }
}
export function applyWorkOperation(
  state,
  op,
  { fail, makeEntry, origin: who, now, source = null },
) {
  const d = {
    ...state,
    work_records: structuredClone(state.work_records || []),
    work_evidence: structuredClone(state.work_evidence || []),
    work_events: structuredClone(state.work_events || []),
  };
  const needText = (v) => {
    if (!text(v))
      fail(
        `Texto requerido; máximo ${WORK_LIMITS.text} caracteres, sin recorte`,
      );
    return v;
  };
  const event = (target, from, to, reason) => {
    if (d.work_events.length >= WORK_LIMITS.events)
      fail('Límite de eventos de seguimiento; no se podará historia', 'limit');
    const e = makeEntry('evento de seguimiento');
    d.work_events.push({
      id: `we-${e.id}`,
      target_id: target.id,
      action: from === null ? 'created' : 'transition',
      from,
      to,
      reason: needText(reason),
      origin: who,
      at: now,
    });
  };
  if (op.type === 'work-add') {
    if (d.work_records.length >= WORK_LIMITS.records)
      fail('Límite de entradas de seguimiento; no se podarán', 'limit');
    if (!WORK_KINDS.includes(op.kind)) fail('Tipo de seguimiento inválido');
    const taskId = op.task_id ?? null,
      goalId = op.goal_id ?? null;
    if (taskId !== null && !(d.tasks || []).some((t) => t.id === taskId))
      fail('No identifico la tarea indicada', 'reference');
    if (goalId !== null && !goals(d).some((g) => g.id === goalId))
      fail('No identifico el objetivo indicado', 'reference');
    const body = needText(op.text);
    if (
      source &&
      (!['proposal', 'result'].includes(op.kind) || body.length > 1000)
    )
      fail('Captura observacional inválida');
    if (
      source &&
      d.work_records.some(
        (r) =>
          r.source.role === 'assistant' &&
          r.source.context_id === source.context_id &&
          r.source.message_id === source.message_id &&
          r.source.digest === source.digest &&
          r.kind === op.kind,
      )
    )
      fail(
        'Esta versión del asistente ya fue registrada; no se reintroducirá',
        'conflict',
      );
    const e = makeEntry(body),
      r = {
        id: `wr-${e.id}`,
        kind: op.kind,
        text: body,
        task_id: taskId,
        goal_id: goalId,
        outcome: op.kind === 'result' ? (op.outcome ?? 'unknown') : null,
        status: 'open',
        verified: false,
        authority: 'tracking-data-only',
        certainty: source ? 'observed-not-verified' : 'explicit',
        source: source || who,
        origin: who,
        created_at: now,
        updated_at: now,
      };
    d.work_records.push(r);
    event(
      r,
      null,
      'open',
      'Registrado explícitamente; sin verificación de ejecución',
    );
  } else if (op.type === 'work-transition') {
    const r = d.work_records.find((r) => r.id === op.id);
    if (!r) fail('Entrada de seguimiento no disponible', 'reference');
    if (
      !statuses[r.kind].includes(op.status) ||
      r.status === op.status ||
      r.status === 'withdrawn'
    )
      fail('Transición de seguimiento inválida', 'conflict');
    // Aceptar/rechazar sólo una propuesta abierta; resolver/reabrir problemas no cierra tareas.
    if (
      r.kind === 'proposal' &&
      r.status !== 'open' &&
      op.status !== 'withdrawn'
    )
      fail('La propuesta ya fue resuelta', 'conflict');
    const before = r.status;
    r.status = op.status;
    r.updated_at = now;
    event(r, before, r.status, op.reason);
  } else if (op.type === 'work-evidence') {
    const r = d.work_records.find(
      (r) => r.id === op.record_id && r.status !== 'withdrawn',
    );
    if (!r) fail('Entrada retirada o no disponible', 'reference');
    if (d.work_evidence.length >= WORK_LIMITS.evidence)
      fail('Límite de evidencia; no se podará', 'limit');
    const e = makeEntry(needText(op.text)),
      v = {
        id: `wv-${e.id}`,
        record_id: r.id,
        text: op.text,
        kind: op.kind,
        locator: op.locator ?? null,
        status: 'active',
        verified: false,
        authority: 'evidence-data-only',
        origin: who,
        created_at: now,
        updated_at: now,
      };
    d.work_evidence.push(v);
    event(
      v,
      null,
      'active',
      'Aporte del usuario; no se abrió ni ejecutó el recurso',
    );
  } else if (op.type === 'work-evidence-withdraw') {
    const e = d.work_evidence.find(
      (e) => e.id === op.id && e.status === 'active',
    );
    if (!e) fail('Evidencia ya retirada o no disponible', 'conflict');
    e.status = 'withdrawn';
    e.updated_at = now;
    event(e, 'active', 'withdrawn', op.reason);
  } else fail('Operación de seguimiento inválida');
  validateWork(d, fail);
  for (const k of ['work_records', 'work_evidence', 'work_events'])
    state[k] = d[k];
}
export function workProjection(s) {
  const records = (s.work_records || []).filter(
    (r) => r.status !== 'withdrawn',
  );
  const evidence = (s.work_evidence || []).filter(
    (e) => e.status === 'active' && records.some((r) => r.id === e.record_id),
  );
  return {
    records,
    evidence,
    open_problems: records.filter(
      (r) => ['error', 'blocker'].includes(r.kind) && r.status === 'open',
    ),
    pending_proposals: records.filter(
      (r) => r.kind === 'proposal' && r.status === 'open',
    ),
    results: records.filter((r) => r.kind === 'result'),
    without_evidence: records
      .filter(
        (r) =>
          r.kind === 'result' && !evidence.some((e) => e.record_id === r.id),
      )
      .map((r) => r.id),
    task_counts: Object.fromEntries(
      ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'].map(
        (status) => [
          status,
          (s.tasks || []).filter((t) => t.status === status).length,
        ],
      ),
    ),
    verified: false,
    authority: 'tracking-data-only',
  };
}
/** Gramática deliberadamente explícita, sin interpretar texto citado/código como acciones. */
export function workDirective(text) {
  const m = text.match(
    /^\s*(avance registrado|resultado|error observado|problema pendiente|bloqueo|propuesta de trabajo|recorded progress|result|observed error|blocker|work proposal)\s*:\s*([^\n]+)\s*$/i,
  );
  if (!m || /[?¿]/.test(text) || /[`]|^\s*[>«“"]/.test(m[2])) return null;
  const k = m[1].toLowerCase();
  return {
    type: 'work-add',
    kind: /^(avance registrado|recorded progress)$/.test(k)
      ? 'advance'
      : /^(resultado|result)$/.test(k)
        ? 'result'
        : /^(bloqueo|blocker)$/.test(k)
          ? 'blocker'
          : /^(propuesta|work proposal)/.test(k)
            ? 'proposal'
            : 'error',
    text: m[2],
    outcome: 'unknown',
  };
}

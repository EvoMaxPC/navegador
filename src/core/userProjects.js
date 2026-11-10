/** Etapa 5: etiquetas locales y referencias sin autoridad normativa ni ejecución. */
export const PROJECT_LIMITS = Object.freeze({
  history: 50,
  references: 30,
  events: 200,
});
export const ENTITY_KINDS = Object.freeze([
  'file',
  'document',
  'component',
  'note',
]);
const key = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const text = (s, max) => typeof s === 'string' && !!s.trim() && s.length <= max;
const id = (s) => text(s, 150);
const origin = (o) =>
  o &&
  o.role === 'user' &&
  typeof o.channel === 'string' &&
  o.channel.length <= 100 &&
  typeof o.message_id === 'string' &&
  o.message_id.length <= 200 &&
  typeof o.url === 'string' &&
  o.url.length <= 2048;
export function validateProjects(s, fail) {
  function profile(p) {
    if (
      !p ||
      !text(p.name, 200) ||
      typeof p.description !== 'string' ||
      p.description.length > 10000 ||
      !origin(p.origin) ||
      !Number.isFinite(p.created_at) ||
      !Number.isFinite(p.updated_at)
    )
      fail('Proyecto local inválido');
  }
  if (s.project !== undefined && s.project !== null) profile(s.project);
  if (s.project_history !== undefined) {
    if (
      !Array.isArray(s.project_history) ||
      s.project_history.length > PROJECT_LIMITS.history
    )
      fail('Historia de proyecto inválida');
    for (const p of s.project_history) {
      profile(p);
      if (!origin(p.changed_by) || !Number.isFinite(p.changed_at))
        fail('Cambio de proyecto inválido');
    }
  }
  if (s.context_references !== undefined) {
    if (
      !Array.isArray(s.context_references) ||
      s.context_references.length > PROJECT_LIMITS.references
    )
      fail('Referencias de contexto inválidas');
    const ids = new Set();
    for (const r of s.context_references) {
      if (
        !r ||
        !id(r.id) ||
        ids.has(r.id) ||
        !/^c-[a-f0-9]{32}$/.test(r.source_context_id) ||
        r.source_context_id === s.context_id ||
        !/^([a-f0-9]{64})$/.test(r.source_digest) ||
        !Number.isSafeInteger(r.source_revision) ||
        r.source_revision < 0 ||
        !['summary', 'entry'].includes(r.target_kind) ||
        (r.target_kind === 'entry' ? !id(r.target_id) : r.target_id !== null) ||
        !text(r.label, 200) ||
        !['pending', 'linked', 'rejected', 'retired'].includes(r.status) ||
        r.authority !== 'reference-data-only' ||
        r.verified !== false ||
        !origin(r.origin) ||
        !Number.isFinite(r.created_at) ||
        !Number.isFinite(r.updated_at)
      )
        fail('Puntero de contexto inválido');
      ids.add(r.id);
    }
  }
  if (s.context_events !== undefined) {
    if (
      !Array.isArray(s.context_events) ||
      s.context_events.length > PROJECT_LIMITS.events
    )
      fail('Historia de referencias inválida');
    const ids = new Set();
    for (const e of s.context_events) {
      if (
        !e ||
        !id(e.id) ||
        ids.has(e.id) ||
        !(s.context_references || []).some((r) => r.id === e.reference_id) ||
        !['proposed', 'linked', 'rejected', 'retired', 'refreshed'].includes(
          e.action,
        ) ||
        !/^([a-f0-9]{64})$/.test(e.source_digest) ||
        !Number.isSafeInteger(e.source_revision) ||
        e.source_revision < 0 ||
        !origin(e.origin) ||
        !Number.isFinite(e.at)
      )
        fail('Evento de referencia inválido');
      ids.add(e.id);
    }
  }
  for (const e of [...s.relevant_context, ...s.instruction_history])
    if (
      e.entity !== undefined &&
      (!e.entity ||
        !text(e.entity.alias, 200) ||
        !ENTITY_KINDS.includes(e.entity.kind))
    )
      fail('Referencia nombrada inválida');
  const aliases = new Set();
  for (const e of s.relevant_context.filter(
    (e) => e.status === 'active' && e.entity,
  )) {
    const name = key(e.entity.alias);
    if (aliases.has(name)) fail('Alias actual duplicado');
    aliases.add(name);
  }
  if (
    s.selected_reference_id !== undefined &&
    s.selected_reference_id !== null &&
    !s.relevant_context.some(
      (e) =>
        e.id === s.selected_reference_id && e.status === 'active' && e.entity,
    )
  )
    fail('Selección de referencia inválida');
}
export function applyProjectOperation(state, op, api) {
  const { fail, makeEntry, origin: who, now } = api,
    d = structuredClone(state);
  d.project_history ||= [];
  d.context_references ||= [];
  d.context_events ||= [];
  function event(r, action) {
    if (d.context_events.length >= PROJECT_LIMITS.events)
      fail('Límite de historia de referencias; no se podará', 'limit');
    const e = makeEntry('evento de referencia');
    d.context_events.push({
      id: `ce-${e.id}`,
      reference_id: r.id,
      action,
      source_revision: r.source_revision,
      source_digest: r.source_digest,
      origin: who,
      at: now,
    });
  }
  switch (op.type) {
    case 'project': {
      if (
        op.name !== null &&
        (!text(op.name, 200) ||
          typeof (op.description ?? '') !== 'string' ||
          (op.description ?? '').length > 10000)
      )
        fail('Nombre de hasta 200 caracteres y descripción de hasta 10000');
      if (
        d.project?.name === op.name &&
        d.project?.description === (op.description ?? '')
      )
        break;
      if (d.project) {
        if (d.project_history.length >= PROJECT_LIMITS.history)
          fail('Límite de historia de proyecto', 'limit');
        d.project_history.push({
          ...d.project,
          changed_by: who,
          changed_at: now,
        });
      }
      d.project =
        op.name === null
          ? null
          : {
              name: op.name,
              description: op.description ?? '',
              origin: who,
              created_at: now,
              updated_at: now,
            };
      break;
    }
    case 'context-item': {
      if (
        !text(op.alias, 200) ||
        !ENTITY_KINDS.includes(op.kind) ||
        !text(op.text, 200000)
      )
        fail('Alias, tipo y texto de referencia requeridos');
      const matches = d.relevant_context.filter(
        (e) =>
          e.status === 'active' &&
          e.entity &&
          key(e.entity.alias) === key(op.alias),
      );
      if (matches.length) {
        if (
          matches.length === 1 &&
          matches[0].text === op.text &&
          matches[0].entity.kind === op.kind
        )
          break;
        fail(
          'El alias ya identifica una referencia vigente. Retirala explícitamente antes de reutilizarlo.',
          'conflict',
        );
      }
      if (d.relevant_context.length >= 200)
        fail('Límite de contexto; no se podarán referencias', 'limit');
      const e = makeEntry(op.text);
      e.entity = { alias: op.alias, kind: op.kind };
      d.relevant_context.push(e);
      break;
    }
    case 'context-select': {
      const matches = d.relevant_context.filter(
        (e) =>
          e.status === 'active' &&
          e.entity &&
          (op.id !== undefined
            ? e.id === op.id
            : key(e.entity.alias) === key(op.alias || '')),
      );
      if (op.id === null) d.selected_reference_id = null;
      else {
        if (matches.length !== 1)
          fail(
            'No identifico una única referencia actual; seleccionala en el panel.',
            'reference',
          );
        d.selected_reference_id = matches[0].id;
      }
      break;
    }
    case 'context-reference': {
      const ref = op.reference;
      if (!ref || ref.source_context_id === state.context_id)
        fail('Elegí otro contexto como antecedente');
      if (
        d.context_references.some(
          (r) =>
            r.source_context_id === ref.source_context_id &&
            r.target_kind === ref.target_kind &&
            r.target_id === ref.target_id &&
            ['pending', 'linked'].includes(r.status),
        )
      )
        break;
      if (d.context_references.length >= PROJECT_LIMITS.references)
        fail('Límite de antecedentes; no se podarán', 'limit');
      const e = makeEntry('referencia a contexto');
      const r = {
        ...ref,
        id: e.id,
        status: 'pending',
        authority: 'reference-data-only',
        verified: false,
        origin: who,
        created_at: now,
        updated_at: now,
      };
      d.context_references.push(r);
      event(r, 'proposed');
      break;
    }
    case 'context-reference-resolve':
    case 'context-reference-refresh': {
      const r = d.context_references.find((r) => r.id === op.id);
      if (!r) fail('Referencia ya no disponible', 'reference');
      if (op.type === 'context-reference-refresh') {
        if (['rejected', 'retired'].includes(r.status))
          fail(
            'No se reactivan referencias rechazadas o retiradas',
            'conflict',
          );
        r.source_revision = op.source_revision;
        r.source_digest = op.source_digest;
        r.status = 'pending';
        r.updated_at = now;
        event(r, 'refreshed');
        break;
      }
      if (!['confirm', 'reject', 'retire'].includes(op.action))
        fail('Acción de referencia inválida');
      if (
        (['confirm', 'reject'].includes(op.action) && r.status !== 'pending') ||
        (op.action === 'retire' && r.status !== 'linked')
      )
        fail('La referencia cambió de estado', 'conflict');
      r.status = { confirm: 'linked', reject: 'rejected', retire: 'retired' }[
        op.action
      ];
      r.updated_at = now;
      event(r, r.status);
      break;
    }
    default:
      fail('Operación de contexto inválida');
  }
  validateProjects(d, fail);
  for (const field of [
    'project',
    'project_history',
    'context_references',
    'context_events',
    'selected_reference_id',
    'relevant_context',
  ])
    if (d[field] !== undefined) state[field] = d[field];
}
export function projectDirective(text) {
  let m = text.match(
    /^\s*(proyecto|project|renombrar proyecto)\s*:\s*([^\n]+)$/i,
  );
  if (m)
    return { type: 'project', name: m[2], rename: /renombrar/i.test(m[1]) };
  m = text.match(
    /^\s*(?:referencia actual|current reference) [«“"]([^»”"]+)[»”"]\s*:\s*([\s\S]+)$/i,
  );
  if (m) return { type: 'context-item', alias: m[1], kind: 'note', text: m[2] };
  m = text.match(
    /^\s*(?:usar referencia|use reference) [«“"]([^»”"]+)[»”"]\s*[.!]?\s*$/i,
  );
  if (m) return { type: 'context-select', alias: m[1] };
  return null;
}

/** Resumen local de datos de usuario; no incluye respuestas del asistente ni copia transcript. */
export function contextItems(state) {
  const entries = [];
  for (const e of [state.user_goal, ...(state.independent_goals || [])].filter(
    Boolean,
  ))
    entries.push({ kind: 'goal', entry: e });
  for (const e of state.tasks || []) entries.push({ kind: 'task', entry: e });
  for (const field of [
    'explicit_constraints',
    'active_instructions',
    'confirmed_decisions',
    'preferences',
    'relevant_context',
  ])
    for (const e of state[field]) entries.push({ kind: field, entry: e });
  return entries;
}
export function contextPreview(row, targetKind = 'summary', targetId = null) {
  const s = row.state;
  const item =
    targetKind === 'entry'
      ? contextItems(s).find((i) => i.entry.id === targetId)
      : null;
  if (targetKind === 'entry' && !item) return null;
  const raw = item
    ? item.entry.text
    : [s.project?.name, s.project?.description, s.user_goal?.text]
        .filter(Boolean)
        .join('\n') || 'Sin objetivo ni etiqueta explícitos';
  return {
    source_context_id: s.context_id,
    source_revision: s.revision,
    target_kind: targetKind,
    target_id: targetKind === 'entry' ? targetId : null,
    label: (
      item?.entry.text ||
      s.project?.name ||
      s.user_goal?.text ||
      'Contexto sin etiqueta'
    ).slice(0, 200),
    preview: raw.slice(0, 1000),
    preview_clipped: raw.length > 1000,
    chars: raw.length,
    kind: item?.kind || 'summary',
    status: item?.entry.status || 'context',
    certainty: item?.entry.certainty || 'reference-data-only',
    origin: item?.entry.origin || s.project?.origin || null,
    url: row.url,
    verified: false,
    authority: 'reference-data-only',
  };
}

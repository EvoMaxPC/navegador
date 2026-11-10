/** Seguimiento explícito UUE: no planificador ejecutor ni evidencia externa. */
export const TASK_LIMITS = Object.freeze({
  tasks: 100,
  events: 200,
  dependencies: 10,
});
export const TASK_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
]);
export const TASK_PRIORITIES = Object.freeze([
  'unset',
  'high',
  'normal',
  'low',
]);
export const TASK_OPERATIONS = Object.freeze([
  'task-add',
  'task-update',
  'task-transition',
  'task-focus',
  'task-next',
  'task-order',
]);
const key = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '');
const open = (t) => !['completed', 'cancelled'].includes(t.status);
const validId = (id) =>
  typeof id === 'string' && id.length > 0 && id.length <= 150;
const textOK = (text) =>
  typeof text === 'string' && !!text.trim() && text.length <= 200000;
const originOK = (o) =>
  o &&
  o.role === 'user' &&
  typeof o.channel === 'string' &&
  o.channel.length <= 100 &&
  typeof o.message_id === 'string' &&
  o.message_id.length <= 200 &&
  typeof o.url === 'string' &&
  o.url.length <= 2048;
const goals = (state) =>
  [
    state.user_goal,
    ...(state.independent_goals || []),
    ...state.goal_history,
  ].filter(Boolean);

/** Las aristas expresan requisitos: dependencias y subtareas antes de completar el padre. */
export function validateTasks(state, fail) {
  const tasks = state.tasks === undefined ? [] : state.tasks,
    events = state.task_events === undefined ? [] : state.task_events;
  if (
    !Array.isArray(tasks) ||
    tasks.length > TASK_LIMITS.tasks ||
    !Array.isArray(events) ||
    events.length > TASK_LIMITS.events
  )
    fail('Registro de tareas inválido');
  const ids = new Set();
  for (const t of tasks) {
    if (
      !t ||
      !validId(t.id) ||
      ids.has(t.id) ||
      !textOK(t.text) ||
      !TASK_STATUSES.includes(t.status) ||
      !TASK_PRIORITIES.includes(t.task_priority) ||
      !['explicit', 'confirmed'].includes(t.certainty) ||
      t.scope !== 'project' ||
      t.priority !== 7 ||
      !originOK(t.origin) ||
      !Number.isFinite(t.created_at) ||
      !Number.isFinite(t.updated_at) ||
      !(t.parent_id === null || validId(t.parent_id)) ||
      !(t.goal_id === null || validId(t.goal_id)) ||
      !Array.isArray(t.depends_on) ||
      t.depends_on.length > TASK_LIMITS.dependencies ||
      new Set(t.depends_on).size !== t.depends_on.length ||
      t.depends_on.some((id) => !validId(id)) ||
      !(t.expected_result === null || textOK(t.expected_result)) ||
      !(t.block_reason === null || textOK(t.block_reason))
    )
      fail('Tarea inválida');
    if (t.status !== 'blocked' && t.block_reason !== null)
      fail('Bloqueo incoherente con el estado');
    if (t.status === 'blocked' && !t.block_reason)
      fail('Falta el bloqueo declarado');
    if (
      t.resolution !== undefined &&
      (!t.resolution ||
        t.resolution.kind !== 'user-declaration' ||
        t.resolution.verified !== false ||
        !originOK(t.resolution.origin) ||
        !Number.isFinite(t.resolution.at))
    )
      fail('Declaración de estado inválida');
    if (t.status !== 'pending' && !t.resolution)
      fail('Estado sin declaración de usuario');
    ids.add(t.id);
  }
  const byId = new Map(tasks.map((t) => [t.id, t])),
    knownGoals = new Map(goals(state).map((g) => [g.id, g]));
  for (const t of tasks) {
    if (
      (t.parent_id && !ids.has(t.parent_id)) ||
      t.depends_on.some((id) => !ids.has(id)) ||
      (t.goal_id && !knownGoals.has(t.goal_id))
    )
      fail('Referencia de tarea inexistente');
  }
  const colors = new Map();
  function visit(id) {
    if (colors.get(id) === 1) fail('La relación crea un ciclo entre tareas');
    if (colors.get(id) === 2) return;
    colors.set(id, 1);
    const t = byId.get(id);
    for (const ref of [
      ...t.depends_on,
      ...tasks.filter((c) => c.parent_id === id).map((c) => c.id),
    ])
      visit(ref);
    colors.set(id, 2);
  }
  for (const t of tasks) visit(t.id);
  for (const t of tasks) {
    let parent = t.parent_id;
    while (parent) {
      const p = byId.get(parent);
      if (p.goal_id && t.goal_id && p.goal_id !== t.goal_id)
        fail('La subtarea y su ancestro pertenecen a objetivos distintos');
      parent = p.parent_id;
    }
  }
  for (const field of ['focused_task_id'])
    if (
      state[field] !== undefined &&
      state[field] !== null &&
      !ids.has(state[field])
    )
      fail('Foco de tarea inválido');
  if (
    state.next_step !== undefined &&
    state.next_step !== null &&
    (!ids.has(state.next_step.task_id) ||
      !originOK(state.next_step.origin) ||
      !Number.isFinite(state.next_step.at))
  )
    fail('Próximo paso inválido');
  const actions = [
    'created',
    'updated',
    'status-changed',
    'focused',
    'next-step-set',
    'next-step-cleared',
    'reordered',
  ];
  const fields = [
    'text',
    'parent_id',
    'goal_id',
    'depends_on',
    'task_priority',
    'expected_result',
    'status',
    'block_reason',
    'focused_task_id',
    'next_task_id',
    'order',
  ];
  const eventIds = new Set();
  for (const e of events) {
    if (
      !e ||
      !validId(e.id) ||
      eventIds.has(e.id) ||
      !(e.task_id === null || ids.has(e.task_id)) ||
      !actions.includes(e.action) ||
      !Number.isFinite(e.at) ||
      !originOK(e.origin) ||
      !Array.isArray(e.changes) ||
      e.changes.length > 10
    )
      fail('Evento de tarea inválido');
    for (const c of e.changes) {
      if (!c || !fields.includes(c.field))
        fail('Campo histórico de tarea inválido');
      const validValue = (v) => {
        if (c.field === 'status') return TASK_STATUSES.includes(v);
        if (c.field === 'task_priority') return TASK_PRIORITIES.includes(v);
        if (['depends_on', 'order'].includes(c.field))
          return (
            Array.isArray(v) &&
            v.length <=
              (c.field === 'order'
                ? TASK_LIMITS.tasks
                : TASK_LIMITS.dependencies) &&
            new Set(v).size === v.length &&
            v.every((id) => ids.has(id))
          );
        if (c.field === 'goal_id') return v === null || knownGoals.has(v);
        if (['parent_id', 'focused_task_id', 'next_task_id'].includes(c.field))
          return v === null || ids.has(v);
        if (c.field === 'text') return textOK(v);
        return v === null || textOK(v);
      };
      if (!validValue(c.from) || !validValue(c.to))
        fail('Cambio histórico de tarea inválido');
    }
    eventIds.add(e.id);
  }
}

/** Sólo elegibilidad estructural, nunca permiso de ejecución ni comprobación factual. */
export function taskProjection(state) {
  const tasks = state.tasks || [],
    byId = new Map(tasks.map((t) => [t.id, t])),
    knownGoals = new Map(goals(state).map((g) => [g.id, g]));
  const satisfiedMemo = new Map();
  function satisfied(id) {
    if (satisfiedMemo.has(id)) return satisfiedMemo.get(id);
    const t = byId.get(id);
    const ok =
      t?.status === 'completed' &&
      t.depends_on.every(satisfied) &&
      tasks.filter((c) => c.parent_id === id).every((c) => satisfied(c.id));
    satisfiedMemo.set(id, ok);
    return ok;
  }
  const eligibility = tasks.map((t) => {
    const reasons = [];
    if (!open(t)) reasons.push('closed');
    if (t.status === 'blocked') reasons.push('user-blocked');
    if (t.depends_on.some((id) => !satisfied(id)))
      reasons.push('unfinished-dependencies');
    let current = t;
    while (current) {
      if (
        current.goal_id &&
        knownGoals.get(current.goal_id)?.status !== 'active'
      )
        reasons.push('closed-goal');
      if (
        current.id !== t.id &&
        (!open(current) || current.status === 'blocked')
      )
        reasons.push('unavailable-parent');
      current = byId.get(current.parent_id);
    }
    return {
      task_id: t.id,
      subtasks_complete: tasks
        .filter((c) => c.parent_id === t.id)
        .every((c) => satisfied(c.id)),
      eligible: reasons.length === 0,
      reasons: [...new Set(reasons)],
    };
  });
  return {
    tasks,
    eligibility,
    focused_task: byId.get(state.focused_task_id) || null,
    next_step: state.next_step
      ? { ...state.next_step, task: byId.get(state.next_step.task_id) }
      : null,
  };
}

/** Transacción local: sólo publica grafo/eventos cuando toda la operación es válida. */
export function applyTaskOperation(state, operation, api) {
  const { fail, makeEntry, origin, now } = api;
  const draft = {
    ...state,
    tasks: structuredClone(state.tasks || []),
    task_events: structuredClone(state.task_events || []),
    focused_task_id: state.focused_task_id ?? null,
    next_step: structuredClone(state.next_step ?? null),
  };
  const tasks = draft.tasks;
  function find(id) {
    const t = tasks.find((t) => t.id === id);
    if (!t) fail('No se identifica una tarea disponible', 'reference');
    return t;
  }
  function ref(text) {
    const matches = tasks.filter((t) => key(t.text) === key(text));
    if (matches.length !== 1)
      fail(
        'No identifico una única tarea con ese texto. Elegila por ID en el panel.',
        'reference',
      );
    return matches[0].id;
  }
  function event(task, action, changes = []) {
    if (draft.task_events.length >= TASK_LIMITS.events)
      fail('Límite de eventos de tareas; no se podará la historia', 'limit');
    const e = makeEntry('evento de tarea');
    draft.task_events.push({
      id: `te-${e.id}`,
      task_id: task?.id ?? null,
      action,
      changes,
      origin,
      at: now,
    });
  }
  const op = structuredClone(operation);
  if (op.target_text !== undefined) op.id = ref(op.target_text);
  if (op.parent_text !== undefined) op.parent_id = ref(op.parent_text);
  if (op.dependency_text !== undefined) {
    const t = find(op.id);
    op.depends_on = [...new Set([...t.depends_on, ref(op.dependency_text)])];
  }
  const previousGoal = op.type === 'task-update' ? find(op.id).goal_id : null;
  switch (op.type) {
    case 'task-add': {
      const texts = op.texts ?? [op.text];
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 10)
        fail('Lista de tareas inválida');
      if (op.focus !== undefined && typeof op.focus !== 'boolean')
        fail('Foco inválido');
      for (const text of texts) {
        if (!textOK(text))
          fail('Texto de tarea requerido; máximo 200000 caracteres');
        const parent = op.parent_id ?? null,
          goal = op.goal_id ?? null;
        const same = tasks.find(
          (t) =>
            key(t.text) === key(text) &&
            t.parent_id === parent &&
            t.goal_id === goal,
        );
        let t = same;
        if (same && !open(same))
          fail(
            'La tarea ya existe cerrada; reabrila explícitamente',
            'conflict',
          );
        if (!same) {
          if (tasks.length >= TASK_LIMITS.tasks)
            fail('Límite de tareas; no se descartan pendientes', 'limit');
          t = {
            ...makeEntry(text),
            status: 'pending',
            parent_id: parent,
            goal_id: goal,
            depends_on: op.depends_on ?? [],
            task_priority: op.task_priority ?? 'unset',
            expected_result: op.expected_result ?? null,
            block_reason: null,
          };
          tasks.push(t);
          event(t, 'created');
        }
        if (op.focus) {
          const previous = draft.focused_task_id;
          draft.focused_task_id = t.id;
          event(t, 'focused', [
            { field: 'focused_task_id', from: previous, to: t.id },
          ]);
        }
      }
      break;
    }
    case 'task-update': {
      const t = find(op.id),
        changes = [];
      for (const field of [
        'text',
        'parent_id',
        'goal_id',
        'depends_on',
        'task_priority',
        'expected_result',
      ])
        if (
          op[field] !== undefined &&
          JSON.stringify(t[field]) !== JSON.stringify(op[field])
        ) {
          changes.push({ field, from: t[field], to: op[field] });
          t[field] = op[field];
        }
      if (changes.length) {
        t.updated_at = now;
        event(t, 'updated', changes);
      }
      break;
    }
    case 'task-transition': {
      const t = find(op.id);
      if (!TASK_STATUSES.includes(op.status)) fail('Estado de tarea inválido');
      if (
        t.status === op.status &&
        (op.status !== 'blocked' || t.block_reason === op.reason)
      )
        break;
      if (!open(t) && op.status !== 'pending')
        fail('Reabrí la tarea como pendiente antes de otro cambio', 'conflict');
      if (['in_progress', 'completed'].includes(op.status)) {
        const eligible = taskProjection(draft).eligibility.find(
          (e) => e.task_id === t.id,
        );
        if (!eligible.eligible)
          fail(
            'La tarea tiene dependencias, objetivo o estado bloqueante; no puede declararse iniciada/completada',
            'conflict',
          );
        if (op.status === 'completed' && !eligible.subtasks_complete)
          fail(
            'Quedan subtareas sin completar; no se completa el padre automáticamente',
            'conflict',
          );
      }
      if (op.status === 'blocked' && !textOK(op.reason))
        fail('Indicá el motivo del bloqueo');
      const before = t.status,
        reason = t.block_reason;
      t.status = op.status;
      t.block_reason = op.status === 'blocked' ? op.reason : null;
      t.updated_at = now;
      t.resolution = {
        kind: 'user-declaration',
        verified: false,
        at: now,
        origin,
      };
      event(t, 'status-changed', [
        { field: 'status', from: before, to: t.status },
        { field: 'block_reason', from: reason, to: t.block_reason },
      ]);
      break;
    }
    case 'task-focus':
    case 'task-next': {
      const t = op.id === null ? null : find(op.id);
      if (op.type === 'task-focus') {
        const previous = draft.focused_task_id;
        draft.focused_task_id = t?.id ?? null;
        event(t, 'focused', [
          {
            field: 'focused_task_id',
            from: previous,
            to: draft.focused_task_id,
          },
        ]);
      } else {
        if (t && !open(t))
          fail('Elegí una tarea abierta para el próximo paso', 'conflict');
        const previous = draft.next_step?.task_id ?? null;
        draft.next_step = t ? { task_id: t.id, at: now, origin } : null;
        event(t, t ? 'next-step-set' : 'next-step-cleared', [
          { field: 'next_task_id', from: previous, to: t?.id ?? null },
        ]);
      }
      break;
    }
    case 'task-order': {
      if (
        !Array.isArray(op.ids) ||
        op.ids.length !== tasks.length ||
        new Set(op.ids).size !== tasks.length ||
        op.ids.some((id) => !tasks.some((t) => t.id === id))
      )
        fail('El orden debe contener todas las tareas una sola vez');
      const previous = tasks.map((t) => t.id);
      draft.tasks = op.ids.map((id) => find(id));
      event(null, 'reordered', [
        { field: 'order', from: previous, to: op.ids },
      ]);
      break;
    }
    default:
      fail('Operación de tarea inválida');
  }
  validateTasks(draft, fail);
  // Sólo los vínculos nuevos deben apuntar a un objetivo activo; se conserva la historia de los cerrados.
  if (
    ['task-add', 'task-update'].includes(op.type) &&
    op.goal_id != null &&
    (op.type === 'task-add' || op.goal_id !== previousGoal) &&
    goals(draft).find((g) => g.id === op.goal_id)?.status !== 'active'
  )
    fail('Elegí un objetivo activo', 'conflict');
  for (const field of ['tasks', 'task_events', 'focused_task_id', 'next_step'])
    state[field] = draft[field];
}

export function taskDirective(text) {
  let m = text.match(/^\s*(tarea actual|tarea|task)\s*:\s*([\s\S]+)$/i);
  if (m) return { type: 'task-add', text: m[2], focus: /actual/i.test(m[1]) };
  m = text.match(/^\s*(?:tareas|tasks)\s*:\s*\n([\s\S]+)$/i);
  if (m) {
    const lines = m[1].split('\n').filter((l) => l.trim());
    if (
      !lines.length ||
      lines.length > 10 ||
      lines.some((l) => !/^\s*[-*]\s+\S/.test(l))
    )
      return { ambiguous: true };
    return {
      type: 'task-add',
      texts: lines.map((l) => l.replace(/^\s*[-*]\s+/, '')),
    };
  }
  if (/^\s*(?:tareas|tasks)\s*:/i.test(text)) return { ambiguous: true };
  m = text.match(
    /^\s*(?:subtarea de|subtask of) [«“"]([^»”"]+)[»”"]\s*:\s*([\s\S]+)$/i,
  );
  if (m) return { type: 'task-add', parent_text: m[1], text: m[2] };
  m = text.match(
    /^\s*(?:la )?(?:tarea|task) [«“"]([^»”"]+)[»”"] (?:depende de|depends on) [«“"]([^»”"]+)[»”"]\s*[.!]?\s*$/i,
  );
  if (m)
    return { type: 'task-update', target_text: m[1], dependency_text: m[2] };
  m = text.match(
    /^\s*(?:prioridad de tarea|task priority) [«“"]([^»”"]+)[»”"]\s*:\s*(alta|normal|baja|sin prioridad|high|low|unset)\s*[.!]?\s*$/i,
  );
  if (m)
    return {
      type: 'task-update',
      target_text: m[1],
      task_priority:
        { alta: 'high', baja: 'low', 'sin prioridad': 'unset' }[
          m[2].toLowerCase()
        ] || m[2].toLowerCase(),
    };
  m = text.match(
    /^\s*(?:resultado esperado de tarea|expected result of task) [«“"]([^»”"]+)[»”"]\s*:\s*([\s\S]+)$/i,
  );
  if (m)
    return { type: 'task-update', target_text: m[1], expected_result: m[2] };
  m = text.match(
    /^\s*(?:tarea|task) [«“"]([^»”"]+)[»”"] (completada|cancelada|en curso|pendiente|bloqueada|completed|cancelled|in progress|pending|blocked)(?:\s*:\s*([^\n]+))?\s*[.!]?\s*$/i,
  );
  if (m)
    return {
      type: 'task-transition',
      target_text: m[1],
      status:
        {
          completada: 'completed',
          cancelada: 'cancelled',
          'en curso': 'in_progress',
          pendiente: 'pending',
          bloqueada: 'blocked',
          'in progress': 'in_progress',
        }[m[2].toLowerCase()] || m[2].toLowerCase(),
      reason: m[3],
    };
  m = text.match(
    /^\s*(?:pr[oó]ximo paso\s*:\s*tarea|next step\s*:\s*task|enfocar tarea|focus task) [«“"]([^»”"]+)[»”"]\s*[.!]?\s*$/i,
  );
  if (m)
    return {
      type: /^(?:\s*enfocar|\s*focus)/i.test(text) ? 'task-focus' : 'task-next',
      target_text: m[1],
    };
  if (/^\s*(?:limpiar pr[oó]ximo paso|clear next step)\s*[.!]?\s*$/i.test(text))
    return { type: 'task-next', id: null };
  return null;
}

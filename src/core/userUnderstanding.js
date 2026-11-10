import {
  appendReview,
  validateReview,
  REVIEW_INTENTS,
  REVIEW_RELATIONS,
} from './userReview.js';
import {
  applyWorkOperation,
  validateWork,
  workProjection,
  workDirective,
} from './userProgress.js';
import {
  applyProjectOperation,
  validateProjects,
  projectDirective,
} from './userProjects.js';
import {
  applyTaskOperation,
  validateTasks,
  taskProjection,
  taskDirective,
} from './userTasks.js';
import {
  RULE_FIELDS,
  DECISION_CANDIDATE_LIMIT,
  ruleSegment,
  ruleRetirement,
  ruleValueKey,
} from './userRules.js';
import {
  goalDirective,
  possibleGoal,
  goalKey,
  GOAL_LIMITS,
} from './userGoals.js';

/** NEXO UUE · Capa 1. Comprensión estructurada local y conservadora, no un LLM. */
export const UNDERSTANDING_VERSION = 1;
export const MAX_USER_TEXT = 200_000;
export const FIELDS = [
  'subgoals',
  'active_instructions',
  'explicit_constraints',
  'preferences',
  'relevant_context',
  'confirmed_decisions',
  'progress',
];
export const PRIORITY = Object.freeze({
  system: 1,
  user_goal: 2,
  explicit_constraints: 3,
  active_instructions: 4,
  confirmed_decisions: 5,
  preferences: 6,
  inference: 7,
});
export const SYSTEM_POLICIES = Object.freeze([
  'No sustituir silenciosamente el objetivo explícito del usuario.',
  'No inventar información ni tratar inferencias como confirmaciones.',
  'La comprensión no autoriza acciones privilegiadas ni envíos externos.',
]);
export class UnderstandingError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}
export function userText(text, { empty = false, max = MAX_USER_TEXT } = {}) {
  if (typeof text !== 'string' || text.length > max || (!empty && !text.trim()))
    throw new UnderstandingError(
      `Texto requerido; máximo ${max} caracteres. No se recorta silenciosamente.`,
    );
  return text;
}
const normalized = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[«»“”"'`]/g, '')
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const active = (e) => e?.status === 'active';
export function newUnderstanding(contextId, now = Date.now()) {
  return {
    schema_version: UNDERSTANDING_VERSION,
    context_id: contextId,
    revision: 0,
    user_goal: null,
    independent_goals: [],
    goal_candidates: [],
    goal_events: [],
    decision_candidates: [],
    project: null,
    project_history: [],
    context_references: [],
    context_events: [],
    selected_reference_id: null,
    current_task: null,
    tasks: [],
    task_events: [],
    work_records: [],
    work_evidence: [],
    work_events: [],
    review_events: [],
    interaction_review: null,
    focused_task_id: null,
    next_step: null,
    subgoals: [],
    active_instructions: [],
    explicit_constraints: [],
    preferences: [],
    relevant_context: [],
    confirmed_decisions: [],
    pending_questions: [],
    progress: [],
    uncertainty: [],
    goal_history: [],
    instruction_history: [],
    seen_messages: [],
    last_interaction: null,
    last_context_update: now,
  };
}
function origin(meta) {
  return {
    channel: meta.channel || 'shell',
    message_id: String(meta.messageId || '').slice(0, 200),
    url: String(meta.url || ''),
    role: 'user',
    authority:
      meta.channel === 'shell' ? 'user-confirmed-input' : 'observed-user-text',
  };
}
function review(state, values, meta, now) {
  appendReview(state, values, {
    now,
    origin: origin(meta),
    makeEntry: (text) => entry(state, 'inference', text, meta, now),
    fail: (message, code = 'invalid') => {
      throw new UnderstandingError(message, code);
    },
  });
}
function mutateWork(state, operation, meta, now) {
  applyWorkOperation(state, operation, {
    now,
    origin: origin(meta),
    source: meta.workSource || null,
    makeEntry: (text) => entry(state, 'progress', text, meta, now),
    fail: (message, code = 'invalid') => {
      throw new UnderstandingError(message, code);
    },
  });
}
function mutateTask(state, operation, meta, now) {
  applyTaskOperation(state, operation, {
    now,
    origin: origin(meta),
    makeEntry: (text) =>
      entry(state, 'inference', text, meta, now, 'explicit', 'project'),
    fail: (message, code = 'invalid') => {
      throw new UnderstandingError(message, code);
    },
  });
}
function mutateProject(state, operation, meta, now) {
  applyProjectOperation(state, operation, {
    now,
    origin: origin(meta),
    makeEntry: (text) =>
      entry(state, 'relevant_context', text, meta, now, 'explicit', 'project'),
    fail: (message, code = 'invalid') => {
      throw new UnderstandingError(message, code);
    },
  });
}
function entry(
  state,
  field,
  text,
  meta,
  now,
  certainty = 'explicit',
  scope = 'project',
) {
  return {
    id: `u-${state.revision + 1}-${++meta.counter}`,
    text: userText(text),
    origin: origin(meta),
    status: 'active',
    certainty,
    scope,
    priority: certainty === 'inferred' ? 7 : PRIORITY[field] || 7,
    ...(RULE_FIELDS.includes(field) ? { category: field } : {}),
    created_at: now,
    updated_at: now,
  };
}
function boundedPush(array, item, max = 200) {
  if (array.length >= max)
    throw new UnderstandingError(
      'Límite de contexto alcanzado. No se descartarán reglas activas; creá otro contexto o eliminá éste explícitamente.',
      'limit',
    );
  array.push(item);
}
function archive(state, e, now, status = 'superseded', meta = null) {
  boundedPush(
    state.instruction_history,
    {
      ...e,
      status,
      updated_at: now,
      ...(meta
        ? {
            change: {
              kind: status === 'obsolete' ? 'retired' : 'replaced',
              at: now,
              origin: origin(meta),
            },
          }
        : {}),
    },
    400,
  );
}
function acceptMatchingDecisions(state, decision, meta, now) {
  for (const c of state.decision_candidates || [])
    if (
      c.status === 'pending' &&
      c.scope === decision.scope &&
      normalized(c.text) === normalized(decision.text)
    ) {
      c.status = 'accepted';
      c.target_id = decision.id;
      c.updated_at = now;
      c.resolution = {
        kind: 'user-confirmation',
        verified: false,
        at: now,
        origin: origin(meta),
      };
    }
}
function add(
  state,
  field,
  text,
  meta,
  now,
  certainty = 'explicit',
  scope = 'project',
) {
  const same = state[field].find(
    (e) =>
      active(e) && e.scope === scope && normalized(e.text) === normalized(text),
  );
  if (same) {
    if (field === 'confirmed_decisions')
      acceptMatchingDecisions(state, same, meta, now);
    return same;
  }
  const e = entry(state, field, text, meta, now, certainty, scope);
  boundedPush(state[field], e);
  if (field === 'confirmed_decisions')
    acceptMatchingDecisions(state, e, meta, now);
  return e;
}
function goalEvent(state, goal, action, meta, now, from = null) {
  state.goal_events ||= [];
  boundedPush(
    state.goal_events,
    {
      id: `ge-${state.revision + 1}-${++meta.counter}`,
      goal_id: goal.id,
      action,
      from,
      to: goal.status,
      at: now,
      origin: origin(meta),
      certainty: 'user-declared',
    },
    GOAL_LIMITS.events,
  );
}
function preserveReviewedRequest(state, meta, now) {
  if (state.current_task?.certainty === 'confirmed')
    archive(state, state.current_task, now, 'superseded', meta);
}
function transitionGoal(
  state,
  id,
  status,
  meta,
  now,
  statement = 'Control explícito del usuario en el panel',
) {
  if (!['active', 'completed', 'cancelled'].includes(status))
    throw new UnderstandingError('Estado de objetivo inválido');
  const goal = [state.user_goal, ...(state.independent_goals || [])]
    .filter(Boolean)
    .find((g) => g.id === id);
  if (!goal)
    throw new UnderstandingError(
      'El objetivo ya no está disponible',
      'conflict',
    );
  if (goal.status === status) return false;
  if (status === 'active' && !['completed', 'cancelled'].includes(goal.status))
    throw new UnderstandingError('Sólo se puede reabrir un objetivo cerrado');
  if (status !== 'active' && goal.status !== 'active')
    throw new UnderstandingError(
      'Reabrí el objetivo antes de cambiar su cierre',
      'conflict',
    );
  const from = goal.status;
  goal.status = status;
  goal.updated_at = now;
  goal.resolution = {
    kind: 'user-declaration',
    verified: false,
    statement,
    at: now,
    origin: origin(meta),
  };
  if (goal.id === state.user_goal?.id) {
    preserveReviewedRequest(state, meta, now);
    state.current_task = null;
  }
  goalEvent(
    state,
    goal,
    status === 'active' ? 'reopened' : status,
    meta,
    now,
    from,
  );
  if (goal.id === state.user_goal?.id)
    for (const q of state.pending_questions)
      if (q.status === 'open' && q.kind === 'goal-change') {
        q.status = 'rejected';
        q.resolved_at = now;
      }
  return true;
}
function independentGoal(state, text, meta, now, certainty = 'explicit') {
  state.independent_goals ||= [];
  const same = [state.user_goal, ...state.independent_goals]
    .filter(Boolean)
    .find((g) => goalKey(g.text) === goalKey(text) && g.status === 'active');
  if (same) return same;
  const closed = state.independent_goals.find(
    (g) => goalKey(g.text) === goalKey(text),
  );
  if (closed)
    throw new UnderstandingError(
      'Ese objetivo ya existe cerrado. Reabrilo explícitamente en lugar de duplicarlo.',
      'conflict',
    );
  const g = entry(state, 'user_goal', text, meta, now, certainty);
  g.goal_type = 'independent';
  boundedPush(state.independent_goals, g, GOAL_LIMITS.independent);
  goalEvent(state, g, 'independent-added', meta, now);
  return g;
}
function candidateGoal(state, text, reason, meta, now) {
  state.goal_candidates ||= [];
  if (state.goal_candidates.some((g) => goalKey(g.text) === goalKey(text)))
    return;
  const g = entry(state, 'inference', text, meta, now, 'inferred');
  g.status = 'pending';
  g.reason = reason;
  boundedPush(state.goal_candidates, g, GOAL_LIMITS.candidates);
}
function setGoal(state, text, meta, now, certainty = 'explicit') {
  if (state.user_goal?.text === text) {
    if (state.user_goal.status !== 'active')
      transitionGoal(
        state,
        state.user_goal.id,
        'active',
        meta,
        now,
        'Objetivo vuelto a declarar explícitamente',
      );
    return;
  }
  for (const q of state.pending_questions)
    if (
      q.status === 'open' &&
      ['missing-goal', 'goal-change'].includes(q.kind)
    ) {
      q.status = q.kind === 'missing-goal' ? 'accepted' : 'rejected';
      q.resolved_at = now;
    }
  if (state.user_goal)
    boundedPush(
      state.goal_history,
      {
        ...state.user_goal,
        status:
          state.user_goal.status === 'active'
            ? 'superseded'
            : state.user_goal.status,
        updated_at: now,
      },
      50,
    );
  const linked = (state.independent_goals || []).find(
    (g) => g.status === 'active' && goalKey(g.text) === goalKey(text),
  );
  if (linked) {
    linked.status = 'superseded';
    linked.updated_at = now;
    goalEvent(state, linked, 'promoted-to-primary', meta, now, 'active');
  }
  state.user_goal = entry(state, 'user_goal', text, meta, now, certainty);
  state.user_goal.goal_type = 'primary';
  preserveReviewedRequest(state, meta, now);
  state.current_task = null;
  goalEvent(state, state.user_goal, 'primary-set', meta, now);
  for (const g of state.goal_candidates || [])
    if (g.status === 'pending') {
      g.status = 'superseded';
      g.updated_at = now;
    }
}

function ask(state, kind, text, proposed, meta, now, conflictIds = []) {
  const same = state.pending_questions.find(
    (q) =>
      q.status === 'open' &&
      q.kind === kind &&
      normalized(q.proposed?.text || '') === normalized(proposed?.text || '') &&
      q.proposed?.field === proposed?.field &&
      q.proposed?.scope === proposed?.scope &&
      q.conflict_ids.join() === conflictIds.join(),
  );
  if (same) return same;
  const q = {
    id: `q-${state.revision + 1}-${++meta.counter}`,
    kind,
    text,
    status: 'open',
    proposed: proposed || null,
    conflict_ids: conflictIds,
    origin: origin(meta),
    created_at: now,
    certainty: 'uncertain',
    significant: true,
  };
  boundedPush(state.pending_questions, q, 100);
  return q;
}
/** Clave limitada de acciones comparables; no pretende detectar contradicciones semánticas generales. */
export function instructionKey(text) {
  const n = normalized(text).replace(
    /^(?:ahora\s+si\s+|ahora\s+|por favor\s+)?(?:no\s+|nunca\s+|never\s+|do not\s+|don't\s+)?/,
    '',
  );
  const language = n.match(
    /^(?:usa|use|utiliza|responde|respond|escribi|escribe)\w*\s+(?:en\s+)?(espanol|ingles|english|spanish)$/,
  );
  if (language)
    return {
      key: 'response-language',
      value:
        language[1] === 'espanol' || language[1] === 'spanish' ? 'es' : 'en',
    };
  const a = n.match(
    /^(modifi(?:c|qu)\w*|cambi\w*|edit\w*|ejecut\w*|run|borr\w*|elimin\w*|delet\w*)\s+(.+)$/,
  );
  if (!a) return null;
  const verb = /^(modifi|cambi|edit)/.test(a[1])
    ? 'modify'
    : /^(ejecut|run)/.test(a[1])
      ? 'execute'
      : 'delete';
  const target = a[2]
    .replace(/^(?:el|la|los|las|the)\s+/, '')
    .replace(/\s+/g, ' ');
  return {
    key: `${verb}:${target}`,
    value: /^(?:ahora\s+)?(?:no|nunca|never|do not|don't)\b/.test(
      normalized(text),
    )
      ? 'deny'
      : 'allow',
  };
}
function comparableRule(text) {
  return (
    instructionKey(text) ||
    ruleValueKey(text) ||
    instructionKey(
      text.replace(
        /^\s*(?:preferencia\s*:\s*|prefiero\s+|preferir[ií]a\s+|i prefer\s+)/i,
        '',
      ),
    )
  );
}
function conflicting(state, field, text) {
  const k = comparableRule(text);
  if (!k) return [];
  // Las preferencias sólo compiten con otras preferencias; nunca retiran obligaciones.
  const fields =
    field === 'preferences'
      ? ['preferences']
      : [...RULE_FIELDS.filter((f) => f !== 'preferences')];
  return fields
    .flatMap((f) => state[f])
    .filter(active)
    .filter((e) => {
      const old = comparableRule(e.text);
      return old && old.key === k.key && old.value !== k.value;
    });
}
function proposal(
  state,
  field,
  text,
  meta,
  now,
  {
    updating = false,
    scope = 'project',
    replaces = null,
    certainty = 'explicit',
  } = {},
) {
  if (!RULE_FIELDS.includes(field))
    return add(state, field, text, meta, now, certainty, scope);
  const clashes = conflicting(state, field, text).filter(
    (e) => e.id !== replaces,
  );
  // Actualizar mismo nivel es explícito; jamás permite saltar una regla superior.
  if (
    clashes.length &&
    !(
      updating &&
      clashes.every((e) => e.priority === PRIORITY[field] && e.scope === scope)
    )
  ) {
    return ask(
      state,
      'conflict',
      `La nueva indicación parece incompatible con ${clashes.map((e) => `«${e.text}»`).join('; ')}. ¿Querés sustituir esas reglas concretas por «${text}»?`,
      { field, text, scope },
      meta,
      now,
      [...clashes.map((e) => e.id), ...(replaces ? [replaces] : [])],
    );
  }
  for (const id of new Set([
    ...(updating ? clashes.map((e) => e.id) : []),
    ...(replaces ? [replaces] : []),
  ]))
    removeActive(state, id, now, 'superseded', meta);
  return add(state, field, text, meta, now, certainty, scope);
}
function decisionCandidate(state, text, scope, meta, now) {
  state.decision_candidates ||= [];
  if (
    state.decision_candidates.some(
      (e) => normalized(e.text) === normalized(text) && e.scope === scope,
    )
  )
    return;
  const e = entry(state, 'inference', text, meta, now, 'inferred', scope);
  e.status = 'pending';
  e.source_kind = 'user-proposal';
  boundedPush(state.decision_candidates, e, DECISION_CANDIDATE_LIMIT);
}
function updateRule(state, operation, meta, now) {
  const oldField = RULE_FIELDS.find((f) =>
    state[f].some((e) => e.id === operation.id && active(e)),
  );
  if (!oldField)
    throw new UnderstandingError('La regla ya no está activa', 'conflict');
  const old = state[oldField].find((e) => e.id === operation.id),
    field = operation.field ?? oldField,
    scope = operation.scope ?? old.scope,
    text = operation.text ?? old.text;
  if (!RULE_FIELDS.includes(field) || !['project', 'session'].includes(scope))
    throw new UnderstandingError('Categoría o vigencia de regla inválida');
  userText(text);
  if (field === oldField && scope === old.scope && text === old.text) return;
  return proposal(state, field, text, meta, now, { scope, replaces: old.id });
}
/** Sólo segmentos propios: se ignoran bloques de código, citas y secciones de ejemplos. */
function ownSegments(text) {
  let fenced = false,
    examples = false;
  const segments = [];
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*>/.test(line)) continue;
    if (
      /^\s*(?:ejemplos?|examples?|texto citado|el asistente dijo|respuesta del asistente|assistant said|assistant response)\s*:/i.test(
        line,
      )
    ) {
      examples = true;
      continue;
    }
    if (examples) {
      if (/^\s*$/.test(line)) examples = false;
      continue;
    }
    const clean = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (clean) segments.push(clean);
  }
  return segments;
}
function goalDeclaration(text) {
  // Declaración libre multilínea con encabezado explícito. El original completo no se recorta.
  const match = text.match(
    /^\s*(?:(cambio de objetivo|nuevo objetivo|actualiz[aá] (?:el|mi) objetivo|cambi[aá] (?:el|mi) objetivo a)|(mi objetivo(?: principal)?|objetivo principal|user goal|my goal))\s*:\s*([\s\S]+)$/i,
  );
  if (match) return { text: match[3], change: Boolean(match[1]) };
  const natural = text.match(
    /^\s*(?:cambi[aá]|actualiz[aá]) (?:el|mi) objetivo (?:principal )?a\s+([\s\S]+)$/i,
  );
  if (natural) return { text: natural[1], change: true };
  const inline = text.match(
    /^\s*(mi objetivo(?: principal)? es|quiero lograr|my goal is)\s+([\s\S]+)$/i,
  );
  return inline ? { text: inline[2], change: false } : null;
}
export function interpretMessage(state, text) {
  userText(text);
  const n = normalized(text);
  const g = goalDeclaration(text);
  if (
    /^(?:pregunta|solicitud|consulta) independiente\s*:|^unrelated (?:question|request)\s*:/.test(
      n,
    )
  )
    return {
      intent: 'independent',
      relation: 'independent',
      certainty: 'explicit',
    };
  const work = workDirective(text);
  if (work)
    return {
      intent: 'work-report',
      relation: 'current-work',
      certainty: 'explicit',
      work,
    };
  const project = projectDirective(text);
  if (project)
    return {
      intent: 'context-directive',
      relation: 'context',
      certainty: 'explicit',
      project,
    };
  const task = taskDirective(text);
  if (task)
    return {
      intent: 'task-directive',
      relation: 'task',
      certainty: 'explicit',
      task,
    };
  const directive = goalDirective(text);
  if (directive)
    return {
      intent: 'goal-directive',
      relation: 'goal',
      certainty: 'explicit',
      directive,
    };
  if (g)
    return {
      intent: g.change ? 'goal-change' : 'goal-declaration',
      relation: 'goal',
      certainty: 'explicit',
      goal: g,
    };
  if (
    /^(?:volvamos|volver) al objetivo original\b|^return to (?:the )?original goal\b/.test(
      n,
    )
  )
    return { intent: 'restore-goal', relation: 'goal', certainty: 'explicit' };
  if (/^(?:reemplaza|sustitui|sustituye|replace)\b/.test(n))
    return {
      intent: 'correction',
      relation: 'current-work',
      certainty: 'explicit',
    };
  if (/^(?:si|sí|de acuerdo|aprobado|acepto|yes|ok|dale)[.!]*$/.test(n))
    return {
      intent: 'approval',
      relation: 'unresolved-reference',
      certainty: 'uncertain',
    };
  if (/^(?:no|rechazado|no acepto|no estoy de acuerdo|nope)[.!]*$/.test(n))
    return {
      intent: 'rejection',
      relation: 'unresolved-reference',
      certainty: 'uncertain',
    };
  if (
    /^(?:continuemos|continuar|seguimos desde donde quedamos|sigamos|hace el siguiente paso|usa la misma configuracion|seguimos desde donde quedamos|retomemos|sigamos con el objetivo original|siguiente paso|continuemos con|continue|resume)\b/.test(
      n,
    )
  )
    return {
      intent: 'continuation',
      relation:
        active(state.user_goal) || state.current_task
          ? 'current-work'
          : 'unresolved-reference',
      certainty: 'inferred',
    };
  if (
    /^(?:corregi|corrige|corregir|fix) (?:lo anterior|eso|the previous)\b/.test(
      n,
    )
  )
    return {
      intent: 'correction',
      relation: 'unresolved-reference',
      certainty: 'inferred',
    };
  if (/^(?:aclaracion|aclaro|para aclarar|clarification)\s*:/.test(n))
    return {
      intent: 'clarification',
      relation: 'current-work',
      certainty: 'explicit',
    };
  if (/[?¿]/.test(text))
    return {
      intent: 'question',
      relation: active(state.user_goal) ? 'possibly-related' : 'unknown',
      certainty: 'inferred',
    };
  return {
    intent: 'request',
    relation: active(state.user_goal) ? 'possibly-related' : 'unknown',
    certainty: 'inferred',
  };
}
function removeActive(state, id, now, status = 'obsolete', meta = null) {
  for (const field of FIELDS) {
    const e = state[field].find((e) => e.id === id && active(e));
    if (e) {
      archive(
        state,
        { ...e, ...(RULE_FIELDS.includes(field) ? { category: field } : {}) },
        now,
        status,
        meta,
      );
      state[field] = state[field].filter((x) => x.id !== id);
      if (state.selected_reference_id === id)
        state.selected_reference_id = null;
      return e;
    }
  }
  throw new UnderstandingError(
    'La regla referenciada ya no está activa',
    'conflict',
  );
}
function resolve(state, id, accept, meta, now) {
  const q = state.pending_questions.find(
    (q) => q.id === id && q.status === 'open',
  );
  if (!q)
    throw new UnderstandingError('La pregunta ya no está abierta', 'conflict');
  if (accept && !q.proposed)
    throw new UnderstandingError(
      'Esta pregunta necesita una aclaración escrita, no un sí genérico',
    );
  if (accept) {
    if (q.kind === 'goal-change') setGoal(state, q.proposed.text, meta, now);
    else if (q.kind === 'conflict') {
      const activeIds = FIELDS.flatMap((f) => state[f])
        .filter(active)
        .map((e) => e.id);
      if (
        q.conflict_ids.some((id) => !activeIds.includes(id)) ||
        conflicting(state, q.proposed.field, q.proposed.text).some(
          (e) => !q.conflict_ids.includes(e.id),
        )
      )
        throw new UnderstandingError(
          'Las reglas cambiaron desde esta propuesta; revisá y formulá el cambio nuevamente.',
          'conflict',
        );
      const candidate = q.proposed.decision_candidate_id
        ? (state.decision_candidates || []).find(
            (c) =>
              c.id === q.proposed.decision_candidate_id &&
              c.status === 'pending',
          )
        : null;
      if (q.proposed.decision_candidate_id && !candidate)
        throw new UnderstandingError(
          'La propuesta de decisión ya no está pendiente',
          'conflict',
        );
      for (const ref of q.conflict_ids)
        removeActive(state, ref, now, 'superseded', meta);
      const confirmed = add(
        state,
        q.proposed.field,
        q.proposed.text,
        meta,
        now,
        'confirmed',
        q.proposed.scope,
      );
      if (candidate) {
        candidate.status = 'accepted';
        candidate.target_id = confirmed.id;
        candidate.updated_at = now;
        candidate.resolution = {
          kind: 'user-confirmation',
          verified: false,
          at: now,
          origin: origin(meta),
        };
      }
    } else if (q.kind === 'context-reference') {
      const e = add(
        state,
        'relevant_context',
        q.proposed.text,
        meta,
        now,
        'confirmed',
        'project',
      );
      e.reference = q.proposed.reference;
    }
  }
  q.status = accept ? 'accepted' : 'rejected';
  q.resolved_at = now;
}
/** Actualización pura. Los metadatos los aporta main, nunca el contenido de una página. */
export function updateUnderstanding(
  current,
  operation,
  metadata = {},
  now = Date.now(),
) {
  if (
    !operation ||
    typeof operation !== 'object' ||
    operation.revision !== current.revision
  )
    throw new UnderstandingError(
      'El contexto cambió; recargá antes de actualizar.',
      'conflict',
    );
  const state = structuredClone(current),
    meta = { ...metadata, counter: 0 };
  let report = {
    intent: 'explicit-edit',
    relation: 'current-work',
    certainty: 'explicit',
    clarifications: [],
  };
  switch (operation.type) {
    case 'ack-message':
      if (
        typeof operation.messageKey !== 'string' ||
        operation.messageKey.length > 200
      )
        throw new UnderstandingError('Identidad inválida');
      if (!state.seen_messages.includes(operation.messageKey))
        state.seen_messages.push(operation.messageKey);
      if (state.seen_messages.length > 2048) state.seen_messages.shift();
      break;
    case 'goal-independent':
      independentGoal(state, userText(operation.text), meta, now);
      break;
    case 'goal-transition':
      transitionGoal(state, operation.id, operation.status, meta, now);
      break;
    case 'goal-candidate': {
      if (!['primary', 'independent', 'reject'].includes(operation.action))
        throw new UnderstandingError('Confirmación de inferencia inválida');
      const g = (state.goal_candidates || []).find(
        (g) => g.id === operation.id && g.status === 'pending',
      );
      if (!g)
        throw new UnderstandingError(
          'La inferencia ya no está pendiente',
          'conflict',
        );
      if (operation.action === 'primary' && active(state.user_goal))
        throw new UnderstandingError(
          'Ya hay un objetivo principal activo. No se reemplaza desde una inferencia. Usá el editor de objetivo explícito.',
          'conflict',
        );
      let target = null;
      if (operation.action === 'primary') {
        setGoal(state, g.text, meta, now, 'confirmed');
        target = state.user_goal;
      }
      if (operation.action === 'independent')
        target = independentGoal(state, g.text, meta, now, 'confirmed');
      g.status = operation.action === 'reject' ? 'rejected' : 'accepted';
      g.updated_at = now;
      g.resolution = {
        kind: 'user-confirmation',
        verified: false,
        at: now,
        origin: origin(meta),
        target_goal_id: target?.id || null,
      };
      goalEvent(
        state,
        g,
        operation.action === 'reject'
          ? 'candidate-rejected'
          : 'candidate-confirmed',
        meta,
        now,
        'pending',
      );
      break;
    }
    case 'goal':
      setGoal(state, userText(operation.text), meta, now);
      break;
    case 'project':
    case 'context-item':
    case 'context-select':
    case 'context-reference':
    case 'context-reference-resolve':
    case 'context-reference-refresh':
      mutateProject(state, operation, meta, now);
      break;
    case 'request-review': {
      const old = state.current_task;
      if (!old || old.id !== operation.id)
        throw new UnderstandingError(
          'La última solicitud cambió; recargá.',
          'conflict',
        );
      if (!['confirm', 'correct', 'reject'].includes(operation.action))
        throw new UnderstandingError('Revisión inválida');
      if (operation.action === 'confirm' && old.certainty !== 'inferred')
        throw new UnderstandingError(
          'La solicitud ya no es una inferencia pendiente.',
          'conflict',
        );
      const goals = [
        state.user_goal,
        ...(state.independent_goals || []),
      ].filter((g) => g && g.status === 'active');
      const goalId = operation.goal_id ?? null;
      if (
        operation.action !== 'reject' &&
        goalId !== null &&
        !goals.some((g) => g.id === goalId)
      )
        throw new UnderstandingError(
          'Elegí un objetivo activo exacto o ninguno.',
          'reference',
        );
      let next = null;
      if (operation.action === 'confirm')
        next = {
          ...old,
          certainty: 'confirmed',
          related_goal_id: goalId,
          updated_at: now,
          resolution: {
            kind: 'user-confirmation',
            verified: false,
            origin: origin(meta),
            at: now,
          },
        };
      else {
        archive(
          state,
          old,
          now,
          operation.action === 'reject' ? 'rejected' : 'superseded',
          meta,
        );
        if (operation.action === 'correct') {
          next = entry(
            state,
            'inference',
            userText(operation.text),
            meta,
            now,
            'confirmed',
            'session',
          );
          next.related_goal_id = goalId;
          next.resolution = {
            kind: 'user-confirmation',
            verified: false,
            origin: origin(meta),
            at: now,
          };
        }
      }
      review(
        state,
        {
          action: {
            confirm: 'request-confirmed',
            correct: 'request-corrected',
            reject: 'request-rejected',
          }[operation.action],
          target_id: old.id,
          replacement_id: next?.id ?? null,
          reason: operation.reason,
          before_label: `${old.certainty} · objetivo ${old.related_goal_id || 'ninguno'}`,
          after_label: next
            ? `confirmed · objetivo ${goalId || 'ninguno'}`
            : 'rejected',
          source_origin: old.origin,
        },
        meta,
        now,
      );
      state.current_task = next;
      report.note =
        'Revisión de la última solicitud guardada; no crea una tarea ejecutora ni modifica objetivos o permisos.';
      break;
    }
    case 'interaction-review': {
      const old = state.last_interaction;
      if (!old)
        throw new UnderstandingError(
          'No hay intención registrada para revisar.',
          'reference',
        );
      if (
        !REVIEW_INTENTS.includes(operation.intent) ||
        !REVIEW_RELATIONS.includes(operation.relation)
      )
        throw new UnderstandingError(
          'Intención o relación de revisión inválida',
        );
      review(
        state,
        {
          action: 'interaction-corrected',
          target_id: `interaction-${old.at}`,
          replacement_id: null,
          reason: operation.reason,
          before_label: JSON.stringify(
            state.interaction_review
              ? {
                  intent: state.interaction_review.intent,
                  relation: state.interaction_review.relation,
                }
              : { intent: old.intent, relation: old.relation },
          ),
          after_label: JSON.stringify({
            intent: operation.intent,
            relation: operation.relation,
          }),
          source_origin: old.origin,
        },
        meta,
        now,
      );
      state.interaction_review = {
        intent: operation.intent,
        relation: operation.relation,
        reason: operation.reason,
        source_message_id: old.origin.message_id,
        source_at: old.at,
        origin: origin(meta),
        at: now,
        verified: false,
      };
      report.note =
        'Anotación humana de intención guardada; la clasificación original se conserva. No reinterpreta el mensaje ni revierte cambios previos.';
      break;
    }
    case 'entry-correct': {
      const field = operation.field;
      if (!['subgoals', 'relevant_context', 'progress'].includes(field))
        throw new UnderstandingError(
          'Usá el editor especializado para esa categoría.',
        );
      const old = state[field].find((e) => e.id === operation.id && active(e));
      if (!old)
        throw new UnderstandingError('La entrada cambió; recargá.', 'conflict');
      if (old.reference || old.entity)
        throw new UnderstandingError(
          'Retirá la referencia y registrá otra explícitamente; no se sustituye su origen.',
        );
      const value = userText(operation.text);
      if (value === old.text)
        throw new UnderstandingError('El texto no cambió.');
      if (
        state[field].some(
          (e) =>
            e.id !== old.id &&
            active(e) &&
            e.scope === old.scope &&
            normalized(e.text) === normalized(value),
        )
      )
        throw new UnderstandingError(
          'Ya existe una entrada equivalente; no se fusionará su historia.',
          'conflict',
        );
      removeActive(state, old.id, now, 'superseded', meta);
      const next = add(state, field, value, meta, now, 'confirmed', old.scope);
      review(
        state,
        {
          action: 'entry-corrected',
          target_id: old.id,
          replacement_id: next.id,
          reason: operation.reason,
          before_label: field,
          after_label: `${field} · confirmed`,
          source_origin: old.origin,
        },
        meta,
        now,
      );
      break;
    }
    case 'work-add':
    case 'work-transition':
    case 'work-evidence':
    case 'work-evidence-withdraw':
      mutateWork(state, operation, meta, now);
      break;
    case 'task-add':
    case 'task-update':
    case 'task-transition':
    case 'task-focus':
    case 'task-next':
    case 'task-order':
      mutateTask(state, operation, meta, now);
      break;
    case 'rule-update':
      updateRule(state, operation, meta, now);
      break;
    case 'decision-candidate': {
      if (!['confirm', 'reject'].includes(operation.action))
        throw new UnderstandingError('Respuesta a propuesta inválida');
      const c = (state.decision_candidates || []).find(
        (e) => e.id === operation.id && e.status === 'pending',
      );
      if (!c)
        throw new UnderstandingError(
          'La propuesta ya no está pendiente',
          'conflict',
        );
      if (operation.action === 'reject') c.status = 'rejected';
      else {
        const result = proposal(
          state,
          'confirmed_decisions',
          c.text,
          meta,
          now,
          { scope: c.scope, certainty: 'confirmed' },
        );
        if (result.kind === 'conflict') {
          result.proposed.decision_candidate_id = c.id;
          report.note =
            'La propuesta sigue pendiente: primero revisá el conflicto concreto. No se activa una decisión.';
          break;
        }
        c.status = 'accepted';
        c.target_id = result.id;
      }
      c.updated_at = now;
      c.resolution = {
        kind: 'user-confirmation',
        verified: false,
        at: now,
        origin: origin(meta),
      };
      break;
    }
    case 'add': {
      if (!FIELDS.includes(operation.field))
        throw new UnderstandingError('Categoría inválida');
      if (!['project', 'session'].includes(operation.scope || 'project'))
        throw new UnderstandingError('Alcance inválido');
      proposal(state, operation.field, userText(operation.text), meta, now, {
        scope: operation.scope || 'project',
      });
      break;
    }
    case 'memory-candidate': {
      const ref = operation.reference;
      if (
        !ref ||
        typeof ref.id !== 'string' ||
        typeof ref.project_id !== 'string'
      )
        throw new UnderstandingError('Referencia inválida');
      if (!state.relevant_context.some((e) => e.reference?.id === ref.id))
        ask(
          state,
          'context-reference',
          `¿Vincular la referencia EVO ${ref.id}? Su contenido no se considera una instrucción ni un hecho verificado.`,
          { text: `Referencia EVO ${ref.id}`, reference: ref },
          meta,
          now,
        );
      break;
    }
    case 'retire':
      removeActive(state, operation.id, now, 'obsolete', meta);
      break;
    case 'resolve':
      if (typeof operation.accept !== 'boolean')
        throw new UnderstandingError('Respuesta inválida');
      resolve(state, operation.id, operation.accept, meta, now);
      break;
    case 'message': {
      const text = userText(operation.text);
      report = interpretMessage(state, text);
      if (report.intent === 'independent')
        return {
          state: current,
          report: { ...report, clarifications: [], isolated: true },
        };
      if (
        operation.messageKey &&
        state.seen_messages.includes(operation.messageKey)
      )
        return {
          state: current,
          report: { ...report, duplicate: true, clarifications: [] },
        };
      if (operation.messageKey) {
        state.seen_messages.push(operation.messageKey);
        if (state.seen_messages.length > 2048) state.seen_messages.shift();
      }
      const previousTask = state.current_task;
      const retiredText = ruleRetirement(text);
      if (report.work) {
        mutateWork(state, report.work, meta, now);
        report.note =
          'Seguimiento declarado, no ejecución comprobada. No cambia tareas, decisiones ni reglas.';
      } else if (report.project) {
        const d = report.project;
        if (
          d.type === 'project' &&
          state.project &&
          state.project.name !== d.name &&
          !d.rename
        )
          ask(
            state,
            'missing-reference',
            'Ya hay una etiqueta de proyecto. Renombrar conserva este contexto y sus reglas; para otro proyecto elegí otra conversación/contexto.',
            null,
            meta,
            now,
          );
        else {
          try {
            mutateProject(
              state,
              {
                ...d,
                ...(d.type === 'project'
                  ? { description: state.project?.description || '' }
                  : {}),
              },
              meta,
              now,
            );
          } catch (error) {
            if (
              !(error instanceof UnderstandingError) ||
              !['reference', 'invalid', 'conflict'].includes(error.code)
            )
              throw error;
            ask(state, 'missing-reference', error.message, null, meta, now);
          }
        }
        report.note =
          'Contexto local declarado; las referencias no ejecutan acciones ni importan reglas de otros proyectos.';
      } else if (report.task) {
        if (report.task.ambiguous)
          ask(
            state,
            'missing-reference',
            'Especificá de 1 a 10 tareas, una por línea con guion. No inventaré subtareas ni orden de ejecución.',
            null,
            meta,
            now,
          );
        else {
          try {
            mutateTask(state, report.task, meta, now);
          } catch (error) {
            if (
              !(error instanceof UnderstandingError) ||
              !['reference', 'invalid', 'conflict'].includes(error.code)
            )
              throw error;
            ask(state, 'missing-reference', error.message, null, meta, now);
          }
        }
        report.note =
          'Seguimiento de tareas declarado por el usuario. No ejecuta acciones ni verifica finalización.';
      } else if (retiredText) {
        const matches = RULE_FIELDS.flatMap((f) => state[f]).filter(
          (e) => active(e) && normalized(e.text) === normalized(retiredText),
        );
        if (matches.length === 1)
          removeActive(state, matches[0].id, now, 'obsolete', meta);
        else
          ask(
            state,
            'missing-reference',
            'No identifico una única regla vigente con ese texto. Seleccionala en el panel.',
            null,
            meta,
            now,
          );
      } else if (report.directive) {
        const d = report.directive;
        if (d.type === 'independent')
          for (const text of d.texts)
            independentGoal(state, userText(text), meta, now);
        else if (d.type === 'ambiguous')
          ask(state, 'missing-reference', d.question, null, meta, now);
        else {
          const candidates = d.target
            ? [state.user_goal, ...(state.independent_goals || [])].filter(
                (g) => g && goalKey(g.text) === goalKey(d.target),
              )
            : [state.user_goal].filter(Boolean);
          if (candidates.length !== 1)
            ask(
              state,
              'missing-reference',
              'No identifico un único objetivo. Indicá su texto exacto entre comillas o elegilo en el panel.',
              null,
              meta,
              now,
            );
          else
            transitionGoal(state, candidates[0].id, d.status, meta, now, text);
        }
        report.note =
          'Actualización de objetivo declarada por el usuario. No verifica ejecución ni pruebas.';
      } else if (report.goal) {
        if (!active(state.user_goal) || report.goal.change)
          setGoal(state, report.goal.text, meta, now);
        else if (
          normalized(state.user_goal.text) !== normalized(report.goal.text)
        )
          ask(
            state,
            'goal-change',
            'Ya existe un objetivo. ¿Querés sustituirlo por esta nueva declaración?',
            { text: report.goal.text },
            meta,
            now,
          );
      } else if (report.intent === 'restore-goal') {
        if (state.goal_history.length)
          setGoal(state, state.goal_history[0].text, meta, now);
        else
          ask(
            state,
            'missing-reference',
            'No hay un objetivo anterior conservado. ¿Cuál querés retomar?',
            null,
            meta,
            now,
          );
      } else if (
        report.intent === 'correction' &&
        /^(?:reemplaz[aá]|sustitu[ií]|sustituye|replace)\s+(?:la instrucci[oó]n\s+)?[«“"]([\s\S]+?)[»”"]\s+(?:por|with)\s+[«“"]([\s\S]+)[»”"]\s*[.!]?$/i.test(
          text.trim(),
        )
      ) {
        const parts = text
          .trim()
          .match(
            /^[^«“"]+[«“"]([\s\S]+?)[»”"]\s+(?:por|with)\s+[«“"]([\s\S]+)[»”"]/i,
          );
        const candidates = FIELDS.flatMap((field) =>
          state[field].map((e) => ({ field, e })),
        ).filter((x) => normalized(x.e.text) === normalized(parts[1]));
        if (candidates.length === 1) {
          const { field, e } = candidates[0];
          if (RULE_FIELDS.includes(field))
            updateRule(state, { id: e.id, text: parts[2] }, meta, now);
          else {
            removeActive(state, e.id, now, 'superseded', meta);
            proposal(state, field, parts[2], meta, now, { scope: e.scope });
          }
        } else
          ask(
            state,
            'missing-reference',
            'No puedo identificar una única instrucción anterior con ese texto. Indicá cuál querés reemplazar.',
            null,
            meta,
            now,
          );
      } else if (
        report.intent === 'approval' ||
        report.intent === 'rejection'
      ) {
        // Un sí puede referirse a una pregunta de otro modelo: nunca aplica cambios por sí solo.
        report.note =
          'Aprobación/rechazo observado. No cambia reglas ni autoriza acciones sin referencia inequívoca.';
      } else if (report.intent === 'continuation') {
        if (!previousTask && !active(state.user_goal))
          ask(
            state,
            'missing-reference',
            '¿Qué trabajo querés retomar? Elegí un contexto guardado o definí el objetivo.',
            null,
            meta,
            now,
          );
        else if (
          /misma configuracion/.test(normalized(text)) &&
          !state.active_instructions.length &&
          !state.confirmed_decisions.length
        )
          ask(
            state,
            'missing-reference',
            'No hay una configuración confirmada en este contexto. ¿Cuál debemos conservar?',
            null,
            meta,
            now,
          );
        // Conserva la tarea previa; continuar no inventa un nuevo paso ni marca avance.
      } else if (report.intent === 'correction') {
        ask(
          state,
          'missing-reference',
          '¿Qué instrucción o resultado anterior querés corregir, y cómo debería quedar?',
          null,
          meta,
          now,
        );
      } else {
        let recognized = false,
          taskRequested = false;
        const clarification = report.intent === 'clarification';
        const segmentsText = clarification
          ? text.replace(
              /^\s*(?:aclaraci[oó]n|aclaro|para aclarar|clarification)\s*:\s*/i,
              '',
            )
          : text;
        for (const line of ownSegments(segmentsText)) {
          let field = null,
            value = line,
            scope = 'project';
          const n = normalized(line);
          if (/^(?:subobjetivo|subgoal)\s*:/.test(n)) {
            field = 'subgoals';
            value = line.slice(line.indexOf(':') + 1).trim();
          } else if (
            /^(?:avance|progreso|problema pendiente|referencia|contexto)\s*:/.test(
              n,
            )
          ) {
            field = /^(avance|progreso)/.test(n)
              ? 'progress'
              : 'relevant_context';
          }
          const rule = field ? null : ruleSegment(line);
          if (rule?.ambiguous) {
            recognized = true;
            ask(
              state,
              'missing-reference',
              'El alcance de la regla es condicional, puntual o dudoso. Aclará su vigencia antes de activarla.',
              null,
              meta,
              now,
            );
            continue;
          }
          if (rule?.proposal) {
            recognized = true;
            if (rule.value)
              decisionCandidate(state, rule.value, rule.scope, meta, now);
            continue;
          }
          if (rule) {
            field = rule.field;
            value = rule.value;
            scope = rule.scope;
          }
          if (field) {
            recognized = true;
            if (rule?.taskRequested) taskRequested = true;
            if (value)
              proposal(state, field, value, meta, now, {
                updating: rule?.updating || false,
                scope,
              });
          }
        }
        if (clarification) {
          if (!recognized) add(state, 'relevant_context', text, meta, now);
          report.note =
            'Aclaración conservada sin sustituir el objetivo ni resolver referencias dudosas por suposición.';
        } else if (
          (!recognized && report.intent !== 'question') ||
          taskRequested
        ) {
          preserveReviewedRequest(state, meta, now);
          state.current_task = entry(
            state,
            'inference',
            text,
            meta,
            now,
            'inferred',
            'session',
          );
          state.current_task.related_goal_id = active(state.user_goal)
            ? state.user_goal.id
            : null;
        }
        const possible =
          !active(state.user_goal) && report.intent === 'request'
            ? possibleGoal(text)
            : null;
        if (possible)
          candidateGoal(state, possible.text, possible.reason, meta, now);
        if (
          !active(state.user_goal) &&
          report.intent === 'request' &&
          !possible
        )
          ask(
            state,
            'missing-goal',
            '¿Cuál es el objetivo principal? La tarea actual no lo sustituye.',
            null,
            meta,
            now,
          );
      }
      state.interaction_review = null;
      state.last_interaction = {
        intent: report.intent,
        relation: report.relation,
        certainty: report.certainty,
        origin: origin(meta),
        at: now,
      };
      break;
    }
    default:
      throw new UnderstandingError('Operación no permitida');
  }
  state.uncertainty = [];
  if (state.current_task?.certainty === 'inferred')
    state.uncertainty.push({
      kind: 'task-relation',
      text: 'La relación de la tarea con el objetivo es una inferencia local, no confirmación del usuario.',
      reference_id: state.current_task.id,
    });
  if ((state.goal_candidates || []).some((g) => g.status === 'pending'))
    state.uncertainty.push({
      kind: 'goal-candidate',
      text: 'Hay una interpretación de objetivo pendiente de confirmación; no es un objetivo declarado.',
      reference_id: state.goal_candidates.find((g) => g.status === 'pending')
        .id,
    });
  if ((state.decision_candidates || []).some((e) => e.status === 'pending'))
    state.uncertainty.push({
      kind: 'decision-proposal',
      text: 'Hay propuestas del usuario pendientes; no son decisiones confirmadas.',
      reference_id: state.decision_candidates.find(
        (e) => e.status === 'pending',
      ).id,
    });
  state.uncertainty.push(
    ...state.pending_questions
      .filter((q) => q.status === 'open')
      .map((q) => ({ kind: q.kind, text: q.text, reference_id: q.id })),
  );
  state.revision++;
  state.last_context_update = now;
  validateUnderstanding(state);
  return {
    state,
    report: {
      ...report,
      clarifications: state.pending_questions
        .filter((q) => q.status === 'open')
        .map((q) => ({ id: q.id, text: q.text, kind: q.kind })),
    },
  };
}
// Índice por dimensión: no se normaliza cada regla una vez por preferencia.
function preferenceAdvisories(state) {
  const index = new Map(),
    conflicts = [];
  for (const f of RULE_FIELDS.filter((f) => f !== 'preferences'))
    for (const e of state[f].filter(active)) {
      const k = comparableRule(e.text);
      if (!k) continue;
      if (!index.has(k.key)) index.set(k.key, []);
      index.get(k.key).push({ id: e.id, value: k.value });
    }
  for (const p of state.preferences.filter(active)) {
    const k = comparableRule(p.text);
    if (!k) continue;
    for (const old of index.get(k.key) || [])
      if (old.value !== k.value) {
        if (conflicts.length === 100) return { conflicts, clipped: true };
        conflicts.push({
          preference_id: p.id,
          rule_id: old.id,
          reason: 'La preferencia no sustituye una regla de mayor prioridad.',
        });
      }
  }
  return { conflicts, clipped: false };
}
export function effectiveUnderstanding(state) {
  validateUnderstanding(state);
  const advisory = preferenceAdvisories(state);
  return {
    context_id: state.context_id,
    revision: state.revision,
    system_policies: [...SYSTEM_POLICIES],
    user_goal: active(state.user_goal) ? state.user_goal : null,
    independent_goals: (state.independent_goals || []).filter(active),
    goal_candidates: (state.goal_candidates || []).filter(
      (g) => g.status === 'pending',
    ),
    decision_candidates: (state.decision_candidates || []).filter(
      (e) => e.status === 'pending',
    ),
    preference_conflicts: advisory.conflicts,
    preference_conflicts_clipped: advisory.clipped,
    explicit_constraints: state.explicit_constraints.filter(active),
    active_instructions: state.active_instructions.filter(active),
    confirmed_decisions: state.confirmed_decisions.filter(active),
    preferences: state.preferences.filter(active),
    current_task: state.current_task,
    task_tracking: taskProjection(state),
    work_tracking: workProjection(state),
    project: state.project || null,
    context_references: (state.context_references || []).filter(
      (r) => r.status === 'linked',
    ),
    selected_reference:
      state.relevant_context.find(
        (e) => e.id === state.selected_reference_id,
      ) || null,
    subgoals: state.subgoals.filter(active),
    relevant_context: state.relevant_context.filter(active),
    progress: state.progress.filter(active),
    pending_questions: state.pending_questions.filter(
      (q) => q.status === 'open',
    ),
    uncertainty: state.uncertainty,
    interaction: {
      original: state.last_interaction,
      review: state.interaction_review || null,
    },
    last_context_update: state.last_context_update,
    readiness: state.pending_questions.some((q) => q.status === 'open')
      ? 'needs-clarification'
      : (state.decision_candidates || []).some((e) => e.status === 'pending')
        ? 'needs-decision-confirmation'
        : !active(state.user_goal)
          ? (state.goal_candidates || []).some((g) => g.status === 'pending')
            ? 'needs-goal-confirmation'
            : 'no-active-goal'
          : 'structured-context-available',
  };
}
export function validateUnderstanding(s) {
  const fail = () => {
    throw new UnderstandingError(
      'Estado de comprensión inválido o incompatible',
      'storage',
    );
  };
  if (
    !s ||
    s.schema_version !== UNDERSTANDING_VERSION ||
    typeof s.context_id !== 'string' ||
    s.context_id.length > 150 ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 0 ||
    !Number.isFinite(s.last_context_update)
  )
    fail();
  function validOrigin(o) {
    return (
      o &&
      o.role === 'user' &&
      typeof o.channel === 'string' &&
      o.channel.length <= 100 &&
      typeof o.message_id === 'string' &&
      o.message_id.length <= 200 &&
      typeof o.url === 'string' &&
      o.url.length <= 2048
    );
  }
  function checkMemoryReference(r) {
    if (
      !r ||
      typeof r.id !== 'string' ||
      !r.id ||
      r.id.length > 200 ||
      typeof r.project_id !== 'string' ||
      !r.project_id ||
      r.project_id.length > 200 ||
      (r.kind !== undefined &&
        (typeof r.kind !== 'string' || r.kind.length > 100)) ||
      (r.digest !== undefined && !/^[a-f0-9]{64}$/.test(r.digest))
    )
      fail();
  }
  function check(
    e,
    statuses = ['active', 'superseded', 'obsolete', 'rejected'],
  ) {
    if (
      !e ||
      typeof e.id !== 'string' ||
      e.id.length > 150 ||
      !statuses.includes(e.status) ||
      !['explicit', 'inferred', 'confirmed'].includes(e.certainty) ||
      !['project', 'session'].includes(e.scope) ||
      !e.origin ||
      e.origin.role !== 'user' ||
      typeof e.origin.channel !== 'string' ||
      e.origin.channel.length > 100 ||
      typeof e.origin.message_id !== 'string' ||
      e.origin.message_id.length > 200 ||
      typeof e.origin.url !== 'string' ||
      e.origin.url.length > 2048 ||
      !Number.isInteger(e.priority) ||
      e.priority < 1 ||
      e.priority > 7 ||
      !Number.isFinite(e.created_at) ||
      !Number.isFinite(e.updated_at)
    )
      fail();
    if (e.resolution !== undefined) {
      const r = e.resolution;
      if (
        !r ||
        !['user-declaration', 'user-confirmation'].includes(r.kind) ||
        r.verified !== false ||
        !Number.isFinite(r.at) ||
        !validOrigin(r.origin) ||
        (r.target_goal_id !== undefined &&
          r.target_goal_id !== null &&
          (typeof r.target_goal_id !== 'string' ||
            r.target_goal_id.length > 150)) ||
        (r.statement !== undefined &&
          (typeof r.statement !== 'string' ||
            r.statement.length > MAX_USER_TEXT))
      )
        fail();
    }
    if (['completed', 'cancelled'].includes(e.status) && !e.resolution) fail();
    if (
      e.category !== undefined &&
      (!RULE_FIELDS.includes(e.category) ||
        (e.certainty !== 'inferred' && e.priority !== PRIORITY[e.category]))
    )
      fail();
    if (e.change !== undefined) {
      const c = e.change;
      if (
        !c ||
        !['retired', 'replaced', 'session-expired'].includes(c.kind) ||
        !Number.isFinite(c.at) ||
        (c.kind !== 'session-expired' && !validOrigin(c.origin))
      )
        fail();
    }
    if (e.reference !== undefined) checkMemoryReference(e.reference);
    userText(e.text);
  }
  const goalStatuses = [
    'active',
    'superseded',
    'obsolete',
    'rejected',
    'completed',
    'cancelled',
  ];
  if (s.user_goal) {
    check(s.user_goal, goalStatuses);
    if (
      s.user_goal.goal_type !== undefined &&
      s.user_goal.goal_type !== 'primary'
    )
      fail();
  }
  for (const [field, max, statuses] of [
    ['independent_goals', GOAL_LIMITS.independent, goalStatuses],
    [
      'goal_candidates',
      GOAL_LIMITS.candidates,
      ['pending', 'accepted', 'rejected', 'superseded'],
    ],
  ]) {
    if (s[field] !== undefined) {
      if (!Array.isArray(s[field]) || s[field].length > max) fail();
      s[field].forEach((e) => {
        check(e, statuses);
        if (field === 'independent_goals' && e.goal_type !== 'independent')
          fail();
        if (
          field === 'goal_candidates' &&
          (e.certainty !== 'inferred' ||
            typeof e.reason !== 'string' ||
            e.reason.length > 2000 ||
            (['accepted', 'rejected'].includes(e.status) &&
              e.resolution?.kind !== 'user-confirmation'))
        )
          fail();
      });
    }
  }
  if (s.goal_events !== undefined) {
    if (
      !Array.isArray(s.goal_events) ||
      s.goal_events.length > GOAL_LIMITS.events ||
      s.goal_events.some(
        (e) =>
          !e ||
          typeof e.id !== 'string' ||
          e.id.length > 150 ||
          typeof e.goal_id !== 'string' ||
          e.goal_id.length > 150 ||
          e.certainty !== 'user-declared' ||
          ![null, 'active', 'completed', 'cancelled', 'pending'].includes(
            e.from,
          ) ||
          ![
            'active',
            'completed',
            'cancelled',
            'superseded',
            'accepted',
            'rejected',
          ].includes(e.to) ||
          ![
            'primary-set',
            'independent-added',
            'promoted-to-primary',
            'reopened',
            'completed',
            'cancelled',
            'candidate-rejected',
            'candidate-confirmed',
          ].includes(e.action) ||
          !Number.isFinite(e.at) ||
          !validOrigin(e.origin),
      )
    )
      fail();
  }
  if (s.decision_candidates !== undefined) {
    if (
      !Array.isArray(s.decision_candidates) ||
      s.decision_candidates.length > DECISION_CANDIDATE_LIMIT
    )
      fail();
    for (const e of s.decision_candidates) {
      check(e, ['pending', 'accepted', 'rejected', 'obsolete']);
      if (
        e.source_kind !== 'user-proposal' ||
        e.certainty !== 'inferred' ||
        (['accepted', 'rejected'].includes(e.status) &&
          e.resolution?.kind !== 'user-confirmation') ||
        (e.status === 'accepted' &&
          (typeof e.target_id !== 'string' || e.target_id.length > 150))
      )
        fail();
    }
  }
  if (s.current_task) check(s.current_task);
  for (const field of FIELDS) {
    if (!Array.isArray(s[field]) || s[field].length > 200) fail();
    s[field].forEach((e) => {
      check(e);
      if (e.category !== undefined && e.category !== field) fail();
    });
  }
  for (const [field, max] of [
    ['goal_history', 50],
    ['instruction_history', 400],
  ]) {
    if (!Array.isArray(s[field]) || s[field].length > max) fail();
    s[field].forEach((e) =>
      check(e, field === 'goal_history' ? goalStatuses : undefined),
    );
  }
  if (
    !Array.isArray(s.pending_questions) ||
    s.pending_questions.length > 100 ||
    s.pending_questions.some(
      (q) =>
        !q ||
        typeof q.id !== 'string' ||
        typeof q.text !== 'string' ||
        !['open', 'accepted', 'rejected'].includes(q.status) ||
        !Array.isArray(q.conflict_ids) ||
        q.conflict_ids.some(
          (id) => typeof id !== 'string' || id.length > 150,
        ) ||
        ![
          'conflict',
          'goal-change',
          'context-reference',
          'missing-goal',
          'missing-reference',
        ].includes(q.kind) ||
        !q.origin ||
        q.origin.role !== 'user' ||
        !Number.isFinite(q.created_at) ||
        (q.proposed &&
          (!['conflict', 'goal-change', 'context-reference'].includes(q.kind) ||
            typeof q.proposed.text !== 'string' ||
            q.proposed.text.length > MAX_USER_TEXT)) ||
        (q.kind === 'conflict' &&
          q.proposed &&
          (!RULE_FIELDS.includes(q.proposed.field) ||
            !['project', 'session'].includes(q.proposed.scope) ||
            !q.conflict_ids.length ||
            (q.proposed.decision_candidate_id !== undefined &&
              (q.proposed.field !== 'confirmed_decisions' ||
                typeof q.proposed.decision_candidate_id !== 'string' ||
                q.proposed.decision_candidate_id.length > 150)))),
    )
  )
    fail();
  if (
    !Array.isArray(s.seen_messages) ||
    s.seen_messages.length > 2048 ||
    s.seen_messages.some((v) => typeof v !== 'string' || v.length > 200)
  )
    fail();
  for (const q of s.pending_questions)
    if (q.proposed?.reference !== undefined)
      checkMemoryReference(q.proposed.reference);
  if (!Array.isArray(s.uncertainty) || s.uncertainty.length > 110) fail();
  if (s.last_interaction !== null && s.last_interaction !== undefined) {
    const i = s.last_interaction;
    if (
      !i ||
      typeof i.intent !== 'string' ||
      i.intent.length > 100 ||
      typeof i.relation !== 'string' ||
      i.relation.length > 100 ||
      !['explicit', 'inferred', 'uncertain'].includes(i.certainty) ||
      !validOrigin(i.origin) ||
      !Number.isFinite(i.at)
    )
      fail();
  }
  validateReview(s, fail);
  validateWork(s, fail);
  validateTasks(s, fail);
  validateProjects(s, fail);
  if (JSON.stringify(s).length > 2_000_000)
    throw new UnderstandingError(
      'El contexto supera el límite de 2 millones de caracteres; no se podarán instrucciones activas.',
      'limit',
    );
  return s;
}

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
    current_task: null,
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
function archive(state, e, now, status = 'superseded') {
  boundedPush(
    state.instruction_history,
    { ...e, status, updated_at: now },
    400,
  );
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
    (e) => active(e) && normalized(e.text) === normalized(text),
  );
  if (same) return same;
  const e = entry(state, field, text, meta, now, certainty, scope);
  boundedPush(state[field], e);
  return e;
}
function setGoal(state, text, meta, now) {
  if (state.user_goal?.text === text) return;
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
      { ...state.user_goal, status: 'superseded', updated_at: now },
      50,
    );
  state.user_goal = entry(state, 'user_goal', text, meta, now);
  state.current_task = null;
}
function ask(state, kind, text, proposed, meta, now, conflictIds = []) {
  const same = state.pending_questions.find(
    (q) =>
      q.status === 'open' &&
      q.kind === kind &&
      normalized(q.proposed?.text || '') === normalized(proposed?.text || '') &&
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
function conflicting(state, field, text) {
  const k = instructionKey(text);
  if (!k) return [];
  return [...state.explicit_constraints, ...state.active_instructions]
    .filter((e) => active(e))
    .filter((e) => {
      const old = instructionKey(e.text);
      return old && old.key === k.key && old.value !== k.value;
    });
}
function proposal(
  state,
  field,
  text,
  meta,
  now,
  { updating = false, scope = 'project' } = {},
) {
  if (!['explicit_constraints', 'active_instructions'].includes(field))
    return add(state, field, text, meta, now, 'explicit', scope);
  const clashes = conflicting(state, field, text);
  if (clashes.length) {
    // Una actualización inequívoca de instrucciones del mismo nivel no cambia restricciones superiores.
    if (updating && clashes.every((e) => e.priority === PRIORITY[field])) {
      for (const e of clashes) {
        archive(state, e, now);
        state[field] = state[field].filter((x) => x.id !== e.id);
      }
      return add(state, field, text, meta, now, 'explicit', scope);
    }
    return ask(
      state,
      'conflict',
      `La nueva indicación parece incompatible con ${clashes.map((e) => `«${e.text}»`).join('; ')}. ¿Querés sustituir esas reglas concretas por «${text}»?`,
      { field, text, scope },
      meta,
      now,
      clashes.map((e) => e.id),
    );
  }
  return add(state, field, text, meta, now, 'explicit', scope);
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
    if (/^\s*(?:ejemplos?|examples?|texto citado)\s*:/i.test(line)) {
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
        state.user_goal || state.current_task
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
      relation: state.user_goal ? 'possibly-related' : 'unknown',
      certainty: 'inferred',
    };
  return {
    intent: 'request',
    relation: state.user_goal ? 'possibly-related' : 'unknown',
    certainty: 'inferred',
  };
}
function removeActive(state, id, now, status = 'obsolete') {
  for (const field of FIELDS) {
    const e = state[field].find((e) => e.id === id);
    if (e) {
      archive(state, e, now, status);
      state[field] = state[field].filter((x) => x.id !== id);
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
      for (const ref of q.conflict_ids)
        removeActive(state, ref, now, 'superseded');
      add(
        state,
        q.proposed.field,
        q.proposed.text,
        meta,
        now,
        'confirmed',
        q.proposed.scope,
      );
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
    case 'goal':
      setGoal(state, userText(operation.text), meta, now);
      break;
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
      removeActive(state, operation.id, now);
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
      if (report.goal) {
        if (!state.user_goal || report.goal.change)
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
          removeActive(state, e.id, now, 'superseded');
          proposal(state, field, parts[2], meta, now, {
            updating: true,
            scope: e.scope,
          });
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
        if (!previousTask && !state.user_goal)
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
            /^(?:decision confirmada|decidimos|decision)\s*:/.test(n)
          ) {
            field = 'confirmed_decisions';
            value = line.slice(line.indexOf(':') + 1).trim();
          } else if (
            /^(?:avance|progreso|problema pendiente|referencia|contexto)\s*:/.test(
              n,
            )
          ) {
            field = /^(avance|progreso)/.test(n)
              ? 'progress'
              : 'relevant_context';
          } else if (/^(?:preferencia|prefiero|preferiria|i prefer)\b/.test(n))
            field = 'preferences';
          else if (/^(?:restriccion|obligatorio)\s*:/.test(n)) {
            field = 'explicit_constraints';
            value = line.slice(line.indexOf(':') + 1).trim();
          } else if (
            /^(?:instruccion|resultado esperado|prioridad)\s*:/.test(n)
          ) {
            field = 'active_instructions';
            value = line.slice(line.indexOf(':') + 1).trim();
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
          if (field) {
            recognized = true;
            if (
              field === 'active_instructions' &&
              /^(?:ahora\s+)?(?:modifica|ejecuta|mejora|analiza|implementa|crea)\b/.test(
                n,
              )
            )
              taskRequested = true;
            if (value)
              proposal(state, field, value, meta, now, {
                updating: /^ahora\b/.test(n),
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
          state.current_task = entry(
            state,
            'inference',
            text,
            meta,
            now,
            'inferred',
            'session',
          );
          state.current_task.related_goal_id = state.user_goal?.id || null;
        }
        if (!state.user_goal && report.intent === 'request')
          ask(
            state,
            'missing-goal',
            '¿Cuál es el objetivo principal? La tarea actual no lo sustituye.',
            null,
            meta,
            now,
          );
      }
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
export function effectiveUnderstanding(state) {
  validateUnderstanding(state);
  return {
    context_id: state.context_id,
    revision: state.revision,
    system_policies: [...SYSTEM_POLICIES],
    user_goal: state.user_goal,
    explicit_constraints: state.explicit_constraints.filter(active),
    active_instructions: state.active_instructions.filter(active),
    confirmed_decisions: state.confirmed_decisions.filter(active),
    preferences: state.preferences.filter(active),
    current_task: state.current_task,
    subgoals: state.subgoals.filter(active),
    relevant_context: state.relevant_context.filter(active),
    progress: state.progress.filter(active),
    pending_questions: state.pending_questions.filter(
      (q) => q.status === 'open',
    ),
    uncertainty: state.uncertainty,
    last_context_update: state.last_context_update,
    readiness: state.pending_questions.some((q) => q.status === 'open')
      ? 'needs-clarification'
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
  function check(e) {
    if (
      !e ||
      typeof e.id !== 'string' ||
      e.id.length > 150 ||
      !['active', 'superseded', 'obsolete', 'rejected'].includes(e.status) ||
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
    userText(e.text);
  }
  if (s.user_goal) check(s.user_goal);
  if (s.current_task) check(s.current_task);
  for (const field of FIELDS) {
    if (!Array.isArray(s[field]) || s[field].length > 200) fail();
    s[field].forEach(check);
  }
  for (const [field, max] of [
    ['goal_history', 50],
    ['instruction_history', 400],
  ]) {
    if (!Array.isArray(s[field]) || s[field].length > max) fail();
    s[field].forEach(check);
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
          (!['active_instructions', 'explicit_constraints'].includes(
            q.proposed.field,
          ) ||
            !['project', 'session'].includes(q.proposed.scope))),
    )
  )
    fail();
  if (
    !Array.isArray(s.seen_messages) ||
    s.seen_messages.length > 2048 ||
    s.seen_messages.some((v) => typeof v !== 'string' || v.length > 200)
  )
    fail();
  if (!Array.isArray(s.uncertainty) || s.uncertainty.length > 110) fail();
  if (JSON.stringify(s).length > 2_000_000)
    throw new UnderstandingError(
      'El contexto supera el límite de 2 millones de caracteres; no se podarán instrucciones activas.',
      'limit',
    );
  return s;
}

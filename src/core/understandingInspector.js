/** Vista explicable, paginada y derivada. No almacena razonamientos ni inventa trazas. */
export const INSPECTOR_CATEGORIES = Object.freeze([
  'system',
  'goals',
  'goal_candidates',
  'request',
  'interaction',
  'subgoals',
  'explicit_constraints',
  'active_instructions',
  'confirmed_decisions',
  'preferences',
  'relevant_context',
  'progress',
  'tasks',
  'project',
  'context_references',
  'work',
  'evidence',
  'questions',
  'history',
  'reviews',
  'observation',
  'tracking',
  'uncertainty',
]);
const reasons = {
  system: 'Política fija de seguridad. No editable desde Comprensión.',
  goals:
    'Objetivo declarado o confirmado por el usuario. Su cierre es declarado, no ejecución comprobada.',
  goal_candidates:
    'Inferencia local pendiente o evaluada. No sustituye un objetivo explícito.',
  request:
    'Última solicitud interpretada. La relación inicial con el objetivo es inferida; confirmar no crea una tarea ejecutora.',
  interaction:
    'Clasificación local del mensaje. Una corrección humana es una anotación, no deshace ni reinterpreta mutaciones anteriores.',
  subgoals:
    'Subobjetivo conservado como dato del usuario; no es un plan automáticamente descompuesto.',
  explicit_constraints:
    'Restricción obligatoria declarada. Prevalece sobre instrucciones, decisiones, preferencias e inferencias; no concede permisos.',
  active_instructions:
    'Instrucción del usuario con alcance registrado. No modifica políticas de seguridad ni permisos del navegador.',
  confirmed_decisions:
    'Decisión declarada/confirmada por el usuario; no es prueba ni autorización para acciones sensibles.',
  preferences:
    'Preferencia orientativa. No puede sustituir restricciones ni objetivos explícitos.',
  relevant_context:
    'Dato contextual o referencia. No otorga autoridad normativa ni demuestra verdad factual.',
  progress:
    'Avance simple declarado. No verificado ni convertido en porcentaje de trabajo real.',
  tasks:
    'Seguimiento explícito de tarea. Elegibilidad sólo estructural, no autorización ni evidencia de ejecución.',
  project:
    'Etiqueta local descriptiva; no fusiona conversaciones ni comparte reglas por similitud de nombres.',
  context_references:
    'Puntero versionado a antecedentes. Confirmarlo vincula datos, no importa instrucciones.',
  work: 'Registro declarado o extracto elegido del asistente. Siempre no verificado; no cierra tareas ni concede permisos.',
  evidence:
    'Aporte del usuario, no resultado observado de una herramienta de NEXO. Ubicaciones no se abren ni se comprueban.',
  questions:
    'Ambigüedad o conflicto conservados. Una pregunta sin propuesta necesita aclaración escrita, no un sí genérico.',
  history:
    'Versión anterior conservada. No se reactiva ni tiene autoridad por aparecer en historia.',
  reviews:
    'Revisión humana con motivo y origen. Se conserva sin convertirla en verificación factual.',
  tracking:
    'Foco y próximo paso elegidos explícitamente. No autorizan ejecución; no se sustituyen con un plan inferido.',
  uncertainty:
    'Duda o inferencia conservada. No es un hecho confirmado ni una probabilidad medida.',
  observation:
    'Metadatos del lector existente. Asistente no es usuario; completo significa estable en DOM, no trabajo completado.',
};
const hints = {
  goals:
    'Objetivos: editar principal o crear/cerrar/reabrir independientes explícitamente.',
  goal_candidates:
    'Objetivos: confirmar como principal sólo si no hay uno activo, independiente o rechazar.',
  request:
    'Revisar última solicitud: confirmar relación, corregir texto o rechazar.',
  interaction:
    'Revisar intención: anotar intención/relación humana sin reejecutar el mensaje.',
  subgoals: 'Corregir dato simple con motivo o retirarlo.',
  progress: 'Corregir dato simple con motivo o retirarlo.',
  relevant_context:
    'Datos simples: corrección con motivo. Referencias nombradas/EVO: retirar y registrar otra explícitamente.',
  tasks: 'Tareas: editor de texto/relaciones y estados con historia.',
  work: 'Progreso: resolver/reabrir problemas, evaluar propuestas o retirar y crear otra entrada.',
  evidence:
    'Progreso: retirar aporte con motivo; corregir mediante un aporte nuevo.',
  questions: 'Aclaraciones: confirmar sólo propuesta concreta o descartar.',
  history: 'Sólo lectura. Declarar una nueva entrada no reactiva ésta.',
  reviews: 'Sólo lectura; una nueva revisión preserva las anteriores.',
};
export function buildUnderstandingInspector(
  state,
  query = {},
  { conversation = null, systemPolicies = [] } = {},
) {
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw Error('Consulta del inspector inválida');
  const {
    category = 'all',
    certainty = 'all',
    status = 'all',
    offset = 0,
  } = query;
  if (
    !['all', ...INSPECTOR_CATEGORIES].includes(category) ||
    ![
      'all',
      'explicit',
      'confirmed',
      'inferred',
      'uncertain',
      'observed-not-verified',
    ].includes(certainty) ||
    typeof status !== 'string' ||
    status.length > 50 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10000
  )
    throw Error('Filtros del inspector inválidos');
  const rows = [];
  function add(category, e, index = 0, override = {}) {
    if (!e) return;
    const raw = e.text ?? e.name ?? e.label ?? e.reason ?? '';
    const source = e.source || e.origin || null;
    rows.push({
      key: `${category}:${e.id || index}:${index}`,
      id: e.id ?? null,
      category,
      text: raw.slice(0, 1000),
      chars: raw.length,
      clipped: raw.length > 1000,
      status: e.status || 'recorded',
      certainty: e.certainty || 'explicit',
      scope: e.scope || 'project',
      priority: e.priority ?? null,
      origin: e.origin || null,
      source,
      created_at: e.created_at ?? e.at ?? null,
      updated_at: e.updated_at ?? e.at ?? null,
      verified: false,
      authority:
        category === 'system'
          ? 'system-policy'
          : category === 'history'
            ? 'historical-data-only'
            : 'inspection-data-only',
      reason: reasons[category],
      correction_hint:
        hints[category] ||
        'Usá los controles específicos de su categoría; no editar políticas desde el inspector.',
      ...override,
    });
  }
  systemPolicies.forEach((text, i) =>
    add(
      'system',
      {
        text,
        status: 'fixed',
        certainty: 'explicit',
        scope: 'system',
        priority: 1,
      },
      i,
    ),
  );
  [state.user_goal, ...(state.independent_goals || [])]
    .filter(Boolean)
    .forEach((e, i) => add('goals', e, i));
  (state.goal_candidates || []).forEach((e, i) => add('goal_candidates', e, i));
  add('request', state.current_task);
  if (state.last_interaction) {
    const i = state.last_interaction,
      r = state.interaction_review;
    add(
      'interaction',
      {
        ...i,
        text: `Original: ${i.intent} · ${i.relation} · ${i.certainty}${r ? `\nRevisión humana: ${r.intent} · ${r.relation} · motivo: ${r.reason}` : ''}`,
      },
      0,
      { review_origin: r?.origin || null },
    );
  }
  for (const field of [
    'subgoals',
    'explicit_constraints',
    'active_instructions',
    'confirmed_decisions',
    'preferences',
    'relevant_context',
    'progress',
  ])
    state[field].forEach((e, i) => add(field, e, i));
  (state.decision_candidates || []).forEach((e, i) =>
    add('confirmed_decisions', e, i, {
      reason:
        'Propuesta del usuario, no decisión vigente hasta confirmación específica.',
    }),
  );
  (state.tasks || []).forEach((e, i) => add('tasks', e, i));
  add('project', state.project);
  (state.context_references || []).forEach((e, i) =>
    add('context_references', e, i),
  );
  (state.work_records || []).forEach((e, i) => add('work', e, i));
  (state.work_evidence || []).forEach((e, i) => add('evidence', e, i));
  state.pending_questions.forEach((e, i) => add('questions', e, i));
  [
    ...state.goal_history,
    ...state.instruction_history,
    ...(state.project_history || []),
  ].forEach((e, i) => add('history', e, i));
  for (const [kind, events] of [
    ['goal', state.goal_events],
    ['task', state.task_events],
    ['context', state.context_events],
    ['work', state.work_events],
  ])
    (events || []).forEach((e, i) =>
      add(
        'history',
        {
          ...e,
          text: `Evento ${kind}: ${e.action} · ${e.task_id || e.goal_id || e.reference_id || e.target_id || 'lista'} · ${e.reason || ''}${e.changes ? ' · ' + JSON.stringify(e.changes) : ''}`,
        },
        i,
        { key: `event:${kind}:${e.id}`, status: 'historical-event' },
      ),
    );
  add('tracking', {
    text: `Foco: ${state.focused_task_id || 'ninguno'} · próximo paso: ${state.next_step?.task_id || 'ninguno'}`,
    origin: state.next_step?.origin || null,
    status: 'recorded',
  });
  state.uncertainty.forEach((e, i) =>
    add(
      'uncertainty',
      { ...e, certainty: 'uncertain', status: 'unresolved' },
      i,
    ),
  );
  (state.review_events || []).forEach((e, i) =>
    add(
      'reviews',
      {
        ...e,
        text: `${e.action} · ${e.target_id} → ${e.replacement_id || 'ninguno'}\n${e.before_label} → ${e.after_label}\nMotivo: ${e.reason}`,
      },
      i,
    ),
  );
  (conversation?.messages || []).forEach((e, i) =>
    add(
      'observation',
      {
        ...e,
        text: `${e.role} · ${e.id} · ${e.chars} caracteres · ${e.status}`,
        certainty: 'observed-not-verified',
        created_at: e.observed_at,
        origin: null,
      },
      i,
      {
        source: {
          role: e.role,
          channel: 'conversation-read',
          message_id: e.id,
        },
        reason: `${reasons.observation} No se copia el texto del mensaje en este índice.`,
      },
    ),
  );
  const matched = rows.filter(
    (r) =>
      (category === 'all' || r.category === category) &&
      (certainty === 'all' || r.certainty === certainty) &&
      (status === 'all' || r.status === status),
  );
  return {
    context_id: state.context_id,
    revision: state.revision,
    total: rows.length,
    matched: matched.length,
    offset,
    page_size: 20,
    items: matched.slice(offset, offset + 20),
    categories: INSPECTOR_CATEGORIES.map((category) => ({
      category,
      count: rows.filter((r) => r.category === category).length,
    })),
    statuses: [...new Set(rows.map((r) => r.status))],
    query: { category, certainty, status, offset },
    explanation:
      'Explicaciones deterministas según campos y procedencia guardados; no son razonamiento interno ni una traza semántica retrospectiva. Sin verificación factual ni ejecución.',
  };
}

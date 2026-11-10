/** Controles de progreso sin herramientas, envíos ni verificación factual. */
const kinds = {
  advance: 'Avance declarado',
  result: 'Resultado declarado',
  error: 'Error informado',
  blocker: 'Bloqueo informado',
  proposal: 'Propuesta, no decisión ni permiso',
};
const statuses = {
  open: 'Abierto',
  resolved: 'Resuelto según el usuario',
  accepted: 'Propuesta aceptada para seguimiento, no autoriza ejecución',
  rejected: 'Propuesta rechazada',
  withdrawn: 'Retirado con historia',
};
const outcomes = {
  unknown: 'No determinado',
  success: 'Éxito informado',
  partial: 'Resultado parcial informado',
  failure: 'Fallo informado',
};
export function createProgressSection({
  state: s,
  tracking,
  conversation,
  create,
  button,
  form,
  mutate,
  drafts,
}) {
  const section = create('section', undefined, 'work-content');
  section.append(
    create('h3', 'Progreso, problemas y evidencia'),
    create(
      'p',
      'Registro local, no auditoría de ejecución. Una afirmación del asistente, una tarea cerrada o una evidencia aportada no prueban que el trabajo se realizó. Aceptar una propuesta sólo registra tu evaluación; no cambia reglas ni autoriza herramientas.',
      'note',
    ),
  );
  if (s.progress.length)
    section.append(
      create(
        'p',
        `${s.progress.length} avances simples conservados en «Avances y problemas declarados». No se migran ni se convierten en evidencia automáticamente.`,
        'note',
      ),
    );
  const counts = tracking.task_counts;
  section.append(
    create(
      'p',
      `Estados de tareas declarados: ${counts.pending} pendientes · ${counts.in_progress} en curso · ${counts.blocked} bloqueadas · ${counts.completed} completadas · ${counts.cancelled} canceladas. No es un porcentaje de avance verificado.`,
    ),
    create(
      'p',
      `${tracking.open_problems.length} problemas abiertos · ${tracking.pending_proposals.length} propuestas pendientes · ${tracking.without_evidence.length} resultados sin evidencia activa aportada. Los bloqueos de este registro no alteran el grafo de tareas: cambiá su estado explícitamente en Tareas.`,
      'note',
    ),
  );
  function select(name, title, options, value) {
    const label = create('label', title),
      input = create('select'),
      key = `${s.context_id}:${name}`;
    for (const [v, title] of options) {
      const o = create('option', title);
      o.value = v;
      input.append(o);
    }
    input.value = drafts.get(key) ?? value;
    input.addEventListener('change', () => drafts.set(key, input.value));
    label.append(input);
    return { label, input };
  }
  const taskOptions = [
    ['', 'Sin tarea asociada'],
    ...(s.tasks || []).map((t) => [t.id, `${t.text} (${t.status})`]),
  ];
  const goalOptions = [
    ['', 'Sin objetivo asociado'],
    ...[s.user_goal, ...(s.independent_goals || []), ...s.goal_history]
      .filter(Boolean)
      .map((g) => [g.id, `${g.text} (${g.status})`]),
  ];
  const kind = select(
      'work-add:kind',
      'Tipo de declaración',
      Object.entries(kinds),
      'advance',
    ),
    task = select('work-add:task', 'Tarea explícita', taskOptions, ''),
    goal = select('work-add:goal', 'Objetivo explícito', goalOptions, ''),
    outcome = select(
      'work-add:outcome',
      'Resultado, sólo para tipo resultado',
      Object.entries(outcomes),
      'unknown',
    );
  const add = form(
    'work-add',
    'Texto literal del registro (máximo 10.000 caracteres)',
    '',
    'Registrar declaración',
    (text, key) =>
      mutate(
        {
          type: 'work-add',
          kind: kind.input.value,
          text,
          task_id: task.input.value || null,
          goal_id: goal.input.value || null,
          outcome: outcome.input.value,
        },
        key,
      ),
  );
  add.querySelectorAll('textarea')[0].maxLength = 10000;
  add.prepend(kind.label, task.label, goal.label, outcome.label);
  section.append(add);
  const taskName = (id) =>
    (s.tasks || []).find((t) => t.id === id)?.text || 'Sin tarea asociada';
  for (const r of s.work_records || []) {
    const card = create(
      r.status === 'withdrawn' ? 'details' : 'article',
      undefined,
      'work-card',
    );
    if (r.status === 'withdrawn')
      card.append(create('summary', `${kinds[r.kind]} · retirado`));
    card.append(
      create('h4', kinds[r.kind]),
      create('p', r.text),
      create(
        'p',
        `${statuses[r.status]} · ${r.id} · ${new Date(r.created_at).toLocaleString()} · ${r.certainty} · no verificado`,
        'note',
      ),
    );
    card.append(
      create(
        'p',
        `Origen del contenido: ${r.source.role === 'assistant' ? 'Asistente observado, no usuario' : 'Usuario'} · ${r.source.channel} · ${r.source.message_id} · ${r.source.url}`,
        'note',
      ),
      create(
        'p',
        `Registrado por el usuario vía ${r.origin.channel} · ${r.origin.message_id}`,
        'note',
      ),
    );
    if (r.source.role === 'assistant')
      card.append(
        create(
          'p',
          `Extracto de hasta 1.000 caracteres; no es la respuesta completa. Huella ${r.source.digest} · observación ${r.source.observation_revision}. La versión capturada se conserva, no se actualiza con regeneraciones.`,
          'note',
        ),
      );
    card.append(
      create(
        'p',
        `Tarea: ${taskName(r.task_id)} · Objetivo: ${goalOptions.find(([id]) => id === r.goal_id)?.[1] || 'Sin objetivo asociado'}`,
        'note',
      ),
    );
    const t = (s.tasks || []).find((t) => t.id === r.task_id);
    if (t?.expected_result)
      card.append(
        create(
          'p',
          `Esperado por la tarea: ${t.expected_result}. Comparación humana pendiente; no se ha comprobado equivalencia.`,
          'note',
        ),
      );
    if (r.kind === 'result')
      card.append(
        create(
          'p',
          `${outcomes[r.outcome]} · ${tracking.without_evidence.includes(r.id) ? 'Sin evidencia activa aportada' : 'Hay aportes, pero no verificación independiente'}`,
          'note',
        ),
      );
    for (const e of (s.work_evidence || []).filter(
      (e) => e.record_id === r.id,
    )) {
      const detail = create('details');
      detail.append(
        create(
          'summary',
          `${e.status === 'active' ? 'Evidencia aportada' : 'Evidencia retirada'} · ${e.kind} · no verificada`,
        ),
        create('p', e.text),
        create(
          'p',
          `${e.origin.channel} · ${e.origin.message_id} · ${new Date(e.created_at).toLocaleString()}`,
          'note',
        ),
      );
      if (e.locator)
        detail.append(
          create('p', `Ubicación declarada (no abierta): ${e.locator}`, 'note'),
        );
      if (e.status === 'active' && r.status !== 'withdrawn')
        detail.append(
          form(
            `work-withdraw-${e.id}`,
            'Motivo para retirar este aporte',
            '',
            'Retirar evidencia con historia',
            (reason, key) =>
              mutate({ type: 'work-evidence-withdraw', id: e.id, reason }, key),
          ),
        );
      card.append(detail);
    }
    if (r.status !== 'withdrawn') {
      const actions =
        r.kind === 'proposal'
          ? r.status === 'open'
            ? ['accepted', 'rejected', 'withdrawn']
            : ['withdrawn']
          : ['error', 'blocker'].includes(r.kind)
            ? [r.status === 'open' ? 'resolved' : 'open', 'withdrawn']
            : ['withdrawn'];
      const action = select(
        `work-state-${r.id}:status`,
        'Cambio explícito',
        actions.map((v) => [v, statuses[v]]),
        actions[0],
      );
      const transition = form(
        `work-state-${r.id}`,
        'Motivo del cambio de seguimiento',
        '',
        'Registrar cambio de seguimiento',
        (reason, key) =>
          mutate(
            {
              type: 'work-transition',
              id: r.id,
              status: action.input.value,
              reason,
            },
            key,
          ),
      );
      transition.prepend(action.label);
      card.append(transition);
      const evidenceKind = select(
        `work-evidence-${r.id}:kind`,
        'Tipo de aporte',
        [
          ['user-report', 'Relato del usuario'],
          [
            'supplied-artifact',
            'Extracto de artefacto aportado por el usuario',
          ],
        ],
        'user-report',
      );
      const location = create('input'),
        locKey = `${s.context_id}:work-evidence-${r.id}:locator`,
        locLabel = create(
          'label',
          'Ubicación opcional; no se abrirá ni comprobará',
        );
      location.maxLength = 2048;
      location.value = drafts.get(locKey) || '';
      location.addEventListener('input', () =>
        drafts.set(locKey, location.value),
      );
      locLabel.append(location);
      const evidence = form(
        `work-evidence-${r.id}`,
        'Evidencia aportada (máximo 10.000 caracteres)',
        '',
        'Conservar evidencia no verificada',
        (text, key) =>
          mutate(
            {
              type: 'work-evidence',
              record_id: r.id,
              text,
              kind: evidenceKind.input.value,
              locator: location.value.trim() ? location.value : null,
            },
            key,
          ),
      );
      evidence.querySelectorAll('textarea')[0].maxLength = 10000;
      evidence.prepend(evidenceKind.label, locLabel);
      card.append(evidence);
    }
    section.append(card);
  }
  const observation = create('details');
  observation.append(
    create(
      'summary',
      'Registrar un extracto observado del asistente explícitamente',
    ),
    create(
      'p',
      'No se clasifican respuestas automáticamente. Elegí si el extracto es una propuesta o una afirmación de resultado; ambas quedan sin verificar. Sólo se aceptan versiones completas con revisión y huella actuales, no streams ni recortes del lector. No equivale a aceptar su contenido.',
      'note',
    ),
  );
  for (const m of conversation?.messages || []) {
    if (m.role !== 'assistant' || m.status !== 'complete' || !m.preview?.trim())
      continue;
    const card = create('article', undefined, 'work-card');
    card.append(
      create('p', m.preview.slice(0, 1000)),
      create(
        'p',
        `${m.id} · extracto de hasta 1.000 caracteres de ${m.chars} · asistente, no verificado`,
        'note',
      ),
    );
    for (const [kind, label] of [
      ['proposal', 'Registrar como propuesta del asistente'],
      ['result', 'Registrar como afirmación de resultado del asistente'],
    ])
      card.append(
        button(label, () =>
          mutate({
            type: 'work-capture',
            kind,
            messageId: m.id,
            digest: m.digest,
            observationRevision: conversation.revision,
          }),
        ),
      );
    observation.append(card);
  }
  section.append(observation);
  const history = create('details');
  history.append(
    create(
      'summary',
      `Historial de seguimiento (${(s.work_events || []).length})`,
    ),
  );
  for (const e of s.work_events || [])
    history.append(
      create(
        'p',
        `${e.target_id} · ${e.from || 'nuevo'} → ${e.to} · ${e.reason} · ${e.origin.channel} · ${e.origin.message_id} · ${new Date(e.at).toLocaleString()}`,
        'note',
      ),
    );
  section.append(history);
  section.querySelectorAll('textarea').forEach((input) => {
    input.maxLength = 10000;
  });
  return section;
}

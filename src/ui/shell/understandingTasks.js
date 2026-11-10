/** Controles de seguimiento: reutilizan el puente y borradores del panel UUE. */
const statuses = {
  pending: 'Pendiente',
  in_progress: 'En curso (declarado)',
  blocked: 'Bloqueada (declarado)',
  completed: 'Completada (declarado, no verificado)',
  cancelled: 'Cancelada',
};
const ranks = {
  unset: 'Sin prioridad acordada',
  high: 'Alta',
  normal: 'Normal',
  low: 'Baja',
};
const reasons = {
  closed: 'Tarea cerrada',
  'user-blocked': 'Bloqueo declarado por el usuario',
  'unfinished-dependencies': 'Dependencias sin completar o reabiertas',
  'closed-goal': 'Objetivo asociado cerrado o sustituido',
  'unavailable-parent': 'Tarea padre cerrada o bloqueada',
};
export function createTaskSection({
  state: s,
  tracking,
  create,
  button,
  form,
  mutate,
  drafts,
  showEntry,
}) {
  const tasks = s.tasks || [],
    byId = new Map(tasks.map((t) => [t.id, t])),
    section = create('section', undefined, 'work-content');
  section.append(
    create('h3', 'Tareas, subtareas y próximo paso'),
    create(
      'p',
      'Seguimiento explícito, no plan automático. Pendiente, en curso y completado son declaraciones; no prueban ejecución. Prioridad y orden no autorizan herramientas ni sustituyen restricciones.',
      'note',
    ),
  );
  const label = (id) => byId.get(id)?.text || 'Sin seleccionar';
  section.append(
    create('p', `Foco explícito: ${label(s.focused_task_id)}`),
    create('p', `Próximo paso acordado: ${label(s.next_step?.task_id)}`),
  );
  if (s.next_step) {
    const e = tracking.eligibility.find(
      (e) => e.task_id === s.next_step.task_id,
    );
    section.append(
      create(
        'p',
        e?.eligible
          ? 'Sin impedimentos estructurales declarados; no autoriza ejecutar.'
          : `Paso conservado, no disponible: ${(e?.reasons || []).map((r) => reasons[r]).join('; ')}. Elegí otro explícitamente.`,
        'note',
      ),
    );
  }
  if (s.focused_task_id)
    section.append(
      button('Quitar foco de tarea', () =>
        mutate({ type: 'task-focus', id: null }),
      ),
    );
  if (s.next_step)
    section.append(
      button('Limpiar próximo paso acordado', () =>
        mutate({ type: 'task-next', id: null }),
      ),
    );
  function select(name, title, options, value, multiple = false) {
    const label = create('label', title),
      input = create('select'),
      key = `${s.context_id}:${name}`;
    input.multiple = multiple;
    const saved = drafts.get(key) ?? value;
    for (const [v, text] of options) {
      const option = create('option', text);
      option.value = v;
      if (multiple) option.selected = saved.includes(v);
      input.append(option);
    }
    if (!multiple) input.value = saved;
    input.addEventListener('change', () =>
      drafts.set(
        key,
        multiple ? [...input.selectedOptions].map((o) => o.value) : input.value,
      ),
    );
    label.append(input);
    return { label, input };
  }
  const goalOptions = [
    ['', 'Sin objetivo vinculado'],
    ...[s.user_goal, ...(s.independent_goals || []), ...s.goal_history]
      .filter(Boolean)
      .map((g) => [g.id, `${g.text} (${g.status})`]),
  ];
  for (const [index, t] of tasks.entries()) {
    const card = showEntry(t, false),
      eligibility = tracking.eligibility.find((e) => e.task_id === t.id);
    card.append(
      create('h4', statuses[t.status]),
      create(
        'p',
        `${ranks[t.task_priority]} · Padre: ${t.parent_id ? label(t.parent_id) : 'Sin padre'} · Dependencias: ${t.depends_on.length ? t.depends_on.map(label).join('; ') : 'Ninguna declarada'}`,
        'note',
      ),
    );
    if (t.status === 'completed' && !eligibility.subtasks_complete)
      card.append(
        create(
          'p',
          'El cierre declarado se conserva, pero hay subtareas no satisfechas. Revisá las relaciones o reabrí la tarea.',
          'note',
        ),
      );
    if (t.goal_id)
      card.append(
        create(
          'p',
          `Objetivo vinculado: ${goalOptions.find(([id]) => id === t.goal_id)?.[1]}`,
          'note',
        ),
      );
    if (t.expected_result)
      card.append(
        create('p', `Resultado esperado (no comprobado): ${t.expected_result}`),
      );
    if (t.block_reason)
      card.append(create('p', `Motivo del bloqueo: ${t.block_reason}`));
    if (t.resolution)
      card.append(
        create(
          'p',
          `Estado declarado por ${t.resolution.origin.channel} · ${new Date(t.resolution.at).toLocaleString()} · ejecución no verificada`,
          'note',
        ),
      );
    if (!eligibility?.eligible)
      card.append(
        create(
          'p',
          `Impedimentos: ${(eligibility?.reasons || []).map((r) => reasons[r]).join('; ')}`,
          'note',
        ),
      );
    card.append(
      button('Seleccionar como foco', () =>
        mutate({ type: 'task-focus', id: t.id }),
      ),
    );
    if (!['completed', 'cancelled'].includes(t.status)) {
      card.append(
        button('Acordar como próximo paso', () =>
          mutate({ type: 'task-next', id: t.id }),
        ),
      );
      if (t.status === 'pending' && eligibility?.eligible)
        card.append(
          button('Declarar tarea en curso', () =>
            mutate({
              type: 'task-transition',
              id: t.id,
              status: 'in_progress',
            }),
          ),
        );
      if (eligibility?.eligible && eligibility.subtasks_complete)
        card.append(
          button('Declarar tarea completada', () =>
            mutate({ type: 'task-transition', id: t.id, status: 'completed' }),
          ),
        );
      if (t.status === 'blocked')
        card.append(
          button('Retirar bloqueo: volver a pendiente', () =>
            mutate({ type: 'task-transition', id: t.id, status: 'pending' }),
          ),
        );
      card.append(
        button('Cancelar tarea', () =>
          mutate({ type: 'task-transition', id: t.id, status: 'cancelled' }),
        ),
      );
      const block = create('details');
      block.append(create('summary', 'Declarar bloqueo'));
      block.append(
        form(
          `block-${t.id}`,
          'Motivo del bloqueo',
          '',
          'Guardar bloqueo declarado',
          (reason, key) =>
            mutate(
              { type: 'task-transition', id: t.id, status: 'blocked', reason },
              key,
            ),
        ),
      );
      card.append(block);
    } else
      card.append(
        button('Reabrir tarea como pendiente', () =>
          mutate({ type: 'task-transition', id: t.id, status: 'pending' }),
        ),
      );
    if (index > 0)
      card.append(
        button('Subir en la lista', () => {
          const ids = tasks.map((t) => t.id);
          [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
          return mutate({ type: 'task-order', ids });
        }),
      );
    if (index < tasks.length - 1)
      card.append(
        button('Bajar en la lista', () => {
          const ids = tasks.map((t) => t.id);
          [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
          return mutate({ type: 'task-order', ids });
        }),
      );
    const edit = create('details');
    edit.append(create('summary', 'Editar tarea y relaciones explícitas'));
    const name = `task-${t.id}`;
    const rank = select(
        `${name}:priority`,
        'Prioridad acordada',
        Object.entries(ranks),
        t.task_priority,
      ),
      parent = select(
        `${name}:parent`,
        'Tarea padre',
        [
          ['', 'Sin padre'],
          ...tasks.filter((c) => c.id !== t.id).map((c) => [c.id, c.text]),
        ],
        t.parent_id || '',
      ),
      goal = select(
        `${name}:goal`,
        'Objetivo asociado',
        goalOptions,
        t.goal_id || '',
      ),
      deps = select(
        `${name}:deps`,
        'Dependencias (selección múltiple; máximo 10)',
        tasks.filter((c) => c.id !== t.id).map((c) => [c.id, c.text]),
        t.depends_on,
        true,
      );
    const resultKey = `${s.context_id}:${name}:result`,
      resultLabel = create('label', 'Resultado esperado; no es evidencia'),
      result = create('textarea');
    result.maxLength = 200000;
    result.rows = 3;
    result.dataset.understandingDraft = resultKey;
    result.value = drafts.get(resultKey) ?? t.expected_result ?? '';
    result.addEventListener('input', () => drafts.set(resultKey, result.value));
    resultLabel.append(result);
    const editor = form(
      name,
      'Texto literal de la tarea',
      t.text,
      'Guardar tarea y relaciones',
      (text, key) =>
        mutate(
          {
            type: 'task-update',
            id: t.id,
            text,
            task_priority: rank.input.value,
            parent_id: parent.input.value || null,
            goal_id: goal.input.value || null,
            depends_on: [...deps.input.selectedOptions].map((o) => o.value),
            expected_result: result.value.trim() ? result.value : null,
          },
          key,
        ),
    );
    editor.append(
      rank.label,
      parent.label,
      goal.label,
      deps.label,
      resultLabel,
    );
    edit.append(editor);
    card.append(edit);
    section.append(card);
  }
  section.append(
    create(
      'p',
      'El orden de lista es explícito y editable; no se infiere que deba ejecutarse en ese orden. Una subtarea no completa automáticamente a su padre.',
      'note',
    ),
  );
  const parent = select(
    'task-add:parent',
    'Agregar como subtarea de',
    [['', 'Sin padre'], ...tasks.map((t) => [t.id, t.text])],
    '',
  );
  const goal = select('task-add:goal', 'Vincular a objetivo', goalOptions, '');
  const add = form(
    'task-add',
    'Agregar tarea explícita',
    '',
    'Conservar tarea pendiente',
    (text, key) =>
      mutate(
        {
          type: 'task-add',
          text,
          parent_id: parent.input.value || null,
          goal_id: goal.input.value || null,
        },
        key,
      ),
  );
  add.prepend(parent.label, goal.label);
  section.append(add);
  const history = create('details');
  history.append(
    create('summary', `Historial de tareas (${(s.task_events || []).length})`),
  );
  for (const e of s.task_events || []) {
    const record = create('article', undefined, 'work-card');
    record.append(
      create(
        'p',
        `${e.action} · ${e.task_id || 'lista'} · ${e.origin.channel} · ${e.origin.message_id} · ${new Date(e.at).toLocaleString()}`,
        'note',
      ),
    );
    for (const c of e.changes)
      record.append(
        create(
          'p',
          `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`,
        ),
      );
    history.append(record);
  }
  section.append(history);
  return section;
}

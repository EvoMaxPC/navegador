/** Inspector local y revisión humana. No ejecuta acciones ni cambia otras capas. */
import { REVIEW_INTENTS, REVIEW_RELATIONS } from '../../core/userReview.js';
export function createInspectorSection({
  snapshot,
  create,
  button,
  form,
  mutate,
  drafts,
  contextRequest,
}) {
  const s = snapshot.state,
    section = create('section', undefined, 'work-content');
  section.append(
    create('h3', 'Inspector y revisión de comprensión'),
    create(
      'p',
      'Inspección local: qué se conserva, de quién proviene, alcance, certeza, estado y por qué su categoría no implica permiso o verificación. Las explicaciones se derivan del modelo guardado; no reconstruyen razonamientos ni inventan certeza numérica. Corregir una clasificación no revierte acciones previas ni reejecuta mensajes.',
      'note',
    ),
  );
  function select(name, title, options, value) {
    const label = create('label', title),
      input = create('select'),
      key = `${s.context_id}:${name}`;
    for (const [v, t] of options) {
      const o = create('option', t);
      o.value = v;
      input.append(o);
    }
    input.value = drafts.get(key) ?? value;
    input.addEventListener('change', () => drafts.set(key, input.value));
    label.append(input);
    return { label, input };
  }
  if (s.last_interaction) {
    const original = s.last_interaction,
      r = s.interaction_review;
    section.append(
      create(
        'p',
        `Clasificación original: ${original.intent} · ${original.relation} · ${original.certainty} · ${original.origin.channel} · ${original.origin.message_id}`,
        'note',
      ),
    );
    if (r)
      section.append(
        create(
          'p',
          `Revisión humana: ${r.intent} · ${r.relation} · ${r.reason} · ${r.origin.channel} · no verificada`,
          'note',
        ),
      );
    const intent = select(
        'review-interaction:intent',
        'Intención anotada por el usuario',
        REVIEW_INTENTS.map((v) => [v, v]),
        REVIEW_INTENTS.includes(original.intent) ? original.intent : 'unknown',
      ),
      relation = select(
        'review-interaction:relation',
        'Relación anotada por el usuario',
        REVIEW_RELATIONS.map((v) => [v, v]),
        REVIEW_RELATIONS.includes(original.relation)
          ? original.relation
          : 'unknown',
      );
    const editor = form(
      'review-interaction',
      'Motivo para corregir la clasificación de intención',
      '',
      'Anotar corrección de intención',
      (reason, key) =>
        mutate(
          {
            type: 'interaction-review',
            intent: intent.input.value,
            relation: relation.input.value,
            reason,
          },
          key,
        ),
    );
    editor.querySelectorAll('textarea')[0].maxLength = 10000;
    editor.prepend(intent.label, relation.label);
    section.append(editor);
  }
  if (s.current_task) {
    const old = s.current_task,
      details = create('details');
    details.append(
      create('summary', 'Revisar última solicitud interpretada'),
      create('p', old.text),
      create(
        'p',
        `Origen: ${old.origin.channel} · ${old.origin.message_id} · ${old.certainty} · relación ${old.related_goal_id || 'sin objetivo'} · ${old.validity || 'última interpretación'}. Confirmar no crea una tarea del grafo.`,
        'note',
      ),
    );
    const actions = [
        ...(old.certainty === 'inferred'
          ? [['confirm', 'Confirmar esta interpretación y su relación']]
          : []),
        ['correct', 'Corregir texto y relación'],
        ['reject', 'Rechazar interpretación sin sustituir el objetivo'],
      ],
      action = select(
        'review-request:action',
        'Revisión explícita',
        actions,
        actions[0][0],
      );
    const goals = [s.user_goal, ...(s.independent_goals || [])].filter(
        (g) => g?.status === 'active',
      ),
      goal = select(
        'review-request:goal',
        'Objetivo asociado explícitamente',
        [['', 'Ninguno'], ...goals.map((g) => [g.id, g.text])],
        '',
      );
    const label = create('label', 'Texto corregido, sólo si elegís corregir'),
      text = create('textarea'),
      textKey = `${s.context_id}:review-request:text`;
    text.value = drafts.get(textKey) ?? old.text;
    text.maxLength = 200000;
    text.rows = 4;
    text.dataset.understandingDraft = textKey;
    text.addEventListener('input', () => drafts.set(textKey, text.value));
    label.append(text);
    const editor = form(
      'review-request',
      'Motivo de revisión de la última solicitud',
      '',
      'Guardar revisión de solicitud',
      (reason, key) =>
        mutate(
          {
            type: 'request-review',
            id: old.id,
            action: action.input.value,
            text: text.value,
            goal_id: goal.input.value || null,
            reason,
          },
          key,
        ),
    );
    editor.querySelectorAll('textarea')[0].maxLength = 10000;
    editor.prepend(action.label, goal.label, label);
    details.append(editor);
    section.append(details);
  }
  const index = create('details');
  index.append(
    create('summary', 'Explorar estado, fuentes e historia sin modificarlo'),
  );
  const controls = create('div'),
    page = create('div');
  index.append(controls, page);
  section.append(index);
  let current = snapshot.inspector;
  if (!current) {
    page.append(
      create('p', 'Índice disponible al leer desde el servicio local.', 'note'),
    );
    return section;
  }
  const category = select(
      'inspector:category',
      'Categoría',
      [
        ['all', 'Todas'],
        ...current.categories.map((c) => [
          c.category,
          `${c.category} (${c.count})`,
        ]),
      ],
      'all',
    ),
    certainty = select(
      'inspector:certainty',
      'Certeza',
      [
        ['all', 'Todas'],
        ...[
          'explicit',
          'confirmed',
          'inferred',
          'uncertain',
          'observed-not-verified',
        ].map((v) => [v, v]),
      ],
      'all',
    ),
    status = select(
      'inspector:status',
      'Estado',
      [['all', 'Todos'], ...current.statuses.map((v) => [v, v])],
      'all',
    );
  async function load(offset) {
    const r = await contextRequest('read', {
      contextId: s.context_id,
      revision: s.revision,
      inspector: {
        category: category.input.value,
        certainty: certainty.input.value,
        status: status.input.value,
        offset,
      },
    });
    if (r?.ok && r.inspector) {
      current = r.inspector;
      renderPage();
    }
  }
  controls.append(
    category.label,
    certainty.label,
    status.label,
    button('Aplicar filtros del inspector', () => load(0)),
  );
  function renderPage() {
    page.replaceChildren();
    page.append(
      create('p', current.explanation, 'note'),
      create(
        'p',
        `Contexto ${current.context_id} · revisión ${current.revision} · ${current.matched} coincidencias de ${current.total} registros · página ${Math.floor(current.offset / 20) + 1}`,
        'note',
      ),
    );
    for (const item of current.items) {
      const card = create('article', undefined, 'work-card');
      card.append(
        create('h4', `${item.category} · ${item.id || item.key}`),
        create('p', item.text),
        create(
          'p',
          `${item.status} · ${item.certainty} · ${item.scope} · prioridad ${item.priority ?? 'no normativa'} · ${item.authority}`,
          'note',
        ),
        create('p', item.reason, 'note'),
        create('p', item.correction_hint, 'note'),
      );
      if (item.clipped)
        card.append(
          create(
            'p',
            `Extracto de 1.000 caracteres sobre ${item.chars}; el editor conserva el texto completo.`,
            'note',
          ),
        );
      if (item.source)
        card.append(
          create(
            'p',
            `Fuente: ${item.source.role} · ${item.source.channel || 'sin canal'} · ${item.source.message_id || 'sin mensaje'} · ${item.source.url || ''}`,
            'note',
          ),
        );
      if (item.origin)
        card.append(
          create(
            'p',
            `Registrado: ${item.origin.role} · ${item.origin.channel} · ${item.origin.message_id} · ${item.origin.url}`,
            'note',
          ),
        );
      if (item.created_at !== null)
        card.append(
          create(
            'p',
            `Creado: ${new Date(item.created_at).toLocaleString()} · actualización: ${new Date(item.updated_at ?? item.created_at).toLocaleString()}`,
            'note',
          ),
        );
      const original = ['subgoals', 'relevant_context', 'progress'].includes(
        item.category,
      )
        ? s[item.category].find(
            (e) => e.id === item.id && e.status === 'active',
          )
        : null;
      if (original && !original.reference && !original.entity) {
        const details = create('details');
        details.append(
          create('summary', 'Corregir este dato simple con historia'),
        );
        const reason = create('textarea'),
          reasonKey = `${s.context_id}:inspector-edit-${original.id}:reason`,
          label = create('label', 'Motivo requerido, máximo 10.000 caracteres');
        reason.value = drafts.get(reasonKey) || '';
        reason.maxLength = 10000;
        reason.required = true;
        reason.addEventListener('input', () =>
          drafts.set(reasonKey, reason.value),
        );
        label.append(reason);
        const editor = form(
          `inspector-edit-${original.id}`,
          'Nuevo texto literal',
          original.text,
          'Corregir dato sin borrar el anterior',
          (text, key) =>
            mutate(
              {
                type: 'entry-correct',
                field: item.category,
                id: original.id,
                text,
                reason: reason.value,
              },
              key,
            ),
        );
        editor.append(label);
        details.append(editor);
        card.append(details);
      }
      page.append(card);
    }
    if (current.offset > 0)
      page.append(
        button('Página anterior del inspector', () =>
          load(Math.max(0, current.offset - 20)),
        ),
      );
    if (current.offset + 20 < current.matched)
      page.append(
        button('Página siguiente del inspector', () =>
          load(current.offset + 20),
        ),
      );
  }
  renderPage();
  return section;
}

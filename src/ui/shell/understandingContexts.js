/** Bloque 5: controles locales. Inspeccionar no activa reglas ni envía datos al sitio. */
const reasons = {
  'changed-source':
    'El origen cambió; no se muestra el contenido como si fuera la versión vinculada.',
  'deleted-source': 'Origen eliminado o no disponible.',
  'missing-entry': 'La entrada de origen ya no existe.',
  'inactive-reference':
    'Referencia rechazada o retirada; no se recupera su contenido.',
};
export function createContextSection({
  snapshot,
  create,
  button,
  form,
  showEntry,
  mutate,
  drafts,
  contextRequest,
  isCurrent,
}) {
  const s = snapshot.state,
    selection = snapshot.contextSelection,
    section = create('section', undefined, 'work-content');
  const edit = (op, key) => (isCurrent() ? mutate(op, key) : undefined);
  section.append(
    create('h3', 'Proyecto, contexto y referencias'),
    create(
      'p',
      'La etiqueta describe sólo este contexto. Renombrar no separa ni fusiona sus reglas. Para otro proyecto usá otra conversación/contexto; los antecedentes se vinculan como datos no verificados.',
      'note',
    ),
  );
  if (selection) {
    section.append(
      create(
        'p',
        `Selección: ${selection.mode === 'explicit' ? 'Continuación elegida explícitamente' : 'Contexto natural de esta conversación'} · ${selection.context_id}`,
        'note',
      ),
      create('p', `Conversación visible: ${selection.document_url}`, 'note'),
    );
    if (selection.mode === 'explicit') {
      section.append(
        create(
          'p',
          `Origen del contexto elegido: ${selection.source_url}. Los próximos mensajes actualizarán ese contexto; no se reimporta la ventana anterior. La selección dura hasta cambiar URL, cerrar pestaña o reiniciar.`,
          'note',
        ),
      );
      section.append(
        button('Volver al contexto natural', () =>
          isCurrent()
            ? contextRequest(
                'bind',
                {
                  contextId: null,
                  revision: s.revision,
                  expectedContextId: s.context_id,
                },
                { apply: true },
              )
            : undefined,
        ),
      );
    }
  }
  const projectKey = `${s.context_id}:project:name`,
    name = create('input');
  name.type = 'text';
  name.maxLength = 200;
  name.required = true;
  name.dataset.understandingDraft = projectKey;
  name.value = drafts.get(projectKey) ?? s.project?.name ?? '';
  name.addEventListener('input', () => drafts.set(projectKey, name.value));
  const nameLabel = create('label', 'Nombre/etiqueta del proyecto');
  nameLabel.append(name);
  const project = form(
    'project',
    'Descripción local del proyecto',
    s.project?.description || '',
    'Guardar etiqueta y descripción',
    (description, key) =>
      edit({ type: 'project', name: name.value, description }, key),
  );
  project.querySelectorAll('textarea')[0].required = false;
  project.querySelectorAll('textarea')[0].maxLength = 10000;
  project.prepend(nameLabel);
  section.append(project);
  if (s.project)
    section.append(
      button('Quitar etiqueta sin borrar comprensión', () =>
        edit({ type: 'project', name: null }),
      ),
    );
  const profileHistory = create('details');
  profileHistory.append(
    create(
      'summary',
      `Historia de etiquetas (${(s.project_history || []).length})`,
    ),
  );
  for (const p of s.project_history || [])
    profileHistory.append(
      create(
        'p',
        `${p.name} · ${p.description} · ${p.changed_by.channel} · ${new Date(p.changed_at).toLocaleString()}`,
      ),
    );
  section.append(profileHistory);
  section.append(
    create('h4', 'Referencias actuales nombradas'),
    create(
      'p',
      'Alias locales para archivos, documentos o componentes. Declararlos no lee archivos ni verifica su existencia; seleccionar no ejecuta ni inserta texto en prompts.',
      'note',
    ),
  );
  const selected = s.relevant_context.find(
    (e) => e.id === s.selected_reference_id,
  );
  section.append(
    create(
      'p',
      `Referencia seleccionada: ${selected?.entity?.alias || 'ninguna'}`,
      'note',
    ),
  );
  if (selected)
    section.append(
      button('Limpiar referencia seleccionada', () =>
        edit({ type: 'context-select', id: null }),
      ),
    );
  for (const e of s.relevant_context.filter(
    (e) => e.status === 'active' && e.entity,
  )) {
    const card = showEntry(e, false);
    card.append(
      create('p', `${e.entity.alias} · ${e.entity.kind}`, 'note'),
      button('Seleccionar esta referencia', () =>
        edit({ type: 'context-select', id: e.id }),
      ),
      button('Retirar referencia actual', () =>
        edit({ type: 'retire', id: e.id }),
      ),
    );
    section.append(card);
  }
  const aliasKey = `${s.context_id}:context-item:alias`,
    alias = create('input');
  alias.type = 'text';
  alias.maxLength = 200;
  alias.required = true;
  alias.dataset.understandingDraft = aliasKey;
  alias.value = drafts.get(aliasKey) || '';
  alias.addEventListener('input', () => drafts.set(aliasKey, alias.value));
  const aliasLabel = create('label', 'Alias inequívoco');
  aliasLabel.append(alias);
  const kind = create('select'),
    kindLabel = create('label', 'Tipo de referencia');
  for (const [value, label] of [
    ['file', 'Archivo declarado'],
    ['document', 'Documento declarado'],
    ['component', 'Componente declarado'],
    ['note', 'Nota actual'],
  ]) {
    const o = create('option', label);
    o.value = value;
    kind.append(o);
  }
  const kindKey = `${s.context_id}:context-item:kind`;
  kind.value = drafts.get(kindKey) || 'note';
  kind.addEventListener('change', () => drafts.set(kindKey, kind.value));
  kindLabel.append(kind);
  const item = form(
    'context-item',
    'Texto de la referencia actual',
    '',
    'Conservar referencia actual',
    (text, key) =>
      edit(
        { type: 'context-item', alias: alias.value, kind: kind.value, text },
        key,
      ),
  );
  item.prepend(aliasLabel, kindLabel);
  section.append(item);
  const previewBox = create('div'),
    listBox = create('div');
  async function inspect(
    c,
    targetKind = 'summary',
    targetId = null,
    offset = 0,
    refreshId = null,
  ) {
    if (!isCurrent()) return;
    const r = await contextRequest('contexts', {
      mode: 'inspect',
      contextId: c.id,
      revision: c.revision,
      targetKind,
      targetId,
      offset,
    });
    if (!r?.ok || !isCurrent()) return;
    const p = r.preview,
      card = create('article', undefined, 'work-card');
    card.append(
      create('h4', p.label),
      create(
        'p',
        `Origen ${p.source_context_id} · revisión ${p.source_revision} · ${p.url} · ${p.kind} · ${p.status} · ${p.certainty} · no verificado`,
        'note',
      ),
      create('p', p.preview),
    );
    if (p.preview_clipped)
      card.append(
        create(
          'p',
          `Extracto de 1000 caracteres sobre ${p.chars}. No es el texto completo.`,
          'note',
        ),
      );
    if (p.source_context_id !== s.context_id)
      card.append(
        button(
          refreshId
            ? 'Actualizar propuesta y volver a revisar'
            : 'Proponer este antecedente',
          () =>
            edit(
              refreshId
                ? {
                    type: 'context-reference-refresh',
                    id: refreshId,
                    sourceRevision: p.source_revision,
                    sourceDigest: p.source_digest,
                  }
                : {
                    type: 'context-reference',
                    sourceContextId: p.source_context_id,
                    sourceRevision: p.source_revision,
                    sourceDigest: p.source_digest,
                    targetKind: p.target_kind,
                    targetId: p.target_id,
                  },
            ),
        ),
      );
    card.append(
      create(
        'p',
        'Entradas del contexto: sólo datos de usuario; no se copian reglas al contexto activo.',
        'note',
      ),
    );
    for (const entry of refreshId ? [] : p.items)
      card.append(
        button(
          `Inspeccionar ${entry.kind}: ${entry.label} (${entry.status})`,
          () => inspect(c, 'entry', entry.id, p.offset, refreshId),
        ),
      );
    if (!refreshId && p.offset > 0)
      card.append(
        button('Entradas anteriores', () =>
          inspect(
            c,
            targetKind,
            targetId,
            Math.max(0, p.offset - 20),
            refreshId,
          ),
        ),
      );
    if (!refreshId && p.offset + 20 < p.total)
      card.append(
        button('Entradas siguientes', () =>
          inspect(c, targetKind, targetId, p.offset + 20, refreshId),
        ),
      );
    previewBox.replaceChildren(card);
  }
  section.append(
    create('h4', 'Antecedentes de otros contextos'),
    create(
      'p',
      'Vincular una referencia no continúa ese proyecto ni activa sus instrucciones. Revisión y huella identifican el origen; si cambia, hay que inspeccionar y confirmar otra vez.',
      'note',
    ),
  );
  for (const r of s.context_references || []) {
    const view = snapshot.contextReferences?.find((v) => v.id === r.id),
      card = create('article', undefined, 'work-card');
    card.append(
      create(
        'p',
        `${r.label} · ${r.status} · revisión de origen ${r.source_revision}`,
      ),
      create(
        'p',
        `${r.origin.channel} · ${new Date(r.updated_at).toLocaleString()} · datos de referencia, no verificados`,
        'note',
      ),
    );
    if (view?.available && view.preview) {
      card.append(create('p', view.preview.preview));
      if (view.preview.preview_clipped)
        card.append(
          create(
            'p',
            'Se muestra un extracto de hasta 1000 caracteres.',
            'note',
          ),
        );
    } else
      card.append(
        create(
          'p',
          reasons[view?.reason] || 'Disponibilidad no confirmada.',
          'note',
        ),
      );
    if (r.status === 'pending') {
      if (view?.available)
        card.append(
          button('Confirmar sólo este antecedente', () =>
            edit({
              type: 'context-reference-resolve',
              id: r.id,
              action: 'confirm',
            }),
          ),
        );
      card.append(
        button('Rechazar antecedente', () =>
          edit({
            type: 'context-reference-resolve',
            id: r.id,
            action: 'reject',
          }),
        ),
      );
    }
    if (r.status === 'linked')
      card.append(
        button('Retirar vínculo de antecedente', () =>
          edit({
            type: 'context-reference-resolve',
            id: r.id,
            action: 'retire',
          }),
        ),
      );
    if (
      ['pending', 'linked'].includes(r.status) &&
      view?.reason === 'changed-source'
    )
      card.append(
        button('Inspeccionar versión actual antes de renovar', () =>
          inspect(
            { id: r.source_context_id, revision: view.currentRevision },
            r.target_kind,
            r.target_id,
            0,
            r.id,
          ),
        ),
      );
    section.append(card);
  }
  section.append(
    button(
      'Listar contextos guardados para inspeccionar o continuar',
      async () => {
        if (!isCurrent()) return;
        const result = await contextRequest('contexts');
        if (!result?.ok || !isCurrent()) return;
        listBox.replaceChildren();
        for (const c of result.contexts) {
          const card = create('article', undefined, 'work-card');
          card.append(
            create(
              'p',
              `${c.project || 'Sin etiqueta'} · ${c.goal} · ${c.url} · revisión ${c.revision}`,
            ),
            button('Inspeccionar sin cambiar contexto', () => inspect(c)),
          );
          if (c.id !== s.context_id)
            card.append(
              button('Continuar en este contexto…', async () => {
                if (
                  !isCurrent() ||
                  !window.confirm(
                    '¿Cambiar el contexto activo para los próximos mensajes? No fusiona conversaciones ni copia reglas. Dura hasta cambiar URL, cerrar pestaña o reiniciar.',
                  )
                )
                  return;
                await contextRequest(
                  'bind',
                  {
                    contextId: c.id,
                    revision: s.revision,
                    expectedContextId: s.context_id,
                    sourceRevision: c.revision,
                    sourceDigest: c.digest,
                  },
                  { apply: true },
                );
              }),
            );
          else card.append(create('p', 'Contexto activo', 'note'));
          listBox.append(card);
        }
      },
    ),
  );
  section.append(listBox, previewBox);
  const history = create('details');
  history.append(
    create(
      'summary',
      `Historia de antecedentes (${(s.context_events || []).length})`,
    ),
  );
  for (const e of s.context_events || [])
    history.append(
      create(
        'p',
        `${e.action} · ${e.reference_id} · revisión ${e.source_revision} · ${e.origin.channel} · ${new Date(e.at).toLocaleString()}`,
        'note',
      ),
    );
  section.append(history);
  return section;
}

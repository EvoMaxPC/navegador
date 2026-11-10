/** Inspector y aclaraciones UUE. No envía prompts ni ejecuta herramientas. */
const LABELS = {
  subgoals: 'Subobjetivos',
  active_instructions: 'Instrucciones vigentes',
  explicit_constraints: 'Restricciones explícitas',
  preferences: 'Preferencias',
  relevant_context: 'Contexto y referencias',
  confirmed_decisions: 'Decisiones declaradas',
  progress: 'Avances y problemas declarados',
};
const create = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function button(label, fn) {
  const b = create('button', label, 'ghost');
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
export function createUnderstandingPanel({ nexo, root, activeTab, notice }) {
  let snapshot = null,
    targetId = null,
    busy = false,
    ticket = 0;
  const drafts = new Map();
  const status = create(
    'p',
    'Abrí una conversación para consultar su comprensión.',
    'work-status',
  );
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const body = create('div', undefined, 'work-content');
  root.append(status, body);
  const tabButton = document.getElementById('panel-tab-understanding');
  function target() {
    try {
      return activeTab()?.view.getWebContentsId();
    } catch {
      return null;
    }
  }
  async function request(method, p = {}) {
    if (!nexo.understanding)
      return { ok: false, error: 'Disponible en Electron.' };
    try {
      return await nexo.understanding[method]({
        ...p,
        webContentsId: targetId,
      });
    } catch {
      return { ok: false, error: 'No se pudo consultar el motor local.' };
    }
  }
  function lock(value) {
    busy = value;
    root.setAttribute('aria-busy', String(value));
    body
      .querySelectorAll('button,textarea,input,select')
      .forEach((n) => (n.disabled = value));
  }
  async function refresh() {
    if (busy) return;
    const id = target();
    if (!id) {
      status.textContent = 'Esperá a que haya una pestaña disponible.';
      return;
    }
    const run = ++ticket;
    targetId = id;
    lock(true);
    const r = await request('read');
    lock(false);
    if (run !== ticket) return;
    if (id !== target()) return refresh();
    if (!r?.ok) {
      snapshot = null;
      body.replaceChildren(button('Reintentar', refresh));
      status.textContent = r?.error || 'No se pudo leer.';
      return;
    }
    snapshot = r;
    render();
    status.textContent =
      r.observationError ||
      (r.erased
        ? 'Contexto eliminado: la observación automática no lo volverá a importar hasta una edición explícita.'
        : r.observationEnabled
          ? 'Comprensión local · no modifica tus prompts ni llama a modelos.'
          : 'Observación pausada porque EVO MEMORY está desactivada.');
    tabButton?.classList.toggle(
      'has-question',
      r.state.pending_questions.some((q) => q.status === 'open'),
    );
  }
  async function mutate(operation, draftKey) {
    if (busy || !snapshot) return;
    if (target() !== targetId) return refresh();
    const id = targetId;
    lock(true);
    status.textContent = 'Guardando comprensión…';
    const r = await request('edit', {
      operation: { ...operation, revision: snapshot.state.revision },
    });
    lock(false);
    if (id !== target()) return refresh();
    if (!r?.ok) {
      status.textContent =
        r?.error || 'No se guardó. Recargá antes de reintentar.';
      return;
    }
    if (draftKey) drafts.delete(draftKey);
    snapshot = r;
    render();
    status.textContent = r.report?.isolated
      ? 'Solicitud independiente analizada sin modificar el contexto activo.'
      : r.report?.note || 'Estado local guardado. No se envió a ningún modelo.';
  }
  function form(name, title, defaultText, submitLabel, onSubmit) {
    const key = `${snapshot.state.context_id}:${name}`;
    const f = create('form', undefined, 'work-form');
    f.append(create('h3', title));
    const label = create('label', 'Texto del usuario');
    const input = create('textarea');
    input.rows = name === 'goal' ? 6 : 4;
    input.maxLength = name === 'recall' ? 4000 : 200000;
    input.required = true;
    input.value = drafts.get(key) ?? defaultText ?? '';
    label.append(input);
    f.append(label);
    input.addEventListener('input', () => {
      drafts.set(key, input.value);
      status.textContent = 'Borrador sin guardar, sólo en esta ventana.';
    });
    const submit = create('button', submitLabel, 'ghost work-primary');
    submit.type = 'submit';
    f.append(submit);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      onSubmit(input.value, key);
    });
    return f;
  }
  function showEntry(e, retire = true) {
    const c = create('article', undefined, 'work-card');
    c.append(create('p', e.text));
    c.append(
      create(
        'p',
        `${e.certainty === 'inferred' ? 'Inferido, sin confirmar' : e.certainty === 'confirmed' ? 'Confirmado por el usuario' : 'Declaración explícita'} · ${e.scope === 'session' ? 'Temporal de sesión' : 'Proyecto'} · ${e.origin.channel} · ${e.status} · ${new Date(e.updated_at).toLocaleString()}`,
        'note',
      ),
    );
    if (e.origin.url) c.append(create('p', e.origin.url, 'note'));
    if (e.reference) {
      const ref = snapshot.memoryReferences.find(
        (r) => r.id === e.reference.id,
      );
      c.append(
        create(
          'p',
          ref?.available
            ? `EVO · no verificado: ${ref.text}`
            : 'Referencia EVO no disponible: no se restaura su contenido.',
          'note',
        ),
      );
    }
    if (retire)
      c.append(
        button('Marcar obsoleta', () => mutate({ type: 'retire', id: e.id })),
      );
    return c;
  }
  function render() {
    const s = snapshot.state;
    body.replaceChildren();
    const head = create('div', undefined, 'work-heading');
    head.append(
      create('span', 'NEXO AI · COMPRENSIÓN', 'eyebrow'),
      create('h2', 'Objetivo e instrucciones'),
      create(
        'p',
        `Contexto ${s.context_id.slice(0, 12)} · revisión ${s.revision}`,
        'note',
      ),
    );
    body.append(head);
    body.append(
      create(
        'p',
        'Interpretación local basada en reglas ES/EN. Una inferencia no es intención confirmada. Sólo las declaraciones y categorías reconocidas se activan; usá los controles para corregirlas.',
        'note',
      ),
    );
    body.append(button('Recargar sin perder borradores', refresh));
    if (s.last_interaction)
      body.append(
        create(
          'p',
          `Última intención: ${s.last_interaction.intent} · relación ${s.last_interaction.relation} · ${s.last_interaction.certainty}`,
          'note',
        ),
      );
    const policies = create('details');
    policies.append(create('summary', 'Jerarquía y límites de seguridad'));
    policies.append(
      create(
        'p',
        'Sistema/seguridad → objetivo explícito → restricciones → instrucciones → decisiones → preferencias → inferencias. Este panel no puede cambiar la política del sistema. Las aprobaciones no autorizan acciones del navegador.',
        'note',
      ),
    );
    for (const text of snapshot.effective.system_policies)
      policies.append(create('p', text, 'note'));
    body.append(policies);
    body.append(create('h3', 'Objetivo principal'));
    if (s.user_goal) body.append(showEntry(s.user_goal, false));
    else
      body.append(
        create(
          'p',
          'Sin objetivo explícito. Una tarea no se convierte automáticamente en objetivo.',
          'note',
        ),
      );
    body.append(
      form(
        'goal',
        'Definir o actualizar objetivo',
        s.user_goal?.text,
        'Guardar objetivo explícito',
        (text, key) => mutate({ type: 'goal', text }, key),
      ),
    );
    if (s.current_task) {
      body.append(create('h3', 'Tarea actual / última conocida'));
      body.append(showEntry(s.current_task, false));
    }
    const questions = s.pending_questions.filter((q) => q.status === 'open');
    if (questions.length)
      body.append(
        create('h3', `Aclaraciones relevantes (${questions.length})`),
      );
    for (const q of questions) {
      const c = create('article', undefined, 'work-card');
      c.append(create('p', q.text));
      if (q.proposed?.text) c.append(create('blockquote', q.proposed.text));
      const ref = snapshot.memoryReferences.find(
        (r) => r.id === q.proposed?.reference?.id,
      );
      if (ref)
        c.append(
          create(
            'p',
            ref.available ? ref.text : 'La memoria ya no está disponible.',
            'note',
          ),
        );
      if (q.proposed)
        c.append(
          button('Confirmar este cambio concreto', () =>
            mutate({ type: 'resolve', id: q.id, accept: true }),
          ),
        );
      c.append(
        button(q.proposed ? 'Rechazar propuesta' : 'Descartar pregunta', () =>
          mutate({ type: 'resolve', id: q.id, accept: false }),
        ),
      );
      body.append(c);
    }
    if (s.uncertainty.length) {
      const d = create('details');
      d.append(create('summary', 'Incertidumbre explícita'));
      for (const u of s.uncertainty) d.append(create('p', u.text, 'note'));
      body.append(d);
    }
    body.append(
      form(
        'message',
        'Analizar una solicitud o aclaración',
        '',
        'Analizar localmente · no enviar',
        (text, key) => mutate({ type: 'message', text }, key),
      ),
    );
    const addForm = form(
      'entry',
      'Agregar una regla o contexto explícito',
      '',
      'Conservar en la categoría elegida',
      (text, key) =>
        mutate(
          { type: 'add', text, field: category.value, scope: scope.value },
          key,
        ),
    );
    const category = create('select');
    const catLabel = create('label', 'Categoría');
    for (const [value, label] of Object.entries(LABELS)) {
      const o = create('option', label);
      o.value = value;
      category.append(o);
    }
    category.value = drafts.get(`${s.context_id}:entry-category`) || 'subgoals';
    category.addEventListener('change', () =>
      drafts.set(`${s.context_id}:entry-category`, category.value),
    );
    catLabel.append(category);
    const scope = create('select');
    const scopeLabel = create('label', 'Vigencia');
    for (const [v, l] of [
      ['project', 'Proyecto: permanece hasta actualización explícita'],
      ['session', 'Temporal: expira al reiniciar NEXO'],
    ]) {
      const o = create('option', l);
      o.value = v;
      scope.append(o);
    }
    scope.value = drafts.get(`${s.context_id}:entry-scope`) || 'project';
    scope.addEventListener('change', () =>
      drafts.set(`${s.context_id}:entry-scope`, scope.value),
    );
    scopeLabel.append(scope);
    addForm.prepend(catLabel, scopeLabel);
    body.append(addForm);
    for (const [field, label] of Object.entries(LABELS)) {
      const details = create('details');
      details.open = ['explicit_constraints', 'active_instructions'].includes(
        field,
      );
      details.append(create('summary', `${label} (${s[field].length})`));
      for (const e of s[field]) details.append(showEntry(e));
      body.append(details);
    }
    const history = create('details');
    history.append(
      create(
        'summary',
        `Historia y reglas obsoletas (${s.goal_history.length + s.instruction_history.length})`,
      ),
    );
    for (const e of [...s.goal_history, ...s.instruction_history])
      history.append(showEntry(e, false));
    body.append(history);
    body.append(
      form(
        'recall',
        'Recuperar antecedentes de EVO sin activarlos',
        s.user_goal?.text.slice(0, 4000) || '',
        'Buscar referencias locales',
        async (query, key) => {
          if (busy) return;
          if (targetId !== target()) return refresh();
          lock(true);
          const r = await request('recall', {
            query,
            revision: snapshot.state.revision,
          });
          lock(false);
          if (targetId !== target()) return refresh();
          if (r?.ok) {
            drafts.delete(key);
            snapshot = r;
            render();
            status.textContent = `${r.count} referencia(s) encontrada(s); requieren confirmación. No se enviaron datos a servicios externos.`;
          } else status.textContent = r?.error || 'No se pudo recuperar.';
        },
      ),
    );
    const restore = create('div', undefined, 'work-actions');
    restore.append(
      button(
        'Elegir otro contexto para continuar en esta pestaña',
        async () => {
          if (busy) return;
          if (targetId !== target()) return refresh();
          lock(true);
          const r = await request('contexts');
          lock(false);
          if (!r?.ok) {
            status.textContent = r?.error;
            return;
          }
          const list = create('div', undefined, 'work-actions');
          for (const c of r.contexts)
            list.append(
              button(`${c.goal} · ${c.url}`, async () => {
                if (
                  !window.confirm(
                    '¿Usar este contexto en la conversación actual? No envía información al sitio.',
                  )
                )
                  return;
                if (targetId !== target()) return refresh();
                lock(true);
                const result = await request('bind', { contextId: c.id });
                lock(false);
                if (targetId !== target()) return refresh();
                if (result?.ok) {
                  snapshot = result;
                  render();
                  status.textContent =
                    'Contexto vinculado explícitamente hasta cambiar de conversación.';
                } else status.textContent = result?.error;
              }),
            );
          restore.append(list);
        },
      ),
    );
    restore.append(
      button('Eliminar este contexto…', async () => {
        if (busy) return;
        if (targetId !== target()) return refresh();
        lock(true);
        const r = await request('clear', { revision: snapshot.state.revision });
        lock(false);
        if (targetId !== target()) return refresh();
        if (r?.ok) {
          for (const key of [...drafts.keys()])
            if (key.startsWith(`${s.context_id}:`)) drafts.delete(key);
          snapshot = r;
          render();
          status.textContent =
            'Comprensión eliminada. EVO y conversaciones no cambiaron.';
        } else if (!r?.cancelled) status.textContent = r?.error;
      }),
    );
    body.append(
      restore,
      create(
        'p',
        'Persistencia local sin cifrado adicional. No hay llamadas a modelos, selección de herramientas ni corrección de respuestas en esta capa. Los borradores no sobreviven al cierre.',
        'note',
      ),
    );
  }
  nexo.on('nexo:understanding-changed', (p) => {
    if (p.needsClarification) {
      tabButton?.classList.add('has-question');
      tabButton?.setAttribute(
        'title',
        'Comprensión: hay una aclaración pendiente en un contexto',
      );
    }
    if (snapshot?.state.context_id === p.contextId && !busy) {
      status.textContent =
        'El contexto se actualizó. Recargá para revisar; se conservarán tus borradores.';
    }
  });
  return {
    refresh,
    changed() {
      if (root.classList.contains('active')) refresh();
    },
  };
}

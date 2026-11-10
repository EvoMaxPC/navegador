import { createContextSection } from './understandingContexts.js';
import { createTaskSection } from './understandingTasks.js';
import { RULE_FIELDS } from '../../core/userRules.js';
import { createUnderstandingRefresh } from './understandingRefresh.js';

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
  const autoRefresh = createUnderstandingRefresh({
    refresh,
    isBusy: () => busy,
    isActive: () => root.classList.contains('active'),
  });
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
    const scroll = root.scrollTop,
      focused = document.activeElement;
    const focusKey = focused?.dataset?.understandingDraft,
      selection = focusKey
        ? [focused.selectionStart, focused.selectionEnd]
        : null;
    snapshot = r;
    render();
    if (focusKey) {
      const replacement = [
        ...body.querySelectorAll('[data-understanding-draft]'),
      ].find((e) => e.dataset.understandingDraft === focusKey);
      if (replacement) {
        replacement.focus({ preventScroll: true });
        if (selection.every(Number.isInteger))
          replacement.setSelectionRange(...selection);
      }
    }
    root.scrollTop = scroll;
    status.textContent =
      r.observationError ||
      (r.erased
        ? 'Contexto eliminado: la observación automática no lo volverá a importar hasta una edición explícita.'
        : r.observationEnabled
          ? 'Comprensión local · no modifica tus prompts ni llama a modelos.'
          : 'No se pudo confirmar el estado de observación.');
    tabButton?.classList.toggle(
      'has-question',
      r.state.pending_questions.some((q) => q.status === 'open') ||
        (r.state.decision_candidates || []).some((e) => e.status === 'pending'),
    );
  }
  async function mutate(operation, draftKey) {
    if (busy || !snapshot) return;
    if (target() !== targetId) return refresh();
    const id = targetId;
    lock(true);
    status.textContent = 'Guardando comprensión…';
    const r = await request('edit', {
      operation: {
        ...operation,
        revision: snapshot.state.revision,
        contextId: snapshot.state.context_id,
      },
    });
    lock(false);
    if (id !== target()) return refresh();
    if (!r?.ok) {
      status.textContent =
        r?.error || 'No se guardó. Recargá antes de reintentar.';
      return;
    }
    if (draftKey)
      for (const key of [...drafts.keys()])
        if (key === draftKey || key.startsWith(`${draftKey}:`))
          drafts.delete(key);
    snapshot = r;
    render();
    status.textContent = r.report?.isolated
      ? 'Solicitud independiente analizada sin modificar el contexto activo.'
      : r.report?.note || 'Estado local guardado. No se envió a ningún modelo.';
  }
  async function contextRequest(method, p = {}, { apply = false } = {}) {
    if (busy || !snapshot) return null;
    if (target() !== targetId) {
      await refresh();
      return null;
    }
    const id = targetId,
      contextId = snapshot.state.context_id;
    lock(true);
    const result = await request(method, p);
    lock(false);
    if (
      target() !== id ||
      (result?.activeContextId && result.activeContextId !== contextId)
    ) {
      await refresh();
      return null;
    }
    if (!result?.ok) {
      status.textContent =
        result?.error || 'No se pudo consultar el contexto local.';
      return result;
    }
    if (apply) {
      snapshot = result;
      render();
      status.textContent =
        'Contexto elegido explícitamente. No se fusionaron reglas ni se enviaron datos al sitio.';
    }
    return result;
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
    input.dataset.understandingDraft = key;
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
        `${e.certainty === 'inferred' ? 'Inferido, sin confirmar' : e.certainty === 'confirmed' ? 'Confirmado por el usuario' : 'Declaración explícita'} · ${e.scope === 'session' ? 'Temporal de sesión' : 'Contexto persistente'} · prioridad ${e.priority} · ${e.origin.channel} · ${e.status} · ${new Date(e.updated_at).toLocaleString()}`,
        'note',
      ),
    );
    if (e.change)
      c.append(
        create(
          'p',
          `Cambio: ${e.change.kind} · ${new Date(e.change.at).toLocaleString()}${e.change.origin ? ` · ${e.change.origin.channel} · ${e.change.origin.message_id}` : ''}`,
          'note',
        ),
      );
    if (e.category)
      c.append(create('p', `Categoría: ${LABELS[e.category]}`, 'note'));
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
    if (e.reference) {
      const ref = snapshot.memoryReferences.find(
        (r) => r.id === e.reference.id,
      );
      if (ref?.changed)
        c.append(
          create(
            'p',
            'El antecedente EVO cambió; no se muestra como la versión vinculada.',
            'note',
          ),
        );
      if (ref?.available && !ref.pinned)
        c.append(
          create(
            'p',
            'Referencia anterior sin huella de versión; no prueba vigencia.',
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
  function ruleCard(e, field) {
    const card = showEntry(e, e.status === 'active');
    if (e.status !== 'active') return card;
    if (field === 'preferences') {
      card.append(
        create(
          'p',
          'Preferencia orientativa: no anula objetivos, restricciones, instrucciones ni decisiones.',
          'note',
        ),
      );
      if (
        snapshot.effective.preference_conflicts?.some(
          (c) => c.preference_id === e.id,
        )
      )
        card.append(
          create(
            'p',
            'Hay una regla reconocida de mayor prioridad incompatible con esta preferencia; la preferencia no la reemplaza.',
            'note',
          ),
        );
    }
    if (field === 'confirmed_decisions')
      card.append(
        create(
          'p',
          'Decisión declarada por el usuario; no prueba ejecución, no valida resultados y no autoriza herramientas.',
          'note',
        ),
      );
    const details = create('details');
    details.append(create('summary', 'Editar texto, categoría o vigencia'));
    const formKey = `rule-${e.id}`;
    const edit = form(
      formKey,
      'Actualizar esta regla',
      e.text,
      'Guardar actualización explícita',
      (text, key) =>
        mutate(
          {
            type: 'rule-update',
            id: e.id,
            text,
            field: category.value,
            scope: scope.value,
          },
          key,
        ),
    );
    const category = create('select'),
      categoryLabel = create('label', 'Categoría de la regla');
    for (const f of RULE_FIELDS) {
      const option = create('option', LABELS[f]);
      option.value = f;
      category.append(option);
    }
    const categoryKey = `${snapshot.state.context_id}:${formKey}:category`;
    category.value = drafts.get(categoryKey) || field;
    category.addEventListener('change', () =>
      drafts.set(categoryKey, category.value),
    );
    categoryLabel.append(category);
    const scope = create('select'),
      scopeLabel = create('label', 'Vigencia de la regla');
    for (const [value, label] of [
      ['project', 'Contexto: permanece hasta cambio explícito'],
      ['session', 'Sólo esta sesión: expira al reiniciar NEXO'],
    ]) {
      const option = create('option', label);
      option.value = value;
      scope.append(option);
    }
    const scopeKey = `${snapshot.state.context_id}:${formKey}:scope`;
    scope.value = drafts.get(scopeKey) || e.scope;
    scope.addEventListener('change', () => drafts.set(scopeKey, scope.value));
    scopeLabel.append(scope);
    edit.prepend(categoryLabel, scopeLabel);
    details.append(edit);
    card.append(details);
    return card;
  }
  function goalCard(goal) {
    const card = showEntry(goal, false);
    card.append(
      create(
        'p',
        goal.status === 'active'
          ? 'Objetivo activo'
          : goal.status === 'completed'
            ? 'Completado según declaración del usuario; ejecución no verificada por NEXO'
            : goal.status === 'cancelled'
              ? 'Cancelado explícitamente; no significa completado'
              : 'Sustituido; conservado para trazabilidad',
        'note',
      ),
    );
    if (goal.resolution)
      card.append(
        create(
          'p',
          `Origen del cambio: ${goal.resolution.kind} · ${new Date(goal.resolution.at).toLocaleString()} · no verificado externamente`,
          'note',
        ),
      );
    if (goal.status === 'active') {
      card.append(
        button('Declarar completado', () =>
          mutate({ type: 'goal-transition', id: goal.id, status: 'completed' }),
        ),
      );
      card.append(
        button('Cancelar objetivo', () =>
          mutate({ type: 'goal-transition', id: goal.id, status: 'cancelled' }),
        ),
      );
    } else if (['completed', 'cancelled'].includes(goal.status))
      card.append(
        button('Reabrir explícitamente', () =>
          mutate({ type: 'goal-transition', id: goal.id, status: 'active' }),
        ),
      );
    return card;
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
    const observation = snapshot.conversation;
    if (observation) {
      const conversation = create('details');
      conversation.open = true;
      conversation.append(
        create(
          'summary',
          `Conversación observada · revisión ${observation.revision}`,
        ),
      );
      conversation.append(
        create(
          'p',
          'Ventana local limitada: metadatos del usuario y extractos de respuestas. Lo dicho por ChatGPT no es una decisión tuya ni evidencia de ejecución. No se guarda una segunda transcripción completa.',
          'note',
        ),
      );
      for (const warning of observation.warnings)
        conversation.append(create('p', warning, 'work-status'));
      for (const m of observation.messages) {
        const card = create('article', undefined, 'work-card');
        card.append(
          create(
            'h3',
            m.role === 'user'
              ? 'Usuario · mensaje observado'
              : 'ChatGPT · respuesta observada, no verificada',
          ),
        );
        card.append(
          create(
            'p',
            `${m.id} · ${m.chars} caracteres · ${m.status === 'streaming' ? 'En generación (sólo RAM)' : m.status === 'clipped' ? 'Recortado' : 'Texto estable en el DOM; no confirma tarea completada'}`,
            'note',
          ),
        );
        if (m.role === 'assistant') card.append(create('p', m.preview));
        if (m.preview_clipped)
          card.append(
            create(
              'p',
              'Se muestra un extracto de hasta 4.000 caracteres.',
              'note',
            ),
          );
        conversation.append(card);
      }
      body.append(conversation);
    }
    if (s.last_interaction)
      body.append(
        create(
          'p',
          `Última intención: ${s.last_interaction.intent} · relación ${s.last_interaction.relation} · ${s.last_interaction.certainty}`,
          'note',
        ),
      );
    body.append(
      createContextSection({
        snapshot,
        create,
        button,
        form,
        showEntry,
        mutate,
        drafts,
        contextRequest,
        isCurrent: () =>
          snapshot?.state.context_id === s.context_id &&
          snapshot?.state.revision === s.revision,
      }),
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
    if (s.user_goal) body.append(goalCard(s.user_goal));
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
    const goals = create('details');
    goals.open = true;
    goals.append(
      create(
        'summary',
        `Objetivos independientes (${(s.independent_goals || []).length})`,
      ),
    );
    goals.append(
      create(
        'p',
        'Se conservan separados y no sustituyen el principal ni reciben sus instrucciones. Para trabajar en otro proyecto, usá otra conversación/contexto. No hay activación ni ejecución automática.',
        'note',
      ),
    );
    for (const g of s.independent_goals || []) goals.append(goalCard(g));
    goals.append(
      form(
        'independent-goal',
        'Agregar objetivo independiente',
        '',
        'Conservar separado',
        (text, key) => mutate({ type: 'goal-independent', text }, key),
      ),
    );
    body.append(goals);
    const inferred = create('details');
    inferred.open = (s.goal_candidates || []).some(
      (g) => g.status === 'pending',
    );
    inferred.append(
      create(
        'summary',
        `Interpretaciones de objetivo (${(s.goal_candidates || []).length})`,
      ),
    );
    for (const g of s.goal_candidates || []) {
      const card = showEntry(g, false);
      card.append(create('p', g.reason, 'note'));
      if (g.status === 'pending') {
        if (s.user_goal?.status !== 'active')
          card.append(
            button('Confirmar como principal', () =>
              mutate({ type: 'goal-candidate', id: g.id, action: 'primary' }),
            ),
          );
        card.append(
          button('Confirmar como independiente', () =>
            mutate({ type: 'goal-candidate', id: g.id, action: 'independent' }),
          ),
        );
        card.append(
          button('Rechazar interpretación', () =>
            mutate({ type: 'goal-candidate', id: g.id, action: 'reject' }),
          ),
        );
      }
      inferred.append(card);
    }
    body.append(inferred);
    const goalEvents = create('details');
    goalEvents.append(
      create(
        'summary',
        `Historial de objetivos (${(s.goal_events || []).length})`,
      ),
    );
    for (const e of s.goal_events || [])
      goalEvents.append(
        create(
          'p',
          `${e.action} · ${e.goal_id} · ${e.from || '—'} → ${e.to} · ${e.origin.channel} · ${new Date(e.at).toLocaleString()}`,
          'note',
        ),
      );
    body.append(goalEvents);
    body.append(
      createTaskSection({
        state: s,
        tracking: snapshot.effective.task_tracking,
        create,
        button,
        form,
        mutate,
        drafts,
        showEntry,
      }),
    );
    if (s.current_task) {
      body.append(
        create('h3', 'Última solicitud interpretada; no acredita ejecución'),
      );
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
    const proposals = create('details');
    proposals.open = (s.decision_candidates || []).some(
      (c) => c.status === 'pending',
    );
    proposals.append(
      create(
        'summary',
        `Propuestas del usuario, no decisiones (${(s.decision_candidates || []).length})`,
      ),
    );
    proposals.append(
      create(
        'p',
        'Las propuestas observadas del asistente siguen siendo sólo datos de conversación; no son decisiones tuyas. Un sí genérico no confirma esta lista.',
        'note',
      ),
    );
    for (const c of s.decision_candidates || []) {
      const card = showEntry(c, false);
      if (c.status === 'pending') {
        card.append(
          button('Confirmar esta decisión concreta', () =>
            mutate({ type: 'decision-candidate', id: c.id, action: 'confirm' }),
          ),
        );
        card.append(
          button('Rechazar esta propuesta', () =>
            mutate({ type: 'decision-candidate', id: c.id, action: 'reject' }),
          ),
        );
      }
      proposals.append(card);
    }
    body.append(proposals);
    if (snapshot.effective.preference_conflicts_clipped)
      body.append(
        create(
          'p',
          'Se muestran sólo los primeros 100 cruces reconocidos de preferencias; las reglas completas se conservan.',
          'note',
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
      ['project', 'Contexto: permanece hasta actualización explícita'],
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
      for (const e of s[field])
        details.append(
          RULE_FIELDS.includes(field) ? ruleCard(e, field) : showEntry(e),
        );
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
    if (snapshot?.state.context_id === p.contextId) autoRefresh.schedule();
  });
  return {
    refresh,
    changed() {
      if (root.classList.contains('active')) refresh();
    },
  };
}

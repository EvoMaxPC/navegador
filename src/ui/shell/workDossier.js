/** Vista del expediente: preferencias declaradas, nunca aprendizaje oculto. */
const STATUS = { todo: 'Pendiente', doing: 'En curso', done: 'Hecha' };
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function btn(text, action, cls = 'ghost') {
  const b = el('button', text, cls);
  b.type = 'button';
  b.addEventListener('click', action);
  return b;
}
function date(ts) {
  return new Date(ts).toLocaleString();
}
export function createWorkDossier({
  nexo,
  root,
  getWorkspaceId,
  getWorkspaceName,
  activeTab,
  openResource,
  show,
  notice,
}) {
  let dossier = null,
    shownId = null,
    section = 'continue',
    generation = 0,
    busy = false,
    external = false;
  const drafts = new Map();
  const live = el('p', '', 'work-status');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  const content = el('div', undefined, 'work-content');
  root.append(live, content);
  const captureDialog = el('dialog', undefined, 'tools-dialog work-capture');
  document.body.append(captureDialog);
  let captureFocus;
  captureDialog.addEventListener('close', () => {
    if (captureDialog.open) return;
    captureDialog.replaceChildren();
    captureFocus?.focus?.();
  });
  const key = (kind) => `${shownId}:${kind}`;
  function message(text) {
    live.textContent = text;
  }
  function report(result) {
    if (!result?.ok && !result?.cancelled)
      message(result?.error || 'No se pudo completar la operación');
    return result?.ok === true;
  }
  async function request(method, payload) {
    if (!nexo.work)
      return { ok: false, error: 'Expedientes disponibles sólo en Electron.' };
    try {
      return await nexo.work[method](payload);
    } catch {
      return {
        ok: false,
        error: 'No se pudo comunicar con el almacenamiento local.',
      };
    }
  }
  function lock(on) {
    busy = on;
    root.setAttribute('aria-busy', String(on));
    root.querySelectorAll('button,input,textarea,select').forEach((n) => {
      if (on) {
        n.dataset.workDisabled = String(n.disabled);
        n.disabled = true;
      } else {
        n.disabled = n.dataset.workDisabled === 'true';
        delete n.dataset.workDisabled;
      }
    });
  }
  async function load({ force = false } = {}) {
    const id = getWorkspaceId();
    if (busy) return;
    if (!force && shownId === id && dossier) return;
    const token = ++generation;
    lock(true);
    message('Leyendo expediente local…');
    const result = await request('read', { workspaceId: id });
    lock(false);
    if (token !== generation) return;
    if (id !== getWorkspaceId()) return load({ force: true });
    if (!report(result)) {
      dossier = null;
      shownId = id;
      content.replaceChildren(btn('Reintentar', () => load({ force: true })));
      return;
    }
    const changed = shownId !== id;
    shownId = id;
    dossier = result.dossier;
    external = false;
    if (changed) section = dossier.preferences.start;
    message(
      draftsForSpace()
        ? 'Borradores sin guardar recuperados en esta ventana.'
        : 'Local · no se envía a ninguna IA ni servicio externo.',
    );
    render();
  }
  function draftsForSpace() {
    return [...drafts.keys()].some((k) => k.startsWith(`${shownId}:`));
  }
  async function change(operation, draftKey) {
    if (busy || !dossier) return;
    if (shownId !== getWorkspaceId()) return load({ force: true });
    const id = shownId,
      revision = dossier.revision;
    lock(true);
    message('Guardando en disco…');
    const result = await request('mutate', {
      workspaceId: id,
      operation: { ...operation, revision },
    });
    lock(false);
    if (report(result)) {
      if (draftKey) drafts.delete(`${id}:${draftKey}`);
      if (id === getWorkspaceId()) {
        dossier = result.dossier;
        external = false;
        render();
        message('Guardado local confirmado.');
      } else await load({ force: true });
    } else {
      if (result?.code === 'conflict') {
        external = true;
        message(`${result.error} Tus borradores siguen en esta ventana.`);
      }
      // No dejar un selector de tarea mostrando como confirmado un estado rechazado.
      if (id === getWorkspaceId()) render();
      else await load({ force: true });
    }
  }
  function form(kind, title, fields, submitLabel, submit) {
    const f = el('form', undefined, 'work-form');
    f.append(el('h3', title));
    const values = drafts.get(key(kind)) || {};
    const controls = {};
    for (const spec of fields) {
      const label = el('label', spec.label);
      let control;
      if (spec.options) {
        control = el('select');
        for (const [value, text] of spec.options) {
          const o = el('option', text);
          o.value = value;
          control.append(o);
        }
      } else {
        control = el('textarea');
        control.rows = spec.rows || 3;
        control.maxLength = spec.max || 2000;
        control.required = spec.required !== false;
      }
      control.name = spec.name;
      control.value = values[spec.name] ?? spec.value ?? '';
      if (spec.hint) {
        const h = el('small', spec.hint);
        label.append(h);
      }
      label.append(control);
      f.append(label);
      controls[spec.name] = control;
      control.addEventListener('input', () => {
        drafts.set(key(kind), {
          ...drafts.get(key(kind)),
          ...Object.fromEntries(
            Object.entries(controls).map(([name, c]) => [name, c.value]),
          ),
        });
        message('Borrador sin guardar · sólo en esta ventana.');
      });
    }
    const save = el('button', submitLabel, 'ghost work-primary');
    save.type = 'submit';
    f.append(save);
    f.addEventListener('submit', (event) => {
      event.preventDefault();
      submit(
        Object.fromEntries(
          Object.entries(controls).map(([name, c]) => [name, c.value]),
        ),
        kind,
      );
    });
    return f;
  }
  function card(title, text) {
    const c = el('article', undefined, 'work-card');
    c.append(el('h3', title));
    if (text) c.append(el('p', text));
    return c;
  }
  function empty(text) {
    content.append(el('p', text, 'note'));
  }
  function remove(collection, item) {
    if (
      !window.confirm(
        '¿Quitar este registro? No se puede deshacer. Quitar evidencia marcará las decisiones vinculadas para revisión.',
      )
    )
      return;
    change({ type: 'remove', collection, id: item.id });
  }
  function render() {
    if (!dossier) return;
    content.replaceChildren();
    content.dataset.detail = dossier.preferences.detail;
    const heading = el('div', undefined, 'work-heading');
    heading.append(
      el('span', 'NEXO · CONTINUIDAD', 'eyebrow'),
      el('h2', getWorkspaceName(shownId)),
      el(
        'p',
        `Revisión ${dossier.revision} · ${dossier.revision ? date(dossier.updatedAt) : 'Todavía sin guardar'}`,
        'note',
      ),
    );
    content.append(heading);
    const objective = el('details', undefined, 'work-goal');
    objective.append(
      el(
        'summary',
        dossier.goal.text
          ? `Objetivo · ${dossier.goal.text.slice(0, 120)}${dossier.goal.text.length > 120 ? '…' : ''}`
          : 'Objetivo todavía sin definir',
      ),
    );
    objective.append(el('p', dossier.goal.text || 'Definilo en Continuar.'));
    const criteria = el('ul');
    for (const c of dossier.goal.criteria) criteria.append(el('li', c));
    objective.append(criteria);
    content.append(objective);
    const nav = el('nav', undefined, 'work-nav');
    nav.setAttribute('aria-label', 'Secciones del expediente');
    for (const [id, label] of [
      ['continue', 'Continuar'],
      ['evidence', 'Fuentes'],
      ['tasks', 'Tareas'],
      ['decisions', 'Decisiones'],
      ['notes', 'Notas'],
      ['preferences', 'Control'],
    ]) {
      const b = btn(label, () => {
        section = id;
        render();
        content.querySelector('.work-nav [aria-pressed="true"]')?.focus();
      });
      b.setAttribute('aria-pressed', String(section === id));
      nav.append(b);
    }
    content.append(nav);
    const reload = btn(
      'Recargar sin perder borradores',
      () => load({ force: true }),
      'icon-label',
    );
    content.append(reload);
    if (external)
      content.append(
        el(
          'p',
          'Hay cambios en otra vista. Recargá antes de guardar.',
          'work-warning',
        ),
      );
    if (section === 'continue') renderContinue();
    if (section === 'evidence') renderEvidence();
    if (section === 'tasks') renderTasks();
    if (section === 'decisions') renderDecisions();
    if (section === 'notes') renderNotes();
    if (section === 'preferences') renderPreferences();
  }
  function renderContinue() {
    const pending = dossier.tasks.filter((t) => t.status !== 'done').length;
    const review = dossier.decisions.filter((d) => d.needsReview).length;
    const summary = card(
      'Punto de continuación',
      dossier.nextStep ||
        'Anotá dónde seguir para no reconstruir el trabajo la próxima vez.',
    );
    summary.append(
      el(
        'p',
        `${pending} tarea(s) pendiente(s) · ${dossier.evidence.length} cita(s) sin verificar · ${review} decisión(es) para revisar`,
        'note',
      ),
    );
    content.append(summary);
    content.append(
      form(
        'goal',
        'Objetivo y criterios',
        [
          {
            name: 'text',
            label: 'Qué querés conseguir',
            value: dossier.goal.text,
            max: 2000,
          },
          {
            name: 'criteria',
            label: 'Criterios de éxito · uno por línea',
            value: dossier.goal.criteria.join('\n'),
            max: 6020,
            required: false,
            hint: 'Hasta 20 criterios de 300 caracteres. No se infiere que estén cumplidos.',
          },
        ],
        dossier.goal.text
          ? 'Guardar revisión del objetivo'
          : 'Definir objetivo',
        (v, k) =>
          change(
            {
              type: 'goal',
              text: v.text,
              criteria: v.criteria
                .split('\n')
                .map((x) => x.trim())
                .filter(Boolean),
            },
            k,
          ),
      ),
    );
    content.append(
      el(
        'p',
        'Cambiar el objetivo o sus criterios conserva la versión anterior y marca decisiones para revisión. No cambia tareas automáticamente.',
        'note work-explanation',
      ),
    );
    content.append(
      form(
        'continuation',
        'Dónde continuar',
        [
          {
            name: 'text',
            label: 'Próximo paso y contexto necesario',
            value: dossier.nextStep,
            max: 3000,
            required: false,
          },
        ],
        'Guardar punto de continuación',
        (v, k) => change({ type: 'continuation', text: v.text }, k),
      ),
    );
    if (dossier.goalHistory.length) {
      const history = el('details');
      history.append(
        el('summary', `Objetivos anteriores (${dossier.goalHistory.length})`),
      );
      for (const g of [...dossier.goalHistory].reverse()) {
        const c = card(`Revisión ${g.revision}`, g.text);
        c.append(el('p', g.criteria.join('\n'), 'note'));
        history.append(c);
      }
      content.append(history);
    }
  }
  async function attachTab() {
    if (busy || !dossier) return;
    if (shownId !== getWorkspaceId()) return load({ force: true });
    const tab = activeTab();
    if (!tab) return message('No hay una pestaña activa.');
    let webContentsId;
    try {
      webContentsId = tab.view.getWebContentsId();
    } catch {
      return message('Esperá a que la pestaña esté lista.');
    }
    const id = shownId;
    lock(true);
    const result = await request('attach', {
      workspaceId: id,
      revision: dossier.revision,
      webContentsId,
    });
    lock(false);
    if (report(result)) {
      if (id === getWorkspaceId()) {
        dossier = result.dossier;
        render();
        message(
          'Referencia de pestaña guardada. No se leyó el contenido de la página.',
        );
      } else load({ force: true });
    }
  }
  function renderEvidence() {
    content.append(
      el(
        'p',
        'Para conservar una cita: seleccioná texto en una página → clic derecho → «Conservar selección en expediente…». Revisá el fragmento antes de guardarlo. No se recopila contenido en segundo plano.',
        'note work-explanation',
      ),
    );
    content.append(btn('Asociar pestaña actual', attachTab));
    if (!dossier.resources.length) empty('Todavía no hay fuentes asociadas.');
    for (const r of dossier.resources) {
      const c = card(r.title || 'Recurso web', r.url);
      c.append(el('p', `Referencia guardada: ${date(r.capturedAt)}`, 'note'));
      c.append(
        btn('Abrir recurso', () => openResource(r.url, shownId), 'icon-label'),
      );
      const removeButton = btn(
        'Quitar recurso',
        () => remove('resources', r),
        'icon-label',
      );
      removeButton.disabled = dossier.evidence.some(
        (e) => e.resourceId === r.id,
      );
      removeButton.title = removeButton.disabled
        ? 'Quitá primero las citas de esta fuente'
        : 'Quitar referencia';
      c.append(removeButton);
      for (const e of dossier.evidence.filter((e) => e.resourceId === r.id)) {
        const quote = el('details', undefined, 'work-evidence');
        quote.open = dossier.preferences.detail === 'expanded';
        quote.append(
          el(
            'summary',
            `Cita ${e.id.slice(0, 8)} · Sin verificar${e.clipped ? ' · Truncada a 8000 caracteres' : ''}`,
          ),
          el('blockquote', e.quote),
          el('p', `${date(e.capturedAt)} · selección nativa`, 'note'),
        );
        if (e.annotation) quote.append(el('p', e.annotation));
        quote.append(
          btn('Quitar cita', () => remove('evidence', e), 'icon-label'),
        );
        c.append(quote);
      }
      content.append(c);
    }
  }
  function renderTasks() {
    content.append(
      form(
        'task',
        'Nuevo pendiente',
        [{ name: 'text', label: 'Tarea o comprobación que falta', max: 1000 }],
        'Agregar tarea',
        (v, k) => change({ type: 'add-task', text: v.text }, k),
      ),
    );
    if (!dossier.tasks.length)
      empty(
        'No hay tareas. El estado se registra manualmente; NEXO no simula su ejecución.',
      );
    for (const t of dossier.tasks) {
      const c = card(t.text);
      const label = el('label', 'Estado');
      const select = el('select');
      for (const [id, name] of Object.entries(STATUS)) {
        const o = el('option', name);
        o.value = id;
        select.append(o);
      }
      select.value = t.status;
      select.addEventListener('change', () =>
        change({ type: 'task-status', id: t.id, status: select.value }),
      );
      label.append(select);
      c.append(
        label,
        btn('Quitar tarea', () => remove('tasks', t), 'icon-label'),
      );
      content.append(c);
    }
  }
  function renderDecisions() {
    const f = form(
      'decision',
      'Registrar decisión',
      [{ name: 'text', label: 'Decisión y motivo', max: 2000 }],
      'Guardar decisión',
      (v, k) =>
        change(
          {
            type: 'add-decision',
            text: v.text,
            evidenceIds: [...f.querySelectorAll('input:checked')].map(
              (c) => c.value,
            ),
          },
          k,
        ),
    );
    const fieldset = el('fieldset');
    fieldset.append(
      el('legend', 'Citas que la sostienen (opcional, hasta 20)'),
    );
    for (const e of dossier.evidence) {
      const label = el(
        'label',
        `${e.id.slice(0, 8)} · ${e.quote.slice(0, 85)}`,
      );
      const box = el('input');
      box.type = 'checkbox';
      box.value = e.id;
      const saved = drafts.get(key('decision'))?.evidenceIds || [];
      box.checked = saved.includes(e.id);
      box.addEventListener('change', () => {
        const old = drafts.get(key('decision')) || {};
        drafts.set(key('decision'), {
          ...old,
          text: f.elements.text.value,
          evidenceIds: [...fieldset.querySelectorAll('input:checked')].map(
            (c) => c.value,
          ),
        });
        message('Borrador sin guardar.');
      });
      label.prepend(box);
      fieldset.append(label);
    }
    f.insertBefore(fieldset, f.querySelector('button[type="submit"]'));
    content.append(f);
    if (!dossier.goal.text)
      content.append(
        el(
          'p',
          'Definí el objetivo antes de registrar una decisión.',
          'work-warning',
        ),
      );
    for (const d of dossier.decisions) {
      const c = card(
        d.needsReview ? 'Requiere revisión' : 'Decisión declarada por vos',
        d.text,
      );
      c.append(
        el(
          'p',
          `Objetivo r${d.goalRevision} · ${d.evidenceIds.length} cita(s) vinculada(s). No implica verificación externa.`,
          'note',
        ),
      );
      for (const id of d.evidenceIds) {
        const e = dossier.evidence.find((e) => e.id === id);
        const details = el('details');
        details.append(
          el('summary', `Cita ${id.slice(0, 8)}`),
          el('blockquote', e.quote),
        );
        c.append(details);
      }
      if (d.needsReview)
        c.append(
          btn(
            'Confirmar que sigue vigente',
            () => change({ type: 'review-decision', id: d.id }),
            'icon-label',
          ),
        );
      c.append(
        btn('Quitar decisión', () => remove('decisions', d), 'icon-label'),
      );
      content.append(c);
    }
  }
  function renderNotes() {
    content.append(
      form(
        'note',
        'Nota propia',
        [
          {
            name: 'text',
            label: 'Nota o interpretación personal · no es una cita de fuente',
            max: 4000,
          },
        ],
        'Guardar nota',
        (v, k) => change({ type: 'add-note', text: v.text }, k),
      ),
    );
    for (const n of dossier.notes) {
      const c = card(date(n.createdAt), n.text);
      c.append(btn('Quitar nota', () => remove('notes', n), 'icon-label'));
      content.append(c);
    }
  }
  function renderPreferences() {
    content.append(
      el(
        'p',
        'Preferencias explícitas, sólo para este expediente. No se deducen hábitos ni se envía contenido a servicios de IA. Esta capa no modifica EVO MEMORY.',
        'note',
      ),
    );
    content.append(
      form(
        'preferences',
        'Cómo querés trabajar aquí',
        [
          {
            name: 'detail',
            label: 'Detalle de las citas',
            value: dossier.preferences.detail,
            options: [
              ['expanded', 'Fragmentos desplegados'],
              ['compact', 'Fragmentos contraídos'],
            ],
          },
          {
            name: 'start',
            label: 'Sección al volver a este espacio',
            value: dossier.preferences.start,
            options: [
              ['continue', 'Continuar'],
              ['evidence', 'Fuentes'],
              ['tasks', 'Tareas'],
            ],
          },
        ],
        'Guardar preferencias',
        (v, k) => change({ type: 'preferences', ...v }, k),
      ),
    );
    const controls = el('div', undefined, 'work-actions');
    for (const [format, label] of [
      ['json', 'Exportar JSON completo'],
      ['markdown', 'Exportar documento Markdown'],
    ])
      controls.append(
        btn(label, async () => {
          if (busy) return;
          const id = shownId;
          lock(true);
          const result = await request('export', { workspaceId: id, format });
          lock(false);
          if (report(result))
            message(
              `Exportación local confirmada · revisión ${result.exportedRevision}. No incluye borradores sin guardar.`,
            );
        }),
      );
    controls.append(
      btn('Descartar borradores de esta ventana', () => {
        if (
          !window.confirm(
            '¿Descartar los borradores sin guardar de este expediente?',
          )
        )
          return;
        for (const k of [...drafts.keys()])
          if (k.startsWith(`${shownId}:`)) drafts.delete(k);
        render();
        message('Borradores descartados. Los datos guardados no cambiaron.');
      }),
    );
    controls.append(
      btn(
        'Eliminar expediente…',
        async () => {
          if (busy) return;
          const id = shownId;
          lock(true);
          const result = await request('clear', {
            workspaceId: id,
            revision: dossier.revision,
          });
          lock(false);
          if (report(result)) {
            for (const k of [...drafts.keys()])
              if (k.startsWith(`${id}:`)) drafts.delete(k);
            if (id === getWorkspaceId()) {
              dossier = result.dossier;
              section = 'continue';
              render();
              message(
                'Expediente eliminado. EVO MEMORY y las exportaciones previas no cambiaron.',
              );
            } else load({ force: true });
          }
        },
        'ghost danger',
      ),
    );
    content.append(
      controls,
      el(
        'p',
        'Los datos se guardan localmente, sin cifrado adicional. Las URLs pueden contener parámetros privados. Las exportaciones son copias independientes. Los borradores no sobreviven al cierre de NEXO.',
        'note',
      ),
    );
  }
  nexo.on('nexo:work-changed', (payload) => {
    if (
      payload.workspaceId === shownId &&
      dossier &&
      payload.revision > dossier.revision &&
      !busy
    ) {
      external = true;
      message(
        'El expediente cambió en otra vista. Recargá sin perder tus borradores antes de guardar.',
      );
    }
  });
  nexo.on('nexo:work-capture', (payload) => {
    if (captureDialog.open) captureDialog.close();
    captureFocus = document.activeElement;
    show();
    const id = getWorkspaceId();
    captureDialog.replaceChildren(
      el('h2', 'Conservar selección'),
      el(
        'p',
        `Destino: ${getWorkspaceName(id)} · Sólo almacenamiento local`,
        'note',
      ),
      el('p', payload.title),
      el('p', payload.url, 'note'),
      el('blockquote', payload.quote),
      el(
        'p',
        `Cita sin verificar${payload.clipped ? ' · truncada a 8000 caracteres' : ''}. No se envía a servicios externos. Confirmación válida por 2 minutos.`,
        'note',
      ),
    );
    const label = el('label', 'Anotación opcional');
    const annotation = el('textarea');
    annotation.maxLength = 2000;
    annotation.rows = 3;
    label.append(annotation);
    captureDialog.append(label);
    const status = el('p', '', 'note');
    status.setAttribute('role', 'status');
    const confirm = btn('Guardar cita en este expediente', async () => {
      if (busy) {
        status.textContent =
          'Esperá a que termine la operación del expediente y volvé a confirmar.';
        return;
      }
      confirm.disabled = true;
      status.textContent = 'Guardando…';
      const current = await request('read', { workspaceId: id });
      const result = current?.ok
        ? await request('capture', {
            workspaceId: id,
            revision: current.dossier.revision,
            token: payload.token,
            annotation: annotation.value,
          })
        : current;
      if (result?.ok) {
        captureDialog.close();
        section = 'evidence';
        await load({ force: true });
        notice('Cita guardada localmente, sin verificar.');
      } else {
        status.textContent =
          result?.error ||
          'No se pudo guardar. Volvé a seleccionar el texto si expiró la confirmación.';
      }
    });
    captureDialog.append(
      status,
      confirm,
      btn('Cancelar', () => captureDialog.close(), 'icon-label'),
    );
    captureDialog.showModal();
  });
  return {
    load,
    workspaceChanged() {
      if (root.classList.contains('active')) load();
    },
  };
}

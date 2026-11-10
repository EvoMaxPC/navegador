/** DOM/puente de fixture; no es una prueba visual de Electron. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element } from './harness/dom-fixture.mjs';
import { createUnderstandingPanel } from '../src/ui/shell/understandingPanel.js';
import {
  newUnderstanding,
  updateUnderstanding,
  effectiveUnderstanding,
} from '../src/core/userUnderstanding.js';
test('panel: tareas relaciones prioridad foco paso orden y declaraciones usan puente UUE sin ejecutar', async () => {
  const previous = globalThis.document,
    root = new Element('section');
  root.className = 'active';
  globalThis.document = {
    createElement: (t) => new Element(t),
    getElementById: () => new Element('button'),
    activeElement: null,
  };
  try {
    let state = newUnderstanding('tasks-panel', 1),
      now = 1,
      active = 31;
    const calls = [];
    const apply = (op) => {
      const r = updateUnderstanding(
        state,
        { ...op, revision: state.revision },
        { channel: 'shell' },
        ++now,
      );
      state = r.state;
      return r.report;
    };
    apply({ type: 'goal', text: 'Control humano' });
    const snap = () => ({
      ok: true,
      state: structuredClone(state),
      effective: effectiveUnderstanding(state),
      memoryReferences: [],
      observationEnabled: true,
    });
    const panel = createUnderstandingPanel({
      root,
      activeTab: () => ({ view: { getWebContentsId: () => active } }),
      notice: () => {},
      nexo: {
        on() {},
        understanding: {
          read: async () => snap(),
          edit: async (p) => {
            calls.push(p);
            const report = apply(p.operation);
            return { ...snap(), report };
          },
        },
      },
    });
    await panel.refresh();
    const addForm = () =>
      root
        .querySelectorAll('form')
        .find((f) =>
          f
            .querySelectorAll('textarea')
            .some(
              (t) => t.dataset.understandingDraft === 'tasks-panel:task-add',
            ),
        );
    let f = addForm();
    f.querySelectorAll('textarea')[0].value = 'Auditar <sin ejecutar>';
    await f.fire('submit');
    const a = state.tasks[0];
    f = addForm();
    f.querySelectorAll('textarea')[0].value = 'Documentar';
    await f.fire('submit');
    const b = state.tasks[1];
    const card = (id) =>
      root
        .querySelectorAll('article')
        .find((a) =>
          a
            .querySelectorAll('textarea')
            .some(
              (t) => t.dataset.understandingDraft === `tasks-panel:task-${id}`,
            ),
        );
    const click = async (id, label) => {
      const button = card(id)
        .querySelectorAll('button')
        .find((b) => b.textContent === label);
      assert.ok(button, label);
      await button.fire('click');
    };
    let editor = card(b.id)
      .querySelectorAll('form')
      .find((f) =>
        f
          .querySelectorAll('textarea')
          .some(
            (t) => t.dataset.understandingDraft === `tasks-panel:task-${b.id}`,
          ),
      );
    let selects = editor.querySelectorAll('select');
    selects[0].value = 'high';
    await selects[0].fire('change');
    selects[3].children.find((o) => o.value === a.id).selected = true;
    await selects[3].fire('change');
    const result = editor
      .querySelectorAll('textarea')
      .find((t) => t.dataset.understandingDraft.endsWith(':result'));
    result.value = 'Informe <revisable>';
    await result.fire('input');
    await panel.refresh();
    editor = card(b.id)
      .querySelectorAll('form')
      .find((f) =>
        f
          .querySelectorAll('textarea')
          .some(
            (t) => t.dataset.understandingDraft === `tasks-panel:task-${b.id}`,
          ),
      );
    assert.equal(editor.querySelectorAll('select')[0].value, 'high');
    assert.equal(
      editor
        .querySelectorAll('textarea')
        .find((t) => t.dataset.understandingDraft.endsWith(':result')).value,
      'Informe <revisable>',
    );
    await editor.fire('submit');
    assert.deepEqual(state.tasks[1].depends_on, [a.id]);
    assert.equal(state.tasks[1].task_priority, 'high');
    assert.equal(state.tasks[1].expected_result, 'Informe <revisable>');
    apply({ type: 'task-update', id: b.id, task_priority: 'normal' });
    await panel.refresh();
    assert.equal(
      card(b.id).querySelectorAll('select')[0].value,
      'normal',
      'metadatos guardados no deben quedar como borrador obsoleto',
    );
    await click(b.id, 'Seleccionar como foco');
    await click(b.id, 'Acordar como próximo paso');
    assert.equal(state.focused_task_id, b.id);
    assert.equal(state.next_step.task_id, b.id);
    assert.match(root.textContent, /Paso conservado, no disponible/);
    assert.ok(
      !card(b.id)
        .querySelectorAll('button')
        .some((b) => b.textContent === 'Declarar tarea completada'),
    );
    await click(b.id, 'Subir en la lista');
    assert.equal(state.tasks[0].id, b.id);
    await click(a.id, 'Declarar tarea completada');
    assert.match(card(a.id).textContent, /ejecución no verificada/);
    assert.equal(state.progress.length, 0);
    await click(b.id, 'Declarar tarea en curso');
    await click(b.id, 'Declarar tarea completada');
    assert.equal(state.tasks[0].status, 'completed');
    assert.equal(state.next_step.task_id, b.id);
    await click(b.id, 'Reabrir tarea como pendiente');
    const blockForm = card(b.id)
      .querySelectorAll('form')
      .find((f) =>
        f
          .querySelectorAll('textarea')
          .some(
            (t) => t.dataset.understandingDraft === `tasks-panel:block-${b.id}`,
          ),
      );
    blockForm.querySelectorAll('textarea')[0].value = 'Falta revisión';
    await blockForm.fire('submit');
    assert.equal(state.tasks[0].status, 'blocked');
    await click(b.id, 'Retirar bloqueo: volver a pendiente');
    assert.equal(state.tasks[0].status, 'pending');
    const before = calls.length;
    active = 32;
    await click(b.id, 'Cancelar tarea');
    assert.equal(calls.length, before);
    assert.ok(
      calls.every(
        (c) => c.webContentsId === 31 && Number.isInteger(c.operation.revision),
      ),
    );
    assert.ok(
      [
        'task-add',
        'task-update',
        'task-focus',
        'task-next',
        'task-order',
        'task-transition',
      ].every((type) => calls.some((c) => c.operation.type === type)),
    );
  } finally {
    globalThis.document = previous;
  }
});

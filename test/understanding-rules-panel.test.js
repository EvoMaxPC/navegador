/** Callbacks reales con DOM/puente de fixture. No prueba Electron visual. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element } from './harness/dom-fixture.mjs';
import { createUnderstandingPanel } from '../src/ui/shell/understandingPanel.js';
import {
  newUnderstanding,
  updateUnderstanding,
  effectiveUnderstanding,
} from '../src/core/userUnderstanding.js';

test('panel: edición de reglas, alcance, propuestas y retiro usan IPC existente con revisión', async () => {
  const previous = globalThis.document,
    root = new Element('section');
  root.className = 'active';
  globalThis.document = {
    createElement: (t) => new Element(t),
    getElementById: () => new Element('button'),
    activeElement: null,
  };
  try {
    let state = newUnderstanding('rules-panel', 1),
      now = 1;
    const calls = [];
    const apply = (operation) => {
      const result = updateUnderstanding(
        state,
        { ...operation, revision: state.revision },
        { channel: 'shell' },
        ++now,
      );
      state = result.state;
      return result.report;
    };
    apply({ type: 'goal', text: 'Mejorar NEXO' });
    apply({
      type: 'message',
      text: 'No ejecutes código\nUsa español\nPrefiero respuestas en inglés\nPropuesta: Documentar la API <sin ejecutar>',
    });
    const snap = () => ({
      ok: true,
      state: structuredClone(state),
      effective: effectiveUnderstanding(state),
      memoryReferences: [],
      observationEnabled: true,
    });
    const panel = createUnderstandingPanel({
      root,
      activeTab: () => ({ view: { getWebContentsId: () => 17 } }),
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
    assert.match(root.textContent, /mayor prioridad incompatible/);
    assert.match(root.textContent, /Propuestas del usuario, no decisiones/);
    assert.match(root.textContent, /prioridad 3/);
    const old = state.active_instructions[0];
    const card = root
      .querySelectorAll('article')
      .find((a) => a.children.some((p) => p.textContent === 'Usa español'));
    const form = card.querySelectorAll('form')[0];
    const selects = form.querySelectorAll('select');
    selects[0].value = 'preferences';
    selects[1].value = 'session';
    const input = form.querySelectorAll('textarea')[0];
    input.value = 'Respuesta con literal <seguro>';
    await input.fire('input');
    await panel.refresh();
    const rerendered = root
      .querySelectorAll('form')
      .find((f) =>
        f
          .querySelectorAll('textarea')
          .some(
            (t) =>
              t.dataset.understandingDraft === `rules-panel:rule-${old.id}`,
          ),
      );
    assert.equal(
      rerendered.querySelectorAll('textarea')[0].value,
      'Respuesta con literal <seguro>',
    );
    // Los cambios de select se notifican como en el DOM; preservan sus borradores también.
    const rs = rerendered.querySelectorAll('select');
    rs[0].value = 'preferences';
    await rs[0].fire('change');
    rs[1].value = 'session';
    await rs[1].fire('change');
    await rerendered.fire('submit');
    assert.equal(state.active_instructions.length, 0);
    const changed = state.preferences.find(
      (p) => p.text === 'Respuesta con literal <seguro>',
    );
    assert.equal(changed.scope, 'session');
    assert.equal(state.instruction_history[0].id, old.id);
    assert.match(root.textContent, /Cambio: replaced/);
    const button = (label) =>
      root.querySelectorAll('button').find((b) => b.textContent === label);
    await button('Confirmar esta decisión concreta').fire('click');
    assert.equal(state.confirmed_decisions.length, 1);
    assert.equal(state.decision_candidates[0].status, 'accepted');
    assert.match(root.textContent, /no prueba ejecución/);
    assert.equal(state.progress.length, 0);
    const changedCard = root
      .querySelectorAll('article')
      .find((a) => a.children.some((p) => p.textContent === changed.text));
    await changedCard
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Marcar obsoleta')
      .fire('click');
    assert.ok(!state.preferences.some((p) => p.id === changed.id));
    assert.equal(state.instruction_history.at(-1).change.kind, 'retired');
    assert.deepEqual(
      calls.map((p) => p.operation.type),
      ['rule-update', 'decision-candidate', 'retire'],
    );
    assert.ok(
      calls.every(
        (p) => p.webContentsId === 17 && Number.isInteger(p.operation.revision),
      ),
    );
  } finally {
    globalThis.document = previous;
  }
});

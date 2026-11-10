/** DOM mínimo de fixture: prueba callbacks/operaciones, no renderizado visual ni Chromium. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUnderstandingPanel } from '../src/ui/shell/understandingPanel.js';
import {
  newUnderstanding,
  updateUnderstanding,
  effectiveUnderstanding,
} from '../src/core/userUnderstanding.js';
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.scrollTop = 0;
    this.value = '';
    this.ownText = '';
    this.classList = {
      contains: (c) => this.className.split(' ').includes(c),
      add: (c) => {
        this.className += ` ${c}`;
      },
      toggle: () => {},
    };
  }
  set textContent(t) {
    this.ownText = String(t);
    this.children = [];
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(_) {
    throw Error('No HTML sin escapar en el panel');
  }
  append(...items) {
    this.children.push(...items);
  }
  prepend(...items) {
    this.children.unshift(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.ownText = '';
  }
  setAttribute(k, v) {
    this[k] = v;
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
  querySelectorAll(selector) {
    const tags = selector.split(',');
    const match = (n) =>
      tags.includes(n.tagName) ||
      (selector === '[data-understanding-draft]' &&
        n.dataset.understandingDraft);
    return this.children.flatMap((c) => [
      ...(match(c) ? [c] : []),
      ...c.querySelectorAll(selector),
    ]);
  }
  async fire(name) {
    await this.listeners.get(name)?.({ preventDefault() {} });
  }
}
test('panel: controles de objetivos mutan el core por puente existente y conservan borrador', async () => {
  const previous = globalThis.document;
  const root = new Element('section');
  root.className = 'active';
  const tabButton = new Element('button');
  globalThis.document = {
    createElement: (t) => new Element(t),
    getElementById: () => tabButton,
    activeElement: null,
  };
  try {
    let state = newUnderstanding('panel-goals', 1),
      now = 1;
    const calls = [];
    let active = 42;
    const apply = (o) => {
      state = updateUnderstanding(
        state,
        { ...o, revision: state.revision },
        { channel: 'shell' },
        ++now,
      ).state;
    };
    apply({ type: 'message', text: 'Quiero construir <una aplicación>' });
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
            apply(p.operation);
            return snap();
          },
        },
      },
    });
    await panel.refresh();
    const buttons = () => root.querySelectorAll('button');
    const click = async (label) => {
      const b = buttons().find((b) => b.textContent === label);
      assert.ok(b, `control ${label}`);
      await b.fire('click');
    };
    assert.match(root.textContent, /Interpretaciones de objetivo/);
    assert.equal(state.user_goal, null);
    await click('Confirmar como independiente');
    assert.equal(state.independent_goals[0].certainty, 'confirmed');
    assert.equal(state.goal_candidates[0].status, 'accepted');
    assert.equal(state.user_goal, null);
    const form = root
      .querySelectorAll('form')
      .find((f) => f.textContent.includes('Definir o actualizar objetivo'));
    form.querySelectorAll('textarea')[0].value = 'Principal literal';
    await form.fire('submit');
    assert.equal(state.user_goal.text, 'Principal literal');
    const primaryCard = () =>
      root
        .querySelectorAll('article')
        .find((a) => a.textContent.includes('Principal literal'));
    await primaryCard()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Declarar completado')
      .fire('click');
    assert.equal(state.user_goal.status, 'completed');
    assert.match(primaryCard().textContent, /ejecución no verificada/);
    assert.equal(state.progress.length, 0);
    await primaryCard()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Reabrir explícitamente')
      .fire('click');
    assert.equal(state.user_goal.status, 'active');
    await primaryCard()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Cancelar objetivo')
      .fire('click');
    assert.equal(state.user_goal.status, 'cancelled');
    assert.match(primaryCard().textContent, /no significa completado/);
    const independentInput = root
      .querySelectorAll('textarea')
      .find(
        (t) => t.dataset.understandingDraft === 'panel-goals:independent-goal',
      );
    independentInput.value = 'Borrador aún no autorizado';
    await independentInput.fire('input');
    await panel.refresh();
    assert.equal(
      root
        .querySelectorAll('textarea')
        .find(
          (t) =>
            t.dataset.understandingDraft === 'panel-goals:independent-goal',
        ).value,
      'Borrador aún no autorizado',
    );
    const edits = calls.length;
    active = 43;
    await primaryCard()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Reabrir explícitamente')
      .fire('click');
    assert.equal(
      calls.length,
      edits,
      'cambio de pestaña no debe aplicar operación pendiente',
    );
    assert.ok(
      calls.every(
        (p) => p.webContentsId === 42 && Number.isInteger(p.operation.revision),
      ),
    );
    assert.deepEqual(
      calls.map((p) => p.operation.type),
      [
        'goal-candidate',
        'goal',
        'goal-transition',
        'goal-transition',
        'goal-transition',
      ],
    );
  } finally {
    globalThis.document = previous;
  }
});

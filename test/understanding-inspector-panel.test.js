/** Fixture DOM y servicio local. No certifica renderizado, foco ni accesibilidad reales. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element } from './harness/dom-fixture.mjs';
import { createUnderstandingPanel } from '../src/ui/shell/understandingPanel.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
async function fixture(run) {
  const previous = globalThis.document,
    root = new Element('section');
  root.className = 'active';
  globalThis.document = {
    createElement: (t) => new Element(t),
    getElementById: () => new Element('button'),
    activeElement: null,
  };
  try {
    let raw = null,
      active = 1,
      url = 'https://chatgpt.com/c/inspector-panel';
    const g = { id: 1, getURL: () => url },
      s = new UserUnderstandingService({
        memoryEnabled: () => false,
        storage: { read: () => raw, write: (v) => (raw = v) },
      }),
      calls = [];
    const edit = (op) =>
      s.edit(g, { ...op, revision: s.snapshot(g).state.revision });
    edit({ type: 'goal', text: 'Control humano' });
    edit({ type: 'message', text: 'Revisar IPC' });
    edit({ type: 'add', field: 'relevant_context', text: 'Dato original' });
    const panel = createUnderstandingPanel({
      root,
      activeTab: () => ({ view: { getWebContentsId: () => active } }),
      notice: () => {},
      nexo: {
        on() {},
        understanding: {
          read: async (p) => {
            calls.push({ read: p });
            const id = s.contextFor(g);
            if (
              (p.contextId && id !== p.contextId) ||
              (p.revision !== undefined &&
                p.revision !== s.row(id).state.revision)
            )
              return { ok: false, error: 'El contexto cambió' };
            return {
              ok: true,
              activeContextId: id,
              ...s.snapshot(g, p.inspector),
            };
          },
          edit: async (p) => {
            calls.push({ edit: p });
            try {
              s.edit(g, p.operation);
              return { ok: true, ...s.snapshot(g) };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          },
        },
      },
    });
    await panel.refresh();
    const context = s.snapshot(g).state.context_id,
      form = (key) =>
        root
          .querySelectorAll('form')
          .find((f) =>
            f
              .querySelectorAll('textarea')
              .some(
                (t) => t.dataset.understandingDraft === `${context}:${key}`,
              ),
          ),
      click = async (label) => {
        const b = root
          .querySelectorAll('button')
          .find((b) => b.textContent === label);
        assert.ok(b, label);
        await b.fire('click');
      };
    const submit = async (key, text) => {
      const f = form(key);
      assert.ok(f, key);
      const input = f
        .querySelectorAll('textarea')
        .find((t) => t.dataset.understandingDraft === `${context}:${key}`);
      input.value = text;
      await f.fire('submit');
    };
    await run({
      root,
      s,
      g,
      panel,
      edit,
      calls,
      form,
      click,
      submit,
      navigate: (v) => (url = v),
      active: (v) => (active = v),
    });
  } finally {
    globalThis.document = previous;
  }
}
test('inspector UI: filtros, corrección literal con motivo, revisión de solicitud y anotación de intención', async () => {
  await fixture(async ({ root, s, g, panel, form, submit, click, calls }) => {
    assert.match(root.textContent, /no reconstruyen razonamientos/);
    let filter = root
      .querySelectorAll('label')
      .find(
        (l) =>
          l.children.some((c) => c.tagName.toLowerCase() === 'select') &&
          l.textContent.startsWith('Categoría'),
      );
    filter.querySelectorAll('select')[0].value = 'relevant_context';
    await click('Aplicar filtros del inspector');
    const original = s.snapshot(g).state.relevant_context[0],
      f = form(`inspector-edit-${original.id}`);
    assert.ok(f);
    f
      .querySelectorAll('textarea')
      .find((t) => !t.dataset.understandingDraft).value = 'El dato era erróneo';
    await submit(
      `inspector-edit-${original.id}`,
      '  Dato corregido <script>\nliteral  ',
    );
    assert.equal(
      s.snapshot(g).state.relevant_context[0].text,
      '  Dato corregido <script>\nliteral  ',
    );
    assert.equal(root.querySelectorAll('script').length, 0);
    let request = form('review-request'),
      selects = request.querySelectorAll('select');
    selects[0].value = 'confirm';
    selects[1].value = s.snapshot(g).state.user_goal.id;
    await submit('review-request', 'Confirmo sólo la interpretación');
    assert.equal(s.snapshot(g).state.current_task.certainty, 'confirmed');
    assert.equal(s.snapshot(g).state.tasks.length, 0);
    const interaction = form('review-interaction');
    interaction.querySelectorAll('select')[0].value = 'question';
    interaction.querySelectorAll('select')[1].value = 'independent';
    await submit('review-interaction', 'Mi intención era preguntar');
    assert.equal(s.snapshot(g).state.interaction_review.intent, 'question');
    assert.match(root.textContent, /Clasificación original:/);
    assert.match(root.textContent, /Revisión humana:/);
    assert.equal(s.snapshot(g).state.user_goal.text, 'Control humano');
    assert.ok(
      calls
        .filter((c) => c.edit)
        .every(
          (c) =>
            c.edit.operation.contextId &&
            Number.isSafeInteger(c.edit.operation.revision),
        ),
    );
  });
});
test('callbacks descartados no heredan una revisión nueva ni escriben en otra URL con revisión igual', async () => {
  await fixture(
    async ({ s, g, root, panel, form, calls, navigate, active }) => {
      const oldGoal = form('goal');
      oldGoal.querySelectorAll('textarea')[0].value = 'NO aplicar';
      await panel.refresh();
      const before = calls.filter((c) => c.edit).length;
      await oldGoal.fire('submit');
      assert.equal(calls.filter((c) => c.edit).length, before);
      assert.equal(s.snapshot(g).state.user_goal.text, 'Control humano');
      const sameTab = form('goal');
      navigate('https://chatgpt.com/c/new-inspector');
      await panel.refresh();
      await sameTab.fire('submit');
      assert.equal(calls.filter((c) => c.edit).length, before);
      assert.equal(s.snapshot(g).state.user_goal, null);
      const staleButton = root
        .querySelectorAll('button')
        .find((b) => b.textContent === 'Guardar objetivo explícito');
      active(2);
      await staleButton.fire('click');
      assert.equal(calls.filter((c) => c.edit).length, before);
    },
  );
});
test('inspector UI pagina sin mutar estado ni registrar la consulta como instrucción', async () => {
  await fixture(async ({ s, g, panel, edit, root, click, calls }) => {
    for (let i = 0; i < 25; i++)
      edit({ type: 'add', field: 'subgoals', text: `Subobjetivo ${i}` });
    await panel.refresh();
    const before = JSON.stringify(s.data);
    root
      .querySelectorAll('label')
      .find(
        (l) =>
          l.textContent.startsWith('Categoría') &&
          l.querySelectorAll('select').length,
      )
      .querySelectorAll('select')[0].value = 'subgoals';
    await click('Aplicar filtros del inspector');
    await click('Página siguiente del inspector');
    assert.match(root.textContent, /página 2/);
    assert.equal(JSON.stringify(s.data), before);
    assert.ok(calls.some((c) => c.read?.inspector?.offset === 20));
  });
});

test('navegación en la misma pestaña durante lectura descarta respuesta vieja y no pierde la renovación', async () => {
  const previous = globalThis.document,
    root = new Element('section');
  root.className = 'active';
  globalThis.document = {
    createElement: (t) => new Element(t),
    getElementById: () => new Element('button'),
    activeElement: null,
  };
  try {
    let raw = null,
      url = 'https://chatgpt.com/c/old-read',
      release,
      hold = false;
    const g = { id: 1, getURL: () => url },
      s = new UserUnderstandingService({
        memoryEnabled: () => false,
        storage: { read: () => raw, write: (v) => (raw = v) },
      });
    const edit = (text) =>
      s.edit(g, { type: 'goal', revision: s.snapshot(g).state.revision, text });
    edit('Meta antigua');
    const panel = createUnderstandingPanel({
      root,
      activeTab: () => ({ view: { getWebContentsId: () => 1 } }),
      notice: () => {},
      nexo: {
        on() {},
        understanding: {
          read: async () => {
            const result = { ok: true, ...s.snapshot(g) };
            if (hold) {
              hold = false;
              return new Promise(
                (resolve) => (release = () => resolve(result)),
              );
            }
            return result;
          },
        },
      },
    });
    await panel.refresh();
    hold = true;
    const pending = panel.refresh();
    url = 'https://chatgpt.com/c/new-read';
    edit('Meta nueva');
    panel.changed();
    release();
    await pending;
    assert.match(root.textContent, /Meta nueva/);
    assert.ok(!root.textContent.includes('Meta antigua'));
  } finally {
    globalThis.document = previous;
  }
});

/** Contrato DOM/puente local; no sustituye pruebas visuales de Chromium. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element } from './harness/dom-fixture.mjs';
import { createUnderstandingPanel } from '../src/ui/shell/understandingPanel.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
async function panelFixture(run) {
  const oldDocument = globalThis.document,
    root = new Element('section');
  root.className = 'active';
  globalThis.document = {
    createElement: (t) => new Element(t),
    getElementById: () => new Element('button'),
    activeElement: null,
  };
  try {
    let raw = null,
      url = 'https://chatgpt.com/c/progress-panel',
      active = 1;
    const guest = { id: 1, getURL: () => url },
      service = new UserUnderstandingService({
        memoryEnabled: () => false,
        storage: { read: () => raw, write: (v) => (raw = v) },
      }),
      calls = [];
    const edit = (op) =>
      service.edit(guest, {
        ...op,
        revision: service.snapshot(guest).state.revision,
      });
    edit({ type: 'goal', text: 'No perder control' });
    edit({ type: 'message', text: 'Avance: continuidad previa' });
    edit({
      type: 'task-add',
      text: 'Revisar IPC',
      expected_result: 'IPC sin fallos',
    });
    const panel = createUnderstandingPanel({
      root,
      activeTab: () => ({ view: { getWebContentsId: () => active } }),
      notice: () => {},
      nexo: {
        on() {},
        understanding: {
          read: async () => ({ ok: true, ...service.snapshot(guest) }),
          edit: async (p) => {
            calls.push(p.operation);
            try {
              service.edit(guest, p.operation);
              return { ok: true, ...service.snapshot(guest) };
            } catch (error) {
              return { ok: false, error: error.message };
            }
          },
        },
      },
    });
    await panel.refresh();
    const context = service.snapshot(guest).state.context_id;
    const form = (key) =>
      root
        .querySelectorAll('form')
        .find((f) =>
          f
            .querySelectorAll('textarea')
            .some((t) => t.dataset.understandingDraft === `${context}:${key}`),
        );
    const submit = async (key, text) => {
      const f = form(key);
      assert.ok(f, key);
      f.querySelectorAll('textarea')[0].value = text;
      await f.fire('submit');
    };
    const click = async (label) => {
      const b = root
        .querySelectorAll('button')
        .find((b) => b.textContent === label);
      assert.ok(b, label);
      await b.fire('click');
    };
    await run({
      root,
      guest,
      service,
      edit,
      panel,
      calls,
      context,
      form,
      submit,
      click,
      navigate: (v) => (url = v),
      active: (v) => (active = v),
    });
  } finally {
    globalThis.document = oldDocument;
  }
}
test('panel: resultado evidencia retiro resolución y propuesta usan control explícito sin completar tareas', async () => {
  await panelFixture(
    async ({ root, service, guest, form, submit, edit, panel, calls }) => {
      const t = service.snapshot(guest).state.tasks[0];
      let f = form('work-add'),
        inputs = f.querySelectorAll('select');
      inputs[0].value = 'result';
      inputs[1].value = t.id;
      inputs[3].value = 'partial';
      await submit('work-add', 'Revisado <script>sin ejecución</script>');
      let r = service.snapshot(guest).state.work_records[0];
      assert.equal(r.outcome, 'partial');
      assert.equal(r.task_id, t.id);
      assert.match(root.textContent, /Esperado por la tarea: IPC sin fallos/);
      assert.match(root.textContent, /Sin evidencia activa aportada/);
      assert.match(root.textContent, /No es un porcentaje/);
      assert.match(root.textContent, /avances simples conservados/);
      assert.equal(root.querySelectorAll('script').length, 0);
      f = form(`work-evidence-${r.id}`);
      f.querySelectorAll('select')[0].value = 'supplied-artifact';
      f.querySelectorAll('input')[0].value = 'https://example.invalid/log';
      await submit(`work-evidence-${r.id}`, 'Salida aportada: una prueba pasó');
      let e = service.snapshot(guest).state.work_evidence[0];
      assert.equal(e.verified, false);
      assert.equal(e.locator, 'https://example.invalid/log');
      assert.match(root.textContent, /no verificación independiente/);
      assert.equal(root.querySelectorAll('a').length, 0);
      await submit(`work-withdraw-${e.id}`, 'Ese log era anterior');
      assert.equal(
        service.snapshot(guest).effective.work_tracking.without_evidence.length,
        1,
      );
      edit({ type: 'work-add', kind: 'error', text: 'Falla pendiente' });
      edit({ type: 'work-add', kind: 'proposal', text: 'Repetir una prueba' });
      await panel.refresh();
      let state = service.snapshot(guest).state,
        error = state.work_records[1],
        proposal = state.work_records[2];
      form(`work-state-${error.id}`).querySelectorAll('select')[0].value =
        'resolved';
      await submit(`work-state-${error.id}`, 'Usuario informa corrección');
      assert.equal(
        service.snapshot(guest).effective.work_tracking.open_problems.length,
        0,
      );
      form(`work-state-${proposal.id}`).querySelectorAll('select')[0].value =
        'accepted';
      await submit(
        `work-state-${proposal.id}`,
        'Acepto como propuesta a considerar',
      );
      state = service.snapshot(guest).state;
      assert.equal(state.tasks[0].status, 'pending');
      assert.equal(state.user_goal.status, 'active');
      assert.equal(state.confirmed_decisions.length, 0);
      assert.match(root.textContent, /no autoriza ejecución/);
      assert.ok(
        calls.every((c) => c.contextId && Number.isSafeInteger(c.revision)),
      );
    },
  );
});
test('panel: captura conserva asistente y versión; cambio de URL o pestaña descarta acciones viejas', async () => {
  await panelFixture(
    async ({
      service,
      guest,
      panel,
      root,
      click,
      form,
      submit,
      navigate,
      active,
      calls,
    }) => {
      service.observeConversation(guest, [
        { id: 'u', role: 'user', content: 'Mi objetivo: No perder control' },
        {
          id: 'a',
          role: 'assistant',
          content: 'Propongo revisar; ya estaría completo',
        },
      ]);
      await panel.refresh();
      assert.equal(service.snapshot(guest).state.work_records.length, 0);
      await click('Registrar como afirmación de resultado del asistente');
      let r = service.snapshot(guest).state.work_records[0];
      assert.equal(r.source.role, 'assistant');
      assert.equal(r.outcome, 'unknown');
      assert.match(root.textContent, /Asistente observado, no usuario/);
      assert.match(root.textContent, /no se actualiza con regeneraciones/);
      const stale = form('work-add');
      navigate('https://chatgpt.com/c/other-progress-panel');
      stale.querySelectorAll('textarea')[0].value = 'No atribuir a la otra URL';
      await stale.fire('submit');
      assert.equal(service.snapshot(guest).state.work_records.length, 0);
      assert.match(root.textContent, /cambió/);
      const before = calls.length;
      active(2);
      await stale.fire('submit');
      assert.equal(calls.length, before);
    },
  );
});

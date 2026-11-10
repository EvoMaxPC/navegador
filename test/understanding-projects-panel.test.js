/** Contratos/callbacks con DOM mínimo y servicio real en RAM; no Chromium visual. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element } from './harness/dom-fixture.mjs';
import { createUnderstandingPanel } from '../src/ui/shell/understandingPanel.js';
import { UserUnderstandingService } from '../src/main/userUnderstanding.js';
test('panel: proyecto alias inspección vínculo obsoleto renovación y selección explícita sin mezclar contextos', async () => {
  const oldDocument = globalThis.document,
    oldWindow = globalThis.window,
    root = new Element('section');
  root.className = 'active';
  globalThis.document = {
    createElement: (t) => new Element(t),
    getElementById: () => new Element('button'),
    activeElement: null,
  };
  globalThis.window = { confirm: () => true };
  try {
    let raw = null;
    const service = new UserUnderstandingService({
        memoryEnabled: () => false,
        storage: {
          read: () => raw,
          write: (t) => {
            raw = t;
          },
        },
      }),
      a = { id: 1, getURL: () => 'https://chatgpt.com/c/panel-project-a' },
      b = { id: 2, getURL: () => 'https://chatgpt.com/c/panel-project-b' };
    let active = b;
    const edit = (g, op) =>
      service.edit(g, { ...op, revision: service.snapshot(g).state.revision });
    edit(a, { type: 'project', name: 'Alpha', description: 'Datos de origen' });
    edit(a, { type: 'goal', text: 'Meta fuente' });
    const bId = service.snapshot(b).state.context_id,
      calls = [];
    const panel = createUnderstandingPanel({
      root,
      activeTab: () => ({ view: { getWebContentsId: () => active.id } }),
      notice: () => {},
      nexo: {
        on() {},
        understanding: {
          read: async () => ({ ok: true, ...service.snapshot(active) }),
          edit: async (p) => {
            calls.push(p.operation);
            service.edit(active, p.operation);
            return { ok: true, ...service.snapshot(active) };
          },
          contexts: async (p) =>
            p.mode === 'inspect'
              ? {
                  ok: true,
                  activeContextId: service.contextFor(active),
                  preview: service.inspect(
                    p.contextId,
                    p.revision,
                    p.targetKind,
                    p.targetId,
                    p.offset,
                  ),
                }
              : {
                  ok: true,
                  activeContextId: service.contextFor(active),
                  contexts: service.contexts(),
                },
          bind: async (p) => {
            service.bind(active, p.contextId, {
              revision: p.revision,
              contextId: p.expectedContextId,
              sourceRevision: p.sourceRevision,
              sourceDigest: p.sourceDigest,
            });
            return { ok: true, ...service.snapshot(active) };
          },
        },
      },
    });
    await panel.refresh();
    const formFor = (key) =>
      root
        .querySelectorAll('form')
        .find((f) =>
          f
            .querySelectorAll('textarea')
            .some((t) => t.dataset.understandingDraft === key),
        );
    let form = formFor(`${bId}:project`);
    form.querySelectorAll('input')[0].value = 'Beta';
    form.querySelectorAll('textarea')[0].value = 'Proyecto separado';
    await form.fire('submit');
    assert.equal(service.snapshot(b).state.project.name, 'Beta');
    assert.equal(service.snapshot(a).state.project.name, 'Alpha');
    form = formFor(`${bId}:context-item`);
    form.querySelectorAll('input')[0].value = 'archivo';
    form.querySelectorAll('textarea')[0].value = 'src/archivo.js';
    await form.fire('submit');
    const click = async (label) => {
      const button = root
        .querySelectorAll('button')
        .find((b) => b.textContent === label);
      assert.ok(button, label);
      await button.fire('click');
    };
    await click('Seleccionar esta referencia');
    assert.equal(
      service.snapshot(b).effective.selected_reference.text,
      'src/archivo.js',
    );
    await click('Listar contextos guardados para inspeccionar o continuar');
    const sourceCard = () =>
      root
        .querySelectorAll('article')
        .find(
          (c) =>
            c.children.some(
              (p) =>
                p.textContent.includes(
                  'https://chatgpt.com/c/panel-project-a',
                ) && p.textContent.includes('revisión'),
            ) &&
            c
              .querySelectorAll('button')
              .some(
                (b) => b.textContent === 'Inspeccionar sin cambiar contexto',
              ),
        );
    await sourceCard()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Inspeccionar sin cambiar contexto')
      .fire('click');
    assert.equal(service.snapshot(b).state.user_goal, null);
    assert.match(root.textContent, /Meta fuente/);
    await click('Proponer este antecedente');
    assert.equal(
      service.snapshot(b).state.context_references[0].status,
      'pending',
    );
    await click('Confirmar sólo este antecedente');
    assert.equal(
      service.snapshot(b).state.context_references[0].status,
      'linked',
    );
    assert.equal(service.snapshot(b).state.user_goal, null);
    edit(a, {
      type: 'project',
      name: 'Alpha renovado',
      description: 'Origen cambiado',
    });
    await panel.refresh();
    assert.match(root.textContent, /El origen cambió/);
    await click('Inspeccionar versión actual antes de renovar');
    assert.ok(
      !root
        .querySelectorAll('button')
        .some((b) => b.textContent.startsWith('Inspeccionar goal:')),
      'renovar no permite cambiar la entrada del vínculo a escondidas',
    );
    await click('Actualizar propuesta y volver a revisar');
    assert.equal(
      service.snapshot(b).state.context_references[0].status,
      'pending',
    );
    await click('Confirmar sólo este antecedente');
    await click('Listar contextos guardados para inspeccionar o continuar');
    await sourceCard()
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Continuar en este contexto…')
      .fire('click');
    assert.equal(service.snapshot(b).contextSelection.mode, 'explicit');
    assert.equal(service.snapshot(b).state.user_goal.text, 'Meta fuente');
    await click('Volver al contexto natural');
    assert.equal(service.snapshot(b).state.project.name, 'Beta');
    assert.equal(service.snapshot(b).state.user_goal, null);
    assert.equal(service.snapshot(b).state.context_references.length, 1);
    const saved = JSON.stringify(service.data);
    active = a;
    await click('Quitar etiqueta sin borrar comprensión');
    assert.equal(JSON.stringify(service.data), saved);
    assert.ok(
      calls.every(
        (c) =>
          typeof c.contextId === 'string' && Number.isSafeInteger(c.revision),
      ),
    );
  } finally {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});

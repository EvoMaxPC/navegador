import test from 'node:test';
import assert from 'node:assert/strict';
import { Element } from './harness/dom-fixture.mjs';
import { createUnderstandingPanel } from '../src/ui/shell/understandingPanel.js';
async function fixture(run) {
  const old = globalThis.document;
  globalThis.document = { createElement: (t) => new Element(t) };
  const root = new Element('section');
  root.className = 'active';
  let id = 1;
  const calls = [],
    events = new Map();
  const response = {
    ok: true,
    available: true,
    status: 'optimized',
    reason: 'Reconstrucción literal verificada.',
    source: 'dom',
    original: '<script>No ejecutar</script>',
    optimized: 'Texto optimizado con referencias',
    metrics: {
      original: 1000,
      optimized: 400,
      saved: 600,
      percent: 60,
      tokenizer: { estimated: true, encoding: 'o200k_base', model: '' },
    },
  };
  let result = response;
  const panel = createUnderstandingPanel({
    root,
    activeTab: () => ({ view: { getWebContentsId: () => id } }),
    nexo: {
      on: (n, f) => {
        events.set(n, f);
        return () => events.delete(n);
      },
      understanding: {
        read: async (p) => {
          calls.push(p);
          return typeof result === 'function' ? result(p) : result;
        },
      },
    },
  });
  try {
    await run({
      root,
      panel,
      calls,
      events,
      response,
      set: (r) => (result = r),
      navigate: (n) => (id = n),
    });
  } finally {
    panel.dispose();
    globalThis.document = old;
  }
}
test('única pantalla estado/ahorro/resultado, texto sin HTML y sin categorías ni formularios', async () =>
  fixture(async (f) => {
    await f.panel.refresh();
    assert.match(f.root.textContent, /Optimización realizada/);
    for (const label of [
      'Tokens originales',
      'Tokens optimizados',
      'Tokens ahorrados',
      'Reducción',
      '600',
      '60%',
      'Consultar contenido original',
    ])
      assert.ok(f.root.textContent.includes(label));
    assert.match(f.root.textContent, /Estimación/);
    assert.equal(f.root.querySelectorAll('form').length, 0);
    assert.equal(f.root.querySelectorAll('input,textarea,select').length, 0);
    assert.ok(
      f.root
        .querySelectorAll('pre')
        .some((p) => p.textContent === '<script>No ejecutar</script>'),
    );
    assert.deepEqual(f.calls, [{ webContentsId: 1, includeText: true }]);
  }));
test('sin necesidad no muestra un resultado ficticio; fallo o streaming no presenta ahorro inexistente', async () =>
  fixture(async (f) => {
    for (const [state, label] of [
      ['unnecessary', 'Sin necesidad de optimización'],
      ['unsafe', 'No se pudo optimizar con seguridad'],
      ['analyzing', 'Analizando'],
    ]) {
      f.set({
        ...f.response,
        status: state,
        optimized: null,
        metrics:
          state === 'unnecessary'
            ? { ...f.response.metrics, optimized: 1000, saved: 0, percent: 0 }
            : null,
      });
      await f.panel.refresh();
      assert.match(f.root.textContent, new RegExp(label));
      assert.doesNotMatch(f.root.textContent, /Contexto optimizado/);
      if (state !== 'unnecessary')
        assert.doesNotMatch(f.root.textContent, /600/);
    }
  }));
test('cambio de pestaña invalida una lectura tardía y no filtra texto anterior', async () =>
  fixture(async (f) => {
    let resolve;
    f.set(() => new Promise((r) => (resolve = r)));
    const old = f.panel.refresh();
    f.navigate(2);
    f.set({
      ...f.response,
      original: 'ORIGINAL PESTAÑA DOS',
      optimized: 'RESULTADO PESTAÑA DOS',
    });
    await f.panel.changed();
    resolve({ ...f.response, optimized: 'RESULTADO OBSOLETO' });
    await old;
    assert.match(f.root.textContent, /RESULTADO PESTAÑA DOS/);
    assert.doesNotMatch(f.root.textContent, /RESULTADO OBSOLETO/);
  }));
test('error de IPC no expone un resultado optimizado previo', async () =>
  fixture(async (f) => {
    await f.panel.refresh();
    f.set({ ok: false, error: 'Pestaña cerrada' });
    await f.panel.refresh();
    assert.match(f.root.textContent, /Pestaña cerrada/);
    assert.doesNotMatch(f.root.textContent, /Texto optimizado con referencias/);
  }));

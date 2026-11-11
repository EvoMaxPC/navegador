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
test('el contexto optimizado se entrega sólo con un gesto: cuadro o portapapeles, nunca envío', async () => {
  const old = globalThis.document;
  globalThis.document = { createElement: (t) => new Element(t) };
  const root = new Element('section');
  root.className = 'active';
  const inserted = [];
  const copied = [];
  let fail = false;
  const panel = createUnderstandingPanel({
    root,
    activeTab: () => ({ view: { getWebContentsId: () => 7 } }),
    insertText: async (text) => {
      if (fail) throw Error('pestaña cerrada');
      inserted.push(text);
      return { ok: true };
    },
    copyText: async (text) => {
      copied.push(text);
      return undefined;
    },
    nexo: {
      on: () => () => {},
      understanding: {
        read: async () => ({
          ok: true,
          status: 'optimized',
          reason: 'Reconstrucción literal verificada.',
          optimized: 'CONTEXTO OPTIMIZADO',
          original: 'ORIGINAL',
          metrics: {
            original: 100,
            optimized: 40,
            saved: 60,
            percent: 60,
            tokenizer: { estimated: false, encoding: 'o200k_base', model: 'gpt-4o' },
          },
        }),
      },
    },
  });
  try {
    await panel.refresh();
    const buttons = root.querySelectorAll('button');
    const insert = buttons.find((b) => b.textContent === 'Escribir en el cuadro');
    const copy = buttons.find((b) => b.textContent === 'Copiar el contexto');
    assert.ok(insert && copy, 'las dos acciones existen');
    assert.equal(insert.tagName, 'button');
    // Nada se entrega sin gesto.
    assert.deepEqual(inserted, []);
    assert.deepEqual(copied, []);

    await insert.fire('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(inserted, ['CONTEXTO OPTIMIZADO']);
    assert.match(root.textContent, /Revisalo y enviá vos: no se envió nada/);
    // El panel no envía ni reemplaza mensajes: no hay formularios ni texto de envío.
    assert.equal(root.querySelectorAll('form,textarea,input').length, 0);

    await copy.fire('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(copied, ['CONTEXTO OPTIMIZADO']);
    assert.match(root.textContent, /no se envió nada/);

    fail = true;
    await insert.fire('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.match(root.textContent, /No se pudo escribir en el cuadro del sitio/);
    assert.doesNotMatch(root.textContent, /se envió nada\./);
  } finally {
    panel.dispose();
    globalThis.document = old;
  }
});

test('el texto que no entra en el cuadro no se inserta a medias', async () => {
  const old = globalThis.document;
  globalThis.document = { createElement: (t) => new Element(t) };
  const root = new Element('section');
  root.className = 'active';
  const inserted = [];
  const panel = createUnderstandingPanel({
    root,
    activeTab: () => ({ view: { getWebContentsId: () => 3 } }),
    insertText: async (t) => {
      inserted.push(t);
      return { ok: true };
    },
    copyText: async () => {},
    maxInsert: 5,
    nexo: {
      on: () => () => {},
      understanding: {
        read: async () => ({
          ok: true,
          status: 'optimized',
          reason: 'ok',
          optimized: '1234567890',
          metrics: {
            original: 10,
            optimized: 4,
            saved: 6,
            percent: 60,
            tokenizer: { estimated: false, encoding: 'o200k_base', model: 'gpt-4o' },
          },
        }),
      },
    },
  });
  try {
    await panel.refresh();
    const insert = root.querySelectorAll('button').find((b) => b.textContent === 'Escribir en el cuadro');
    assert.equal(insert.disabled, true);
    await insert.fire('click');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(inserted, []);
    assert.match(root.textContent, /Copialo por partes/);
  } finally {
    panel.dispose();
    globalThis.document = old;
  }
});

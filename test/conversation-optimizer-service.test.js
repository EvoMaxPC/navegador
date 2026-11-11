import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConversationOptimizer } from '../src/main/conversationOptimizer.js';
import {
  optimizeConversation,
  optimizePrompt,
} from '../src/core/conversationOptimization.js';
import { optimizationTokenizer } from '../src/main/optimizationTokens.js';
const text =
  'Preservar EVO MEMORY y el lector DOM. No eliminar datos históricos. Modificar sólo la funcionalidad solicitada y comprobar todas las pruebas antes de continuar.';
const turn = (id, role = 'user', content = text) => ({
  id,
  role,
  content,
  clipped: false,
});
const packet = (g, turns, extra = {}) => ({
  href: g.getURL(),
  turns,
  streaming: false,
  coverage: {
    scope: 'loaded-dom',
    strategy: 'author-role',
    detected_turns: turns.length,
    sent_turns: turns.length,
    omitted_turns: 0,
    clipped: false,
    remote_history_complete: false,
  },
  ...extra,
});
function fixture(t, run) {
  let url = 'https://chatgpt.com/c/service';
  const g = { id: 1, getURL: () => url };
  let runs = 0;
  const events = new EventEmitter();
  const service = new ConversationOptimizer({
    delay: 0,
    notify: () => events.emit('changed'),
    run: async (job) => {
      runs++;
      return run
        ? run(job)
        : job.mode === 'prompt'
          ? optimizePrompt(job.text, optimizationTokenizer(job.model))
          : optimizeConversation(job.messages, {
              ...optimizationTokenizer(job.model),
              partial: job.partial,
            });
    },
  });
  t.after(() => service.close());
  return {
    g,
    service,
    navigate: (u) => (url = u),
    runs: () => runs,
    settled: () =>
      new Promise((resolve, reject) => {
        const done = () => {
          const s = service.snapshot(g, { includeText: true });
          if (s.status !== 'analyzing') {
            clearTimeout(timer);
            events.off('changed', done);
            resolve(s);
          }
        };
        const timer = setTimeout(() => {
          events.off('changed', done);
          reject(Error('analysis timeout'));
        }, 2000);
        events.on('changed', done);
        done();
      }),
  };
}
test('DOM completo → nuevo motor → métricas; duplicados no disparan procesamiento', async (t) => {
  const f = fixture(t),
    p = packet(
      f.g,
      Array.from({ length: 30 }, (_, i) =>
        turn(`m${i}`, i % 2 ? 'assistant' : 'user'),
      ),
    );
  assert.equal(f.service.receive(f.g, p).ok, true);
  const result = await f.settled();
  assert.equal(result.status, 'optimized');
  assert.ok(result.metrics.saved > 0);
  assert.equal(result.metrics.tokenizer.estimated, true);
  assert.equal(f.runs(), 1);
  assert.equal(f.service.receive(f.g, p).duplicate, true);
  assert.equal(f.runs(), 1);
  assert.equal(f.service.snapshot(f.g).original, null);
});
test('nodos ausentes de ventana posterior se conservan; nuevos mensajes y actualizaciones se fusionan sin duplicados', async (t) => {
  const f = fixture(t);
  f.service.receive(
    f.g,
    packet(f.g, [turn('u1'), turn('a1', 'assistant', 'Respuesta inicial')]),
  );
  await f.settled();
  f.service.receive(
    f.g,
    packet(f.g, [
      turn('a1', 'assistant', 'Respuesta actualizada'),
      turn('u2', 'user', 'Siguiente instrucción'),
    ]),
  );
  const r = await f.settled();
  const original = JSON.parse(r.original);
  assert.deepEqual(
    original.messages.map((m) => m.id),
    ['u1', 'a1', 'u2'],
  );
  assert.equal(original.messages[1].content, 'Respuesta actualizada');
});
test('no procesa generación provisional, sólo final estable', async (t) => {
  const f = fixture(t);
  f.service.receive(
    f.g,
    packet(f.g, [turn('u1'), turn('a1', 'assistant', 'Parcial')], {
      streaming: true,
    }),
  );
  assert.equal(f.runs(), 0);
  assert.equal(f.service.snapshot(f.g).status, 'analyzing');
  f.service.receive(
    f.g,
    packet(f.g, [turn('u1'), turn('a1', 'assistant', 'Final completo')]),
  );
  const r = await f.settled();
  assert.equal(f.runs(), 1);
  assert.match(r.original, /Final completo/);
  assert.doesNotMatch(r.original, /Parcial/);
});
test('recorte u orden ambiguo conservan original y no producen falso ahorro', async (t) => {
  const f = fixture(t);
  f.service.receive(f.g, packet(f.g, [turn('u1'), turn('u2')]));
  await f.settled();
  f.service.receive(f.g, packet(f.g, [turn('u2'), turn('u1')]));
  const r = await f.settled();
  assert.equal(r.status, 'unsafe');
  assert.equal(r.optimized, null);
  assert.equal(r.metrics.saved, 0);
});
test('fallo del motor no modifica conversación ni anuncia ahorro; actualización permite recuperación', async (t) => {
  let fail = true;
  const f = fixture(t, (job) => {
    if (fail) throw Error('controlled');
    return optimizeConversation(job.messages, optimizationTokenizer());
  });
  f.service.receive(f.g, packet(f.g, [turn('u1')]));
  let r = await f.settled();
  assert.equal(r.status, 'unsafe');
  assert.equal(r.metrics, null);
  assert.match(r.original, /Preservar/);
  fail = false;
  f.service.receive(f.g, packet(f.g, [turn('u1'), turn('a1', 'assistant')]));
  r = await f.settled();
  assert.notEqual(r.status, 'unsafe');
});
test('un resultado obsoleto no pisa una versión nueva ni una respuesta en generación', async (t) => {
  let resolve;
  const f = fixture(t, () => new Promise((r) => (resolve = r)));
  f.service.receive(f.g, packet(f.g, [turn('u1')]));
  await new Promise((r) => setTimeout(r, 10));
  f.service.receive(
    f.g,
    packet(f.g, [turn('u1'), turn('a1', 'assistant', 'stream')], {
      streaming: true,
    }),
  );
  resolve({ status: 'optimized', reason: 'STALE', metrics: { saved: 999 } });
  await new Promise((r) => setTimeout(r, 10));
  const r = f.service.snapshot(f.g);
  assert.equal(r.status, 'analyzing');
  assert.equal(r.metrics, null);
});
test('navegación y release invalidan todo contexto de la pestaña anterior', async (t) => {
  const f = fixture(t);
  f.service.receive(f.g, packet(f.g, [turn('u1')]));
  await f.settled();
  f.navigate('https://chatgpt.com/c/new');
  assert.equal(f.service.snapshot(f.g).available, false);
  const stale = packet(f.g, [turn('u2')]);
  stale.href = 'https://chatgpt.com/c/service';
  assert.equal(f.service.receive(f.g, stale).code, 'conflict');
  f.service.activate(f.g);
  f.service.release(f.g);
  assert.equal(f.service.views.size, 0);
  f.navigate('https://chatgpt.com/');
  f.service.receive(f.g, {
    ...packet(f.g, [turn('root-old')]),
    conversationId: '/#session-one',
  });
  await f.settled();
  f.service.receive(f.g, {
    ...packet(f.g, [turn('root-new')]),
    conversationId: '/#session-two',
  });
  const root = await f.settled();
  assert.equal(root.retainedMessages, 1);
  assert.doesNotMatch(root.original, /root-old/);
});
test('prompt preparado usa motor nuevo sin alterar el argumento ni sustituir un envío', async (t) => {
  const f = fixture(t);
  const content = (text + '\n\n').repeat(30);
  f.service.observePrompt(f.g, content, 'gpt-4o');
  const r = await f.settled();
  assert.equal(r.source, 'prompt');
  assert.equal(r.status, 'optimized');
  assert.equal(r.original, content);
  assert.equal(r.metrics.tokenizer.estimated, false);
  assert.equal(r.metrics.tokenizer.model, 'gpt-4o');
});
test('worker de producción ejecuta BPE fuera de main, sin modelos externos', async (t) => {
  const service = new ConversationOptimizer({ delay: 0 });
  t.after(() => service.close());
  const g = { id: 99, getURL: () => 'https://chatgpt.com/c/worker' };
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('worker timeout')), 10000);
    service.notify = () => {
      const s = service.snapshot(g);
      if (s.status !== 'analyzing') {
        clearTimeout(timeout);
        resolve(s);
      }
    };
  });
  service.receive(
    g,
    packet(
      g,
      Array.from({ length: 30 }, (_, i) => turn(`m${i}`)),
    ),
  );
  const result = await done;
  assert.equal(result.status, 'optimized');
  assert.ok(result.metrics.saved > 0);
});

test('modelo observado actualiza sólo tokenizador y no modifica los mensajes', async (t) => {
  const f = fixture(t);
  f.service.receive(
    f.g,
    packet(
      f.g,
      Array.from({ length: 30 }, (_, i) => turn(`model-${i}`)),
    ),
  );
  const before = await f.settled();
  assert.equal(before.metrics.tokenizer.estimated, true);
  f.service.setModel(f.g, 'gpt-4-turbo');
  const after = await f.settled();
  assert.equal(after.metrics.tokenizer.estimated, false);
  assert.equal(after.metrics.tokenizer.encoding, 'cl100k_base');
  assert.equal(before.original, after.original);
});
test('presupuesto de contexto rechaza ampliar sin podar mensajes previos ni anunciar ahorro', async (t) => {
  const f = fixture(t),
    chunk = 'x'.repeat(200000);
  for (let page = 0; page < 4; page++) {
    f.service.receive(
      f.g,
      packet(
        f.g,
        Array.from({ length: 10 }, (_, i) =>
          turn(`large-${page}-${i}`, 'user', chunk),
        ),
      ),
    );
  }
  const before = f.service.views.get(f.g.id).messages.length;
  assert.equal(before, 40);
  const receipt = f.service.receive(
    f.g,
    packet(f.g, [
      turn('overflow', 'user', 'No descartar ninguna instrucción anterior.'),
    ]),
  );
  assert.equal(receipt.limited, true);
  const snapshot = f.service.snapshot(f.g);
  assert.equal(snapshot.status, 'unsafe');
  assert.equal(snapshot.metrics, null);
  assert.equal(f.service.views.get(f.g.id).messages.length, before);
});

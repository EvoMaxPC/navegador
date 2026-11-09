import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EvoMemory } from '../src/memory/engine.js';
import { extractFromTurn, summarizeEpisode } from '../src/memory/extract.js';
import { buildHandoff, handoffToMarkdown, importHandoff } from '../src/memory/handoff.js';
import { MemoryStore } from '../src/memory/store.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;

function memStorage(initial = null) {
  return {
    data: initial,
    writes: 0,
    read() {
      return this.data;
    },
    write(value) {
      this.data = value;
      this.writes += 1;
    },
  };
}

function makeEngine(extra = {}) {
  return new EvoMemory({ now: clock, projectId: 'p1', projectName: 'Proyecto 1', ...extra });
}

/* ------------------------------------------------------------------ */
/* extracción                                                          */
/* ------------------------------------------------------------------ */

test('captura decisiones, restricciones, pendientes y problemas', () => {
  const cases = [
    ['Decidimos usar PostgreSQL 16 para la base de datos.', 'decision'],
    ['No podemos detener el servicio más de 5 minutos.', 'constraint'],
    ['Queda pendiente validar el paquete de continuidad.', 'task'],
    ['El error que vimos fue una excepción de clave duplicada.', 'issue'],
    ['El objetivo es reducir el gasto en tokens un 40 %.', 'goal'],
    ['Prefiero respuestas cortas con ejemplos concretos.', 'preference'],
  ];
  for (const [text, expected] of cases) {
    const [item] = extractFromTurn({ role: 'user', content: text }, { projectId: 'p1' });
    assert.ok(item, `no extrajo nada de: ${text}`);
    assert.equal(item.kind, expected, `«${text}» se clasificó como ${item.kind}`);
    assert.ok(item.reason.length > 0, 'cada memoria debe explicar por qué existe');
  }
});

test('las preguntas del usuario quedan como hilos abiertos', () => {
  const items = extractFromTurn(
    { role: 'user', content: '¿Cómo medimos el ahorro real de tokens en una conversación larga?' },
    { projectId: 'p1' },
  );
  assert.equal(items[0].kind, 'question');
});

test('los bloques de código se guardan como artefactos', () => {
  const turn = {
    role: 'assistant',
    content: 'Acá está el comando:\n```bash\nnpm run migrate -- --dry-run\n```\nEso valida antes de aplicar.',
  };
  const items = extractFromTurn(turn, { projectId: 'p1' });
  const artifact = items.find((item) => item.kind === 'artifact');
  assert.ok(artifact, 'debería guardar el bloque de código');
  assert.match(artifact.text, /npm run migrate/);
});

test('descarta saludos y muletillas de modelo', () => {
  assert.deepEqual(extractFromTurn({ role: 'user', content: 'Hola' }, {}), []);
  assert.deepEqual(
    extractFromTurn({ role: 'assistant', content: 'Como modelo de lenguaje no tengo acceso a esa información.' }, {}),
    [],
  );
});

test('no duplica la misma frase dentro de un turno', () => {
  const repeated = 'Decidimos usar PostgreSQL 16 para producción. Decidimos usar PostgreSQL 16 para producción.';
  const items = extractFromTurn({ role: 'user', content: repeated }, {});
  assert.equal(items.filter((item) => item.kind === 'decision').length, 1);
});

test('el resumen de episodio es corto y trazable', () => {
  const text = summarizeEpisode(
    [
      { role: 'user', content: 'Necesitamos medir el ahorro de tokens.' },
      { role: 'assistant', content: 'Podemos instrumentar la línea base.' },
    ],
    { maxChars: 200 },
  );
  assert.ok(text.length <= 200);
  assert.match(text, /usuario/);
});

/* ------------------------------------------------------------------ */
/* motor                                                               */
/* ------------------------------------------------------------------ */

test('recuerda lo importante de una conversación', () => {
  const evo = makeEngine();
  const outcome = evo.remember({ role: 'user', content: 'Decidimos usar un archivo JSON por perfil.' });
  assert.equal(outcome.created.length, 1);
  assert.equal(evo.stats().byKind.decision, 1);
  assert.equal(evo.metrics.turnsIngested, 1);
});

test('fusiona lo repetido en lugar de inflar la memoria', () => {
  const evo = makeEngine();
  evo.remember({ role: 'user', content: 'Decidimos usar un archivo JSON por perfil.' });
  const second = evo.remember({ role: 'user', content: 'Decidimos usar un archivo JSON por perfil.' });
  assert.equal(second.merged.length, 1);
  assert.equal(evo.store.size, 1);
});

test('cierra un episodio cada N turnos', () => {
  const evo = makeEngine({ episodeEvery: 4 });
  for (let i = 0; i < 4; i += 1) {
    evo.remember({ role: i % 2 ? 'assistant' : 'user', content: `Mensaje número ${i} sobre el diseño del motor de memoria.` });
  }
  assert.equal(evo.store.all({ kinds: ['episode'] }).length, 1);
  assert.equal(evo.turnsSinceEpisode, 0);
});

test('compilar el contexto refuerza las memorias usadas', () => {
  const evo = makeEngine();
  evo.remember({ role: 'user', content: 'Decidimos usar PostgreSQL 16 para producción.' });
  const before = evo.store.all()[0].uses;
  evo.compile({ query: '¿qué base de datos decidimos?', history: [], budgetTokens: 800 });
  assert.ok(evo.store.all()[0].uses > before, 'usar una memoria debe reforzarla');
});

test('compilar mide tokens inyectados y ahorrados', () => {
  const evo = makeEngine();
  evo.remember({ role: 'user', content: 'Decidimos usar PostgreSQL 16 para producción.' });
  const history = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Turno ${i}: hablamos del diseño del motor de memoria y de sus límites de tokens en producción.`,
  }));
  const compiled = evo.compile({ query: '¿qué decidimos?', history, budgetTokens: 300 });
  assert.ok(evo.metrics.tokensInjected > 0);
  assert.ok(compiled.stats.used <= 340);
  assert.ok(compiled.stats.baselineTokens > compiled.stats.used);
});

test('persiste entre sesiones', () => {
  const storage = memStorage();
  const first = makeEngine({ storage });
  first.remember({ role: 'user', content: 'Decidimos que el paquete de continuidad se exporte en texto plano.' });

  const second = makeEngine({ storage });
  assert.equal(second.store.size, 1);
  const recalled = second.recall('paquete de continuidad', { limit: 3 });
  assert.ok(recalled.length >= 1);
  assert.match(recalled[0].item.text, /paquete de continuidad/);
});

test('fijar y olvidar se reflejan en el listado del panel', () => {
  const evo = makeEngine();
  const { created } = evo.remember({ role: 'user', content: 'Prefiero las listas cortas antes que las tablas.' });
  const id = created[0].id;
  evo.pin(id, true);
  assert.equal(evo.list()[0].pinned, true);
  evo.forget(id);
  assert.equal(evo.list().length, 0);
});

test('el estado de depuración es coherente', () => {
  const evo = makeEngine();
  evo.remember({ role: 'user', content: 'Decidimos usar PostgreSQL 16 para producción.' });
  const debug = evo.debug();
  assert.equal(debug.items, 1);
  assert.ok(debug.terms > 0);
  assert.equal(debug.active, 1);
});

/* ------------------------------------------------------------------ */
/* paquete de continuidad                                              */
/* ------------------------------------------------------------------ */

test('el paquete de continuidad agrupa por tipo y se puede pegar en cualquier chat', () => {
  const evo = makeEngine();
  evo.remember({ role: 'user', content: 'El objetivo es reducir el gasto en tokens un 40 %.' });
  evo.remember({ role: 'user', content: 'Decidimos usar PostgreSQL 16 para producción.' });
  evo.remember({ role: 'user', content: 'Queda pendiente validar el paquete de continuidad.' });

  const packet = evo.handoff();
  assert.equal(packet.projectName, 'Proyecto 1');
  assert.equal(packet.counts.goal, 1);
  assert.equal(packet.counts.decision, 1);
  assert.equal(packet.counts.task, 1);
  assert.match(packet.markdown, /\[EVO MEMORY · paquete de continuidad · Proyecto 1\]/);
  assert.match(packet.markdown, /## Decisiones tomadas/);
  assert.match(packet.markdown, /PostgreSQL 16/);
});

test('el paquete se puede reimportar en otro equipo sin duplicar', () => {
  const origin = makeEngine();
  origin.remember({ role: 'user', content: 'Decidimos usar PostgreSQL 16 para producción.' });
  origin.remember({ role: 'user', content: 'Queda pendiente validar el paquete de continuidad.' });
  const packet = JSON.parse(JSON.stringify(origin.handoff()));

  const target = new EvoMemory({ now: clock, projectId: 'p1' });
  const result = target.importHandoff(packet);
  assert.equal(result.added, 2);
  assert.equal(target.store.size, 2);

  const again = target.importHandoff(packet);
  assert.equal(again.added, 0);
  assert.equal(again.merged, 2);
  assert.equal(target.store.size, 2, 'reimportar no debe duplicar');
});

test('el markdown incluye fecha de generación y aviso de verdad de referencia', () => {
  const store = new MemoryStore({ now: clock });
  store.add({ kind: 'goal', text: 'Queremos que el contexto quepa en 2000 tokens.' });
  const packet = buildHandoff({ store, projectId: 'default', now: NOW });
  const md = handoffToMarkdown(packet, 'es');
  assert.match(md, /verdad de referencia/);
  assert.match(md, /EVO MEMORY/);
  assert.match(md, /generado/i);
});

test('importar un paquete vacío no rompe nada', () => {
  const store = new MemoryStore({ now: clock });
  assert.deepEqual(importHandoff(store, null), { added: 0, merged: 0, superseded: 0 });
  assert.deepEqual(importHandoff(store, { sections: {} }), { added: 0, merged: 0, superseded: 0 });
});

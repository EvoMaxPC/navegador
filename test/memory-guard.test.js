import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConversationGuard } from '../src/core/guard.js';
import { EvoMemory } from '../src/memory/engine.js';

const SEED = [
  { role: 'user', content: 'Decidimos que el motor viva en un módulo isomorfo sin dependencias.' },
  { role: 'assistant', content: 'Así se puede probar en Node y en el navegador con el mismo código.' },
  { role: 'user', content: 'La restricción es que no podemos llamar a servicios externos.' },
  { role: 'assistant', content: 'Entonces todo el análisis tiene que ser local y determinista.' },
];

function makeMemory() {
  const memory = new EvoMemory({ projectId: 'guard-test', projectName: 'Pruebas' });
  memory.ingestConversation(SEED, { conversationId: 'c1' });
  return memory;
}

test('el guard manda el bloque EVO antes del protocolo', () => {
  const memory = makeMemory();
  const guard = new ConversationGuard({ language: 'es', memory, conversationId: 'c1' });
  guard.seedHistory(SEED);

  const report = guard.preparePrompt('¿qué decidimos sobre el motor?');
  assert.deepEqual(report.blocks.map((b) => b.id), ['memory', 'protocol']);
  assert.match(report.enhanced, /\[EVO · memoria del proyecto «Pruebas»\]/);
  assert.match(report.enhanced, /módulo isomorfo/);
  assert.match(report.enhanced, /\[\/EVO\]/, 'el bloque debe cerrarse para poder quitarlo');
});

test('el contexto llega al consumidor con estadísticas de tokens', () => {
  const memory = makeMemory();
  const guard = new ConversationGuard({ language: 'es', memory, conversationId: 'c1' });
  guard.seedHistory(SEED);
  const report = guard.preparePrompt('¿qué queda pendiente?');
  assert.equal(report.context.engine, 'evo');
  assert.ok(report.context.stats.used > 0);
  assert.ok(report.context.stats.budget > 0);
  assert.ok(report.context.retrieved.length > 0);
});

test('el turno del usuario se recuerda después de compilar, no antes', () => {
  const memory = makeMemory();
  const guard = new ConversationGuard({ language: 'es', memory, conversationId: 'c1' });
  guard.seedHistory(SEED);

  const before = memory.store.size;
  guard.preparePrompt('Decidimos usar PostgreSQL 16 para la base de producción.');
  assert.ok(memory.store.size > before, 'la decisión nueva debe entrar en memoria');
  const stored = memory.list().find((item) => /PostgreSQL 16/.test(item.text));
  assert.ok(stored, 'la decisión del usuario debe estar guardada');
  assert.equal(stored.kind, 'decision');
});

test('una pregunta del usuario no se guarda como decisión', () => {
  const memory = makeMemory();
  const guard = new ConversationGuard({ language: 'es', memory, conversationId: 'c1' });
  guard.seedHistory(SEED);
  guard.preparePrompt('¿Qué decidimos sobre el motor y qué falta para terminar?');
  const wrong = memory.list().filter((item) => item.kind === 'decision' && item.text.includes('¿'));
  assert.equal(wrong.length, 0);
});

test('la respuesta del asistente también entra en memoria al cerrar el turno', () => {
  const memory = makeMemory();
  const guard = new ConversationGuard({ language: 'es', memory, conversationId: 'c1' });
  guard.seedHistory(SEED);
  guard.preparePrompt('¿cómo seguimos?');

  const before = memory.store.size;
  guard.finalizeResponse({
    delivered: 'Queda pendiente migrar la base de datos de producción antes del viernes.',
    verdict: {},
  });
  assert.ok(memory.store.size > before, 'el pendiente del asistente debe registrarse');
  assert.ok(memory.list().some((item) => item.kind === 'task' && /migrar la base/.test(item.text)));
});

test('sin motor de memoria el guard sigue usando el plegado clásico', () => {
  const guard = new ConversationGuard({ language: 'es' });
  guard.seedHistory(SEED);
  const report = guard.preparePrompt('¿qué hacemos ahora?');
  assert.ok(!report.context, 'sin memoria no hay contexto EVO');
  assert.ok(report.blocks.some((b) => b.id === 'protocol'));
});

test('el registro de intervenciones explica lo que hizo EVO', () => {
  const memory = makeMemory();
  const guard = new ConversationGuard({ language: 'es', memory, conversationId: 'c1' });
  guard.seedHistory(SEED);
  guard.preparePrompt('¿qué decidimos?');
  const entry = guard.logbook.entries.find((e) => e.code === 'evo-recall');
  assert.ok(entry, 'debe quedar constancia de la recuperación');
  assert.match(entry.title, /EVO recuperó \d+ memorias/);
  assert.ok(Array.isArray(entry.meta.retrieved));
});

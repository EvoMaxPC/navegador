import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConversationGuard, Logbook } from '../src/core/guard.js';
import { buildContinuationPrompt } from '../src/core/protocol.js';
import { CLEAN_ANSWER, LOOPING_ANSWER, LONG_HISTORY, TRUNCATED_ANSWER } from './fixtures.js';

function streamAll(guard, text, size = 11) {
  const turn = guard.beginResponse();
  for (let i = 0; i < text.length; i += size) turn.push(text.slice(i, i + size));
  return turn.complete();
}

test('el turno completo registra intervenciones de envío y de recepción', () => {
  const guard = new ConversationGuard({});
  guard.preparePrompt('Explica los índices invertidos.');
  const done = streamAll(guard, LOOPING_ANSWER);

  const kinds = new Set(guard.logbook.entries.map((e) => e.kind));
  assert.ok(kinds.has('sending'));
  assert.ok(kinds.has('receiving'));
  assert.ok(guard.logbook.entries.some((e) => e.code === 'repeat-unit'));
  assert.ok(done.repaired.text.length > 0);
});

test('tras un bucle propone continuar donde se cortó', () => {
  const guard = new ConversationGuard({});
  const done = streamAll(guard, LOOPING_ANSWER);
  assert.equal(done.nextAction.type, 'continue');
  assert.ok(done.nextAction.prompt.includes('[Continuación automática · Nexo]'));
  assert.ok(done.nextAction.prompt.includes('bucle'));
});

test('al segundo bucle con el mismo patrón escala a reintento', () => {
  const guard = new ConversationGuard({});
  streamAll(guard, LOOPING_ANSWER);
  const done = streamAll(guard, LOOPING_ANSWER);
  assert.equal(done.nextAction.type, 'regenerate');
  assert.match(done.nextAction.prompt, /Reintento automático/);
});

test('acumula el historial con los textos mediados', () => {
  const guard = new ConversationGuard({});
  guard.preparePrompt('Primera pregunta.');
  streamAll(guard, CLEAN_ANSWER);
  guard.preparePrompt('Segunda pregunta.');
  assert.equal(guard.history.length, 3);
  assert.equal(guard.history[0].role, 'user');
  // El turno guardado es el texto real del usuario, no el inyectado.
  assert.equal(guard.history[0].content, 'Primera pregunta.');
});

test('una respuesta cortada pide continuación', () => {
  const guard = new ConversationGuard({});
  const done = streamAll(guard, TRUNCATED_ANSWER);
  assert.equal(done.nextAction.type, 'continue');
});

test('las estadísticas resumen lo ocurrido', () => {
  const guard = new ConversationGuard({});
  guard.seedHistory(LONG_HISTORY);
  guard.preparePrompt('¿Seguimos?');
  streamAll(guard, LOOPING_ANSWER);
  const stats = guard.stats();
  assert.equal(stats.turns, 1);
  assert.ok(stats.loopsSeen >= 1);
  assert.ok(stats.logbook.total > 0);
});

test('el logbook respeta el máximo de entradas y notifica', () => {
  const log = new Logbook({ maxEntries: 3 });
  const seen = [];
  log.subscribe((e) => seen.push(e.id));
  for (let i = 0; i < 5; i += 1) log.add({ title: `evento ${i}` });
  assert.equal(log.entries.length, 3);
  assert.equal(seen.length, 5);
  assert.equal(log.entries[0].title, 'evento 4');
});

test('el prompt de continuación incluye el fragmento a evitar', () => {
  const prompt = buildContinuationPrompt({
    reason: 'loop',
    lastWords: 'y la arquitectura',
    avoid: 'La arquitectura propuesta separa',
  });
  assert.ok(prompt.includes('No repitas'));
  assert.ok(prompt.includes('La arquitectura propuesta separa'));
});

test('los ajustes se pueden cambiar en caliente', () => {
  const guard = new ConversationGuard({});
  guard.setSettings({ protocol: { level: 'off' } });
  const report = guard.preparePrompt('Hola.');
  assert.equal(report.enhanced, 'Hola.');
});

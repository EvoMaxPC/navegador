import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { retrieve, inferIntent } from '../src/memory/rank.js';
import { compileContext } from '../src/memory/context.js';

const NOW = 1_700_000_000_000;
const clock = () => NOW;
const daysAgo = (n) => NOW - n * 86_400_000;

function seedStore() {
  const store = new MemoryStore({ now: clock });
  store.add({ kind: 'goal', text: 'El objetivo es que el usuario aproveche mejor los modelos que ya paga.' });
  store.add({ kind: 'decision', text: 'Decidimos que el motor viva en un módulo isomorfo sin dependencias.' });
  store.add({ kind: 'constraint', text: 'La restricción es que no podemos llamar a servicios externos.' });
  store.add({ kind: 'fact', text: 'El puerto de la base de datos de pruebas es 5432 y el endpoint vive en scripts/health.js.' });
  store.add({ kind: 'task', text: 'Queda pendiente decidir si la continuación automática la confirma el usuario.' });
  store.add({ kind: 'issue', text: 'El error que vimos fue una excepción de clave duplicada en la tabla pedidos.' });
  store.add({ kind: 'preference', text: 'Prefiero respuestas cortas con ejemplos concretos, nunca tablas enormes.' });
  return store;
}

test('recupera por coincidencia léxica directa', () => {
  const store = seedStore();
  const results = retrieve(store, { query: 'puerto base de datos', now: NOW, minScore: 0 });
  assert.equal(results[0].item.kind, 'fact');
  assert.ok(results[0].score > 0.4);
});

test('la expansión conceptual encuentra lo que la consulta no nombra', () => {
  const store = seedStore();
  const results = retrieve(store, { query: '¿qué falta para terminar?', now: NOW, minScore: 0 });
  assert.equal(results[0].item.kind, 'task');
  assert.ok(results[0].parts.lexical > 0, 'la expansión debe producir coincidencia léxica');
});

test('las anclas duras mandan cuando la consulta trae un número', () => {
  const store = seedStore();
  const results = retrieve(store, { query: '¿qué era el 5432?', now: NOW, minScore: 0 });
  assert.equal(results[0].item.kind, 'fact');
  assert.ok(results[0].parts.anchors > 0);
});

test('«qué falló» llega al problema registrado', () => {
  const store = seedStore();
  const results = retrieve(store, { query: '¿qué falló?', now: NOW, minScore: 0 });
  assert.equal(results[0].item.kind, 'issue');
});

test('devuelve algo útil incluso sin coincidencia léxica', () => {
  const store = seedStore();
  const results = retrieve(store, { query: 'zzz qqq', now: NOW, minScore: 0, limit: 5 });
  assert.ok(results.length >= 3, 'la red de seguridad por saliencia debe activarse');
});

test('nunca devuelve memorias archivadas', () => {
  const store = new MemoryStore({ now: clock });
  const first = store.add({ kind: 'constraint', text: 'No podemos detener el servicio más de 5 minutos.' });
  store.add({ kind: 'constraint', text: 'Podemos detener el servicio hasta 30 minutos.' });
  const results = retrieve(store, { query: 'detener servicio minutos', now: NOW, minScore: 0 });
  assert.ok(!results.some((r) => r.item.id === first.item.id));
});

test('aísla la recuperación por proyecto', () => {
  const store = new MemoryStore({ now: clock });
  store.add({ kind: 'decision', text: 'Decidimos usar PostgreSQL en el proyecto A.', projectId: 'A' });
  store.add({ kind: 'decision', text: 'Decidimos usar SQLite en el proyecto B.', projectId: 'B' });
  const results = retrieve(store, { query: 'decidimos base de datos', projectId: 'A', now: NOW, minScore: 0 });
  assert.ok(results.every((r) => r.item.projectId === 'A'));
});

test('MMR evita repetir la misma idea en el contexto', () => {
  const store = new MemoryStore({ now: clock });
  store.add({ kind: 'fact', text: 'El servidor de producción escucha en el puerto 8080 sobre HTTP.' });
  store.add({ kind: 'fact', text: 'El servidor de producción escucha en el puerto 8080 sobre HTTP y TLS.' });
  store.add({ kind: 'task', text: 'Queda pendiente documentar el puerto del servidor de producción.' });
  const results = retrieve(store, { query: 'puerto del servidor de producción', now: NOW, limit: 2, minScore: 0 });
  const texts = results.map((r) => r.item.text);
  assert.equal(texts.length, 2);
  const nearDuplicate = texts.filter((t) => /escucha en el puerto 8080/.test(t)).length;
  assert.equal(nearDuplicate, 1, 'no deben entrar dos versiones casi iguales');
});

test('lo que ya está en el contexto pierde prioridad', () => {
  const store = seedStore();
  const query = 'el puerto de la base de datos de pruebas es 5432';
  const withoutExclusion = retrieve(store, { query, now: NOW, minScore: 0, limit: 3 });
  const withExclusion = retrieve(store, {
    query,
    now: NOW,
    minScore: 0,
    limit: 3,
    excludeTerms: ['puerto', 'base', 'dato', 'prueba', '5432', 'endpoint', 'script', 'health'],
  });
  assert.ok(withoutExclusion[0].score > withExclusion[0].score, 'la redundancia debe penalizar');
});

test('infiere la intención de la consulta', () => {
  assert.deepEqual(inferIntent('¿qué queda pendiente?'), ['task', 'goal']);
  assert.ok(inferIntent('¿qué decidimos?').includes('decision'));
  assert.ok(inferIntent('¿cuál era el puerto?').includes('fact'));
});

/* ------------------------------------------------------------------ */
/* compilador de contexto                                              */
/* ------------------------------------------------------------------ */

const history = [
  { role: 'user', content: 'Estamos diseñando la memoria del navegador y necesitamos persistencia local sin servicios externos.' },
  { role: 'assistant', content: 'Conviene un índice invertido propio con BM25 y expansión conceptual determinista.' },
  { role: 'user', content: 'Decidimos usar un archivo JSON por perfil para no depender de ninguna base de datos.' },
  { role: 'assistant', content: 'Ese diseño permite exportar el paquete de continuidad como texto plano.' },
  { role: 'user', content: 'Queda pendiente medir cuántos tokens ahorra el compresor de contexto en una charla larga.' },
  { role: 'assistant', content: 'Se puede instrumentar con la línea base de pegar todo el historial.' },
];

test('el contexto respeta el presupuesto de tokens', () => {
  const store = seedStore();
  const compiled = compileContext({ store, query: '¿qué falta?', history, budgetTokens: 400, now: NOW });
  assert.ok(compiled.stats.used <= 400 + 40, `usó ${compiled.stats.used} tokens`);
  assert.ok(compiled.payload.length > 0);
});

test('el contexto incluye el estado del proyecto y lo recuperado', () => {
  const store = seedStore();
  const compiled = compileContext({ store, query: '¿qué falta para terminar?', history, budgetTokens: 1200, now: NOW });
  assert.match(compiled.payload, /Estado del proyecto/);
  assert.match(compiled.payload, /Pendientes:/);
  assert.match(compiled.payload, /[Ee]l objetivo es que el usuario/);
});

test('las memorias fijadas viajan siempre', () => {
  const store = seedStore();
  const pinned = store.add({ kind: 'preference', text: 'Nunca usar tablas: siempre listas cortas con ejemplos.', pinned: true });
  const compiled = compileContext({ store, query: 'cualquier cosa', history: [], budgetTokens: 600, now: NOW });
  assert.ok(compiled.payload.includes('Nunca usar tablas'));
  assert.ok(compiled.memoryIds.includes(pinned.item.id));
});

test('el historial reciente se mantiene literal', () => {
  const store = seedStore();
  const compiled = compileContext({ store, query: 'seguimos', history, budgetTokens: 3000, now: NOW });
  assert.equal(compiled.stats.workingTurns, history.length);
  assert.equal(compiled.stats.foldedTurns, 0);
  assert.ok(compiled.working.length === history.length);
});

test('con presupuesto chico pliega los turnos viejos en vez de perderlos', () => {
  const store = seedStore();
  const compiled = compileContext({ store, query: 'seguimos', history, budgetTokens: 220, now: NOW });
  assert.ok(compiled.stats.foldedTurns > 0);
  assert.ok(compiled.stats.workingTurns < history.length);
  assert.match(compiled.payload, /Turnos anteriores/);
});

test('las estadísticas de ahorro son honestas', () => {
  const store = seedStore();
  const compiled = compileContext({ store, query: '¿qué falta?', history, budgetTokens: 400, now: NOW });
  assert.ok(compiled.stats.baselineTokens > 0);
  assert.ok(compiled.stats.savedPct >= 0);
  assert.ok(compiled.stats.compression >= 0);
  assert.equal(
    compiled.stats.savedTokens,
    Math.max(0, compiled.stats.baselineTokens - compiled.stats.used),
  );
});

test('el encabezado identifica el proyecto', () => {
  const store = seedStore();
  const compiled = compileContext({
    store,
    query: 'hola',
    history: [],
    budgetTokens: 800,
    now: NOW,
    projectName: 'Navegador Nexo',
  });
  assert.match(compiled.payload, /EVO · memoria del proyecto «Navegador Nexo»/);
});

test('sin memoria el compilador no inventa bloques', () => {
  const store = new MemoryStore({ now: clock });
  const compiled = compileContext({ store, query: 'hola', history: [], budgetTokens: 500, now: NOW });
  assert.equal(compiled.blocks.length, 0);
  assert.equal(compiled.payload, '');
});

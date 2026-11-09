import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { isActive } from '../src/memory/item.js';

function memoryStorage(initial = null) {
  return {
    data: initial,
    read() {
      return this.data;
    },
    write(value) {
      this.data = value;
      this.writes = (this.writes || 0) + 1;
    },
  };
}

const NOW = 1_700_000_000_000;
const clock = () => NOW;

test('guarda una memoria con derivados calculados', () => {
  const store = new MemoryStore({ now: clock });
  const { item, action } = store.add({ kind: 'decision', text: 'Decidimos usar PostgreSQL 16 para producción.' });
  assert.equal(action, 'created');
  assert.equal(item.kind, 'decision');
  assert.ok(item.terms.includes('postgresql'));
  assert.ok(item.tokens > 0);
  assert.equal(store.size, 1);
  assert.equal(store.activeCount, 1);
});

test('fusiona duplicados en lugar de acumularlos', () => {
  const store = new MemoryStore({ now: clock });
  store.add({ kind: 'decision', text: 'Decidimos usar PostgreSQL 16 para producción.' });
  const second = store.add({ kind: 'decision', text: 'Decidimos usar PostgreSQL 16 para producción.' });
  assert.equal(second.action, 'merged');
  assert.equal(store.size, 1);
  assert.equal(store.get(second.item.id).merged, 1);
});

test('descarta textos demasiado cortos', () => {
  const store = new MemoryStore({ now: clock });
  const result = store.add({ kind: 'fact', text: 'ok' });
  assert.equal(result.action, 'ignored');
  assert.equal(store.size, 0);
});

test('una contradicción archiva la memoria vieja pero la conserva', () => {
  const store = new MemoryStore({ now: clock });
  const first = store.add({ kind: 'constraint', text: 'No podemos detener el servicio más de 5 minutos.' });
  const second = store.add({ kind: 'constraint', text: 'Podemos detener el servicio hasta 30 minutos.' });
  assert.equal(second.action, 'superseded');
  assert.equal(isActive(store.get(first.item.id)), false);
  assert.equal(store.activeCount, 1);
  assert.equal(store.all({ includeSuperseded: true }).length, 2);
});

test('no archiva dos memorias del mismo tipo que no se contradicen', () => {
  const store = new MemoryStore({ now: clock });
  const a = store.add({ kind: 'fact', text: 'El puerto de la base de pruebas es 5432.' });
  const b = store.add({ kind: 'fact', text: 'El puerto del entorno de staging es 6543.' });
  assert.equal(a.action, 'created');
  assert.equal(b.action, 'created');
  assert.equal(store.activeCount, 2);
});

test('el índice invertido devuelve candidatos por término', () => {
  const store = new MemoryStore({ now: clock });
  store.add({ kind: 'fact', text: 'El puerto de la base de datos es 5432.' });
  store.add({ kind: 'decision', text: 'Decidimos usar pg_dump para la migración.' });
  const ids = store.candidates(['puerto']);
  assert.equal(ids.size, 1);
  assert.ok(store.documentFrequency('puerto') === 1);
  assert.ok(store.averageLength > 0);
});

test('olvidar limpia el índice y las huellas', () => {
  const store = new MemoryStore({ now: clock });
  const { item } = store.add({ kind: 'fact', text: 'El puerto de la base de datos es 5432.' });
  assert.equal(store.forget(item.id), true);
  assert.equal(store.size, 0);
  assert.equal(store.candidates(['puerto']).size, 0);
  assert.equal(store.documentFrequency('puerto'), 0);
});

test('persiste y reconstruye el índice al cargar', () => {
  const storage = memoryStorage();
  const a = new MemoryStore({ storage, now: clock });
  a.add({ kind: 'goal', text: 'Queremos reducir el consumo de tokens a la mitad.' });
  a.add({ kind: 'task', text: 'Queda pendiente validar el paquete de continuidad.' });
  assert.ok(a.save());
  assert.ok(storage.data.includes('paquete de continuidad'));

  const b = new MemoryStore({ storage, now: clock });
  b.load();
  assert.equal(b.size, 2);
  assert.equal(b.candidates(['token']).size, 1, 'el índice debe reconstruirse');
  assert.ok(b.get(b.all()[0].id).terms.length > 0);
});

test('un archivo corrupto no rompe la carga', () => {
  const storage = memoryStorage('{ esto no es json');
  const store = new MemoryStore({ storage, now: clock });
  store.load();
  assert.equal(store.size, 0);
});

test('respeta el límite olvidando lo menos saliente', () => {
  const store = new MemoryStore({ now: clock, maxItems: 3 });
  store.add({ kind: 'decision', text: 'Decidimos usar el motor isomorfo sin dependencias externas.' });
  for (let i = 0; i < 6; i += 1) {
    store.add({ kind: 'fact', text: `El valor de la variable secundaria número ${i} es ${1000 + i}.` });
  }
  assert.ok(store.size <= 3);
  assert.ok(store.all().some((item) => item.kind === 'decision'), 'las decisiones no se descartan');
});

test('fijar una memoria sube su peso', () => {
  const store = new MemoryStore({ now: clock });
  const { item } = store.add({ kind: 'fact', text: 'El puerto de la base de datos es 5432.' });
  const before = item.importance;
  store.pin(item.id, true);
  assert.ok(store.get(item.id).importance > before);
  assert.equal(store.get(item.id).pinned, true);
});

test('las estadísticas resumen el contenido', () => {
  const store = new MemoryStore({ now: clock });
  store.add({ kind: 'goal', text: 'Queremos que el contexto no supere los 2000 tokens.' });
  store.add({ kind: 'task', text: 'Queda pendiente medir el ahorro real por conversación.' });
  const stats = store.stats(NOW);
  assert.equal(stats.total, 2);
  assert.equal(stats.active, 2);
  assert.equal(stats.byKind.goal, 1);
  assert.ok(stats.tokens > 0);
  assert.equal(stats.top.length, 2);
});

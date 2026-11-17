/**
 * Importar una memoria pegada desde el panel.
 *
 * El botón «Importar» arma `{ markdown, items }` (`src/ui/shell/app.js:1209`) y
 * manda eso al proceso principal (`:1212` → `main.js:1896` → `engine.memoryImport`
 * → `memory/engine.js:192` → `handoff.js:116`). El importador leía sólo
 * `packet.sections`, así que ese paquete importaba cero.
 *
 * Acá se ejerce el camino real con las dos formas: el paquete de la UI (`items`)
 * y el paquete completo (`sections`), que no debe cambiar de comportamiento.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EvoMemory } from '../src/memory/engine.js';
import { importHandoff, kindDeItem } from '../src/memory/handoff.js';

/** Réplica literal del parser del panel (`src/ui/shell/app.js:1228-1242`). */
function parsePacketText(raw) {
  const items = [];
  let kind = 'fact';
  const map = { 'Decisiones tomadas': 'decision', 'Restricciones': 'constraint', 'Objetivos': 'goal', 'Pendientes': 'task', 'Problemas abiertos': 'issue', 'Datos y referencias': 'fact' };
  for (const line of raw.split('\n')) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      kind = map[heading[1].trim()] || 'fact';
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) items.push({ kind, text: bullet[1].trim() });
  }
  return items;
}

const memoriaNueva = () => new EvoMemory({ storage: null });

const MARKDOWN = [
  '# Paquete de continuidad',
  '',
  '## Decisiones tomadas',
  '- Usar ESM en todo el proyecto.',
  '- Las pruebas van con node --test.',
  '',
  '## Pendientes',
  '- Revisar el registro de pruebas.',
  '',
  '## Encabezado que el panel no conoce',
  '- Un dato suelto que no tiene sección propia.',
  '',
  '- Una viñeta antes de cualquier encabezado.',
].join('\n');

test('la forma que arma la UI importa de verdad', () => {
  const packet = { markdown: MARKDOWN, items: parsePacketText(MARKDOWN) };
  const mem = memoriaNueva();
  const resultado = mem.importHandoff(packet);
  assert.deepEqual(resultado, { added: 5, merged: 0, superseded: 0, ignored: 0 });
  const kinds = mem.store.all().map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['decision', 'decision', 'fact', 'fact', 'task'], 'kind por encabezado, y fact sin sección');
});

test('un encabezado desconocido y una viñeta sin encabezado caen en fact', () => {
  const mem = memoriaNueva();
  const items = [
    { kind: 'Decisiones tomadas', text: 'Se usa ESM en todo el proyecto.' },
    { kind: 'Sección inventada', text: 'Lo que no se reconoce se guarda como dato.' },
    { kind: 'fact', text: 'Una viñeta suelta también es un dato.' },
  ];
  const resultado = mem.importHandoff({ markdown: '', items });
  assert.equal(resultado.added, 3);
  assert.deepEqual(mem.store.all().map((item) => item.kind).sort(), ['decision', 'fact', 'fact']);
});

test('los items con texto vacío se ignoran', () => {
  const mem = memoriaNueva();
  const resultado = mem.importHandoff({
    items: [
      { kind: 'decision', text: '   ' },
      { kind: 'decision', text: '' },
      { kind: 'decision' },
      { kind: 'decision', text: 'Este sí entra en la memoria.' },
    ],
  });
  assert.deepEqual(resultado, { added: 1, merged: 0, superseded: 0, ignored: 0 });
});

test('un paquete con sections no cambia de comportamiento', () => {
  const paquete = {
    version: 1,
    generator: 'EVO MEMORY',
    projectId: 'default',
    sections: {
      goal: [{ text: 'Cerrar la etapa con pruebas verdes.' }],
      decision: [{ text: 'Las pruebas van con node --test.' }],
      task: [{ text: 'Revisar el registro de pruebas.' }],
    },
  };
  const mem = memoriaNueva();
  const resultado = mem.importHandoff(paquete);
  assert.deepEqual(resultado, { added: 3, merged: 0, superseded: 0, ignored: 0 });
  assert.deepEqual([...new Set(mem.store.all().map((item) => item.kind))].sort(), ['decision', 'goal', 'task']);
});

test('dos importaciones seguidas del mismo paquete no duplican: la segunda fusiona', () => {
  const packet = { markdown: MARKDOWN, items: parsePacketText(MARKDOWN) };
  const mem = memoriaNueva();
  const primera = mem.importHandoff(packet);
  const tras1 = mem.store.all().length;
  const segunda = mem.importHandoff(packet);
  const tras2 = mem.store.all().length;
  // Conteos medidos, no supuestos: `store.add` ya fusiona duplicados.
  assert.deepEqual(primera, { added: 5, merged: 0, superseded: 0, ignored: 0 });
  assert.deepEqual(segunda, { added: 0, merged: 5, superseded: 0, ignored: 0 });
  assert.equal(tras1, 5);
  assert.equal(tras2, 5, 'la segunda vuelta no crea memorias nuevas');
});

test('el kind de un item: válido tal cual, prefijo normalizado, desconocido a fact', () => {
  assert.equal(kindDeItem('decision'), 'decision');
  assert.equal(kindDeItem('DECISIÓN'), 'decision');
  assert.equal(kindDeItem('Decisiones tomadas'), 'decision');
  assert.equal(kindDeItem('Tarea pendiente'), 'task');
  assert.equal(kindDeItem('Restricción'), 'constraint');
  assert.equal(kindDeItem('Preferencias de trabajo'), 'preference');
  assert.equal(kindDeItem('Objetivo'), 'goal');
  assert.equal(kindDeItem('Problemas abiertos'), 'issue');
  assert.equal(kindDeItem('Pregunta abierta'), 'question');
  assert.equal(kindDeItem('Artefacto: comando'), 'artifact');
  assert.equal(kindDeItem('entidad'), 'fact');
  assert.equal(kindDeItem(''), 'fact');
  assert.equal(kindDeItem(undefined), 'fact');
});

test('ida y vuelta: el markdown de handoff() se puede volver a importar', () => {
  const origen = memoriaNueva();
  origen.importHandoff({
    sections: {
      decision: [{ text: 'Decisión de ida y vuelta con texto suficiente.' }],
      task: [{ text: 'Pendiente de ida y vuelta con texto suficiente.' }],
    },
  });
  const paquete = origen.handoff();
  assert.ok(Array.isArray(parsePacketText(paquete.markdown)) && parsePacketText(paquete.markdown).length === 2,
    'el parser del panel lee el markdown que exporta handoff()');

  const destino = memoriaNueva();
  const resultado = destino.importHandoff({ markdown: paquete.markdown, items: parsePacketText(paquete.markdown) });
  assert.deepEqual(resultado, { added: 2, merged: 0, superseded: 0, ignored: 0 });
  assert.deepEqual(destino.store.all().map((item) => item.text).sort(),
    origen.store.all().map((item) => item.text).sort(), 'los mismos textos vuelven');
});

test('importHandoff directo también acepta items', () => {
  const store = { agregados: [], add(item) { this.agregados.push(item); return { action: 'created' }; } };
  const resultado = importHandoff(store, { items: [{ kind: 'decision', text: 'Texto de prueba con longitud.' }] });
  assert.deepEqual(resultado, { added: 1, merged: 0, superseded: 0, ignored: 0 });
  assert.deepEqual(store.agregados.map((item) => item.kind), ['decision']);
});

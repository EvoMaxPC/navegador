import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StreamSentinel } from '../src/core/streamSentinel.js';
import {
  chunk,
  CLEAN_ANSWER,
  LINE_LOOP_ANSWER,
  LOOPING_ANSWER,
  STUTTER_ANSWER,
} from './fixtures.js';

function runStream(text, opts = {}, size = 11) {
  const sentinel = new StreamSentinel({
    settings: {
      receiving: { severityThreshold: 'medium', stopOnLoop: true, ...(opts.receiving || {}) },
    },
    ...opts,
  });
  let out = '';
  for (const delta of chunk(text, size)) out += sentinel.push(delta).emit;
  const verdict = sentinel.finish();
  out += verdict.emit; // lo retenido en el búfer de salida
  return { out, verdict, sentinel };
}

test('entrega completa una respuesta limpia sin intervenir', () => {
  const { out, verdict } = runStream(CLEAN_ANSWER);
  assert.equal(out, CLEAN_ANSWER);
  assert.equal(verdict.stopped, false);
  assert.equal(verdict.interventions.filter((e) => e.type === 'loop').length, 0);
});

test('corta el bucle de párrafos antes de que llegue a pantalla', () => {
  const { out, verdict } = runStream(LOOPING_ANSWER);
  assert.equal(verdict.stopped, true);
  assert.ok(out.length < LOOPING_ANSWER.length, 'debe entregar menos texto que el original');

  // La parte entregada no contiene el párrafo repetido dos veces.
  const flat = out.replace(/\s+/g, ' ');
  const occurrences = (flat.match(/La arquitectura propuesta/g) || []).length;
  assert.ok(occurrences <= 1, `el párrafo repetido apareció ${occurrences} veces`);

  const loopEvent = verdict.interventions.find((e) => e.type === 'loop');
  assert.ok(loopEvent, 'debería registrar la intervención');
  assert.equal(loopEvent.kind, 'receiving');
  assert.ok(loopEvent.droppedChars > 0);
});

test('detiene el tartamudeo de tokens', () => {
  const { out, verdict } = runStream(STUTTER_ANSWER, {}, 5);
  assert.equal(verdict.stopped, true);
  assert.ok(!/la la la la la la/.test(out), 'no debe mostrar la repetición');
  assert.ok(out.includes('validación del formulario'));
});

test('detiene listas que se reescriben', () => {
  const { verdict } = runStream(LINE_LOOP_ANSWER, {}, 9);
  assert.equal(verdict.stopped, true);
  assert.ok(['line-loop', 'repeat-unit', 'repeat-tokens'].includes(verdict.stopReason));
});

test('un corte no pierde el comienzo de la respuesta', () => {
  const { out } = runStream(LOOPING_ANSWER);
  assert.ok(out.startsWith('## Estrategia de reintentos'));
  assert.ok(out.includes('El límite de intentos debe ser finito'));
});

test('marca truncamiento cuando el stream termina a mitad de frase', () => {
  const truncated = 'Para configurar el proxy necesitas tres datos: el host, el puerto y el certificado. Primero';
  const { verdict } = runStream(truncated);
  assert.equal(verdict.truncated, true);
  assert.ok(verdict.interventions.some((e) => e.type === 'truncation'));
});

test('con umbral alto solo avisa y no corta', () => {
  const { verdict, out } = runStream(LOOPING_ANSWER, { receiving: { severityThreshold: 'high' } });
  // El bucle de párrafos es de severidad media: con umbral alto no se corta.
  assert.equal(verdict.stopReason, null);
  assert.ok(out.length > 0);
  assert.ok(verdict.interventions.some((e) => e.type === 'warning'));
});

test('stopOnLoop=false deja pasar el texto pero registra el aviso', () => {
  const { verdict, out } = runStream(LOOPING_ANSWER, { receiving: { stopOnLoop: false } });
  assert.equal(verdict.stopped, false);
  assert.equal(out, LOOPING_ANSWER);
  assert.ok(verdict.interventions.some((e) => e.type === 'warning'));
});

test('el delta que dispara el corte se recorta en el punto exacto', () => {
  const sentinel = new StreamSentinel({ settings: { receiving: { severityThreshold: 'medium' } } });
  // Un único delta gigante que ya contiene la repetición entera.
  const { emit } = sentinel.push(LOOPING_ANSWER);
  assert.ok(emit.length < LOOPING_ANSWER.length);
  assert.ok(!emit.includes('La arquitectura propuesta\n\nLa arquitectura propuesta'));
});

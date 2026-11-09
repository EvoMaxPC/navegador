import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anchors,
  cosine,
  expandQueryTerms,
  indexTerms,
  isNegated,
  normalizeTerm,
  stem,
  termFreq,
  termJaccard,
  tfidfVector,
} from '../src/memory/lexicon.js';

test('normaliza acentos y mayúsculas', () => {
  assert.equal(normalizeTerm('Migración'), 'migracion');
  assert.equal(normalizeTerm('¿Qué?'), 'que');
});

test('el stemmer colapsa flexiones sin destruir palabras cortas', () => {
  assert.equal(stem('migracion'), 'migr');
  assert.equal(stem('restauracion'), 'restaur');
  assert.equal(stem('decidimos'), 'decidimo');
  assert.equal(stem('error'), 'error');
  assert.equal(stem('mes'), 'mes');
});

test('«comando» no se convierte en «com»', () => {
  assert.equal(stem('comando'), 'comando');
});

test('los términos descartan palabras vacías y se indexan sin acentos', () => {
  const terms = indexTerms('El puerto de la base de datos es 5432 y está en producción');
  assert.deepEqual(terms, ['puerto', 'base', 'dato', '5432', 'produccion']);
});

test('la expansión conceptual une «falta» con «pendiente»', () => {
  const weights = expandQueryTerms(indexTerms('¿qué falta?'));
  assert.equal(weights.get('falta'), 1);
  assert.ok(weights.get('pendiente') > 0 && weights.get('pendiente') < 1);
});

test('la expansión no inventa relaciones lejanas', () => {
  const weights = expandQueryTerms(indexTerms('migración de base de datos'));
  assert.equal(weights.get('migr'), 1);
  assert.ok(!weights.has('bucle'));
});

test('extrae anclas duras: números, rutas, urls y versiones', () => {
  const found = anchors('El puerto 5432 está en scripts/health.js, versión v2.1 y en https://api.local/health');
  assert.ok(found.includes('5432'));
  assert.ok(found.includes('scripts/health.js'));
  assert.ok(found.includes('https://api.local/health'));
  assert.ok(found.some((a) => /v2\.1/i.test(a)));
});

test('tf, coseno y jaccard se comportan como se espera', () => {
  const a = ['base', 'datos', 'puerto'];
  const b = ['base', 'datos'];
  const idfOf = () => 1;
  assert.equal(termFreq(a).get('datos'), 1);
  assert.ok(cosine(tfidfVector(a, idfOf), tfidfVector(b, idfOf)) > 0.5);
  assert.equal(Number(termJaccard(a, b).toFixed(3)), 0.667);
  assert.equal(termJaccard(a, []), 0);
});

test('detecta negación', () => {
  assert.equal(isNegated('no podemos usar servicios externos'), true);
  assert.equal(isNegated('podemos usar servicios externos'), false);
});

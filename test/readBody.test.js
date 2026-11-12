import test from 'node:test';
import assert from 'node:assert/strict';
import { readBody, MAX_BODY } from '../src/core/readBody.js';

test('string', async () => {
  assert.deepEqual(await readBody('x', { body: '{"a":1}' }), { text: '{"a":1}', reason: null });
});

test('Blob y ArrayBuffer', async () => {
  assert.equal((await readBody('x', { body: new Blob(['hola']) })).text, 'hola');
  assert.equal((await readBody('x', { body: new TextEncoder().encode('hola') })).text, 'hola');
});

test('Request sin init.body: lee un clon y el original sigue intacto', async () => {
  const req = new Request('https://e.test/', { method: 'POST', body: 'hola' });
  assert.equal((await readBody(req, undefined)).text, 'hola');
  assert.equal(req.bodyUsed, false);
  assert.equal(await req.text(), 'hola');
});

test('Request con body ya consumido', async () => {
  const req = new Request('https://e.test/', { method: 'POST', body: 'hola' });
  await req.text();
  assert.deepEqual(await readBody(req, undefined), { text: null, reason: 'stream-o-desconocido' });
});

test('formulario', async () => {
  assert.equal((await readBody('x', { body: new URLSearchParams({ a: '1' }) })).reason, 'formulario');
  const fd = new FormData(); fd.append('a', '1');
  assert.equal((await readBody('x', { body: fd })).reason, 'formulario');
});

test('sin cuerpo', async () => {
  assert.equal((await readBody('x', {})).reason, 'sin-cuerpo');
  assert.equal((await readBody('x', undefined)).reason, 'sin-cuerpo');
  assert.equal((await readBody('x', { body: null })).reason, 'sin-cuerpo');
});

test('stream: no se toca', async () => {
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
  assert.equal((await readBody('x', { body: stream })).reason, 'stream-o-desconocido');
});

test('demasiado grande', async () => {
  assert.equal((await readBody('x', { body: 'a'.repeat(MAX_BODY + 1) })).reason, 'demasiado-grande');
});

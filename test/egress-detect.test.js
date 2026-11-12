import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSensitive } from '../src/egress/detect.js';

const tipos = (t) => detectSensitive(t).map((f) => f.type);

test('tarjeta válida por Luhn, con y sin separadores', () => {
  assert.deepEqual(tipos('pago 4111 1111 1111 1111 ok'), ['card']);
  assert.deepEqual(tipos('4111-1111-1111-1111'), ['card']);
  assert.deepEqual(tipos('4111111111111111'), ['card']);
  assert.deepEqual(tipos('5500 0000 0000 0004'), ['card']);
});

test('no es tarjeta: Luhn inválido, 13 dígitos, primer dígito 1, demasiado larga', () => {
  assert.deepEqual(tipos('4111 1111 1111 1112'), []);
  assert.deepEqual(tipos('1700000000000'), []);
  assert.deepEqual(tipos('1111111111111117'), []);
  assert.deepEqual(tipos('4'.repeat(25)), []);
});

test('claves de API', () => {
  assert.deepEqual(tipos(`k=sk-${'a'.repeat(30)}`), ['api_key']);
  assert.deepEqual(tipos(`AKIA${'A'.repeat(16)}`), ['api_key']);
  assert.deepEqual(tipos(`ghp_${'a'.repeat(36)}`), ['api_key']);
  assert.deepEqual(tipos('-----BEGIN RSA PRIVATE KEY-----'), ['api_key']);
});

test('no son claves: prefijo a mitad de palabra o demasiado corto', () => {
  assert.deepEqual(tipos(`task-${'a'.repeat(30)}`), []);
  assert.deepEqual(tipos('sk-corto'), []);
});

test('email', () => {
  assert.deepEqual(tipos('escribe a ana.perez+x@example.com ya'), ['email']);
  assert.deepEqual(tipos('a@b'), []);
  assert.deepEqual(tipos('@usuario'), []);
});

test('DNI y NIE con letra de control válida', () => {
  assert.deepEqual(tipos('12345678Z'), ['dni_es']);
  assert.deepEqual(tipos('12345678-Z'), ['dni_es']);
  assert.deepEqual(tipos('X1234567L'), ['dni_es']);
  assert.deepEqual(tipos('12345678A'), []);
  assert.deepEqual(tipos('123456789Z'), []);
});

test('posiciones exactas y gravedad', () => {
  const t = 'hola 12345678Z fin';
  const [f] = detectSensitive(t);
  assert.equal(t.slice(f.start, f.end), '12345678Z');
  assert.equal(f.severity, 'medium');
  assert.equal(detectSensitive('4111 1111 1111 1111')[0].severity, 'critical');
});

test('el hallazgo no contiene el valor', () => {
  const [f] = detectSensitive('4111 1111 1111 1111');
  assert.deepEqual(Object.keys(f).sort(), ['end', 'severity', 'start', 'type']);
});

test('varios hallazgos: ordenados y sin solapes', () => {
  const t = 'a@example.com y 4111 1111 1111 1111 y 12345678Z';
  const fs = detectSensitive(t);
  assert.deepEqual(fs.map((f) => f.type), ['email', 'card', 'dni_es']);
  for (let i = 1; i < fs.length; i += 1) assert.ok(fs[i].start >= fs[i - 1].end);
});

test('entradas no válidas', () => {
  for (const v of [undefined, null, 42, '', {}, []]) assert.deepEqual(detectSensitive(v), []);
});

test('textos grandes en tiempo lineal', () => {
  const casos = ['a'.repeat(1_000_000), '4'.repeat(1_000_000), 'a.'.repeat(500_000), `sk-${'a'.repeat(1_000_000)}`];
  for (const c of casos) {
    const t0 = performance.now();
    detectSensitive(c);
    assert.ok(performance.now() - t0 < 2000, 'demasiado lento');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFailure } from '../scripts/download-diagnostic.mjs';

test('un fallo TLS dentro de fetch se diagnostica como certificado, no como código roto', () => {
  const cause = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  assert.equal(downloadFailure(new TypeError('fetch failed', { cause })), 'tls');
  assert.equal(downloadFailure(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })), 'tls');
});

test('se reconoce el fallo de red anidado de fetch', () => {
  const cause = Object.assign(new Error('socket'), { code: 'ECONNRESET' });
  assert.equal(downloadFailure(new TypeError('fetch failed', { cause })), 'network');
  assert.equal(downloadFailure(new Error('getaddrinfo ENOTFOUND github.com')), 'network');
});

test('los errores de empaquetado no se disfrazan de errores de descarga', () => {
  assert.equal(downloadFailure(new Error('invalid PE executable')), null);
});

test('una cadena circular de causas no bloquea el diagnóstico', () => {
  const error = new Error('otro error');
  error.cause = error;
  assert.equal(downloadFailure(error), null);
});

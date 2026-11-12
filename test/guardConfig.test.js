import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGuard, GUARD_DEFAULTS } from '../src/core/guardConfig.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings.js';

test('entradas no válidas devuelven los valores por defecto', () => {
  for (const raw of [undefined, null, [], 'enforce', 42, true]) {
    assert.deepEqual(normalizeGuard(raw), { ...GUARD_DEFAULTS });
  }
});

test('valores válidos se conservan', () => {
  const cfg = { mode: 'enforce', onUnreadable: 'block', decisionTimeoutMs: 30_000, allowSendCritical: true };
  assert.deepEqual(normalizeGuard(cfg), cfg);
});

test('mode inválido cae al valor por defecto, sin coerción', () => {
  for (const mode of ['ENFORCE', 'observe ', '', 'on', 1, null, {}]) {
    assert.equal(normalizeGuard({ mode }).mode, GUARD_DEFAULTS.mode);
  }
});

test('decisionTimeoutMs: solo números finitos, acotados y redondeados', () => {
  assert.equal(normalizeGuard({ decisionTimeoutMs: 1 }).decisionTimeoutMs, 5_000);
  assert.equal(normalizeGuard({ decisionTimeoutMs: 1e9 }).decisionTimeoutMs, 600_000);
  assert.equal(normalizeGuard({ decisionTimeoutMs: 12345.6 }).decisionTimeoutMs, 12_346);
  for (const t of ['120000', null, NaN, Infinity, undefined, {}]) {
    assert.equal(normalizeGuard({ decisionTimeoutMs: t }).decisionTimeoutMs, GUARD_DEFAULTS.decisionTimeoutMs);
  }
});

test('allowSendCritical solo con true estricto; onUnreadable solo "block" bloquea', () => {
  for (const v of ['true', 1, 'yes', null]) assert.equal(normalizeGuard({ allowSendCritical: v }).allowSendCritical, false);
  assert.equal(normalizeGuard({ onUnreadable: 'BLOCK' }).onUnreadable, 'pass');
});

test('ignora claves desconocidas y no muta la entrada', () => {
  const raw = Object.freeze({ mode: 'observe', extra: 1 });
  const out = normalizeGuard(raw);
  assert.equal('extra' in out, false);
  assert.equal(out.mode, 'observe');
});

test('DEFAULT_SETTINGS.guard coincide con GUARD_DEFAULTS y es punto fijo de normalizeGuard', () => {
  assert.deepEqual(DEFAULT_SETTINGS.guard, { ...GUARD_DEFAULTS });
  assert.deepEqual(normalizeGuard(DEFAULT_SETTINGS.guard), DEFAULT_SETTINGS.guard);
});

test('mergeSettings: un parche parcial de guard conserva el resto y no muta los defaults', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, { guard: { mode: 'enforce' } });
  assert.deepEqual(merged.guard, { ...GUARD_DEFAULTS, mode: 'enforce' });
  assert.deepEqual(merged.memory, DEFAULT_SETTINGS.memory);
  assert.equal(DEFAULT_SETTINGS.guard.mode, 'off');
});

// settingsForHost está exportada y conserva el bloque `guard` tal cual
// (verificado ejecutando antes de incluirlo). Ver R4 del informe.
test('settingsForHost conserva el bloque guard', async () => {
  const { settingsForHost } = await import('../src/core/settings.js');
  const out = settingsForHost(DEFAULT_SETTINGS, 'chatgpt.com');
  assert.ok('guard' in out);
  assert.deepEqual(out.guard, DEFAULT_SETTINGS.guard);
});

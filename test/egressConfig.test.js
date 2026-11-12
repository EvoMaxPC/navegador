import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEgress, EGRESS_DEFAULTS } from '../src/core/egressConfig.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings.js';

test('entradas no válidas devuelven los valores por defecto', () => {
  for (const raw of [undefined, null, [], 'enforce', 42, true]) {
    assert.deepEqual(normalizeEgress(raw), { ...EGRESS_DEFAULTS });
  }
});

test('valores válidos se conservan', () => {
  const cfg = { mode: 'enforce', onUnreadable: 'block', decisionTimeoutMs: 30_000, allowSendCritical: true };
  assert.deepEqual(normalizeEgress(cfg), cfg);
});

test('mode inválido cae al valor por defecto, sin coerción', () => {
  for (const mode of ['ENFORCE', 'observe ', '', 'on', 1, null, {}]) {
    assert.equal(normalizeEgress({ mode }).mode, EGRESS_DEFAULTS.mode);
  }
});

test('decisionTimeoutMs: solo números finitos, acotados y redondeados', () => {
  assert.equal(normalizeEgress({ decisionTimeoutMs: 1 }).decisionTimeoutMs, 5_000);
  assert.equal(normalizeEgress({ decisionTimeoutMs: 1e9 }).decisionTimeoutMs, 600_000);
  assert.equal(normalizeEgress({ decisionTimeoutMs: 12345.6 }).decisionTimeoutMs, 12_346);
  for (const t of ['120000', null, NaN, Infinity, undefined, {}]) {
    assert.equal(normalizeEgress({ decisionTimeoutMs: t }).decisionTimeoutMs, EGRESS_DEFAULTS.decisionTimeoutMs);
  }
});

test('allowSendCritical solo con true estricto; onUnreadable solo "block" bloquea', () => {
  for (const v of ['true', 1, 'yes', null]) assert.equal(normalizeEgress({ allowSendCritical: v }).allowSendCritical, false);
  assert.equal(normalizeEgress({ onUnreadable: 'BLOCK' }).onUnreadable, 'pass');
});

test('ignora claves desconocidas y no muta la entrada', () => {
  const raw = Object.freeze({ mode: 'observe', extra: 1 });
  const out = normalizeEgress(raw);
  assert.equal('extra' in out, false);
  assert.equal(out.mode, 'observe');
});

test('DEFAULT_SETTINGS.egress coincide con EGRESS_DEFAULTS y es punto fijo de normalizeEgress', () => {
  assert.deepEqual(DEFAULT_SETTINGS.egress, { ...EGRESS_DEFAULTS });
  assert.deepEqual(normalizeEgress(DEFAULT_SETTINGS.egress), DEFAULT_SETTINGS.egress);
});

test('mergeSettings: un parche parcial de egress conserva el resto y no muta los defaults', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, { egress: { mode: 'enforce' } });
  assert.deepEqual(merged.egress, { ...EGRESS_DEFAULTS, mode: 'enforce' });
  assert.deepEqual(merged.memory, DEFAULT_SETTINGS.memory);
  assert.equal(DEFAULT_SETTINGS.egress.mode, 'off');
});

// settingsForHost está exportada y conserva el bloque `egress` tal cual
// (verificado ejecutando antes de incluirlo). Ver R4 del informe.
test('settingsForHost conserva el bloque egress', async () => {
  const { settingsForHost } = await import('../src/core/settings.js');
  const out = settingsForHost(DEFAULT_SETTINGS, 'chatgpt.com');
  assert.ok('egress' in out);
  assert.deepEqual(out.egress, DEFAULT_SETTINGS.egress);
});

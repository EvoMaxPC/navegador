import test from 'node:test';
import assert from 'node:assert/strict';
import { createEgressGate } from '../src/main/egressGate.js';

const CARD = '4111 1111 1111 1111';
const mk = (cfg, ask) => {
  const diags = [];
  const asks = [];
  let statsCalls = 0;
  const gate = createEgressGate({
    getConfig: () => cfg,
    askUser: async (a) => { asks.push(a); return ask ? ask(a) : 'cancel'; },
    onDiagnostic: (d) => diags.push(d),
    onStats: () => { statsCalls += 1; },
  });
  return { gate, diags, asks, statsCalls: () => statsCalls };
};
const call = (gate, sender, payload) => gate.handle({ sender, host: 'x.test', payload });
const S = () => ({ id: 1 });

test('off: pasa sin tocar nada', async () => {
  const { gate, asks } = mk({});
  assert.deepEqual(await call(gate, S(), { slots: [CARD] }), { action: 'pass', mode: 'off' });
  assert.equal(asks.length, 0);
  assert.deepEqual(Object.values(gate.stats()).reduce((a, b) => a + b, 0), 0);
});

test('observe: detecta, cuenta y no pregunta', async () => {
  const { gate, asks } = mk({ mode: 'observe' });
  assert.equal((await call(gate, S(), { slots: [`pago ${CARD}`] })).action, 'pass');
  assert.equal(asks.length, 0);
  assert.equal(gate.stats().observed, 1);
});

test('enforce: limpio pasa; solo email pasa sin preguntar', async () => {
  const { gate, asks } = mk({ mode: 'enforce' });
  assert.equal((await call(gate, S(), { slots: ['hola'] })).action, 'pass');
  assert.equal((await call(gate, S(), { slots: ['a@example.com'] })).action, 'pass');
  assert.equal(asks.length, 0);
  assert.equal(gate.stats().clean, 1);
  assert.equal(gate.stats().observed, 1);
});

test('enforce + tarjeta + redactar: replace sin dígitos', async () => {
  const { gate, asks } = mk({ mode: 'enforce' }, () => 'redact');
  const r = await call(gate, S(), { slots: [`pago ${CARD} ok`], canRewrite: true });
  assert.deepEqual(r, { action: 'replace', slots: ['pago [CARD_1] ok'] });
  assert.ok(!JSON.stringify(r).includes('4111'));
  assert.deepEqual(asks[0].allowed, ['redact', 'cancel']);
  assert.equal(gate.stats().replaced, 1);
});

test('el email NO se redacta aunque haya tarjeta', async () => {
  const { gate } = mk({ mode: 'enforce' }, () => 'redact');
  const r = await call(gate, S(), { slots: [`${CARD} y a@example.com`], canRewrite: true });
  assert.equal(r.slots[0], '[CARD_1] y a@example.com');
});

test('cancelar y timeout bloquean', async () => {
  const a = mk({ mode: 'enforce' }, () => 'cancel');
  assert.deepEqual(await call(a.gate, S(), { slots: [CARD], canRewrite: true }), { action: 'block', reason: 'cancelado' });
  const b = mk({ mode: 'enforce' }, () => 'timeout');
  assert.deepEqual(await call(b.gate, S(), { slots: [CARD], canRewrite: true }), { action: 'block', reason: 'timeout' });
  assert.equal(b.gate.stats().blocked, 1);
});

test('"send" solo vale si allowSendCritical es true', async () => {
  const a = mk({ mode: 'enforce' }, () => 'send');
  assert.equal((await call(a.gate, S(), { slots: [CARD], canRewrite: true })).action, 'block');
  const b = mk({ mode: 'enforce', allowSendCritical: true }, () => 'send');
  assert.equal((await call(b.gate, S(), { slots: [CARD], canRewrite: true })).action, 'pass');
  assert.equal(b.gate.stats().sentAnyway, 1);
});

test('sin canRewrite no se ofrece redactar y elegirlo bloquea', async () => {
  const { gate, asks } = mk({ mode: 'enforce' }, () => 'redact');
  const r = await call(gate, S(), { slots: [CARD], canRewrite: false });
  assert.deepEqual(asks[0].allowed, ['cancel']);
  assert.equal(r.action, 'block');
});

test('si el diálogo falla: error (decide el llamador)', async () => {
  const { gate } = mk({ mode: 'enforce' }, () => { throw new Error('x'); });
  assert.deepEqual(await call(gate, S(), { slots: [CARD], canRewrite: true }), { action: 'error', reason: 'dialogo' });
});

test('un diálogo por pestaña; otra pestaña no se ve afectada', async () => {
  let release;
  const { gate, asks } = mk({ mode: 'enforce' }, () => new Promise((r) => { release = r; }));
  const s = S();
  const p1 = call(gate, s, { slots: [CARD], canRewrite: true });
  const r2 = await call(gate, s, { slots: [CARD], canRewrite: true });
  assert.deepEqual(r2, { action: 'block', reason: 'busy' });
  assert.equal(asks.length, 1);
  release('cancel');
  assert.equal((await p1).action, 'block');
  const p3 = call(gate, { id: 2 }, { slots: [CARD], canRewrite: true });
  assert.equal(asks.length, 2);
  release('cancel');
  await p3;
});

test('varios slots: se redacta solo el que lleva el dato', async () => {
  const { gate } = mk({ mode: 'enforce' }, () => 'redact');
  const r = await call(gate, S(), { slots: ['hola', `pago ${CARD}`], canRewrite: true });
  assert.deepEqual(r.slots, ['hola', 'pago [CARD_1]']);
});

test('payload inválido: error, nunca excepción', async () => {
  const { gate } = mk({ mode: 'enforce' });
  for (const p of [undefined, null, {}, { slots: [] }, { slots: [1] }, { slots: 'x' },
    { slots: new Array(65).fill('a') }, { slots: ['a'.repeat(1_000_001)] }]) {
    assert.deepEqual(await call(gate, S(), p), { action: 'error', reason: 'payload' });
  }
});

test('cuerpo ilegible: pass salvo enforce + onUnreadable block; motivo desconocido = otro', async () => {
  const a = mk({ mode: 'observe' });
  assert.deepEqual(await call(a.gate, S(), { unreadable: 'formulario' }), { action: 'pass', reason: 'formulario' });
  const b = mk({ mode: 'enforce', onUnreadable: 'block' });
  assert.deepEqual(await call(b.gate, S(), { unreadable: 'inventado' }), { action: 'block', reason: 'otro' });
  assert.equal(b.gate.stats().unreadable, 1);
});

test('diagnósticos, resumen y respuestas nunca llevan el valor', async () => {
  const { gate, diags, asks } = mk({ mode: 'enforce', allowSendCritical: true }, () => 'redact');
  await call(gate, S(), { slots: [`${CARD} y sk-${'a'.repeat(30)}`], canRewrite: true });
  const todo = JSON.stringify({ diags, summary: asks.map((a) => a.summary) });
  assert.ok(!todo.includes('4111'));
  assert.ok(!todo.includes('sk-aaa'));
});

test('onStats solo en block, replace, sendAnyway y unreadable', async () => {
  const a = mk({ mode: 'enforce' }, () => 'redact');
  await call(a.gate, S(), { slots: ['hola'] });
  await call(a.gate, S(), { slots: ['a@example.com'] });
  assert.equal(a.statsCalls(), 0);
  await call(a.gate, S(), { slots: [CARD], canRewrite: true });
  assert.equal(a.statsCalls(), 1);
});

test('noteUnauthorized cuenta', () => {
  const { gate } = mk({});
  gate.noteUnauthorized();
  assert.equal(gate.stats().unauthorized, 1);
});

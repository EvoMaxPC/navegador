import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaptureDiagnostic } from '../src/main/captureDiagnostic.js';
import { Engine } from '../src/main/engine.js';
import { EvoMemory } from '../src/memory/engine.js';

async function workspace(run) {
  const dir = await mkdtemp(join(tmpdir(), 'nexo-diagnostic-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('JSONL contiene sólo metadatos permitidos y correlación opaca, sin texto ni URLs o IDs crudos', () => workspace(async (dir) => {
  const file = join(dir, 'documents', 'NEXO-CAPTURE-DIAGNOSTIC.jsonl');
  const writer = createCaptureDiagnostic(file);
  const secret = 'PRIVADO: mi conversación, correo y contraseña no van al informe';
  const data = { host: 'chatgpt.com', source: 'cdp', chars: 58, messageId: secret,
    text: secret, prompt: secret, detail: secret, url: `https://chatgpt.com/c/${encodeURIComponent(secret)}?q=${secret}`,
    memory: { saved: true, persisted: true, chars: 58, action: 'created', text: secret, error: secret } };
  await writer.write('request-detected', data);
  await writer.write('response-delivered', data);
  const raw = await readFile(file, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes('https:'));
  assert.ok(!raw.includes(encodeURIComponent(secret)));
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].captureId, rows[1].captureId);
  assert.match(rows[0].captureId, /^[a-f0-9]{24}$/);
  assert.equal(rows[1].chars, 58);
  assert.deepEqual(rows[1].memory, { saved: true, persisted: true, chars: 58, action: 'created' });
  assert.equal(rows[0].site, 'chatgpt');
}));

test('valores textuales inyectados en metadatos también se descartan', () => workspace(async (dir) => {
  const file = join(dir, 'report.jsonl'), writer = createCaptureDiagnostic(file);
  await writer.write('diagnostic', { host: 'SECRETO', site: 'SECRETO', source: 'SECRETO', code: 'SECRETO', chars: -5,
    memory: { saved: 'SECRETO', persisted: 'SECRETO', chars: Infinity, action: 'SECRETO' } });
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('SECRETO'));
  const row = JSON.parse(raw);
  assert.equal(row.code, null);
  assert.deepEqual(row.memory, { saved: null, persisted: null, chars: 0, action: null });
}));

test('escrituras concurrentes son líneas completas ordenadas y se rotan con tamaño acotado', () => workspace(async (dir) => {
  const file = join(dir, 'report.jsonl'), writer = createCaptureDiagnostic(file, { maxBytes: 3000 });
  await Promise.all(Array.from({ length: 35 }, (_, chars) => writer.write('response-delivered', { chars })));
  await writer.flush();
  const current = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  const previous = (await readFile(`${file}.1`, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(current.at(-1).chars, 34);
  assert.ok(previous.at(-1).chars < current[0].chars);
  assert.ok(Buffer.byteLength(await readFile(file)) <= 3000);
  assert.ok(Buffer.byteLength(await readFile(`${file}.1`)) <= 3000);
}));

test('fallo al escribir es observable y no se presenta como guardado del informe', () => workspace(async (dir) => {
  const parent = join(dir, 'not-a-directory');
  await writeFile(parent, 'x');
  const errors = [], writer = createCaptureDiagnostic(join(parent, 'report.jsonl'), { onError: (code) => errors.push(code) });
  assert.equal(await writer.write('app-start'), false);
  assert.ok(writer.status().error);
  assert.equal(errors.length, 1);
}));

test('el recibo de EVO MEMORY corresponde a la captura actual y distingue fallo de disco', () => {
  const secret = 'Respuesta privada de la captura actual, no de otro turno.';
  for (const fail of [false, true]) {
    const memory = new EvoMemory({ storage: { read: () => null, write() { if (fail) throw new Error('disco lleno'); } } });
    const log = Array.from({ length: 60 }, () => ({ code: 'gpt-response-memory', meta: { chars: 999, messageId: 'viejo' } }));
    const engine = new Engine({ memory, store: { settings: { enabled: true, memory: { enabled: true }, sites: { chatgpt: { enabled: false } } }, pushLog: (entry) => log.unshift(entry) } });
    const result = engine.onCdpCapture(5, { site: 'chatgpt', host: 'chatgpt.com', text: secret, messageId: 'actual', documentUrl:'https://chatgpt.com/c/receipt' });
    assert.equal(result.memory.chars, secret.length);
    assert.equal(result.memory.saved, !fail);
    assert.equal(result.memory.persisted, !fail);
    assert.ok(!JSON.stringify(result.memory).includes(secret));
  }
});

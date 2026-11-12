import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/egress/', import.meta.url);
const archivos = readdirSync(dir).filter((f) => f.endsWith('.js'));

test('src/egress es independiente: sin nombres de proveedor y solo imports relativos ./', () => {
  assert.ok(archivos.length >= 4);
  for (const f of archivos) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /chatgpt|openai|claude|anthropic|gemini/i, f);
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.\//, `${f}: ${m[1]}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const probe = readFileSync(new URL('../scripts/probes/repetition-electron.cjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/ui/shell/index.html', import.meta.url), 'utf8');

test('probe Electron usa paneles actuales, sin depender de la pestaña Repetición retirada', () => {
  const panels = new Set([...html.matchAll(/class="stab[^\"]*" data-panel="([^\"]+)"/g)].map(m => m[1]));
  for (const match of probe.matchAll(/\.stab\[data-panel="([^"]+)"\]/g)) {
    assert.ok(panels.has(match[1]), `panel inexistente: ${match[1]}`);
  }
  assert.doesNotMatch(probe, /#repetitionList|repetitionDiagnostic|data-panel="repetition"/);
  assert.match(probe, /nexo\.repetition\.get\(/, 'el lector aislado se sigue comprobando por IPC');
  assert.match(probe, /memoryPersistence.*state==='disabled'/, 'EVO apagada sigue siendo una condición comprobada');
  assert.match(probe, /#memoryLiveConversation \.repeat-text/, 'la vista habilitada se comprueba en EVO');
});

test('probe Electron sólo utiliza IDs existentes o creados por su fixture', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  // IDs que la propia prueba añade explícitamente al documento del guest.
  for (const id of ['liveAnswer', 'fixtureStop']) {
    assert.match(probe, new RegExp(`(?:id=\\"|\\.id=')${id}`));
    ids.add(id);
  }
  for (const match of probe.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
    assert.ok(ids.has(match[1]), `ID inexistente: ${match[1]}`);
  }
});

test('probe conserva espacios, saltos y Unicode de la fixture, sin doble escape al ejecutar JS', () => {
  const literal = probe.match(/const expected = (\[[^;]+\]);/);
  assert.ok(literal);
  const expected = Array.from(vm.runInNewContext(literal[1]));
  assert.deepEqual(expected, ['  Hola\n', 'Respuesta de fixture 😊\n  código\n']);
  const finalLiteral = probe.match(/const finalText = ('[^;]+');/);
  assert.equal(vm.runInNewContext(finalLiteral[1]), '  uno dos tres\n');
  assert.match(probe, /JSON\.stringify\(finalText\)/, 'el literal se serializa una sola vez al renderer');
  assert.match(probe, /readFileSync\(memoryFile/, 'se conserva la comprobación del archivo real');
  assert.match(probe, /rightMenuMode:'fixed'/, 'anclaje se mide con el panel visible, no autocontraído');
});

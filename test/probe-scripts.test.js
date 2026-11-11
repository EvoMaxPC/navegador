import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * La sonda de integración ejecuta guiones en el MISMO contexto del webview con
 * `executeJavaScript`. Un `const`/`let`/`class` de nivel superior sobrevive a la
 * llamada, así que el segundo guion que repite ese nombre falla con
 * «Script failed to execute» y la sonda reporta un error opaco. Esto ya pasó en
 * CI con dos `const u`; la prueba reproduce el mecanismo sin Electron.
 */
const probe = readFileSync(new URL('../scripts/probes/repetition-electron.cjs', import.meta.url), 'utf8');

function guestScripts() {
  const scripts = [];
  const re = /guest\.executeJavaScript\(`([^`]*)`\)/g;
  let match;
  while ((match = re.exec(probe))) scripts.push(match[1]);
  return scripts;
}

test('la sonda declara guiones ejecutables y no los deja vacíos', () => {
  const scripts = guestScripts();
  assert.ok(scripts.length >= 8, `guiones encontrados: ${scripts.length}`);
  for (const script of scripts) assert.notEqual(script.trim(), '');
});

test('ningún guion de la sonda repite una declaración global entre llamadas', () => {
  // Un contexto único por ejecución: reproduce el webview real de la sonda.
  const context = vm.createContext({
    document: {}, window: {}, Boolean, JSON, String, Number,
  });
  const fallos = [];
  for (const script of guestScripts()) {
    const run = () => {
      try {
        vm.runInContext(script, context, { timeout: 1000 });
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
        // ReferenceError/TypeError son esperables: no hay DOM real.
      }
    };
    try {
      run();
    } catch (error) {
      fallos.push(`primer guion: ${error.message} → ${script.slice(0, 80)}`);
      continue;
    }
    try {
      run();
    } catch (error) {
      fallos.push(`segunda llamada: ${error.message} → ${script.slice(0, 80)}`);
    }
  }
  assert.deepEqual(fallos, []);
});

test('los guiones que declaran variables están aislados en una función', () => {
  for (const script of guestScripts()) {
    if (!/^\s*(const|let|class)\s/m.test(script)) continue;
    assert.match(
      script,
      /^\s*\(\(\)\s*=>\s*\{[\s\S]*\}\)\(\)\s*$/,
      `el guion debe ir dentro de una IIFE: ${script.slice(0, 80)}`,
    );
  }
});

/**
 * Pruebas de la prueba de humo.
 *
 * La prueba de humo corre dentro de `nexo.exe`, donde no hay tests posibles; acá
 * se la enfrenta a ventanas falsas para comprobar que distingue un arranque sano
 * de uno roto y que nunca deja el proceso colgado.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke, report } from '../src/main/smoke.js';

/** Respuesta típica de una shell sana. */
function healthy(overrides = {}) {
  return JSON.stringify({
    protocol: 'nexo:',
    title: 'Nexo',
    readyState: 'complete',
    bridge: true,
    bridgeKeys: ['bookmarks', 'downloads', 'getSettings', 'history', 'profile', 'suggest'],
    hasBridgeMethod: true,
    omnibox: true,
    tabStrip: true,
    webviews: 1,
    background: 'rgb(7, 8, 12)',
    stylesheetLoaded: true,
    ...overrides,
  });
}

function fakeWindow(response) {
  return {
    isDestroyed: () => false,
    webContents: {
      calls: 0,
      async executeJavaScript() {
        this.calls += 1;
        if (typeof response === 'function') return response();
        return response;
      },
    },
  };
}

const names = (checks) => checks.filter((item) => !item.ok).map((item) => item.name);

test('una shell sana pasa todas las comprobaciones', async () => {
  const win = fakeWindow(healthy());
  const result = await runSmoke({ win });
  assert.equal(result.ok, true, names(result.checks).join(', '));
  assert.ok(result.checks.length >= 9);
  assert.deepEqual(names(result.checks), []);
});

test('detecta que el preload no llegó a la página', async () => {
  const win = fakeWindow(healthy({ bridge: false, bridgeKeys: [] }));
  const result = await runSmoke({ win });
  assert.equal(result.ok, false);
  const failed = names(result.checks);
  assert.ok(failed.includes('preload expuesto'));
  assert.ok(failed.includes('puente completo'));
});

test('detecta que el esquema nexo no sirvió la interfaz', async () => {
  const win = fakeWindow(healthy({ protocol: 'file:', title: '', omnibox: false }));
  const result = await runSmoke({ win });
  assert.equal(result.ok, false);
  assert.deepEqual(names(result.checks), ['esquema nexo', 'título de la ventana', 'barra de direcciones']);
});

test('detecta estilos que no cargaron (CSS fuera del paquete)', async () => {
  const win = fakeWindow(healthy({ stylesheetLoaded: false, background: 'rgba(0, 0, 0, 0)' }));
  const result = await runSmoke({ win });
  assert.equal(result.ok, false);
  assert.deepEqual(names(result.checks), ['hoja de estilos aplicada']);
});

test('detecta que no se creó ninguna pestaña', async () => {
  const win = fakeWindow(healthy({ webviews: 0 }));
  const result = await runSmoke({ win });
  assert.deepEqual(names(result.checks), ['webview montada']);
});

test('una ventana inexistente no rompe la prueba', async () => {
  const result = await runSmoke({ win: null });
  assert.equal(result.ok, false);
  assert.deepEqual(names(result.checks), ['ventana creada']);

  const destroyed = await runSmoke({ win: { isDestroyed: () => true } });
  assert.equal(destroyed.ok, false);
});

test('un error dentro de la página se informa en vez de propagarse', async () => {
  const win = fakeWindow(() => {
    throw new Error('no se pudo evaluar');
  });
  const result = await runSmoke({ win });
  assert.equal(result.ok, false);
  assert.equal(result.checks.at(-1).detail, 'no se pudo evaluar');
});

test('una respuesta ilegible no deja la prueba sin informe', async () => {
  const win = fakeWindow('esto no es JSON');
  const result = await runSmoke({ win });
  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 2);
});

test('la prueba se corta si la página no responde', async () => {
  const win = fakeWindow(() => new Promise(() => {}));
  const result = await runSmoke({ win, timeout: 30 });
  assert.equal(result.ok, false);
  assert.match(result.checks.at(-1).detail, /sin respuesta en 30 ms/);
});

test('el informe se imprime y define el código de salida', async () => {
  const lines = [];
  const ok = await runSmoke({ win: fakeWindow(healthy()) });
  assert.equal(report(ok, (line) => lines.push(line)), 0);
  assert.ok(lines.some((line) => line.includes('✔ arrancó y funciona')));
  assert.ok(lines.every((line) => !line.includes('undefined')));

  const bad = await runSmoke({ win: fakeWindow(healthy({ omnibox: false })) });
  const lines2 = [];
  assert.equal(report(bad, (line) => lines2.push(line)), 1);
  assert.ok(lines2.some((line) => line.startsWith('✖ barra de direcciones')));
});

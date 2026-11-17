/**
 * P0-3g · el rótulo del cuarto contador dice lo que el contador hace.
 *
 * `statTurnsPerformed` cuenta sólo el desenlace `unknown` de un turno
 * (`src/core/turnOutcome.js:4-7`: `completed` se conserva para deduplicar y no
 * tiene contador). El rótulo «turnos realizados» prometía un total de turnos que
 * el campo no es. Ahora dice «turnos sin resultado claro».
 *
 * Se comprueba contra el HTML de la shell tal cual está en disco: el rótulo
 * nuevo, el ID que la interfaz consulta y que nadie rotule el campo como un
 * total. No se toca la lógica ni el ID.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shellHtml = readFileSync(new URL('../src/ui/shell/index.html', import.meta.url), 'utf8');
const shellApp = readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');

test('el rótulo del cuarto contador es «turnos sin resultado claro»', () => {
  assert.match(shellHtml,
    /id="statTurnsPerformed">0<\/b><span>turnos sin resultado claro<\/span>/,
    'el HTML trae el rótulo nuevo junto al ID de siempre');
  assert.doesNotMatch(shellHtml, /<span>turnos realizados<\/span>/,
    'y ya no queda el rótulo que prometía un total');
});

test('el ID `statTurnsPerformed` sigue existiendo y sigue siendo el que la interfaz pinta', () => {
  assert.equal((shellHtml.match(/id="statTurnsPerformed"/g) || []).length, 1,
    'un solo elemento con ese ID');
  assert.match(shellApp,
    /turnsPerformed: document\.getElementById\('statTurnsPerformed'\)/,
    'app.js:54 sigue leyendo ese ID');
  assert.match(shellApp,
    /for \(const key of \['turnsCancelled', 'turnsFailed', 'turnsPerformed'\]\)/,
    'app.js:947 sigue pintando los tres contadores de resultado');
});

test('la shell no rotula el campo como un total de turnos', () => {
  const rotulo = shellHtml.match(/id="statTurnsPerformed">0<\/b><span>([^<]*)<\/span>/)[1];
  assert.equal(rotulo, 'turnos sin resultado claro', 'texto literal del rótulo');
  assert.doesNotMatch(rotulo, /realizados|completos|total/i,
    'ni «realizados», ni «completos», ni «total»');
});

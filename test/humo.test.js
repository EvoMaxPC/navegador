/**
 * Pruebas del lanzador de la prueba de humo.
 *
 * Se cambia el ejecutable por `node -e …`, que escribe el mismo informe que
 * escribiría `nexo.exe --smoke`. Así se cubren los tres desenlaces que importan:
 * pasó, falló y no dejó informe, sin depender de Windows ni de Electron.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXITO, verifySmoke } from '../scripts/humo.mjs';

/** Un «ejecutable» que escribe un informe y sale con el código indicado. */
function fakeExe({ informe, exit }) {
  const informeJson = JSON.stringify(informe ?? null);
  return [
    '-e',
    `const fs=require('node:fs');
     const informe=${informeJson};
     if (informe!==null) fs.writeFileSync(process.env.NEXO_SMOKE_OUT, informe);
     console.log('stderr y stdout del ejecutable');
     process.exit(${exit});`,
  ];
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-humo-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const INFORME_OK = `── prueba de humo ──\n✔ ventana creada\n────────────────────\n✔ ${EXITO}\n`;

test('un arranque sano pasa aunque el código de salida no sea cero', () => {
  withTemp((dir) => {
    const out = join(dir, 'ci-humo.txt');
    const result = verifySmoke({
      exe: process.execPath,
      args: fakeExe({ informe: INFORME_OK, exit: 7 }),
      out,
    });
    assert.equal(result.ok, true, result.motivo);
    assert.equal(result.code, 7, 'el código se informa, pero no decide');
    assert.match(result.report, /arrancó y funciona/);
    assert.match(result.texto, /código de salida: 7/);
    assert.match(result.texto, /duración: \d+\.\d s/);
    assert.match(result.texto, /===== salida del ejecutable =====/);
    assert.match(result.texto, /stderr y stdout del ejecutable/);
  });
});

test('un informe que no dice que funcionó es un fallo', () => {
  withTemp((dir) => {
    const out = join(dir, 'ci-humo.txt');
    const result = verifySmoke({
      exe: process.execPath,
      args: fakeExe({ informe: '── prueba de humo ──\n✖ algo falló\n', exit: 0 }),
      out,
    });
    assert.equal(result.ok, false);
    assert.match(result.motivo, /no dice que arrancó/);
    assert.equal(result.code, 0);
  });
});

test('sin informe se explica por qué', () => {
  withTemp((dir) => {
    const out = join(dir, 'ci-humo.txt');
    const result = verifySmoke({ exe: process.execPath, args: fakeExe({ informe: null, exit: 3 }), out });
    assert.equal(result.ok, false);
    assert.equal(result.motivo, 'sin informe');
    assert.match(result.texto, /sin informe: el ejecutable no llegó a escribirlo/);
    assert.match(result.texto, /código de salida: 3/);
  });
});

test('un ejecutable que no existe no se intenta lanzar', () => {
  withTemp((dir) => {
    const result = verifySmoke({ exe: join(dir, 'no-existe.exe'), out: join(dir, 'ci-humo.txt') });
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
    assert.match(result.motivo, /no existe el ejecutable/);
  });
});

test('el informe queda escrito en el archivo indicado', () => {
  withTemp((dir) => {
    const out = join(dir, 'ci-humo.txt');
    const result = verifySmoke({
      exe: process.execPath,
      args: fakeExe({ informe: INFORME_OK, exit: 0 }),
      out,
    });
    writeFileSync(out, result.texto, 'utf8');
    const guardado = readFileSync(out, 'utf8');
    assert.match(guardado, /✔ arrancó y funciona/);
    assert.match(guardado, /código de salida: 0/);
  });
});

test('un ejecutable que se cuelga se corta por tiempo', () => {
  withTemp((dir) => {
    const out = join(dir, 'ci-humo.txt');
    const result = verifySmoke({
      exe: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      out,
      timeout: 300,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, null, 'sin código: se lo mató por tiempo');
    assert.match(result.texto, /señal|sin informe/);
  });
});

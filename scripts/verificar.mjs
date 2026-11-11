/**
 * Verificación automática de Nexo.
 *
 * Corre lo que sí se puede comprobar sin abrir una ventana: pruebas, empaquetado
 * de la capa de inyección y contrato entre capas. Al final imprime el checklist
 * manual que requiere Chromium y una persona mirando.
 *
 *   npm run verify
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const steps = [];

function run(label, command, args) {
  process.stdout.write(`\n▶ ${label}\n`);
  // Sin `shell`: ambos comandos son `process.execPath`, y con shell el camino de
  // node en Windows (con espacios) se parte en argumentos.
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  const ok = result.status === 0;
  steps.push({ label, ok });
  return ok;
}

const buildOk = run('Empaquetado de la capa de inyección', process.execPath, ['scripts/build-inject.mjs']);
const testsOk = buildOk && run('Pruebas automatizadas', process.execPath, ['--test']);

const checklist = [
  'Navegar a 3 sitios distintos y comprobar que renderizan.',
  'Abrir 6 pestañas, cambiar con Ctrl+Tab y reabrir una cerrada con Ctrl+Shift+T.',
  'Ctrl+Shift+A: buscar entre pestañas abiertas y cerradas; Alt+F: menú del navegador.',
  'Buscar en el historial y volver a una página desde el resultado.',
  'Cerrar y reabrir la aplicación: pestañas e historial siguen ahí.',
  'Marcar con la estrella y verlo en el panel de marcadores.',
  'Bajar un archivo, ver el progreso y abrirlo desde Descargas.',
  'Ctrl+F en una página: «n de m», siguiente y anterior.',
  'Zoom con Ctrl++ en un solo sitio y comprobar que no afecta a otros.',
  'Cambiar un permiso en Sitios y verificar que se aplica.',
  'Apagar la mediación y repetir la navegación: debe ser idéntica.',
];

console.log('\n──────────────────────────────────────────────');
for (const step of steps) console.log(`${step.ok ? '✔' : '✖'} ${step.label}`);
console.log('──────────────────────────────────────────────');
console.log('\nChecklist manual (requiere Electron y display):\n');
checklist.forEach((item, index) => console.log(`  ${String(index + 1).padStart(2, ' ')}. ${item}`));
console.log('\nDetalle y criterios de aceptación: docs/NAVEGADOR.md\n');

if (!testsOk || !buildOk) {
  console.error('Verificación automática FALLIDA.\n');
  process.exit(1);
}
console.log('Verificación automática OK. Falta el checklist manual.\n');

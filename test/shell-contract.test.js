/**
 * Contrato entre las tres capas que no comparten tipos: HTML, interfaz,
 * preload y proceso principal.
 *
 * Estas pruebas no abren una ventana: leen los archivos y verifican que no haya
 * identificadores ni canales IPC huérfanos. Es el error más caro de detectar a
 * mano y el más probable después de refactorizar.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Se normalizan los saltos de línea: en Windows el checkout usa CRLF y las
// expresiones de este archivo razonan sobre líneas.
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n?/g, '\n');

const html = read('src/ui/shell/index.html');
const shellApp = read('src/ui/shell/app.js') + '\n' + read('src/ui/shell/browserTools.js') + '\n' + read('src/ui/shell/workDossier.js') + '\n' + read('src/ui/shell/understandingPanel.js');
const preload = read('src/preload/shell.cjs');
const main = read('src/main/main.js') + '\n' + read('src/main/advancedBrowser.js') + '\n' + read('src/main/workDossier.js') + '\n' + read('src/main/userUnderstanding.js');
const pagePreload = read('src/preload/bridge.cjs');

function unique(values) {
  return [...new Set(values)];
}

test('todos los identificadores que usa la interfaz existen en el HTML', () => {
  const used = unique([
    ...[...shellApp.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...shellApp.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ]);
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = used.filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `faltan en el HTML: ${missing.join(', ')}`);
  assert.ok(used.length > 30, 'la interfaz debería usar muchos identificadores');
});

test('cada solapa del panel tiene su sección y al revés', () => {
  const tabs = unique([...html.matchAll(/class="stab[^"]*" data-panel="([^"]+)"/g)].map((m) => m[1]));
  const panels = unique([...html.matchAll(/class="panel-view[^"]*" data-panel="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(tabs.sort(), panels.sort());
});

test('todo canal IPC que invoca el preload está registrado en el principal', () => {
  const invoked = unique([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
  // El servicio de expedientes usa un registrador con prefijo fijo y allowlist de nombres.
  for (const match of read('src/main/workDossier.js').matchAll(/register\('([^']+)'/g)) handled.add(`nexo:work:${match[1]}`);
  for(const match of read('src/main/userUnderstanding.js').matchAll(/handle\('([^']+)'/g))handled.add(`nexo:understanding:${match[1]}`);
  const missing = invoked.filter((channel) => !handled.has(channel));
  assert.deepEqual(missing, [], `canales sin handler: ${missing.join(', ')}`);
});

test('todo canal que el preload envía sin respuesta tiene su listener', () => {
  const sent = unique([
    ...[...preload.matchAll(/ipcRenderer\.send(?:Sync)?\('([^']+)'/g)].map((m) => m[1]),
  ]);
  const listened = new Set([...main.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1]));
  const missing = sent.filter((channel) => !listened.has(channel));
  assert.deepEqual(missing, [], `canales enviados sin listener: ${missing.join(', ')}`);
});

test('todo canal que el principal emite puede escucharse desde el preload', () => {
  const broadcasted = unique([...main.matchAll(/broadcast\('([^']+)'/g)].map((m) => m[1]));
  const allowed = new Set([...preload.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const missing = broadcasted.filter((channel) => channel.startsWith('nexo:') && !allowed.has(channel));
  assert.deepEqual(missing, [], `eventos no permitidos en el preload: ${missing.join(', ')}`);
});

test('los métodos que la interfaz llama existen en el puente expuesto', () => {
  // Se recolecta `nexo.algo(...)` y `nexo.algo.sub(...)` de la interfaz.
  const calls = unique([...shellApp.matchAll(/nexo\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?\(/g)].map((m) =>
    m[2] ? `${m[1]}.${m[2]}` : m[1],
  ));
  const exposed = new Set();
  // Recorre el árbol de `exposeInMainWorld('nexo', {...})` a nivel de nombres.
  const body = preload.slice(preload.indexOf("exposeInMainWorld('nexo'"));
  let currentGroup = null;
  for (const line of body.split('\n')) {
    const group = line.match(/^\s{2}([a-zA-Z]+): \{$/);
    if (group) {
      currentGroup = group[1];
      exposed.add(currentGroup);
      continue;
    }
    if (/^\s{2}\},?$/.test(line)) {
      currentGroup = null;
      continue;
    }
    const member = line.match(/^(\s+)([a-zA-Z]+):/);
    if (!member) continue;
    const depth = member[1].length;
    const name = member[2];
    if (depth === 2) exposed.add(currentGroup ? `${currentGroup}.${name}` : name);
    else if (depth === 4 && currentGroup) exposed.add(`${currentGroup}.${name}`);
  }

  // `nexo.on` se usa con encadenado opcional y `nexosiona` no existe: se filtra
  // lo que no es una llamada real al puente.
  const missing = calls.filter((name) => !exposed.has(name) && !name.startsWith('on'));
  assert.deepEqual(missing, [], `métodos sin puente: ${missing.join(', ')}`);
});

test('el preload de las pestañas no expone Node a la página', () => {
  // El puente inyecta el motor en el mundo principal desde el mundo aislado y
  // nunca entrega `require`, `process` ni `ipcRenderer` a la página.
  assert.ok(!/exposeInMainWorld\(\s*['"](require|process|ipcRenderer)/.test(pagePreload));
  assert.ok(!/window\.require\s*=/.test(pagePreload));
  assert.match(pagePreload, /webFrame\.executeJavaScript/, 'la inyección va por el mundo aislado');
  assert.match(pagePreload, /location\.protocol/, 'las páginas internas no se median');
});

test('las ventanas de pestañas mantienen el aislamiento', () => {
  assert.match(main, /webPreferences\.nodeIntegration = false/);
  assert.match(main, /webPreferences\.contextIsolation = true/);
  assert.match(main, /delete webPreferences\.preloadURL/);
});

test('no hay manejadores de permisos que concedan todo', () => {
  const forbidden = /callback\(true\)|setPermissionRequestHandler\(\([^)]*\)\s*=>\s*callback\(true\)/;
  assert.ok(!forbidden.test(main), 'ningún permiso debe concederse sin política');
  assert.match(main, /profile\.permissions\.decide/);
});

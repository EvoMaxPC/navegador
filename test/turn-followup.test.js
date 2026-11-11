import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('el cierre de un turno publica reparaciones, sugerencias y continuación', () => {
  const main = read('src/main/main.js');
  assert.match(main, /function turnFollowUp\(result\)/);
  assert.match(main, /broadcast\('nexo:turn-followup'/);
  // Sólo se emite cuando hay algo útil: no se inunda la interfaz.
  assert.match(main, /if \(!fixes\.length && !suggestions\.length && !next && !repaired\.truncated && !repaired\.refusal\) return null;/);
  // El prompt sugerido se acota y nunca se manda desde el principal.
  assert.match(main, /prompt\.slice\(0, 2000\)/);
  assert.match(main, /s\.prompt\.length <= 2000/);
});

test('el evento no viaja a la página ni permite inyectar canales arbitrarios', () => {
  const bridge = read('src/preload/bridge.cjs');
  assert.doesNotMatch(bridge, /nexo:turn-followup/);
  const shell = read('src/preload/shell.cjs');
  assert.match(shell, /ipcRenderer\.on\('nexo:turn-followup'/);
  // La lectura de la pestaña sigue resolviéndose por webContentsId real.
  assert.match(read('src/ui/shell/app.js'), /getWebContentsId\(\) === id/);
});

test('la interfaz escribe la continuación y nunca la envía sola', () => {
  const app = read('src/ui/shell/app.js');
  const insert = app.slice(app.indexOf("getElementById('followUpInsert')"));
  assert.match(insert, /action: 'insert-text'/);
  assert.match(insert, /Revisalo y enviá vos/);
  // No hay clic al botón de enviar ni llamada a submit tras insertar.
  assert.doesNotMatch(insert.slice(0, 1600), /submit|sendButton|\.click\(\)/);
  assert.match(app, /function refreshFollowUp\(\)/);
  assert.match(app, /nexo\.onTurnFollowUp\?\./);
});

test('el diálogo y el menú ofrecen la continuación sin prometer envío automático', () => {
  const hub = read('src/ui/shell/navigationHub.js');
  assert.match(hub, /command\.type === 'continue-response'/);
  assert.match(hub, /showFollowUp\(\)/);
  assert.match(hub, /Nada se envía automáticamente/);
  assert.match(hub, /'continue-response', 'Continuar la respuesta'/);
  const html = read('src/ui/shell/index.html');
  for (const id of ['followUpBar', 'followUpInsert', 'followUpDismiss']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /id="followUpBar"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('si la pestaña no es la activa no se muestra un aviso falso', () => {
  const app = read('src/ui/shell/app.js');
  assert.match(app, /const touchesActive = tab\.id === state\.activeId;/);
  assert.match(app, /if \(!touchesActive\) return;/);
  // La marca de reparada queda igual, para encontrarla al cambiar de pestaña.
  assert.match(app, /tab\.tabEl\.classList\.add\('follow-up'\)/);
});

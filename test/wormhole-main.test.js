import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((r) => setTimeout(r, 40));
const window = journal.windows[0],
  owner = window.webContents;
const event = (sender) => ({ sender, senderFrame: sender.mainFrame });
const handler = journal.ipcHandlers.get('nexo:advanced:set-prefs');
test('ventana nativa utiliza el Wormhole oficial', () => {
  assert.match(
    window.options.icon.replaceAll('\\', '/'),
    /identity\/NEXO-Wormhole\.(?:png|ico)$/,
  );
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
});
test('modo derecho y zoom de interfaz persisten por IPC confiable y se aplican realmente a shell, no al guest', async () => {
  const guest = window.attachWebview('https://chatgpt.com/c/zoom');
  const prefs = await journal.ipcHandlers.get('nexo:advanced:prefs')(
    event(owner),
  );
  const result = await handler(event(owner), {
    ...prefs,
    rightMenuMode: 'fixed',
    uiZoom: 1.25,
  });
  assert.equal(result.ok, true);
  assert.equal(owner.getZoomFactor(), 1.25);
  assert.equal(guest.getZoomFactor(), 1);
  const disk = JSON.parse(
    readFileSync(join(journal.userData, 'browser-tools.json'), 'utf8'),
  );
  assert.equal(disk.rightMenuMode, 'fixed');
  assert.equal(disk.uiZoom, 1.25);
  owner.emit('did-finish-load');
  assert.equal(owner.getZoomFactor(), 1.25);
  const reset = await handler(event(owner), {
    ...result.prefs,
    rightMenuMode: 'auto',
    uiZoom: 1,
  });
  assert.equal(reset.ok, true);
  assert.equal(owner.getZoomFactor(), 1);
});
test('sitio y subframe no pueden cambiar modo ni zoom de la interfaz', async () => {
  const guest = window.attachWebview('https://evil.example');
  assert.equal(
    (await handler(event(guest), { uiZoom: 1.5, rightMenuMode: 'fixed' })).ok,
    false,
  );
  assert.equal(
    (await handler({ sender: owner, senderFrame: {} }, { uiZoom: 1.5 })).ok,
    false,
  );
  assert.equal(owner.getZoomFactor(), 1);
});

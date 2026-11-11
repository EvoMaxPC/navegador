import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync } from 'node:fs';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
const file = join(journal.userData, 'nexo-profile.json');
const damaged = Buffer.from('{"settings":{"enabled":false},"log":[{"code":"conservar"}]\ntruncado');
writeFileSync(file, damaged);
await import('../src/main/main.js');

test('IPC real: recupera perfil corrupto y rechaza guardados fallidos sin confirmar ajustes falsos', async () => {
  // Espera una condición de arranque, no una sesión real de Electron/Windows.
  await new Promise(resolve => setTimeout(resolve, 60));
  const owner = journal.windows[0].webContents;
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const call = (channel, payload) => Promise.resolve().then(() => journal.ipcHandlers.get(channel)(event, payload));
  const status = await call('nexo:storage:status');
  assert.equal(status.state, 'recovered');
  assert.deepEqual(readFileSync(status.backup), damaged);
  await call('nexo:settings:set', { enabled: false });
  assert.deepEqual(readFileSync(status.backup), damaged);
  const confirmed = structuredClone(await call('nexo:settings:get'));
  const log = structuredClone(await call('nexo:log'));

  // Fallo real de rename: un directorio ocupa el destino, no se simula el IPC.
  const preserved = file + '.test-preserved';
  renameSync(file, preserved);
  mkdirSync(file);
  try {
    await assert.rejects(call('nexo:settings:set', { enabled: true }), /No se pudo guardar el perfil/);
    await assert.rejects(call('nexo:settings:reset'), /No se pudo guardar el perfil/);
    await assert.rejects(call('nexo:log:clear'), /No se pudo guardar el perfil/);
    assert.deepEqual(await call('nexo:settings:get'), confirmed);
    assert.deepEqual(await call('nexo:log'), log);
    assert.match((await call('nexo:storage:status')).error, /No se pudo guardar el perfil/);
    assert.deepEqual(readFileSync(status.backup), damaged);
  } finally {
    rmdirSync(file);
    renameSync(preserved, file);
  }
  await call('nexo:settings:set', { enabled: true });
  assert.equal((await call('nexo:storage:status')).error, null);
});

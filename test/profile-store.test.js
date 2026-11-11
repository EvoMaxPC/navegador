import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { register } from 'node:module';
import vm from 'node:vm';
register('./harness/loader.mjs', import.meta.url);
const { Store } = await import('../src/main/store.js');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'nexo-profile-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'nexo-profile.json');
  return { dir, file, open: (opts = {}) => new Store({ file, fs: { ...fs, ...overrides }, ...opts }) };
}
function ioError(code = 'EIO') { return Object.assign(new Error(`fallo simulado ${code}`), { code }); }

test('Store: ENOENT es primer arranque; guardar produce JSON legible', t => {
  const f = fixture(t), store = f.open();
  assert.equal(store.loadStatus.state, 'new');
  store.setSettings({ enabled: false });
  assert.equal(f.open().settings.enabled, false);
  assert.deepEqual(fs.readdirSync(f.dir), ['nexo-profile.json']);
});

test('Store: datos → corrupción → reinicio → ajuste preserva exactamente el original', t => {
  const f = fixture(t), original = f.open();
  original.setSettings({ enabled: false });
  original.pushLog({ code: 'evidencia', text: 'árbol 👩🏽‍💻' });
  const damaged = Buffer.concat([fs.readFileSync(f.file), Buffer.from('\nJSON roto\x00')]);
  fs.writeFileSync(f.file, damaged);
  const restarted = f.open();
  assert.equal(restarted.loadStatus.state, 'recovered');
  const backup = restarted.loadStatus.backup;
  assert.deepEqual(fs.readFileSync(backup), damaged);
  restarted.setSettings({ enabled: true });
  assert.deepEqual(fs.readFileSync(backup), damaged);
  assert.equal(f.open().settings.enabled, true);
  assert.ok(backup.startsWith(f.file + '.corrupt-'));
});

for (const raw of ['null', '[]', '42', '{"settings":null}', '{"log":{}}', '{"settings":[]}']) {
  test(`Store: estructura inválida ${raw} se preserva antes de escribir`, t => {
    const f = fixture(t);
    fs.writeFileSync(f.file, raw);
    const store = f.open();
    assert.equal(store.loadStatus.state, 'recovered');
    store.clearLog();
    assert.equal(fs.readFileSync(store.loadStatus.backup, 'utf8'), raw);
  });
}

test('Store: dos reinicios corruptos crean respaldos diferentes y no los pisan', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'primer roto');
  const first = f.open().loadStatus.backup;
  fs.writeFileSync(f.file, 'segundo roto');
  const second = f.open().loadStatus.backup;
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'primer roto');
  assert.equal(fs.readFileSync(second, 'utf8'), 'segundo roto');
});

for (const code of ['EACCES', 'EIO']) {
  test(`Store: ${code} al leer bloquea sobrescritura, no se trata como ENOENT`, t => {
    const f = fixture(t, { readFileSync: () => { throw ioError(code); } });
    fs.writeFileSync(f.file, 'original inaccesible');
    const store = f.open();
    assert.equal(store.loadStatus.state, 'unreadable');
    assert.throws(() => store.setSettings({ enabled: false }), /Perfil no guardado/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original inaccesible');
  });
}

test('Store: si falla el respaldo de corrupción, ninguna mutación pisa el original', t => {
  const f = fixture(t, { copyFileSync: () => { throw ioError('ENOSPC'); } });
  fs.writeFileSync(f.file, '{roto');
  const store = f.open();
  assert.equal(store.loadStatus.state, 'recovery-blocked');
  for (const mutate of [() => store.setSettings({ enabled: false }), () => store.replaceSettings({}),
    () => store.pushLog({ code: 'nuevo' }), () => store.clearLog()]) assert.throws(mutate, /Perfil no guardado/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{roto');
});

for (const failing of ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`Store: fallo ${failing} rechaza todas las mutaciones sin cambiar disco ni RAM`, t => {
    const f = fixture(t), initial = f.open();
    initial.setSettings({ enabled: false }); initial.pushLog({ code: 'conservar' });
    const disk = fs.readFileSync(f.file), store = f.open({ fs: { ...fs, [failing]: () => { throw ioError('ENOSPC'); } } });
    const before = structuredClone(store.data);
    for (const mutate of [() => store.setSettings({ enabled: true }), () => store.replaceSettings({}),
      () => store.pushLog({ code: 'nuevo' }), () => store.clearLog()]) {
      assert.throws(mutate, /No se pudo guardar el perfil/);
      assert.deepEqual(store.data, before);
      assert.deepEqual(fs.readFileSync(f.file), disk);
      assert.deepEqual(fs.readdirSync(f.dir), ['nexo-profile.json'], 'no deja temporales');
    }
  });
}

test('Store: log de fondo avisa del fallo sin publicar estado ni provocar recursión', t => {
  const f = fixture(t), errors = [];
  const store = f.open({ fs: { ...fs, renameSync: () => { throw ioError(); } }, onLogError: error => errors.push(error) });
  assert.equal(store.pushLog({ code: 'no-persistido' }), null);
  assert.equal(errors.length, 1);
  assert.deepEqual(store.log, []);
  assert.throws(() => store.setSettings({ enabled: false }), /No se pudo guardar/);
});

test('Store: orden de guardado es write → fsync → close → rename; RAM cambia al final', t => {
  const calls = [], f = fixture(t);
  const store = f.open({ fs: { ...fs,
    writeFileSync: (...args) => { calls.push('write'); return fs.writeFileSync(...args); },
    fsyncSync: (...args) => { calls.push('fsync'); return fs.fsyncSync(...args); },
    closeSync: (...args) => { calls.push('close'); return fs.closeSync(...args); },
    renameSync: (...args) => { calls.push('rename'); assert.equal(store.settings.enabled, true); return fs.renameSync(...args); },
  } });
  store.setSettings({ enabled: false });
  assert.deepEqual(calls, ['write', 'fsync', 'close', 'rename']);
  assert.equal(store.settings.enabled, false);
});

test('UI: rechazo de setSettings conserva ajustes confirmados y muestra el error', async () => {
  const source = fs.readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function patchSettings('), source.indexOf("S.enabled.addEventListener('change'"));
  const settings = { enabled: true }, notices = [], filled = [];
  const context = { state: { settings }, nexo: { setSettings: async () => { throw new Error('ENOSPC'); } },
    fillSettings: s => filled.push(s), renderSitesList() {}, settingsStorageNotice: s => notices.push(s) };
  vm.createContext(context);
  vm.runInContext(body, context);
  await context.patchSettings({ enabled: false });
  assert.deepEqual(filled, [settings]);
  assert.match(notices[0], /No se guardaron.*ENOSPC/);
});

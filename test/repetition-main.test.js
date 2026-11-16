import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
const settle = () => new Promise((resolve) => setTimeout(resolve, 35));
const invoke = (channel, sender, payload) => journal.ipcHandlers.get(channel)({ sender, senderFrame: sender.mainFrame }, payload);
const turns = [{ id: 'u', role: 'user', content: '  pregunta\n' }, { id: 'a', role: 'assistant', content: '\nRespuesta 😊\n  código\n' }];
let shell, a, b;

test('recibe sólo de ChatGPT y entrega copia literal a la shell, incluso con memoria apagada', async () => {
  await settle();
  shell = journal.windows[0].webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  await invoke('nexo:settings:set', shell, { enabled: false, memory: { enabled: false } });
  a = journal.windows[0].attachWebview('https://chatgpt.com/c/a');
  b = journal.windows[0].attachWebview('https://chatgpt.com/c/b');
  const before = await invoke('nexo:stats', shell);
  const memoryBefore = await invoke('nexo:memory:list', shell);
  const popup = { webContents: { getURL: () => 'https://accounts.example.com/login', send() { throw Error('No enviar conversación a popups remotos'); } } };
  journal.windows.push(popup);
  let result;
  try { result = await invoke('nexo:repetition:snapshot', a, { href: a.url, turns, streaming: true }); }
  finally { journal.windows.pop(); }
  assert.equal(result.ok, true);
  const snapshot = await invoke('nexo:repetition:get', shell, { webContentsId: a.id, href: a.url });
  assert.deepEqual(snapshot.turns.map((turn) => turn.content), turns.map((turn) => turn.content));
  assert.equal(snapshot.streaming, true);
  const after = await invoke('nexo:stats', shell);
  for (const key of ['messages', 'responses', 'outputTokens', 'inputTokens', 'turnsCancelled', 'turnsFailed', 'turnsPerformed']) assert.equal(after[key], before[key], key);
  assert.deepEqual(await invoke('nexo:memory:list', shell), memoryBefore, 'no guarda ni destila la repetición');
  assert.ok(shell.sent.some((event) => event.channel === 'nexo:repetition-changed' && event.payload.webContentsId === a.id));
});

test('una página no puede leer el panel ni fingir la URL o un origen permitido', async () => {
  assert.equal(await invoke('nexo:repetition:get', b, { webContentsId: a.id, href: a.url }), null);
  const query = { webContentsId: a.id, href: a.url };
  shell.mainFrame = {};
  assert.equal(await journal.ipcHandlers.get('nexo:repetition:get')({ sender: shell, senderFrame: {} }, query), null, 'no admite subframes de la shell');
  assert.equal(await invoke('nexo:repetition:get', { id: shell.id, getURL: () => shell.url }, query), null, 'el ID o URL no sustituyen a la shell conocida');
  assert.equal((await invoke('nexo:repetition:snapshot', b, { href: a.url, turns })).ok, false);
  const alien = journal.windows[0].attachWebview('https://example.com');
  assert.equal((await invoke('nexo:repetition:snapshot', alien, { href: alien.url, turns })).ok, false);
  assert.equal((await invoke('nexo:repetition:snapshot', shell, { href: shell.url, turns })).ok, false);
  a.mainFrame = {};
  assert.equal((await journal.ipcHandlers.get('nexo:repetition:snapshot')({ sender: a, senderFrame: {} }, { href: a.url, turns })).ok, false, 'no acepta subframes');
});

test('dos pestañas no mezclan conversaciones y una consulta vieja por URL no devuelve contenido', async () => {
  await invoke('nexo:repetition:snapshot', b, { href: b.url, turns: [{ id: 'b', role: 'assistant', content: 'Sólo B' }] });
  assert.equal((await invoke('nexo:repetition:get', shell, { webContentsId: b.id, href: b.url })).turns[0].content, 'Sólo B');
  assert.equal((await invoke('nexo:repetition:get', shell, { webContentsId: a.id, href: a.url })).turns[0].content, turns[0].content);
  assert.equal(await invoke('nexo:repetition:get', shell, { webContentsId: a.id, href: b.url }), null);
});

test('la navegación vacía el panel sin esperar otro snapshot; los temporales no se leen', async () => {
  a.navigateTo('https://chatgpt.com/c/nueva', 'ChatGPT');
  assert.equal(await invoke('nexo:repetition:get', shell, { webContentsId: a.id, href: 'https://chatgpt.com/c/a' }), null);
  assert.ok(shell.sent.some((entry) => entry.channel === 'nexo:repetition-changed' && entry.payload.webContentsId === a.id && entry.payload.href === null));
  a.navigateTo('https://chatgpt.com/?temporary-chat=true', 'Temporal');
  assert.equal((await invoke('nexo:repetition:snapshot', a, { href: a.url, turns })).ok, false);
});

test('al destruir la pestaña se elimina su copia volátil', async () => {
  b.emit('destroyed');
  assert.equal(await invoke('nexo:repetition:get', shell, { webContentsId: b.id, href: b.url }), null);
});


test('activar memoria actualiza el preload de webviews existentes, no sólo la shell', async () => {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/settings-live');
  const other = journal.windows[0].attachWebview('https://example.com/');
  await invoke('nexo:settings:set', shell, { enabled: false, memory: { enabled: true } });
  const config = view.sent.findLast(entry => entry.channel === 'nexo:settings')?.payload;
  assert.equal(config.settings.memory.enabled, true);
  assert.equal(config.enabled, false);
  assert.equal(other.sent.some(entry => entry.channel === 'nexo:settings'), false);
  await invoke('nexo:settings:set', shell, { enabled: false, memory: { enabled: false } });
  assert.equal(view.sent.findLast(entry => entry.channel === 'nexo:settings').payload.settings.memory.enabled, false);
});

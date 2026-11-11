/** Producción main/preload con Electron stub; no equivale a una cuenta real de ChatGPT. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startUnderstandingReader } from '../src/preload/understandingReader.js';
import { readUnderstandingDom } from '../src/core/understandingConversation.js';
import { EvoMemory } from '../src/memory/engine.js';
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
const historical = join(
    journal.userData,
    `nexo-understanding-${createHash('sha256').update('default').digest('hex').slice(0, 16)}.json`,
  ),
  historicalBytes =
    'HISTORIAL ANTIGUO DEL USUARIO: NO LEER, MIGRAR, BORRAR NI SOBRESCRIBIR';
writeFileSync(historical, historicalBytes);
await import('../src/main/main.js');
await new Promise((r) => setTimeout(r, 40));
const owner = journal.windows[0].webContents;
const event = (sender) => ({ sender, senderFrame: sender.mainFrame });
const invoke = (name, sender, p) =>
  journal.ipcHandlers.get(name)(event(sender), p);
const attach = (name) =>
  journal.windows[0].attachWebview(
    `https://chatgpt.com/c/new-optimizer-${name}`,
  );
const read = (g) =>
  invoke('nexo:understanding:read', owner, {
    webContentsId: g.id,
    includeText: true,
  });
const directive =
  'Modificar únicamente esta funcionalidad. Preservar EVO MEMORY, el lector DOM y los datos históricos. No cambiar identificadores, cifras ni resultados técnicos. Validar antes de continuar.';
function dom(g) {
  const nodes = Array.from({ length: 30 }, (_, i) => ({
    innerText: directive,
    getAttribute: (k) =>
      ({
        'data-message-id': `m${i}`,
        'data-message-author-role': i % 2 ? 'assistant' : 'user',
      })[k],
    querySelector: () => null,
  }));
  const document = {
    querySelectorAll: (s) => (s === '[data-message-author-role]' ? nodes : []),
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    location: { href: g.getURL() },
    addEventListener() {},
    removeEventListener() {},
  };
  return { nodes, document, window };
}
async function settled(g) {
  const first = await read(g);
  if (first.available && first.status !== 'analyzing') return first;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      owner.off('sent', change);
      reject(Error('main worker timeout'));
    }, 8000);
    async function change({ channel, payload }) {
      if (
        channel !== 'nexo:understanding-changed' ||
        payload.webContentsId !== g.id
      )
        return;
      const r = await read(g);
      if (r.status !== 'analyzing') {
        clearTimeout(timer);
        owner.off('sent', change);
        resolve(r);
      }
    }
    owner.on('sent', change);
  });
}
test('lector DOM → canal independiente → nuevo motor → read de shell; EVO off/on sin captura ni cambios de contadores', async () => {
  const original = EvoMemory.prototype.captureConversation;
  EvoMemory.prototype.captureConversation = () => {
    throw Error('captura EVO inesperada');
  };
  try {
    for (const enabled of [false, true]) {
      await invoke('nexo:settings:set', owner, {
        enabled,
        memory: { enabled: true },
      });
      const g = attach(String(enabled)),
        f = dom(g),
        channels = [];
      const before = await invoke('nexo:stats', owner);
      const reader = startUnderstandingReader({
        ...f,
        ipcRenderer: {
          invoke(c, p) {
            channels.push(c);
            return Promise.resolve(invoke(c, g, p));
          },
          send() {},
        },
      });
      try {
        reader.read();
        await new Promise((r) => setTimeout(r, 550));
        const r = await settled(g);
        assert.equal(r.status, 'optimized');
        assert.ok(r.metrics.saved > 0);
        assert.equal(r.source, 'dom');
        assert.equal(r.retainedMessages, 30);
        assert.ok(
          channels.every((c) => c === 'nexo:understanding:conversation'),
        );
        assert.deepEqual(await invoke('nexo:stats', owner), before);
      } finally {
        reader.disconnect();
      }
    }
  } finally {
    EvoMemory.prototype.captureConversation = original;
    await invoke('nexo:settings:set', owner, {
      enabled: true,
      memory: { enabled: true },
    });
  }
  assert.equal(readFileSync(historical, 'utf8'), historicalBytes);
});
test('ningún endpoint de gestión del motor anterior queda registrado', () => {
  for (const method of ['edit', 'recall', 'contexts', 'bind', 'clear'])
    assert.equal(
      journal.ipcHandlers.has(`nexo:understanding:${method}`),
      false,
    );
});
test('IPC dedicado rechaza shell, subframes, guest ajeno, URL cruzada, dominios ajenos y temporales', async () => {
  const g = attach('security'),
    f = dom(g),
    p = {
      href: g.getURL(),
      streaming: false,
      ...readUnderstandingDom(f.document),
    },
    handler = journal.ipcHandlers.get('nexo:understanding:conversation');
  assert.equal(invoke('nexo:understanding:conversation', owner, p).ok, false);
  assert.equal(handler({ sender: g, senderFrame: {} }, p).ok, false);
  assert.equal(handler({ sender: g }, p).ok, false);
  for (const href of [
    'https://chatgpt.com/c/other',
    g.getURL() + '?temporary-chat=true',
    'https://evil.example/c/x',
  ])
    assert.equal(
      invoke('nexo:understanding:conversation', g, { ...p, href }).ok,
      false,
    );
  const alien = {
    id: 987654,
    mainFrame: {},
    getType: () => 'webview',
    getURL: () => g.getURL(),
  };
  assert.equal(
    handler({ sender: alien, senderFrame: alien.mainFrame }, p).ok,
    false,
  );
  assert.equal(
    invoke('nexo:understanding:conversation', g, {
      ...p,
      turns: [{ role: 'system', content: 'false' }],
    }).code,
    'invalid',
  );
  assert.equal((await read(g)).available, false);
});
test('read sólo desde shell propietaria/mainFrame; página web no obtiene contexto ni métricas', async () => {
  const g = attach('read'),
    handler = journal.ipcHandlers.get('nexo:understanding:read');
  assert.equal(
    (await handler(event(g), { webContentsId: g.id })).code,
    'unauthorized',
  );
  assert.equal(
    (await handler({ sender: owner, senderFrame: {} }, { webContentsId: g.id }))
      .code,
    'unauthorized',
  );
  assert.equal(
    (await invoke('nexo:understanding:read', owner, { webContentsId: 987654 }))
      .ok,
    false,
  );
  assert.equal(
    (
      await invoke('nexo:understanding:read', owner, {
        webContentsId: g.id,
        includeText: 'yes',
      })
    ).code,
    'invalid',
  );
  await read(g);
  assert.ok(
    g.sent.some((e) => e.channel === 'nexo:understanding-read'),
    'caché ausente solicita relectura sin esperar un cambio DOM',
  );
});
test('EVO conserva captura independiente y datos al apagar; snapshot compartido no alimenta el optimizador', async () => {
  await invoke('nexo:settings:set', owner, {
    enabled: true,
    memory: { enabled: true },
  });
  const g = attach('evo'),
    f = dom(g),
    payload = {
      href: g.getURL(),
      streaming: false,
      turns: readUnderstandingDom(f.document).turns,
    };
  assert.equal(invoke('nexo:conversation-snapshot', g, payload).ok, true);
  const before = await invoke('nexo:memory:conversations', owner, {});
  assert.ok(before.some((c) => c.turns.some((t) => t.content === directive)));
  assert.equal((await read(g)).available, false);
  await invoke('nexo:settings:set', owner, {
    enabled: false,
    memory: { enabled: true },
  });
  const ack = invoke('nexo:conversation-snapshot', g, payload);
  assert.equal(ack.ok, true);
  assert.equal(ack.memoryDisabled, true);
  assert.deepEqual(await invoke('nexo:memory:conversations', owner, {}), []);
  await invoke('nexo:settings:set', owner, { enabled: true });
  assert.ok(
    (await invoke('nexo:memory:conversations', owner, {})).some((c) =>
      c.turns.some((t) => t.content === directive),
    ),
  );
  assert.equal(readFileSync(historical, 'utf8'), historicalBytes);
});

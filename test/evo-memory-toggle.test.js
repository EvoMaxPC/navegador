import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/main/engine.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings.js';
test('EVO global off bloquea lectura escritura búsqueda exportación e importación de memoria sin borrar', () => {
  const calls = [],
    memory = {
      list: () => {
        calls.push('list');
        return [{ id: 'retained', text: 'conservado' }];
      },
      stats: () => {
        calls.push('stats');
        return { total: 1 };
      },
      recall: () => {
        throw Error('recall inesperado');
      },
      handoff: () => {
        throw Error('export inesperado');
      },
      pin: () => {
        throw Error('pin inesperado');
      },
      forget: () => {
        throw Error('forget inesperado');
      },
      touch: () => {
        throw Error('touch inesperado');
      },
      importHandoff: () => {
        throw Error('import inesperado');
      },
      store: {
        add: () => {
          throw Error('captura inesperada');
        },
      },
    };
  const store = {
      settings: mergeSettings(DEFAULT_SETTINGS, {
        enabled: false,
        memory: { enabled: true },
      }),
    },
    engine = new Engine({ store, memory });
  assert.deepEqual(engine.memoryList(), []);
  assert.equal(engine.memoryStats().enabled, false);
  assert.deepEqual(engine.memoryRecall('privado'), []);
  assert.equal(engine.memoryHandoff(), null);
  assert.equal(engine.memoryPin('retained').ok, false);
  assert.equal(engine.memoryForget('retained').ok, false);
  assert.equal(engine.memoryTouch('retained').ok, false);
  assert.equal(engine.memoryImport({ items: [] }).added, 0);
  assert.equal(
    engine.onCdpCapture(1, {
      host: 'chatgpt.com',
      site: 'chatgpt',
      documentUrl: 'https://chatgpt.com/c/toggle',
      text: 'No guardar',
    }).skipped,
    'disabled',
  );
  assert.deepEqual(calls, []);
  store.settings.enabled = true;
  assert.equal(engine.memoryList()[0].text, 'conservado');
  assert.equal(engine.memoryStats().enabled, true);
  assert.deepEqual(calls, ['list', 'stats']);
});
test('guards existentes desconectan EVO al apagar cualquiera de los dos gates y recuperan sólo si ambos permiten', () => {
  const store = { settings: mergeSettings(DEFAULT_SETTINGS, {}) },
    memory = {},
    engine = new Engine({ store, memory }),
    guard = { host: 'chatgpt.com', memory, setSettings() {} };
  engine.guards.set(1, guard);
  store.settings.enabled = false;
  engine.refresh();
  assert.equal(guard.memory, null);
  store.settings.enabled = true;
  store.settings.memory.enabled = false;
  engine.refresh();
  assert.equal(guard.memory, null);
  store.settings.memory.enabled = true;
  engine.refresh();
  assert.equal(guard.memory, memory);
});

test('shell: apagar limpia vista/cache/paquete EVO y descarta estadísticas pendientes sin frenar Comprensión', async () => {
  const { readFileSync } = await import('node:fs'),
    { runInNewContext } = await import('node:vm'),
    { isEvoMemoryEnabled } = await import('../src/core/settings.js'),
    { setMemoryPanelAvailability } = await import(
      '../src/ui/shell/memoryPanel.js'
    );
  const source = readFileSync(
      new URL('../src/ui/shell/app.js', import.meta.url),
      'utf8',
    ),
    snippet = source.slice(
      source.indexOf('function syncMemoryAvailability()'),
      source.indexOf("MEM.conversations.closest('details').addEventListener"),
    );
  const node = () => ({
      value: 'privado',
      textContent: 'privado',
      dataset: {},
      replaceChildren() {
        this.textContent = '';
      },
    }),
    nodes = new Map(),
    root = {
      classList: {
        toggle(_c, v) {
          this.disabled = v;
        },
      },
      querySelector: () => notice,
    },
    notice = { hidden: true };
  const MEM = Object.fromEntries(
    [
      'list',
      'conversations',
      'packet',
      'items',
      'tokens',
      'saved',
      'legend',
      'file',
      'context',
      'captureCurrent',
      'captureSaved',
      'captureConversations',
      'captureDot',
      'captureStatus',
      'captureDetail',
    ].map((k) => [k, node()]),
  );
  const memState = {
      stats: { tokens: 99 },
      items: [{ text: 'privado' }],
      conversations: [{ turns: [{ content: 'privado' }] }],
      liveSnapshot: { turns: [{ content: 'privado' }] },
      lastPacket: { markdown: 'privado' },
    },
    state = { settings: { enabled: true, memory: { enabled: true } } };
  let release,
    listCalls = 0;
  const ctx = {
    MEM,
    memState,
    state,
    isEvoMemoryEnabled,
    setMemoryPanelAvailability,
    document: {
      getElementById: (id) =>
        id === 'panel-memory'
          ? root
          : nodes.get(id) || nodes.set(id, node()).get(id),
    },
    memoryLiveView: {
      render(snapshot) {
        this.snapshot = snapshot;
      },
    },
    repetitionSource: () => null,
    activeTab: () => null,
    sameConversationSource: () => true,
    renderChatCapture() {},
    nexo: {
      memory: {
        stats: () => new Promise((resolve) => (release = resolve)),
        list: () => {
          listCalls++;
          return [{ text: 'no mostrar' }];
        },
      },
    },
  };
  runInNewContext(
    `let memoryRefreshTicket=0,memoryLiveRevision=0,memoryRegistryLoaded=true;${snippet}\nglobalThis.testApi={refreshMemory,syncMemoryAvailability};`,
    ctx,
  );
  const pending = ctx.testApi.refreshMemory();
  state.settings.enabled = false;
  ctx.testApi.syncMemoryAvailability();
  release({ tokens: 999 });
  await pending;
  assert.equal(listCalls, 0);
  assert.equal(memState.items.length, 0);
  assert.equal(memState.conversations.length, 0);
  assert.equal(memState.liveSnapshot, null);
  assert.equal(memState.lastPacket, null);
  assert.equal(MEM.packet.value, '');
  assert.equal(MEM.tokens.textContent, '0');
  assert.equal(root.classList.disabled, true);
  assert.equal(notice.hidden, false);
  assert.match(MEM.captureDetail.textContent, /Comprensión sigue activa/);
  await ctx.testApi.refreshMemory();
  assert.equal(listCalls, 0);
});

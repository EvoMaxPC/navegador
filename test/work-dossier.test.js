import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  emptyDossier,
  mutateDossier,
  validateDossier,
  workspaceKey,
  dossierMarkdown,
} from '../src/nav/workDossier.js';
import { DossierStore, installWorkDossier } from '../src/main/workDossier.js';

let sequence = 0;
function mutate(d, operation, source) {
  return mutateDossier(
    d,
    { revision: d.revision, ...operation },
    { now: 1000 + ++sequence, id: `item-${sequence}`, source },
  );
}
const source = {
  url: 'https://example.test/specs',
  title: 'Especificaciones',
  quote: 'Memoria ampliable a 64 GB.',
  capturedAt: 900,
};
function goal() {
  return mutate(emptyDossier('main', 100), {
    type: 'goal',
    text: 'Elegir equipo de desarrollo',
    criteria: ['Memoria ampliable'],
  });
}

test('objetivo, criterios y continuación se guardan sin modificar el objeto anterior', () => {
  const d = emptyDossier('main', 100),
    g = mutate(d, {
      type: 'goal',
      text: 'Investigar',
      criteria: ['Documentar fuentes'],
    });
  assert.equal(d.goal.text, '');
  assert.equal(g.goal.revision, 1);
  assert.equal(g.revision, 1);
  const next = mutate(g, { type: 'continuation', text: 'Comprobar garantía' });
  assert.equal(next.nextStep, 'Comprobar garantía');
  assert.equal(next.goalHistory.length, 0);
});
test('cambiar criterios conserva revisión anterior y marca decisiones', () => {
  let d = mutate(goal(), {
    type: 'add-decision',
    text: 'Priorizar ampliación',
    evidenceIds: [],
  });
  d = mutate(d, {
    type: 'goal',
    text: d.goal.text,
    criteria: ['32 GB incluidos'],
  });
  assert.equal(d.goalHistory[0].criteria[0], 'Memoria ampliable');
  assert.equal(d.goal.revision, 2);
  assert.equal(d.decisions[0].needsReview, true);
  d = mutate(d, { type: 'review-decision', id: d.decisions[0].id });
  assert.equal(d.decisions[0].needsReview, false);
  assert.equal(d.decisions[0].goalRevision, 2);
});
test('guardar el mismo objetivo no crea revisión semántica nueva', () => {
  const d = goal();
  const next = mutate(d, {
    type: 'goal',
    text: d.goal.text,
    criteria: d.goal.criteria,
  });
  assert.equal(next.goal.revision, 1);
  assert.equal(next.goalHistory.length, 0);
});
test('evidencias nativas conservan fuente, fecha, truncado e incertidumbre', () => {
  const d = mutate(
    goal(),
    { type: 'capture-evidence', annotation: 'Comprobar variante' },
    { ...source, clipped: true },
  );
  assert.equal(d.evidence[0].review, 'unverified');
  assert.equal(d.evidence[0].method, 'native-selection');
  assert.equal(d.evidence[0].clipped, true);
  assert.equal(d.evidence[0].capturedAt, 900);
  assert.equal(d.resources[0].url, source.url);
  const literal = mutate(
    goal(),
    { type: 'capture-evidence' },
    { ...source, quote: '  línea uno\n  línea dos  ' },
  );
  assert.equal(literal.evidence[0].quote, '  línea uno\n  línea dos  ');
  assert.throws(
    () => mutate(d, { type: 'capture-evidence' }),
    /selección nativa/,
  );
});
test('fuentes idénticas no duplican recursos y notas no se convierten en citas', () => {
  let d = mutate(goal(), { type: 'attach-tab' }, source);
  d = mutate(d, { type: 'capture-evidence' }, source);
  d = mutate(d, { type: 'capture-evidence' }, source);
  d = mutate(d, { type: 'add-note', text: 'Creo que es adecuado' });
  assert.equal(d.resources.length, 1);
  assert.equal(d.evidence.length, 2);
  assert.equal(d.notes.length, 1);
});
test('eliminar evidencia quita su contenido y señala decisiones afectadas', () => {
  let d = mutate(goal(), { type: 'capture-evidence' }, source);
  const id = d.evidence[0].id;
  d = mutate(d, {
    type: 'add-decision',
    text: 'Elegir candidato',
    evidenceIds: [id],
  });
  assert.throws(
    () =>
      mutate(d, {
        type: 'remove',
        collection: 'resources',
        id: d.resources[0].id,
      }),
    /evidencias/,
  );
  d = mutate(d, { type: 'remove', collection: 'evidence', id });
  assert.equal(d.evidence.length, 0);
  assert.deepEqual(d.decisions[0].evidenceIds, []);
  assert.equal(d.decisions[0].needsReview, true);
  assert.ok(!JSON.stringify(d).includes(source.quote));
});
test('referencias inexistentes, tareas inválidas y decisiones sin objetivo se rechazan', () => {
  assert.throws(
    () =>
      mutate(goal(), {
        type: 'add-decision',
        text: 'Decisión',
        evidenceIds: ['missing'],
      }),
    /registro/,
  );
  assert.throws(
    () =>
      mutate(emptyDossier('main'), {
        type: 'add-decision',
        text: 'Decisión',
        evidenceIds: [],
      }),
    /objetivo/,
  );
  const d = mutate(goal(), { type: 'add-task', text: 'Verificar garantía' });
  assert.throws(
    () =>
      mutate(d, {
        type: 'task-status',
        id: d.tasks[0].id,
        status: 'automated',
      }),
    /Opción/,
  );
  const next = mutate(d, {
    type: 'task-status',
    id: d.tasks[0].id,
    status: 'done',
  });
  assert.equal(next.tasks[0].status, 'done');
  assert.equal(next.goal.revision, d.goal.revision);
});
test('preferencias explícitas están acotadas al expediente', () => {
  const a = mutate(goal(), {
    type: 'preferences',
    detail: 'compact',
    start: 'tasks',
  });
  assert.equal(a.preferences.start, 'tasks');
  assert.equal(emptyDossier('other').preferences.start, 'continue');
  assert.throws(
    () =>
      mutate(a, {
        type: 'preferences',
        detail: 'secret-learning',
        start: 'tasks',
      }),
    /Opción/,
  );
});
test('control de revisión rechaza escrituras viejas o sin revisión', () => {
  const d = goal();
  for (const revision of [0, -1, undefined, NaN, '1'])
    assert.throws(
      () =>
        mutateDossier(
          d,
          { type: 'add-note', text: 'Nota', revision },
          { id: 'x' },
        ),
      (e) => e.code === 'conflict',
    );
});
test('validación de rutas, URLs, longitudes y operaciones arbitrarias', () => {
  for (const id of ['../secret', 'main/x', '__proto__', '', null])
    assert.throws(() => workspaceKey(id));
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.test/',
  ])
    assert.throws(() =>
      mutate(goal(), { type: 'attach-tab' }, { ...source, url }),
    );
  assert.throws(() =>
    mutate(goal(), { type: 'goal', text: 'x'.repeat(2001), criteria: [] }),
  );
  assert.throws(() =>
    mutate(
      goal(),
      { type: 'capture-evidence' },
      { ...source, quote: 'x'.repeat(8001) },
    ),
  );
  assert.throws(() => mutate(goal(), { type: 'execute-code' }), /permitida/);
});
test('archivos incompatibles, referencias rotas e IDs repetidos no se aceptan', () => {
  assert.throws(() => validateDossier({ ...goal(), version: 99 }, 'main'));
  assert.throws(() => validateDossier(goal(), 'other'));
  const d = mutate(goal(), { type: 'add-note', text: 'Nota' });
  d.notes.push({ ...d.notes[0] });
  assert.throws(() => validateDossier(d, 'main'));
  const broken = mutate(goal(), { type: 'capture-evidence' }, source);
  broken.resources = [];
  assert.throws(() => validateDossier(broken, 'main'));
});
test('los límites no podan evidencia ni historial silenciosamente', () => {
  const d = goal();
  d.notes = Array.from({ length: 200 }, (_, i) => ({
    id: `n-${i}`,
    text: 'Nota',
    createdAt: 1,
  }));
  assert.throws(() => mutate(d, { type: 'add-note', text: 'Otra' }), /límite/);
  const g = goal();
  g.goalHistory = Array.from({ length: 50 }, () => ({
    text: 'Anterior',
    criteria: [],
    revision: 1,
    archivedAt: 1,
  }));
  assert.throws(
    () => mutate(g, { type: 'goal', text: 'Otro objetivo', criteria: [] }),
    /50 revisiones/,
  );
});
test('exportación mantiene citas, decisiones y faltantes sin llamar verificado al contenido', () => {
  let d = mutate(
    goal(),
    { type: 'capture-evidence', annotation: '<script>test</script>' },
    source,
  );
  d = mutate(d, {
    type: 'add-decision',
    text: 'Candidato',
    evidenceIds: [d.evidence[0].id],
  });
  const markdown = dossierMarkdown(d);
  assert.match(markdown, /Sin verificar/);
  assert.match(markdown, /Sin punto de continuación/);
  assert.ok(markdown.includes(source.url));
  assert.ok(!markdown.includes('<script>'));
  assert.match(markdown, /declarada por el usuario/);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nexo-dossier-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new DossierStore(directory) };
}
test('persistencia real: nuevo almacén retoma objetivo, preferencias y pendiente', async (t) => {
  const { directory, store } = await fixture(t);
  let d = await store.change('main', {
    revision: 0,
    type: 'goal',
    text: 'Investigar',
    criteria: ['Citar'],
  });
  d = await store.change('main', {
    revision: d.revision,
    type: 'preferences',
    detail: 'compact',
    start: 'tasks',
  });
  d = await store.change('main', {
    revision: d.revision,
    type: 'continuation',
    text: 'Consultar garantía',
  });
  assert.deepEqual(await new DossierStore(directory).read('main'), d);
  assert.equal((await store.read('other')).goal.text, '');
  assert.deepEqual(await readdir(directory), ['main.json']);
});
test('dos escritores de la misma revisión: sólo uno confirma', async (t) => {
  const { store } = await fixture(t);
  const result = await Promise.allSettled([
    store.change('main', { revision: 0, type: 'add-note', text: 'Primera' }),
    store.change('main', { revision: 0, type: 'add-note', text: 'Segunda' }),
  ]);
  assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    result.find((x) => x.status === 'rejected').reason.code,
    'conflict',
  );
  assert.equal((await store.read('main')).notes.length, 1);
});
test('archivo corrupto no se sobrescribe ni se interpreta como vacío', async (t) => {
  const { store, directory } = await fixture(t);
  const path = join(directory, 'main.json');
  await writeFile(path, '{broken');
  await assert.rejects(store.read('main'), (e) => e.code === 'storage');
  await assert.rejects(
    store.change('main', { revision: 0, type: 'add-note', text: 'Nota' }),
  );
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
test('fallo de rename no confirma ni modifica el expediente anterior y limpia temporales', async (t) => {
  const { store, directory } = await fixture(t);
  await store.change('main', {
    revision: 0,
    type: 'add-note',
    text: 'Original',
  });
  const failing = new DossierStore(directory, {
    io: {
      mkdir,
      readFile,
      writeFile,
      stat,
      unlink,
      rename: async () => {
        throw Error('disk failed');
      },
    },
  });
  await assert.rejects(
    failing.change('main', {
      revision: 1,
      type: 'add-note',
      text: 'No guardada',
    }),
  );
  const d = await store.read('main');
  assert.equal(d.revision, 1);
  assert.equal(d.notes.length, 1);
  assert.deepEqual(await readdir(directory), ['main.json']);
});
test('eliminar vacía el expediente, conserva revisión y bloquea resurrección por escritor viejo', async (t) => {
  const { store } = await fixture(t);
  await store.change('main', {
    revision: 0,
    type: 'add-note',
    text: 'Privado',
  });
  const cleared = await store.clear('main', 1);
  assert.equal(cleared.revision, 2);
  assert.equal(cleared.notes.length, 0);
  await assert.rejects(
    store.change('main', { revision: 1, type: 'add-note', text: 'Vieja' }),
    (e) => e.code === 'conflict',
  );
  assert.ok(!JSON.stringify(await store.read('main')).includes('Privado'));
});

async function ipcFixture(t) {
  const { store, directory } = await fixture(t);
  const handlers = new Map(),
    events = [];
  const owner = new EventEmitter();
  Object.assign(owner, {
    id: 1,
    mainFrame: {},
    getURL: () => 'nexo://app/src/ui/shell/index.html',
    isDestroyed: () => false,
    send: (name, payload) => events.push({ name, payload }),
  });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const guest = { getURL: () => source.url, getTitle: () => source.title };
  let response = 0,
    clock = 1000;
  const deps = {
    now: () => clock,
    store,
    app: { getPath: () => directory },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: owner }],
      fromWebContents: () => ({}),
    },
    dialog: {
      showMessageBox: async () => ({ response }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    getWorkspaceIds: () => ['main', 'other'],
    resolveGuest: (sender, id) => {
      if (sender !== owner || id !== 42) throw Error('foreign');
      return guest;
    },
    broadcast: (name, payload) => events.push({ name, payload }),
  };
  const api = installWorkDossier(deps);
  api.attachShell(owner);
  return {
    store,
    handlers,
    events,
    owner,
    event,
    api,
    deps,
    advance: () => {
      clock += 120001;
    },
    confirm: () => {
      response = 1;
    },
    call: (name, payload = {}, e = event) =>
      handlers.get(`nexo:work:${name}`)(e, { workspaceId: 'main', ...payload }),
  };
}
test('todos los IPC exigen shell real, frame principal y espacio configurado', async (t) => {
  const f = await ipcFixture(t);
  assert.equal(f.handlers.size, 6);
  for (const name of [
    'read',
    'mutate',
    'attach',
    'capture',
    'clear',
    'export',
  ]) {
    assert.equal(
      (await f.call(name, {}, { sender: f.owner, senderFrame: {} })).code,
      'unauthorized',
    );
    const impostor = {
      ...f.owner,
      getURL: f.owner.getURL,
      isDestroyed: () => false,
    };
    assert.equal(
      (
        await f.call(
          name,
          {},
          { sender: impostor, senderFrame: impostor.mainFrame },
        )
      ).code,
      'unauthorized',
    );
    assert.equal((await f.call(name, { workspaceId: 'missing' })).ok, false);
  }
  assert.equal((await f.call('read')).ok, true);
});
test('el renderer no puede inventar una evidencia ni suministrar su propia URL privilegiada', async (t) => {
  const f = await ipcFixture(t);
  assert.equal(
    (
      await f.call('mutate', {
        operation: {
          type: 'capture-evidence',
          revision: 0,
          quote: 'Fake',
          url: 'https://fake.test',
        },
      })
    ).ok,
    false,
  );
  assert.equal(
    (await f.call('capture', { revision: 0, token: 'invented' })).ok,
    false,
  );
  assert.equal(
    (await f.call('attach', { revision: 0, webContentsId: 99 })).ok,
    false,
  );
  const result = await f.call('attach', {
    revision: 0,
    webContentsId: 42,
    url: 'https://fake.test',
  });
  assert.equal(result.dossier.resources[0].url, source.url);
});
test('capacidad nativa: captura requiere token, se consume una vez y no incluye contraseñas', async (t) => {
  const f = await ipcFixture(t);
  f.api.captureSelection(
    f.owner,
    { getURL: () => source.url, getTitle: () => source.title },
    { selectionText: 'secreto', inputFieldType: 'password' },
  );
  assert.equal(f.events.length, 0);
  f.api.captureSelection(
    f.owner,
    { getURL: () => source.url, getTitle: () => source.title },
    { selectionText: source.quote },
  );
  const draft = f.events[0].payload;
  assert.equal(
    (await f.call('capture', { revision: 0, token: 'wrong' })).ok,
    false,
  );
  const result = await f.call('capture', {
    revision: 0,
    token: draft.token,
    annotation: 'Revisar',
  });
  assert.equal(result.ok, true);
  assert.equal(result.dossier.evidence[0].quote, source.quote);
  assert.equal(
    (await f.call('capture', { revision: 1, token: draft.token })).ok,
    false,
  );
});
test('draft se invalida al destruir la shell y se trunca explícitamente', async (t) => {
  const f = await ipcFixture(t);
  f.api.captureSelection(
    f.owner,
    { getURL: () => source.url, getTitle: () => source.title },
    { selectionText: 'x'.repeat(9000) },
  );
  const draft = f.events[0].payload;
  assert.equal(draft.quote.length, 8000);
  assert.equal(draft.clipped, true);
  f.owner.emit('destroyed');
  assert.equal(
    (await f.call('capture', { revision: 0, token: draft.token })).ok,
    false,
  );
});
test('eliminar requiere confirmación nativa y no borra si se cancela', async (t) => {
  const f = await ipcFixture(t);
  await f.store.change('main', {
    revision: 0,
    type: 'add-note',
    text: 'Conservar',
  });
  assert.equal((await f.call('clear', { revision: 1 })).cancelled, true);
  assert.equal((await f.store.read('main')).notes.length, 1);
  f.confirm();
  assert.equal((await f.call('clear', { revision: 1 })).ok, true);
  assert.equal((await f.store.read('main')).notes.length, 0);
});
test('exportar cancelado no escribe un destino sugerido por renderer', async (t) => {
  const f = await ipcFixture(t);
  assert.equal(
    (await f.call('export', { format: 'json', filePath: 'evil.json' }))
      .cancelled,
    true,
  );
  assert.deepEqual(await readdir(f.store.directory), []);
});

test('la capacidad de selección caduca y no se comparte entre shells autorizadas', async (t) => {
  const f = await ipcFixture(t);
  f.api.captureSelection(
    f.owner,
    { getURL: () => source.url, getTitle: () => source.title },
    { selectionText: source.quote },
  );
  const draft = f.events[0].payload;
  const other = new EventEmitter();
  Object.assign(other, {
    id: 2,
    mainFrame: {},
    getURL: () => 'nexo://app/src/ui/shell/index.html',
    isDestroyed: () => false,
  });
  f.deps.BrowserWindow.getAllWindows = () => [
    { webContents: f.owner },
    { webContents: other },
  ];
  assert.equal(
    (
      await f.call(
        'capture',
        { token: draft.token, revision: 0 },
        { sender: other, senderFrame: other.mainFrame },
      )
    ).code,
    'expired',
  );
  f.advance();
  assert.equal(
    (await f.call('capture', { token: draft.token, revision: 0 })).code,
    'expired',
  );
  assert.equal((await f.store.read('main')).evidence.length, 0);
});

test('integración pública y paquete incluyen la vista y no publican el servicio main', async () => {
  const { isPublicAssetPath } = await import('../src/main/internalAssets.js');
  const { requiredAsarEntries, isIgnored } = await import(
    '../scripts/packaging-config.mjs'
  );
  for (const path of [
    'src/main/workDossier.js',
    'src/nav/workDossier.js',
    'src/ui/shell/workDossier.js',
    'src/ui/shell/workDossier.css',
  ]) {
    assert.ok(requiredAsarEntries.includes(path));
    assert.equal(isIgnored(path), false);
  }
  assert.equal(isPublicAssetPath('src/main/workDossier.js'), false);
  assert.equal(isPublicAssetPath('src/ui/shell/workDossier.js'), true);
  assert.equal(isPublicAssetPath('src/ui/shell/workDossier.css'), true);
});

test('exportación real escribe sólo el destino del diálogo y conserva advertencias', async (t) => {
  const f = await ipcFixture(t);
  await f.store.change('main', {
    revision: 0,
    type: 'goal',
    text: 'Comparar fuentes',
    criteria: ['Citas'],
  });
  for (const [format, extension] of [
    ['json', 'json'],
    ['markdown', 'md'],
  ]) {
    const filePath = join(f.store.directory, `exportado.${extension}`);
    f.deps.dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    const result = await f.call('export', {
      format,
      filePath: join(f.store.directory, 'no-elegido'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.exportedRevision, 1);
    const raw = await readFile(filePath, 'utf8');
    if (format === 'json')
      assert.equal(JSON.parse(raw).goal.text, 'Comparar fuentes');
    else {
      assert.match(raw, /Comparar fuentes/);
      assert.match(raw, /no equivalen a hechos verificados/);
    }
  }
  assert.ok(!(await readdir(f.store.directory)).includes('no-elegido'));
});

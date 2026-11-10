/** Coordinación de expedientes: disco y capacidades sólo en main. Nunca llama a EVO/CDP/red. */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  DossierError,
  MAX_DOSSIER_BYTES,
  emptyDossier,
  validateDossier,
  mutateDossier,
  workspaceKey,
  dossierMarkdown,
} from '../nav/workDossier.js';

export class DossierStore {
  constructor(
    directory,
    {
      io = { mkdir, readFile, rename, stat, unlink, writeFile },
      now = Date.now,
      uuid = randomUUID,
    } = {},
  ) {
    this.directory = directory;
    this.io = io;
    this.now = now;
    this.uuid = uuid;
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  path(id) {
    return join(this.directory, `${workspaceKey(id)}.json`);
  }
  async load(id) {
    const path = this.path(id);
    let raw;
    try {
      if ((await this.io.stat(path)).size > MAX_DOSSIER_BYTES)
        throw new Error('Archivo demasiado grande');
      raw = await this.io.readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyDossier(id, this.now());
      throw new DossierError(
        'No se pudo leer el expediente; no se sobrescribirá.',
        'storage',
      );
    }
    try {
      if (Buffer.byteLength(raw, 'utf8') > MAX_DOSSIER_BYTES)
        throw new Error('Archivo demasiado grande');
      return validateDossier(JSON.parse(raw), id);
    } catch {
      throw new DossierError(
        'Expediente inválido o incompatible. Conservamos el archivo sin sobrescribirlo.',
        'storage',
      );
    }
  }
  read(id) {
    return this.serial(() => this.load(id));
  }
  async save(d) {
    validateDossier(d, d.workspaceId);
    const path = this.path(d.workspaceId),
      tmp = `${path}.${this.uuid()}.tmp`;
    await this.io.mkdir(this.directory, { recursive: true });
    try {
      await this.io.writeFile(tmp, JSON.stringify(d), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await this.io.rename(tmp, path);
    } finally {
      await this.io.unlink(tmp).catch(() => {});
    }
    return d;
  }
  change(id, input, source = null) {
    return this.serial(async () => {
      const previous = await this.load(id);
      const next = mutateDossier(previous, input, {
        now: this.now(),
        id: this.uuid(),
        source,
      });
      return this.save(next);
    });
  }
  clear(id, revision) {
    return this.serial(async () => {
      const previous = await this.load(id);
      if (!Number.isSafeInteger(revision) || revision !== previous.revision)
        throw new DossierError(
          'El expediente cambió. Recargá antes de eliminarlo.',
          'conflict',
        );
      // Registro vacío con revisión monotónica: un editor viejo no puede resucitar datos.
      const next = emptyDossier(id, this.now());
      next.revision = previous.revision + 1;
      return this.save(next);
    });
  }
}

export function installWorkDossier({
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  getWorkspaceIds,
  resolveGuest,
  broadcast,
  store = new DossierStore(join(app.getPath('userData'), 'work-dossiers')),
  now = Date.now,
}) {
  const drafts = new Map();
  function trusted(event) {
    return Boolean(
      event?.senderFrame &&
        event.senderFrame === event.sender?.mainFrame &&
        !event.sender.isDestroyed() &&
        event.sender.getURL() === 'nexo://app/src/ui/shell/index.html' &&
        BrowserWindow.getAllWindows().some(
          (w) => w.webContents === event.sender,
        ),
    );
  }
  function workspace(value) {
    const id = workspaceKey(value);
    if (!getWorkspaceIds().includes(id))
      throw new DossierError('Este espacio ya no está disponible');
    return id;
  }
  function sourceOf(contents) {
    const url = contents.getURL();
    const parsed = new URL(url);
    if (
      url.length > 2048 ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new DossierError(
        'Elegí una página HTTP(S) sin credenciales en la dirección',
      );
    return {
      url: parsed.href,
      title: String(contents.getTitle() || '').slice(0, 300),
      capturedAt: now(),
    };
  }
  const changed = (d) =>
    broadcast('nexo:work-changed', {
      workspaceId: d.workspaceId,
      revision: d.revision,
    });
  function register(name, handler) {
    ipcMain.handle(`nexo:work:${name}`, async (event, payload) => {
      if (!trusted(event))
        return {
          ok: false,
          code: 'unauthorized',
          error: 'Remitente no autorizado',
        };
      try {
        if (
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          JSON.stringify(payload).length > 20_000
        )
          throw new DossierError('Solicitud inválida');
        const id = workspace(payload.workspaceId);
        return await handler(event, payload, id);
      } catch (error) {
        return {
          ok: false,
          code: error instanceof DossierError ? error.code : 'storage',
          error:
            error instanceof DossierError
              ? error.message
              : 'No se pudo completar la operación de disco. Tus cambios no se confirmaron.',
        };
      }
    });
  }
  register('read', async (_e, _p, id) => ({
    ok: true,
    dossier: await store.read(id),
  }));
  register('mutate', async (_e, p, id) => {
    const allowed = [
      'goal',
      'continuation',
      'preferences',
      'add-task',
      'task-status',
      'add-note',
      'add-decision',
      'review-decision',
      'remove',
    ];
    if (!allowed.includes(p.operation?.type))
      throw new DossierError('Acción no permitida');
    const d = await store.change(id, p.operation);
    changed(d);
    return { ok: true, dossier: d };
  });
  register('attach', async (event, p, id) => {
    if (!Number.isSafeInteger(p.webContentsId) || p.webContentsId < 1)
      throw new DossierError('Identificador de pestaña inválido');
    let contents;
    try {
      contents = resolveGuest(event.sender, p.webContentsId);
    } catch {
      throw new DossierError('Pestaña ajena o cerrada', 'unauthorized');
    }
    const d = await store.change(
      id,
      { type: 'attach-tab', revision: p.revision },
      sourceOf(contents),
    );
    changed(d);
    return { ok: true, dossier: d };
  });
  register('capture', async (event, p, id) => {
    const draft = drafts.get(event.sender.id);
    if (!draft || draft.token !== p.token || draft.expires < now())
      throw new DossierError(
        'La selección expiró. Volvé a abrir su menú contextual.',
        'expired',
      );
    // Capacidad de un solo uso, incluso si el guardado falla. No reutilizar una autorización.
    drafts.delete(event.sender.id);
    const d = await store.change(
      id,
      {
        type: 'capture-evidence',
        revision: p.revision,
        annotation: p.annotation,
      },
      draft.source,
    );
    changed(d);
    return { ok: true, dossier: d };
  });
  register('clear', async (event, p, id) => {
    const { response } = await dialog.showMessageBox(
      BrowserWindow.fromWebContents(event.sender),
      {
        type: 'warning',
        message: '¿Eliminar el expediente de este espacio?',
        detail:
          'Se quitarán objetivo, revisiones, evidencias, tareas, notas, decisiones y preferencias. No se borran páginas, archivos descargados ni EVO MEMORY. Las exportaciones previas no se eliminan.',
        buttons: ['Cancelar', 'Eliminar expediente'],
        defaultId: 0,
        cancelId: 0,
      },
    );
    if (response !== 1) return { ok: false, cancelled: true };
    if (!trusted(event))
      throw new DossierError('La ventana ya no está disponible');
    const d = await store.clear(id, p.revision);
    changed(d);
    return { ok: true, dossier: d };
  });
  register('export', async (event, p, id) => {
    if (!['json', 'markdown'].includes(p.format))
      throw new DossierError('Formato inválido');
    const d = await store.read(id);
    const markdown = p.format === 'markdown';
    const result = await dialog.showSaveDialog(
      BrowserWindow.fromWebContents(event.sender),
      {
        title: 'Exportar expediente local — puede contener información privada',
        defaultPath: join(
          app.getPath('documents'),
          `NEXO-expediente-${id}.${markdown ? 'md' : 'json'}`,
        ),
        filters: [
          {
            name: markdown ? 'Markdown' : 'JSON',
            extensions: [markdown ? 'md' : 'json'],
          },
        ],
      },
    );
    if (result.canceled || !result.filePath)
      return { ok: false, cancelled: true };
    if (!trusted(event))
      throw new DossierError('La ventana ya no está disponible');
    await writeFile(
      result.filePath,
      markdown ? dossierMarkdown(d) : JSON.stringify(d, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    return { ok: true, exportedRevision: d.revision };
  });
  return {
    captureSelection(owner, contents, params) {
      if (
        owner.isDestroyed() ||
        params.inputFieldType === 'password' ||
        !String(params.selectionText || '').trim()
      )
        return;
      const source = {
        ...sourceOf(contents),
        quote: String(params.selectionText).slice(0, 8000),
        clipped: params.selectionText.length > 8000,
      };
      const token = randomUUID();
      drafts.set(owner.id, { token, source, expires: now() + 120_000 });
      owner.send('nexo:work-capture', { token, ...source });
    },
    attachShell(owner) {
      owner.once('destroyed', () => drafts.delete(owner.id));
    },
  };
}

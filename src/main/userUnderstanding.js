/** UUE main: usa la persistencia atómica existente de EVO, sin cambiar sus archivos. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { fileStorage } from './memory.js';
import { isAiHost } from '../core/cdp.js';
import {
  newUnderstanding,
  updateUnderstanding,
  effectiveUnderstanding,
  validateUnderstanding,
  UnderstandingError,
  userText,
  FIELDS,
} from '../core/userUnderstanding.js';
const hash = (text) => createHash('sha256').update(text).digest('hex');
export class UserUnderstandingService {
  constructor({
    storage,
    memory = null,
    enabled = () => true,
    now = Date.now,
    notify = () => {},
    file = null,
  } = {}) {
    this.storage = storage || (file ? fileStorage(file) : null);
    this.memory = memory;
    this.enabled = enabled;
    this.now = now;
    this.notify = notify;
    this.projectId = memory?.projectId || 'default';
    this.session = randomUUID();
    this.bindings = new Map();
    this.reports = new Map();
    this.recent = new Map();
    this.data = { version: 1, contexts: [], deleted_revisions: {} };
    this.loadError = null;
    try {
      if (file && existsSync(file) && statSync(file).size > 8_000_000)
        throw Error('size');
      const raw = this.storage?.read();
      if (file && existsSync(file) && raw === null) throw Error('read');
      if (raw) {
        const d = JSON.parse(raw);
        this.validateData(d);
        this.data = d;
      }
      // Instrucciones temporales expiran; la última tarea se conserva como referencia inferida.
      for (const row of this.data.contexts) {
        for (const field of FIELDS) {
          const retained = [];
          for (const e of row.state[field]) {
            if (e.scope !== 'session' || e.status !== 'active') {
              retained.push(e);
              continue;
            }
            const expired = { ...e, status: 'obsolete', updated_at: now() };
            // Nunca bloquear la lectura o descartar una regla porque el historial se llenó.
            if (row.state.instruction_history.length < 400)
              row.state.instruction_history.push(expired);
            else retained.push(expired);
          }
          row.state[field] = retained;
        }
        for (const q of row.state.pending_questions)
          if (q.status === 'open' && q.proposed?.scope === 'session') {
            q.status = 'rejected';
            q.resolved_at = now();
          }
        if (row.state.current_task)
          row.state.current_task.validity = 'last-known';
      }
    } catch {
      this.loadError =
        'El archivo de comprensión es ilegible, demasiado grande o incompatible. No se sobrescribirá.';
    }
  }
  validateData(d) {
    if (
      !d ||
      d.version !== 1 ||
      !Array.isArray(d.contexts) ||
      d.contexts.length > 50 ||
      !d.deleted_revisions ||
      typeof d.deleted_revisions !== 'object' ||
      Array.isArray(d.deleted_revisions)
    )
      throw Error('schema');
    const ids = new Set();
    for (const row of d.contexts) {
      validateUnderstanding(row.state);
      if (
        !/^c-[a-f0-9]{32}$/.test(row.state.context_id) ||
        ids.has(row.state.context_id) ||
        typeof row.url !== 'string' ||
        row.url.length > 2048
      )
        throw Error('context');
      ids.add(row.state.context_id);
    }
    for (const [id, revision] of Object.entries(d.deleted_revisions))
      if (
        !/^c-[a-f0-9]{32}$/.test(id) ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw Error('tombstone');
    if (Buffer.byteLength(JSON.stringify(d), 'utf8') > 8_000_000)
      throw new UnderstandingError(
        'La comprensión supera 8 MB. No se eliminarán reglas silenciosamente.',
        'limit',
      );
  }
  ready() {
    if (this.loadError) throw new UnderstandingError(this.loadError, 'storage');
  }
  document(contents) {
    const u = new URL(contents.getURL());
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.href.length > 2048
    )
      throw new UnderstandingError(
        'Elegí una pestaña HTTP(S) sin credenciales',
      );
    return `${u.origin}${u.pathname}`;
  }
  contextFor(contents) {
    this.ready();
    const url = this.document(contents),
      previous = this.bindings.get(contents.id);
    if (previous?.url === url) return previous.id;
    const root = /^\/(?:app\/?)?$/.test(new URL(url).pathname);
    const id = `c-${hash(`${this.projectId}|${root ? `${this.session}|${contents.id}|` : ''}${url}`).slice(0, 32)}`;
    // Migra únicamente una conversación nueva de raíz a su primera URL identificable.
    if (
      previous?.temporary &&
      !root &&
      new URL(previous.url).origin === new URL(url).origin &&
      /\/(?:c|chat|app)\/[^/]+/.test(new URL(url).pathname) &&
      !Object.hasOwn(this.data.deleted_revisions, id) &&
      !this.data.contexts.some((r) => r.state.context_id === id)
    ) {
      if (Object.hasOwn(this.data.deleted_revisions, previous.id)) {
        const next = structuredClone(this.data);
        next.deleted_revisions[id] = next.deleted_revisions[previous.id];
        delete next.deleted_revisions[previous.id];
        this.commit(next);
      }
      const row = this.data.contexts.find(
        (r) => r.state.context_id === previous.id,
      );
      if (row) {
        const next = structuredClone(this.data),
          m = next.contexts.find((r) => r.state.context_id === previous.id);
        m.state.context_id = id;
        m.url = url;
        this.commit(next);
      }
    }
    this.bindings.set(contents.id, { id, url, temporary: root });
    return id;
  }
  row(id, url = '') {
    return (
      this.data.contexts.find((r) => r.state.context_id === id) || {
        state: {
          ...newUnderstanding(id, this.now()),
          revision: this.data.deleted_revisions[id] || 0,
        },
        url,
      }
    );
  }
  commit(next) {
    this.ready();
    this.validateData(next);
    if (!this.storage)
      throw new UnderstandingError(
        'No hay almacenamiento persistente configurado',
        'storage',
      );
    try {
      this.storage.write(JSON.stringify(next));
    } catch {
      throw new UnderstandingError(
        'No se pudo guardar la comprensión. Los cambios no se confirmaron.',
        'storage',
      );
    }
    this.data = next;
  }
  change(id, url, operation, meta = {}) {
    this.ready();
    const row = this.row(id, url),
      result = updateUnderstanding(row.state, operation, meta, this.now());
    if (result.state === row.state) {
      this.reports.set(id, result.report);
      return result;
    }
    const next = structuredClone(this.data),
      index = next.contexts.findIndex((r) => r.state.context_id === id);
    if (index < 0) {
      if (next.contexts.length >= 50)
        throw new UnderstandingError(
          'Máximo 50 contextos. Eliminá uno explícitamente antes de crear otro.',
          'limit',
        );
      next.contexts.push({ state: result.state, url });
    } else next.contexts[index] = { state: result.state, url: row.url || url };
    delete next.deleted_revisions[id];
    this.commit(next);
    this.reports.set(id, result.report);
    this.notify('nexo:understanding-changed', {
      contextId: id,
      revision: result.state.revision,
      needsClarification: result.state.pending_questions.some(
        (q) => q.status === 'open',
      ),
    });
    return result;
  }
  snapshot(contents) {
    const id = this.contextFor(contents),
      state = structuredClone(this.row(id, this.document(contents)).state);
    const references = [
      ...state.relevant_context.map((e) => e.reference),
      ...state.pending_questions.map((q) => q.proposed?.reference),
    ].filter(Boolean);
    const memories = this.memory?.list({ limit: 6000 }) || [];
    const memoryReferences = references.map((ref) => {
      const found = memories.find((e) => e.id === ref.id);
      return {
        id: ref.id,
        available: Boolean(found),
        text: found?.text || null,
        kind: found?.kind || ref.kind,
        verified: false,
      };
    });
    return {
      state,
      effective: effectiveUnderstanding(state),
      report: this.reports.get(id) || null,
      observationError: this.reports.get(`error-${contents.id}`)?.error || null,
      memoryReferences,
      observationEnabled: this.enabled(),
      erased: Object.hasOwn(this.data.deleted_revisions, id),
    };
  }
  observe(
    contents,
    text,
    { messageId, channel = 'prepare', transmittedText } = {},
  ) {
    if (!this.enabled()) return { skipped: 'disabled' };
    try {
      if (!isAiHost(new URL(contents.getURL()).hostname))
        return { skipped: 'not-ai' };
      userText(text);
      const id = this.contextFor(contents),
        url = this.document(contents);
      if (Object.hasOwn(this.data.deleted_revisions, id))
        return { skipped: 'erased' };
      const digest = hash(text),
        previous = this.recent.get(contents.id),
        now = this.now();
      const key = hash(
        `${channel}|${messageId || `${digest}|${now}`}|${digest}`,
      );
      if (
        channel === 'conversation-read' &&
        (previous?.digest === digest ||
          previous?.transmittedDigest === digest) &&
        previous.channel === 'prepare'
      ) {
        const row = this.row(id);
        if (!row.state.seen_messages.includes(key))
          this.change(
            id,
            url,
            {
              type: 'ack-message',
              revision: row.state.revision,
              messageKey: key,
            },
            { channel, messageId, url },
          );
        return { duplicate: true };
      }
      if (
        channel === 'conversation-read' &&
        /\[(?:[^\]\n]* · Nexo|EVO · |Texto pegado por el usuario)/.test(text)
      ) {
        this.reports.set(`error-${contents.id}`, {
          error:
            'El turno contiene bloques de mediación y no hay un original inequívoco asociado. No se interpreta: definí o aclarà el objetivo en este panel.',
        });
        return { skipped: 'mediated-without-original' };
      }
      const result = this.change(
        id,
        url,
        {
          type: 'message',
          revision: this.row(id).state.revision,
          text,
          messageKey: key,
        },
        { channel, messageId: messageId || key, url },
      );
      if (!result.report.duplicate)
        this.recent.set(contents.id, {
          digest,
          transmittedDigest:
            typeof transmittedText === 'string' ? hash(transmittedText) : null,
          channel,
          at: now,
        });
      this.reports.delete(`error-${contents.id}`);
      return {
        ok: true,
        contextId: id,
        revision: result.state.revision,
        independent: result.report.isolated === true,
      };
    } catch (error) {
      // No texto privado en logs; no bloquear lectura, envío ni conteo existentes.
      this.reports.set(`error-${contents.id}`, { error: error.message });
      return { ok: false, error: error.message };
    }
  }
  observeConversation(contents, turns) {
    const user = turns
      .filter(
        (t) =>
          t?.role === 'user' &&
          typeof t.content === 'string' &&
          t.content.trim(),
      )
      .at(-1);
    if (!user) return { skipped: 'no-user-turn' };
    if (user.clipped) return { skipped: 'clipped-user-turn' };
    return this.observe(contents, user.content, {
      messageId: String(user.id || hash(user.content)),
      channel: 'conversation-read',
    });
  }
  edit(contents, operation) {
    const id = this.contextFor(contents),
      url = this.document(contents);
    if (operation.type === 'resolve' && operation.accept) {
      const q = this.row(id).state.pending_questions.find(
        (q) => q.id === operation.id,
      );
      if (
        q?.proposed?.reference &&
        !this.memory
          ?.list({ limit: 6000 })
          .some((e) => e.id === q.proposed.reference.id)
      )
        throw new UnderstandingError(
          'La referencia EVO ya no está disponible; no se reintroducirá.',
        );
    }
    return this.change(id, url, operation, {
      channel: 'shell',
      messageId: randomUUID(),
      url,
    });
  }
  recall(contents, query, revision) {
    if (!this.enabled())
      throw new UnderstandingError('EVO MEMORY está desactivada');
    userText(query, { max: 4000 });
    const id = this.contextFor(contents),
      row = this.row(id);
    if (row.state.revision !== revision)
      throw new UnderstandingError('El contexto cambió; recargá.', 'conflict');
    const found =
      this.memory?.recall(query, {
        limit: 6,
        kinds: ['goal', 'constraint', 'task', 'decision', 'preference'],
      }) || [];
    let result = { state: row.state };
    for (const { item } of found)
      result = this.change(
        id,
        this.document(contents),
        {
          type: 'memory-candidate',
          revision: result.state.revision,
          reference: {
            id: item.id,
            project_id: this.projectId,
            kind: item.kind,
          },
        },
        {
          channel: 'evo-recall',
          messageId: randomUUID(),
          url: this.document(contents),
        },
      );
    return { count: found.length };
  }
  contexts() {
    this.ready();
    return this.data.contexts
      .map((r) => ({
        id: r.state.context_id,
        url: r.url,
        goal: r.state.user_goal?.text.slice(0, 150) || 'Sin objetivo',
        updatedAt: r.state.last_context_update,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  bind(contents, id) {
    if (!this.data.contexts.some((r) => r.state.context_id === id))
      throw new UnderstandingError('Contexto no disponible');
    this.bindings.set(contents.id, {
      id,
      url: this.document(contents),
      temporary: false,
    });
  }
  clear(contents, revision) {
    const id = this.contextFor(contents),
      row = this.row(id);
    if (row.state.revision !== revision)
      throw new UnderstandingError('El contexto cambió; recargá.', 'conflict');
    const next = structuredClone(this.data);
    next.contexts = next.contexts.filter((r) => r.state.context_id !== id);
    next.deleted_revisions[id] = revision + 1;
    this.commit(next);
    this.reports.delete(id);
    this.notify('nexo:understanding-changed', {
      contextId: id,
      revision: revision + 1,
    });
  }
  release(contents) {
    this.bindings.delete(contents.id);
    this.recent.delete(contents.id);
    this.reports.delete(`error-${contents.id}`);
  }
}

export function installUnderstandingIPC({
  service,
  ipcMain,
  BrowserWindow,
  dialog,
  resolveGuest,
}) {
  function trusted(e) {
    return Boolean(
      e?.senderFrame &&
        e.senderFrame === e.sender?.mainFrame &&
        !e.sender.isDestroyed() &&
        e.sender.getURL() === 'nexo://app/src/ui/shell/index.html' &&
        BrowserWindow.getAllWindows().some((w) => w.webContents === e.sender),
    );
  }
  function handle(name, fn) {
    ipcMain.handle(`nexo:understanding:${name}`, async (event, p) => {
      if (!trusted(event))
        return {
          ok: false,
          code: 'unauthorized',
          error: 'Remitente no autorizado',
        };
      try {
        if (
          !p ||
          typeof p !== 'object' ||
          Array.isArray(p) ||
          JSON.stringify(p).length > 250000
        )
          throw new UnderstandingError('Solicitud inválida');
        if (name === 'contexts')
          return { ok: true, contexts: service.contexts() };
        if (!Number.isSafeInteger(p.webContentsId))
          throw new UnderstandingError('Pestaña inválida');
        let contents;
        try {
          contents = resolveGuest(event.sender, p.webContentsId);
        } catch {
          throw new UnderstandingError(
            'Pestaña ajena o cerrada',
            'unauthorized',
          );
        }
        return await fn(event, p, contents);
      } catch (error) {
        return {
          ok: false,
          code: error instanceof UnderstandingError ? error.code : 'storage',
          error:
            error instanceof UnderstandingError
              ? error.message
              : 'No se pudo completar la operación local.',
        };
      }
    });
  }
  handle('read', (_e, _p, c) => ({ ok: true, ...service.snapshot(c) }));
  handle('edit', (_e, p, c) => {
    if (
      !['goal', 'add', 'retire', 'resolve', 'message'].includes(
        p.operation?.type,
      )
    )
      throw new UnderstandingError('Operación no permitida');
    const { report } = service.edit(c, p.operation);
    return { ok: true, ...service.snapshot(c), report };
  });
  handle('recall', (_e, p, c) => ({
    ok: true,
    ...service.recall(c, p.query, p.revision),
    ...service.snapshot(c),
  }));
  handle('contexts', () => {});
  handle('bind', (_e, p, c) => {
    service.bind(c, p.contextId);
    return { ok: true, ...service.snapshot(c) };
  });
  handle('clear', async (e, p, c) => {
    const id = service.contextFor(c);
    const { response } = await dialog.showMessageBox(
      BrowserWindow.fromWebContents(e.sender),
      {
        type: 'warning',
        message: '¿Eliminar este contexto de comprensión?',
        detail:
          'No borra conversaciones ni EVO MEMORY. Se detiene la relectura automática de este contexto hasta que lo edites explícitamente.',
        buttons: ['Cancelar', 'Eliminar'],
        defaultId: 0,
        cancelId: 0,
      },
    );
    if (response !== 1) return { ok: false, cancelled: true };
    if (!trusted(e) || service.contextFor(c) !== id)
      throw new UnderstandingError('La ventana o la conversación cambió');
    service.clear(c, p.revision);
    return { ok: true, ...service.snapshot(c) };
  });
}

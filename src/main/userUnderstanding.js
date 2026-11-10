import { contextItems, contextPreview } from '../core/userProjects.js';
/** UUE main: usa la persistencia atómica existente de EVO, sin cambiar sus archivos. */
import {
  planObservation,
  validateObservation,
  emptyObservation,
} from '../core/conversationObservation.js';
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
    memoryEnabled = enabled,
    now = Date.now,
    notify = () => {},
    file = null,
  } = {}) {
    this.storage = storage || (file ? fileStorage(file) : null);
    this.memory = memory;
    // `enabled` se conserva como alias compatible: sólo habilita antecedentes EVO.
    // La observación y persistencia propias de UUE no dependen de este callback.
    this.enabled = memoryEnabled;
    this.now = now;
    this.notify = notify;
    this.projectId = memory?.projectId || 'default';
    this.session = randomUUID();
    this.bindings = new Map();
    this.reports = new Map();
    this.recent = new Map();
    this.liveConversations = new Map();
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
            const expired = {
              ...e,
              status: 'obsolete',
              updated_at: now(),
              change: { kind: 'session-expired', at: now() },
            };
            // Nunca bloquear la lectura o descartar una regla porque el historial se llenó.
            if (row.state.instruction_history.length < 400)
              row.state.instruction_history.push(expired);
            else retained.push(expired);
          }
          row.state[field] = retained;
        }
        for (const c of row.state.decision_candidates || [])
          if (c.scope === 'session' && c.status === 'pending') {
            c.status = 'obsolete';
            c.updated_at = now();
            c.change = { kind: 'session-expired', at: now() };
          }
        for (const q of row.state.pending_questions)
          if (q.status === 'open' && q.proposed?.scope === 'session') {
            q.status = 'rejected';
            q.resolved_at = now();
          }
        row.state.uncertainty = row.state.uncertainty.filter(
          (u) =>
            u.kind !== 'decision-proposal' ||
            (row.state.decision_candidates || []).some(
              (c) => c.status === 'pending',
            ),
        );
        if (
          row.state.selected_reference_id &&
          !row.state.relevant_context.some(
            (e) =>
              e.status === 'active' &&
              e.id === row.state.selected_reference_id &&
              e.entity,
          )
        )
          row.state.selected_reference_id = null;
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
      if (row.conversation) validateObservation(row.conversation);
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
  documentIdentity(contents) {
    const url = this.document(contents),
      path = new URL(url).pathname;
    const temporary =
      /^\/(?:app\/?)?$/.test(path) ||
      /^\/g\/[^/]+(?:\/project)?\/?$/.test(path);
    return {
      url,
      temporary,
      id: `c-${hash(`${this.projectId}|${temporary ? `${this.session}|${contents.id}|` : ''}${url}`).slice(0, 32)}`,
    };
  }
  contextFor(contents) {
    this.ready();
    const url = this.document(contents),
      previous = this.bindings.get(contents.id);
    if (previous?.url === url) return previous.id;
    const identity = this.documentIdentity(contents),
      root = identity.temporary,
      id = identity.id;
    const previousPath = previous ? new URL(previous.url).pathname : '';
    const migrationPath = previousPath.startsWith('/g/')
      ? `${previousPath.replace(/\/project\/?$|\/$/, '')}/c/`
      : null;
    const sameRoute = migrationPath
      ? new URL(url).pathname.startsWith(migrationPath)
      : /^\/(?:c|chat|app)\/[^/]+/.test(new URL(url).pathname);
    this.recent.delete(contents.id);
    this.reports.delete(`error-${contents.id}`);
    // Migra únicamente una conversación nueva de raíz a su primera URL identificable.
    if (
      previous?.temporary &&
      !root &&
      new URL(previous.url).origin === new URL(url).origin &&
      sameRoute &&
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
    } else
      next.contexts[index] = {
        ...next.contexts[index],
        state: result.state,
        url: row.url || url,
      };
    delete next.deleted_revisions[id];
    this.commit(next);
    this.reports.set(id, result.report);
    this.notify('nexo:understanding-changed', {
      contextId: id,
      revision: result.state.revision,
      needsClarification:
        result.state.pending_questions.some((q) => q.status === 'open') ||
        (result.state.decision_candidates || []).some(
          (e) => e.status === 'pending',
        ),
    });
    return result;
  }
  snapshot(contents) {
    const id = this.contextFor(contents),
      physical = this.documentIdentity(contents),
      state = structuredClone(this.row(id, this.document(contents)).state);
    const references = [
      ...state.relevant_context
        .filter((e) => e.status === 'active')
        .map((e) => e.reference),
      ...state.pending_questions
        .filter((q) => q.status === 'open')
        .map((q) => q.proposed?.reference),
    ].filter(Boolean);
    const memories =
      references.length && this.enabled()
        ? this.memory?.list({ limit: 6000 }) || []
        : [];
    const memoryReferences = references.map((ref) => {
      const found = memories.find((e) => e.id === ref.id);
      return {
        id: ref.id,
        available:
          Boolean(found) &&
          ref.project_id === this.projectId &&
          (!ref.digest || ref.digest === hash(found.text || '')),
        text:
          found &&
          ref.project_id === this.projectId &&
          (!ref.digest || ref.digest === hash(found.text || ''))
            ? found.text
            : null,
        changed: Boolean(
          found && ref.digest && ref.digest !== hash(found.text || ''),
        ),
        pinned: Boolean(ref.digest),
        kind: found?.kind || ref.kind,
        verified: false,
      };
    });
    const sourceCache = new Map();
    const contextReferences = (state.context_references || []).map((ref) =>
      this.referenceView(ref, sourceCache),
    );
    const effective = effectiveUnderstanding(state);
    effective.context_references = effective.context_references.map((r) => ({
      ...r,
      available:
        contextReferences.find((v) => v.id === r.id)?.available === true,
    }));
    return {
      state,
      effective,
      report: this.reports.get(id) || null,
      observationError: this.reports.get(`error-${contents.id}`)?.error || null,
      memoryReferences,
      contextReferences,
      contextSelection: {
        mode: this.bindings.get(contents.id)?.manual ? 'explicit' : 'natural',
        context_id: id,
        document_context_id: physical.id,
        document_url: physical.url,
        source_url: this.row(id).url,
        temporary: physical.temporary,
        baselinePending: Boolean(
          this.bindings.get(contents.id)?.baseline_pending,
        ),
      },
      observationEnabled: true,
      conversation: structuredClone(
        this.liveConversations.get(physical.id) ||
          this.row(physical.id).conversation ||
          emptyObservation(),
      ),
      erased: Object.hasOwn(this.data.deleted_revisions, id),
    };
  }
  observe(
    contents,
    text,
    { messageId, channel = 'prepare', transmittedText } = {},
  ) {
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
  observeConversation(contents, turns, { streaming = false } = {}) {
    try {
      if (!isAiHost(new URL(contents.getURL()).hostname))
        return { skipped: 'not-ai' };
      const id = this.contextFor(contents),
        url = this.document(contents);
      if (Object.hasOwn(this.data.deleted_revisions, id))
        return { skipped: 'erased' };
      const physical = this.documentIdentity(contents),
        binding = this.bindings.get(contents.id);
      const row = this.row(id, url),
        previous =
          this.liveConversations.get(physical.id) ||
          this.row(physical.id).conversation;
      const prepared = turns
        .filter(
          (t) =>
            t &&
            ['user', 'assistant'].includes(t.role) &&
            typeof t.content === 'string' &&
            t.content.trim(),
        )
        .map((t) => ({
          ...t,
          id: String(t.id || hash(t.content)).slice(0, 256),
          digest: hash(t.content),
        }));
      const plan = planObservation(previous, prepared, {
        bootstrap: row.state.revision === 0,
        streaming,
        now: this.now(),
      });
      if (
        binding?.baseline_pending &&
        prepared.some((t) => t.role === 'user')
      ) {
        plan.users = [];
        plan.observation.warnings = [
          'Contexto elegido explícitamente: la ventana ya visible se toma como punto de partida, no se reimportan sus instrucciones.',
        ];
        plan.changed = true;
      }
      if (plan.skipped && !binding?.baseline_pending)
        return { skipped: plan.skipped };
      let result = { ok: true, duplicate: !plan.changed };
      for (const user of plan.users) {
        result = this.observe(contents, user.content, {
          messageId: user.id,
          channel: 'conversation-read',
        });
        if (result.ok === false || result.skipped) return result;
      }
      if (result.independent) return result;
      if (plan.changed) {
        // El stream se muestra en RAM; sólo respuestas estables y la continuidad del
        // usuario se guardan, no un archivo por cada fragmento de respuesta.
        const stable = {
          ...plan.observation,
          messages: plan.observation.messages.filter(
            (m) => m.status !== 'streaming',
          ),
        };
        const saved =
          this.row(physical.id, url).conversation || emptyObservation();
        if (
          !Object.hasOwn(this.data.deleted_revisions, physical.id) &&
          JSON.stringify({ ...saved, revision: 0 }) !==
            JSON.stringify({ ...stable, revision: 0 })
        ) {
          const next = structuredClone(this.data),
            index = next.contexts.findIndex(
              (r) => r.state.context_id === physical.id,
            );
          if (index < 0) {
            if (next.contexts.length >= 50)
              throw new UnderstandingError('Máximo 50 contextos', 'limit');
            next.contexts.push({
              ...this.row(physical.id, url),
              conversation: stable,
            });
          } else next.contexts[index].conversation = stable;
          this.commit(next);
        }
        this.liveConversations.delete(physical.id);
        this.liveConversations.set(physical.id, plan.observation);
        if (this.liveConversations.size > 50)
          this.liveConversations.delete(
            this.liveConversations.keys().next().value,
          );
        this.notify('nexo:understanding-changed', {
          contextId: id,
          revision: this.row(id).state.revision,
          conversationRevision: plan.observation.revision,
        });
      }
      if (
        binding?.baseline_pending &&
        prepared.some((t) => t.role === 'user') &&
        !prepared.filter((t) => t.role === 'user').at(-1)?.clipped
      )
        binding.baseline_pending = false;
      this.reports.delete(`error-${contents.id}`);
      return result;
    } catch (error) {
      this.reports.set(`error-${contents.id}`, { error: error.message });
      return { ok: false, error: error.message };
    }
  }

  edit(contents, operation) {
    const id = this.contextFor(contents),
      url = this.document(contents);
    if (operation.contextId !== undefined && operation.contextId !== id)
      throw new UnderstandingError(
        'La conversación/contexto cambió; recargá antes de editar.',
        'conflict',
      );
    let workSource = null;
    if (operation.type === 'work-capture') {
      const physical = this.documentIdentity(contents);
      const observation =
        this.liveConversations.get(physical.id) ||
        this.row(physical.id).conversation ||
        emptyObservation();
      const message = observation.messages.find(
        (m) => m.id === operation.messageId && m.role === 'assistant',
      );
      if (
        Object.hasOwn(this.data.deleted_revisions, physical.id) ||
        observation.revision !== operation.observationRevision ||
        !message ||
        message.digest !== operation.digest ||
        message.status !== 'complete' ||
        !['proposal', 'result'].includes(operation.kind) ||
        !message.preview.trim()
      )
        throw new UnderstandingError(
          'La respuesta cambió, está incompleta o ya no está disponible; recargá antes de registrarla.',
          'conflict',
        );
      workSource = {
        role: 'assistant',
        channel: 'conversation-read',
        message_id: message.id,
        digest: message.digest,
        context_id: physical.id,
        url: physical.url,
        observation_revision: observation.revision,
        observed_at: message.observed_at,
      };
      // Un extracto acotado de la observación existente; nunca texto ni rol suministrados por el guest.
      operation = {
        type: 'work-add',
        revision: operation.revision,
        kind: operation.kind,
        text: message.preview.slice(0, 1000),
        task_id: operation.task_id ?? null,
        goal_id: operation.goal_id ?? null,
      };
    }
    if (operation.type === 'context-reference') {
      const preview = this.inspect(
        operation.sourceContextId,
        operation.sourceRevision,
        operation.targetKind || 'summary',
        operation.targetId ?? null,
      );
      if (
        operation.sourceDigest !== undefined &&
        operation.sourceDigest !== preview.source_digest
      )
        throw new UnderstandingError(
          'El origen cambió; inspeccionalo nuevamente.',
          'conflict',
        );
      operation = {
        type: 'context-reference',
        revision: operation.revision,
        reference: {
          source_context_id: preview.source_context_id,
          source_revision: preview.source_revision,
          source_digest: preview.source_digest,
          target_kind: preview.target_kind,
          target_id: preview.target_id,
          label: preview.label,
        },
      };
    }
    if (
      ['context-reference-resolve', 'context-reference-refresh'].includes(
        operation.type,
      )
    ) {
      const r = (this.row(id).state.context_references || []).find(
        (r) => r.id === operation.id,
      );
      if (!r)
        throw new UnderstandingError('Referencia no disponible', 'conflict');
      if (operation.type === 'context-reference-refresh') {
        const preview = this.inspect(
          r.source_context_id,
          operation.sourceRevision,
          r.target_kind,
          r.target_id,
        );
        if (
          operation.sourceDigest !== undefined &&
          operation.sourceDigest !== preview.source_digest
        )
          throw new UnderstandingError(
            'El origen cambió; inspeccionalo nuevamente.',
            'conflict',
          );
        operation = {
          ...operation,
          source_revision: preview.source_revision,
          source_digest: preview.source_digest,
        };
      } else if (
        operation.action === 'confirm' &&
        !this.referenceView(r).available
      )
        throw new UnderstandingError(
          'El antecedente cambió o fue eliminado. Revisá y actualizá la referencia antes de confirmar.',
          'conflict',
        );
    }
    if (operation.type === 'resolve' && operation.accept) {
      const q = this.row(id).state.pending_questions.find(
        (q) => q.id === operation.id,
      );
      if (
        q?.proposed?.reference &&
        (!this.enabled() ||
          !this.memory
            ?.list({ limit: 6000 })
            .some(
              (e) =>
                e.id === q.proposed.reference.id &&
                q.proposed.reference.project_id === this.projectId &&
                (!q.proposed.reference.digest ||
                  q.proposed.reference.digest === hash(e.text || '')),
            ))
      )
        throw new UnderstandingError(
          'La referencia EVO ya no está disponible; no se reintroducirá.',
        );
    }
    return this.change(id, url, operation, {
      channel: 'shell',
      workSource,
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
            digest: hash(item.text || ''),
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
  inspect(id, revision, targetKind = 'summary', targetId = null, offset = 0) {
    this.ready();
    const row = this.data.contexts.find((r) => r.state.context_id === id);
    if (!row || Object.hasOwn(this.data.deleted_revisions, id))
      throw new UnderstandingError(
        'Contexto eliminado o no disponible',
        'conflict',
      );
    if (row.state.revision !== revision)
      throw new UnderstandingError(
        'El contexto de origen cambió; recargá la lista.',
        'conflict',
      );
    if (
      !['summary', 'entry'].includes(targetKind) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 2000
    )
      throw new UnderstandingError('Selección de antecedente inválida');
    const preview = contextPreview(row, targetKind, targetId);
    if (!preview)
      throw new UnderstandingError(
        'La entrada de origen ya no está disponible',
        'conflict',
      );
    const items = contextItems(row.state);
    return {
      ...preview,
      source_digest: hash(JSON.stringify(row.state)),
      items: items.slice(offset, offset + 20).map((i) => ({
        id: i.entry.id,
        label: i.entry.text.slice(0, 150),
        kind: i.kind,
        status: i.entry.status,
        certainty: i.entry.certainty,
      })),
      offset,
      total: items.length,
    };
  }
  referenceView(ref, cache = new Map()) {
    if (['rejected', 'retired'].includes(ref.status))
      return {
        id: ref.id,
        available: false,
        reason: 'inactive-reference',
        preview: null,
      };
    if (!cache.has(ref.source_context_id)) {
      const row = this.data.contexts.find(
        (r) => r.state.context_id === ref.source_context_id,
      );
      cache.set(ref.source_context_id, {
        row,
        digest: row ? hash(JSON.stringify(row.state)) : null,
      });
    }
    const { row, digest } = cache.get(ref.source_context_id);
    if (
      !row ||
      Object.hasOwn(this.data.deleted_revisions, ref.source_context_id)
    )
      return {
        id: ref.id,
        available: false,
        reason: 'deleted-source',
        preview: null,
      };
    if (
      row.state.revision !== ref.source_revision ||
      digest !== ref.source_digest
    )
      return {
        id: ref.id,
        available: false,
        reason: 'changed-source',
        preview: null,
        currentRevision: row.state.revision,
      };
    const preview = contextPreview(row, ref.target_kind, ref.target_id);
    return {
      id: ref.id,
      available: Boolean(preview),
      reason: preview ? 'available' : 'missing-entry',
      preview,
    };
  }
  contexts() {
    this.ready();
    return this.data.contexts
      .filter(
        (r) => !Object.hasOwn(this.data.deleted_revisions, r.state.context_id),
      )
      .map((r) => ({
        id: r.state.context_id,
        url: r.url,
        goal: r.state.user_goal?.text.slice(0, 150) || 'Sin objetivo',
        project: r.state.project?.name || null,
        revision: r.state.revision,
        digest: hash(JSON.stringify(r.state)),
        updatedAt: r.state.last_context_update,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  bind(contents, id, expected = {}) {
    const current = this.contextFor(contents),
      physical = this.documentIdentity(contents);
    if (
      (expected.revision !== undefined &&
        this.row(current).state.revision !== expected.revision) ||
      (expected.contextId !== undefined && expected.contextId !== current)
    )
      throw new UnderstandingError(
        'El contexto activo cambió; recargá antes de elegir otro.',
        'conflict',
      );
    if (id !== null) {
      const row = this.data.contexts.find((r) => r.state.context_id === id);
      if (!row || Object.hasOwn(this.data.deleted_revisions, id))
        throw new UnderstandingError('Contexto no disponible', 'conflict');
      if (
        (expected.sourceRevision !== undefined &&
          row.state.revision !== expected.sourceRevision) ||
        (expected.sourceDigest !== undefined &&
          hash(JSON.stringify(row.state)) !== expected.sourceDigest)
      )
        throw new UnderstandingError(
          'El contexto de origen cambió; recargá la lista.',
          'conflict',
        );
    }
    const target = id ?? physical.id;
    if (
      target === current &&
      Boolean(this.bindings.get(contents.id)?.manual) === (id !== null)
    )
      return;
    this.bindings.set(contents.id, {
      id: target,
      url: physical.url,
      temporary: id === null && physical.temporary,
      manual: id !== null,
      baseline_pending: true,
    });
    this.recent.delete(contents.id);
    this.reports.delete(`error-${contents.id}`);
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
    this.liveConversations.delete(id);
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
        if (name === 'contexts') {
          let activeContextId;
          if (
            p.webContentsId !== undefined &&
            !Number.isSafeInteger(p.webContentsId)
          )
            throw new UnderstandingError('Pestaña inválida');
          if (p.webContentsId !== undefined) {
            let guest;
            try {
              guest = resolveGuest(event.sender, p.webContentsId);
            } catch {
              throw new UnderstandingError(
                'Pestaña ajena o cerrada',
                'unauthorized',
              );
            }
            activeContextId = service.contextFor(guest);
          }
          if (p.mode === 'inspect')
            return {
              ok: true,
              activeContextId,
              preview: service.inspect(
                p.contextId,
                p.revision,
                p.targetKind || 'summary',
                p.targetId ?? null,
                p.offset ?? 0,
              ),
            };
          return { ok: true, activeContextId, contexts: service.contexts() };
        }
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
      ![
        'project',
        'context-item',
        'context-select',
        'context-reference',
        'context-reference-resolve',
        'context-reference-refresh',
        'goal',
        'work-add',
        'work-capture',
        'work-transition',
        'work-evidence',
        'work-evidence-withdraw',
        'task-add',
        'task-update',
        'task-transition',
        'task-focus',
        'task-next',
        'task-order',
        'rule-update',
        'decision-candidate',
        'goal-independent',
        'goal-transition',
        'goal-candidate',
        'add',
        'retire',
        'resolve',
        'message',
      ].includes(p.operation?.type)
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
    if (
      !Number.isSafeInteger(p.revision) ||
      typeof p.expectedContextId !== 'string' ||
      (p.contextId !== null &&
        (!Number.isSafeInteger(p.sourceRevision) ||
          typeof p.sourceDigest !== 'string'))
    )
      throw new UnderstandingError(
        'Selección requiere contexto y revisiones actuales',
      );
    service.bind(c, p.contextId, {
      revision: p.revision,
      contextId: p.expectedContextId,
      sourceRevision: p.sourceRevision,
      sourceDigest: p.sourceDigest,
    });
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

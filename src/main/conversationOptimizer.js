import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import {
  validateUnderstandingDom,
} from '../core/understandingConversation.js';

const digest = (v) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const identity = (contents) => {
  const u = new URL(contents.getURL());
  return u.origin + u.pathname;
};
const key = (m) => `${m.role}:${m.id}`;
const MAX_CHARS = 8000000,
  MAX_VIEWS = 8;
/** Un worker local, cola latest-only por webview. Ninguna llamada a IA externa. */
class LocalRunner {
  constructor() {
    this.worker = null;
    this.waiting = new Map();
    this.active = null;
    this.serial = 0;
  }
  run(job, view) {
    return new Promise((resolve, reject) => {
      this.waiting.get(view)?.reject(Error('superseded'));
      if (!this.waiting.has(view) && this.waiting.size >= MAX_VIEWS) {
        reject(Error('busy'));
        return;
      }
      this.waiting.set(view, { job, view, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.active || !this.waiting.size) return;
    if (!this.worker) {
      const worker = new Worker(
        new URL('./optimizationWorker.js', import.meta.url),
      );
      this.worker = worker;
      worker.on('message', (p) => {
        if (worker !== this.worker || p.id !== this.active?.id) return;
        const batch = this.active;
        this.active = null;
        clearTimeout(this.timeout);
        p.error ? batch.reject(Error(p.error)) : batch.resolve(p.result);
        worker.unref();
        this.pump();
      });
      const fail = () => {
        if (this.worker !== worker) return;
        this.worker = null;
        clearTimeout(this.timeout);
        this.active?.reject(Error('worker-failed'));
        this.active = null;
        for (const v of this.waiting.values()) v.reject(Error('worker-failed'));
        this.waiting.clear();
        void worker.terminate();
      };
      worker.on('error', fail);
      worker.on('exit', fail);
      worker.unref();
    }
    const [view, batch] = this.waiting.entries().next().value;
    this.waiting.delete(view);
    this.active = { ...batch, id: ++this.serial };
    this.worker.ref();
    this.worker.postMessage({ id: this.active.id, job: batch.job });
    this.timeout = setTimeout(() => {
      const worker = this.worker;
      this.worker = null;
      this.active?.reject(Error('timeout'));
      this.active = null;
      for (const b of this.waiting.values()) b.reject(Error('timeout'));
      this.waiting.clear();
      void worker?.terminate();
    }, 20000);
    this.timeout.unref?.();
  }
  release(view) {
    this.waiting.get(view)?.reject(Error('released'));
    this.waiting.delete(view);
  }
  close() {
    clearTimeout(this.timeout);
    this.active?.reject(Error('closed'));
    this.active = null;
    for (const b of this.waiting.values()) b.reject(Error('closed'));
    this.waiting.clear();
    const worker = this.worker;
    this.worker = null;
    return worker?.terminate();
  }
}
/** Nuevo módulo, sin importaciones del antiguo UUE, EVO o archivos históricos. */
export class ConversationOptimizer {
  constructor({ notify = () => {}, run, delay = 120 } = {}) {
    this.notify = notify;
    this.delay = delay;
    this.views = new Map();
    this.runner = run ? null : new LocalRunner();
    this.run = run || ((job, id) => this.runner.run(job, id));
  }
  activate(contents) {
    const url = identity(contents);
    const old = this.views.get(contents.id);
    if (old?.url === url) return old;
    this.release(contents);
    while (this.views.size >= MAX_VIEWS)
      this.release({ id: this.views.keys().next().value });
    const row = {
      url,
      messages: [],
      generation: 0,
      signature: null,
      partial: false,
      model: '',
      source: 'dom',
      status: 'analyzing',
      reason: 'Esperando mensajes disponibles en el DOM.',
      coverage: null,
      result: null,
    };
    this.views.set(contents.id, row);
    return row;
  }
  receive(contents, payload) {
    if (!validateUnderstandingDom(payload))
      return { ok: false, code: 'invalid', observed: false };
    if (
      new URL(payload.href).origin + new URL(payload.href).pathname !==
      identity(contents)
    )
      return { ok: false, code: 'conflict', observed: false };
    let row = this.activate(contents);
    if (
      !row.url.includes('/c/') &&
      row.domSession &&
      payload.conversationId &&
      row.domSession !== payload.conversationId
    ) {
      this.release(contents);
      row = this.activate(contents);
    }
    if (payload.conversationId) row.domSession = payload.conversationId;
    const incoming = payload.turns.map(({ id, role, content, clipped }) => ({
      id,
      role,
      content,
      clipped,
    }));
    const signature = digest({
      incoming,
      coverage: payload.coverage,
      streaming: payload.streaming,
    });
    if (signature === row.signature)
      return { ok: true, observed: true, duplicate: true };
    const priorKeys = row.messages.map(key),
      incomingKeys = incoming.map(key),
      shared = new Set(priorKeys),
      incomingSet = new Set(incomingKeys),
      priorMap = new Map(row.messages.map((m) => [key(m), m]));
    const priorOverlap = priorKeys.filter((k) => incomingSet.has(k)),
      incomingOverlap = incomingKeys.filter((k) => shared.has(k));
    const unstable =
      incoming.some((m) => m.id.startsWith('visible-')) &&
      row.messages.length > 0 &&
      incoming.some((m) => {
        const old = priorMap.get(key(m));
        return old && old.content !== m.content;
      });
    const uncertainOrder =
      JSON.stringify(priorOverlap) !== JSON.stringify(incomingOverlap);
    const map = new Map(row.messages.map((m) => [key(m), m])),
      order = [...priorKeys];
    // Añadir mensajes antes de su siguiente vecino conocido. No eliminar los ausentes
    // de una ventana DOM virtualizada ni podarlos por antigüedad.
    for (let i = incoming.length - 1; i >= 0; i--) {
      const message = incoming[i],
        k = key(message);
      if (!map.has(k)) {
        const next = incomingKeys[i + 1],
          position = next ? order.indexOf(next) : -1;
        if (position < 0) order.push(k);
        else order.splice(position, 0, k);
      }
      map.set(k, message);
    }
    const messages = order.map((k) => map.get(k)),
      chars = messages.reduce((n, m) => n + m.content.length, 0);
    if (chars > MAX_CHARS || messages.length > 10000) {
      clearTimeout(row.timer);
      row.partial = true;
      row.status = 'unsafe';
      row.reason =
        'Se alcanzó el presupuesto de contexto: no se descartan silenciosamente mensajes anteriores.';
      row.result = null;
      row.generation++;
      this.changed(contents);
      return { ok: true, observed: false, limited: true };
    }
    row.messages = messages;
    row.signature = signature;
    row.source = 'dom';
    row.coverage = {
      scope: 'loaded-dom',
      detected_turns: payload.coverage.detected_turns,
      sent_turns: payload.coverage.sent_turns,
      omitted_turns: payload.coverage.omitted_turns,
      clipped: payload.coverage.clipped,
      remote_history_complete: false,
    };
    row.partial =
      row.partial || payload.coverage.clipped || unstable || uncertainOrder;
    row.streaming = payload.streaming;
    row.generation++;
    if (payload.streaming) {
      clearTimeout(row.timer);
      row.result = null;
      row.status = 'analyzing';
      row.reason = 'ChatGPT está generando: no se considera definitivo.';
      this.changed(contents);
    } else this.schedule(contents, row);
    this.limitTotal(contents.id);
    return {
      ok: true,
      observed: true,
      source: 'independent-dom',
      streaming: payload.streaming,
    };
  }
  limitTotal(keep) {
    let total = () =>
      [...this.views.values()].reduce(
        (n, r) => n + r.messages.reduce((s, m) => s + m.content.length, 0),
        0,
      );
    while (total() > MAX_CHARS && this.views.size > 1) {
      const id = [...this.views.keys()].find((k) => k !== keep);
      this.release({ id });
    }
  }
  setModel(contents, model) {
    if (typeof model !== 'string' || !model.trim() || model.length > 100)
      return;
    const row = this.views.get(contents.id);
    if (!row || row.url !== identity(contents) || row.model === model) return;
    row.model = model;
    row.generation++;
    if (!row.streaming && (row.messages.length || row.prompt))
      this.schedule(contents, row);
  }
  observePrompt(contents, text, model = '') {
    if (typeof text !== 'string' || !text.trim() || text.length > 200000)
      return;
    const row = this.activate(contents),
      signature = digest({ text, model });
    if (row.promptSignature === signature) return;
    row.promptSignature = signature;
    row.model = String(model || row.model).slice(0, 100);
    row.source = 'prompt';
    row.prompt = text;
    row.generation++;
    this.schedule(contents, row);
  }
  schedule(contents, row) {
    clearTimeout(row.timer);
    row.status = 'analyzing';
    row.reason = 'Analizando oportunidad de ahorro local.';
    row.result = null;
    const generation = row.generation;
    this.changed(contents);
    row.timer = setTimeout(async () => {
      row.timer = null;
      try {
        const job =
          row.source === 'prompt'
            ? { mode: 'prompt', text: row.prompt, model: row.model }
            : {
                mode: 'conversation',
                messages: row.messages.map(({ id, role, content }) => ({
                  id,
                  role,
                  content,
                })),
                partial: row.partial,
                model: row.model,
              };
        const result = await this.run(job, contents.id);
        if (
          this.views.get(contents.id) !== row ||
          row.generation !== generation
        )
          return;
        row.result = result;
        row.status = result.status;
        row.reason = result.reason;
        this.changed(contents);
      } catch {
        if (
          this.views.get(contents.id) !== row ||
          row.generation !== generation
        )
          return;
        row.status = 'unsafe';
        row.reason =
          'No se pudo optimizar con seguridad. El texto original no fue modificado.';
        row.result = null;
        this.changed(contents);
      }
    }, this.delay);
    row.timer.unref?.();
  }
  changed(contents) {
    this.notify('nexo:understanding-changed', { webContentsId: contents.id });
  }
  snapshot(contents, { includeText = false } = {}) {
    let row = this.views.get(contents.id);
    if (row && row.url !== identity(contents)) {
      this.release(contents);
      row = null;
    }
    if (!row)
      return {
        available: false,
        status: 'analyzing',
        reason: 'Esperando el canal DOM independiente.',
        metrics: null,
        original: null,
        optimized: null,
      };
    const r = row.result;
    return {
      available: true,
      url: row.url,
      source: row.source,
      status: row.status,
      reason: row.reason,
      coverage: row.coverage,
      retainedMessages: row.messages.length,
      metrics: r?.metrics || null,
      verification: r?.verification || null,
      original: includeText
        ? r?.original ||
          (row.source === 'prompt' ? row.prompt : JSON.stringify(row.messages))
        : null,
      optimized: includeText ? r?.optimized || null : null,
    };
  }
  release(contents) {
    const row = this.views.get(contents.id);
    clearTimeout(row?.timer);
    this.views.delete(contents.id);
    this.runner?.release(contents.id);
  }
  async close() {
    for (const id of [...this.views.keys()]) this.release({ id });
    await this.runner?.close();
  }
}
export function installOptimizationIPC({
  service,
  ipcMain,
  BrowserWindow,
  resolveGuest,
}) {
  ipcMain.handle('nexo:understanding:read', async (event, p = {}) => {
    if (!p || typeof p !== 'object') return { ok: false, code: 'invalid' };
    const sender = event.sender;
    if (
      !event.senderFrame ||
      event.senderFrame !== sender?.mainFrame ||
      sender.isDestroyed() ||
      sender.getURL() !== 'nexo://app/src/ui/shell/index.html' ||
      !BrowserWindow.getAllWindows().some((w) => w.webContents === sender)
    )
      return { ok: false, code: 'unauthorized' };
    if (
      !Number.isSafeInteger(p.webContentsId) ||
      typeof (p.includeText ?? false) !== 'boolean'
    )
      return { ok: false, code: 'invalid' };
    try {
      const contents = resolveGuest(sender, p.webContentsId);
      const snapshot = service.snapshot(contents, {
        includeText: p.includeText === true,
      });
      if (p.refresh === true || !snapshot.available)
        contents.send('nexo:understanding-read');
      return { ok: true, ...snapshot };
    } catch {
      return {
        ok: false,
        code: 'unauthorized',
        error: 'Pestaña ajena, cerrada o no disponible.',
      };
    }
  });
}

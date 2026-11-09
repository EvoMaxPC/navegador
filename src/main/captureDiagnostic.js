/** Diagnóstico de captura: lista cerrada de metadatos, nunca texto/URLs/IDs crudos. */
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

const STAGES = new Set(['app-start', 'diagnostic', 'request-detected', 'response-delivered', 'conversation-read']);
const SOURCES = new Set(['cdp', 'sse', 'json', 'websocket', 'composer', 'request', 'dpu', 'dpu-dom', 'dom-recovery', 'dom-conversation', 'dom']);
const CODES = new Set(['cdp-attached', 'cdp-sin-depurador', 'response-base64', 'response-capa', 'response-formato', 'response-mime', 'response-sin-cuerpo', 'response-sin-texto', 'response-tipo', 'response-vacio', 'chatgpt-conversation-read', 'conversation-memory-error']);
const ACTIONS = new Set(['created', 'merged', 'superseded', 'ignored']);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const bool = (value) => typeof value === 'boolean' ? value : null;
const choice = (set, value) => set.has(value) ? value : null;

export function createCaptureDiagnostic(file, { maxBytes = 5 * 1024 * 1024, onError = () => {} } = {}) {
  let queue = Promise.resolve();
  const key = randomBytes(32); // Correlación dentro del arranque sin exponer IDs.
  let lastError = null;
  return {
    file,
    write(stage, data = {}) {
      if (!STAGES.has(stage)) return Promise.resolve(false);
      const capture = data.capture || {};
      const host = String(data.host || capture.host || '').toLowerCase();
      const site = ['chatgpt.com', 'chat.openai.com'].includes(host) ? 'chatgpt'
        : ['claude.ai'].includes(host) ? 'claude' : null;
      const rawId = data.messageId || capture.messageId;
      const receipt = data.memory;
      const safe = {
        ts: new Date().toISOString(), stage, site,
        source: choice(SOURCES, data.source || capture.source),
        chars: count(data.chars ?? capture.text?.length),
        captureId: typeof rawId === 'string' && rawId ? createHmac('sha256', key).update(rawId).digest('hex').slice(0, 24) : null,
        paired: bool(data.paired), duplicate: bool(data.duplicate),
        memory: receipt && typeof receipt === 'object' ? {
          saved: bool(receipt.saved), persisted: bool(receipt.persisted),
          chars: count(receipt.chars), action: choice(ACTIONS, receipt.action),
        } : null,
        code: choice(CODES, data.code),
      };
      const line = JSON.stringify(safe) + '\n';
      queue = queue.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const size = await stat(file).then((info) => info.size, (error) => {
          if (error.code !== 'ENOENT') throw error;
          return 0;
        });
        if (size + Buffer.byteLength(line) > maxBytes && size > 0) {
          await rm(`${file}.1`, { force: true });
          await rename(file, `${file}.1`);
        }
        await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
        lastError = null;
        return true;
      }).catch((error) => {
        lastError = String(error?.code || 'write-failed');
        onError(lastError); // Nunca propagar rutas o texto del error al informe.
        return false;
      });
      return queue;
    },
    flush: () => queue,
    status: () => ({ file, error: lastError }),
  };
}

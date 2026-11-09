/**
 * Registro de sitios de IA que Nexo sabe interceptar.
 *
 * Cada perfil describe cómo se comporta un sitio concreto:
 *   · hosts         — dominios que cubre
 *   · composer      — selectores del cuadro de texto (intervención en el DOM)
 *   · sendButton    — selectores del botón de enviar
 *   · requestMatch  — regex de la petición que lleva el mensaje al modelo
 *   · body         — cómo se reescribe el cuerpo de la petición
 *   · deltaPaths   — pistas para extraer el texto de cada evento del stream
 *
 * Los selectores cambian a menudo: el adaptador DOM es un refuerzo, no la base.
 * La base es el enganche de red, que no depende de la interfaz.
 */

import { getPath, setPath } from './sse.js';

export const SITES = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    composer: ['#prompt-textarea', 'div[contenteditable="true"][id^="prompt"]', 'textarea[data-id]'],
    sendButton: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[aria-label*="Enviar"]'],
    stopButton: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
    // Sólo la petición que ENVÍA un mensaje: POST a `/backend-api/conversation`
    // (o `/f/conversation`; `backend-anon` para sesiones sin cuenta). Las rutas
    // que empiezan igual NO son mensajes y no deben tocarse: `/conversation/prepare`
    // (se mediaría dos veces el mismo texto), `/conversations` (listado),
    // `/conversation/<id>` (historial).
    requestMatch: /\/backend-(api|anon)\/(f\/)?conversation\/?$/,
    requestPath: /^\/backend-(api|anon)\/(f\/)?conversation\/?$/,
    postOnly: true,
    streamAdapter: 'chatgpt',
    body: {
      kind: 'chatgpt-messages',
      // Con esquema propio: si no se encuentra el mensaje NO se busca otro
      // string cualquiera del cuerpo (se corrompería `timezone` o el modelo).
      strict: true,
      // messages: [{author:{role}, content:{content_type, parts:[...]}}]
      patch: (body, text) => {
        patchUserText(body, { body: { kind: 'chatgpt-messages', strict: true } }, text);
        return body;
      },
    },
    deltaPaths: ['message.content.parts', 'message.content.text', 'delta'],
    accent: '#10a37f',
  },
  {
    id: 'claude',
    label: 'Claude',
    hosts: ['claude.ai'],
    composer: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
    sendButton: ['button[aria-label="Send message"]', 'button[aria-label="Enviar mensaje"]'],
    requestMatch: /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion\/?$/,
    requestPath: /^\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion\/?$/,
    postOnly: true,
    streamAdapter: 'claude',
    body: {
      kind: 'claude-prompt',
      strict: true,
      patch: (body, text) => {
        if (typeof body?.prompt === 'string') body.prompt = text;
        return body;
      },
    },
    deltaPaths: ['completion', 'delta.text'],
    accent: '#d97757',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    hosts: ['gemini.google.com'],
    composer: ['rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
    sendButton: ['button.send-button', 'button[aria-label*="Send"]'],
    requestMatch: /\/_\/BardChatUi\/data\/|batchexecute/,
    body: {
      kind: 'gemini-batch',
      // El cuerpo es un array anidado; se localiza el último string "de usuario".
      patch: (body, text) => {
        patchUserText(body, { body: { kind: 'gemini-batch' } }, text);
        return body;
      },
    },
    deltaPaths: null,
    accent: '#4285f4',
  },
  {
    id: 'copilot',
    label: 'Copilot',
    hosts: ['copilot.microsoft.com', 'www.bing.com'],
    composer: ['textarea#userInput', 'textarea[data-testid="composer-input"]', 'div[contenteditable="true"]'],
    sendButton: ['button[data-testid="submit-button"]', 'button[aria-label*="Submit"]'],
    requestMatch: /\/c\/api\/|conversation\/create/,
    body: { kind: 'copilot', patch: patchJsonMessages },
    deltaPaths: ['arguments[0].messages'],
    accent: '#0f6cbd',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    hosts: ['perplexity.ai', 'www.perplexity.ai'],
    composer: ['textarea[placeholder*="Ask"]', 'div[contenteditable="true"]', 'textarea'],
    sendButton: ['button[aria-label*="Submit"]', 'button[data-testid="submit-button"]'],
    requestMatch: /\/api\/query|perplexity_ask|\/rest\/sse/,
    body: { kind: 'perplexity', patch: patchJsonMessages },
    deltaPaths: ['text', 'delta'],
    accent: '#20b8cd',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hosts: ['chat.deepseek.com'],
    composer: ['textarea#chat-input', 'textarea'],
    sendButton: ['div[role="button"][aria-disabled="false"]', 'button[type="submit"]'],
    requestMatch: /\/api\/v0\/chat\/completion/,
    body: { kind: 'deepseek', patch: patchJsonMessages },
    deltaPaths: ['v', 'content'],
    accent: '#4d6bfe',
  },
  {
    id: 'grok',
    label: 'Grok',
    hosts: ['grok.com', 'x.com'],
    composer: ['textarea[aria-label*="Grok"]', 'div[contenteditable="true"]', 'textarea'],
    sendButton: ['button[aria-label*="Submit"]', 'button[type="submit"]'],
    requestMatch: /\/graphql\/|GrokConversation/,
    body: { kind: 'grok-graphql', patch: patchJsonMessages },
    deltaPaths: ['response', 'token'],
    accent: '#111827',
  },
  {
    id: 'mistral',
    label: 'Le Chat',
    hosts: ['chat.mistral.ai'],
    composer: ['textarea', 'div[contenteditable="true"]'],
    sendButton: ['button[type="submit"]'],
    requestMatch: /\/api\/v1\/conversations|stream/,
    body: { kind: 'mistral', patch: patchJsonMessages },
    deltaPaths: ['content', 'delta'],
    accent: '#fa520f',
  },
  {
    id: 'local',
    label: 'Ollama / LM Studio',
    hosts: ['localhost', '127.0.0.1'],
    composer: ['textarea', 'div[contenteditable="true"]'],
    sendButton: ['button[type="submit"]', 'button[aria-label*="Send"]'],
    requestMatch: /\/api\/chat|\/v1\/chat\/completions|completion/,
    body: { kind: 'openai-messages', patch: patchOpenAIMessages },
    deltaPaths: ['message.content', 'choices[0].delta.content', 'response'],
    accent: '#8b5cf6',
  },
];

const GENERIC = {
  id: 'generic',
  label: 'Sitio de IA genérico',
  hosts: [],
  composer: ['div[contenteditable="true"]', 'textarea'],
  sendButton: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button[aria-label*="Enviar"]'],
  requestMatch: /\/chat|\/completions|\/conversation|\/messages|\/api\/|stream|sse/i,
  body: { kind: 'generic', patch: patchJsonMessages },
  deltaPaths: null,
  accent: '#64748b',
};

/** Encuentra el perfil del sitio para un host. */
export function detectSite(host = '') {
  const clean = String(host).toLowerCase().replace(/^www\./, '').split(':')[0];
  const found = SITES.find((s) =>
    s.hosts.some((h) => clean === h || clean.endsWith(`.${h}`)),
  );
  return found || { ...GENERIC, host: clean };
}

/**
 * ¿La petición envía un mensaje de chat?
 *
 * Se evalúa sobre la RUTA (sin dominio ni query) cuando el perfil la declara, y
 * los sitios con `postOnly` sólo se median con POST: un GET nunca lleva mensaje,
 * y medirlo rompería listados y preparaciones intermedias.
 */
export function isChatRequest(profile, url = '', method = '') {
  if (!profile?.requestMatch) return false;
  if (profile.postOnly && method && String(method).toUpperCase() !== 'POST') return false;
  if (profile.requestPath) {
    let pathname = '';
    try {
      pathname = new URL(String(url), 'https://placeholder.invalid').pathname;
    } catch {
      return false;
    }
    return profile.requestPath.test(pathname);
  }
  return profile.requestMatch.test(url);
}

/**
 * Localiza el texto que el usuario acaba de escribir dentro del cuerpo de la
 * petición, sea cual sea el esquema del sitio.
 *
 * @param {any} body cuerpo ya parseado
 * @param {object} profile perfil del sitio
 * @returns {null | {path: Array<string|number>, value: string}}
 */
export function locateUserText(body, profile = {}) {
  const kind = profile?.body?.kind;

  if (kind === 'claude-prompt') {
    if (typeof body?.prompt === 'string') return { path: ['prompt'], value: body.prompt };
    if (profile.body.strict) return null;
  }

  if (kind === 'chatgpt-messages') {
    // Regenerar, variantes y continuar no llevan un mensaje nuevo del usuario:
    // tocarlos reescribiría cualquier otro string del cuerpo.
    if (body?.action && body.action !== 'next') return null;
    if (Array.isArray(body?.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i -= 1) {
        const m = body.messages[i];
        if (m?.author?.role !== 'user') continue;
        const parts = m.content?.parts;
        if (Array.isArray(parts)) {
          // Con adjuntos, `parts` mezcla objetos (imágenes, archivos) y texto:
          // se toma el último string no vacío y se deja el resto como está.
          for (let j = parts.length - 1; j >= 0; j -= 1) {
            if (typeof parts[j] === 'string' && parts[j].length) {
              return { path: ['messages', i, 'content', 'parts', j], value: parts[j] };
            }
          }
        }
        if (typeof m.content?.text === 'string' && m.content.text.length) {
          return { path: ['messages', i, 'content', 'text'], value: m.content.text };
        }
        // El último mensaje del usuario no tiene texto: no se mira más atrás.
        break;
      }
    }
    if (profile.body.strict) return null;
  }

  if (Array.isArray(body?.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i -= 1) {
      const m = body.messages[i];
      if (m?.role !== 'user') continue;
      if (typeof m.content === 'string' && m.content.length) {
        return { path: ['messages', i, 'content'], value: m.content };
      }
      if (Array.isArray(m.content)) {
        const idx = m.content.findIndex((p) => typeof p?.text === 'string' && p.text.length);
        if (idx >= 0) return { path: ['messages', i, 'content', idx, 'text'], value: m.content[idx].text };
      }
    }
  }

  if (typeof body?.prompt === 'string' && body.prompt.length) {
    return { path: ['prompt'], value: body.prompt };
  }

  if (Array.isArray(body?.f_req) && typeof body.f_req[1] === 'string') {
    const inner = safeParse(body.f_req[1]);
    if (inner) {
      const nested = locateUserText(inner, { body: { kind: 'generic' } });
      if (nested) return { path: ['f_req', 1, ...nested.path], value: nested.value, inner: true };
    }
  }

  // Genérico: el último string largo que no sea metadato.
  const candidates = [];
  collectStrings(body, candidates, []);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (candidates[i].value.length >= 8) {
      return { path: candidates[i].path, value: candidates[i].value };
    }
  }
  return null;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Escribe el texto mediado en el mismo lugar donde estaba el del usuario.
 * @returns {boolean} si se pudo sustituir
 */
export function patchUserText(body, profile, text) {
  const located = locateUserText(body, profile);
  if (!located) return false;

  if (located.inner) {
    const inner = safeParse(body.f_req[1]);
    if (!inner) return false;
    const innerPath = located.path.slice(2);
    if (!setPath(inner, innerPath, text)) return false;
    body.f_req[1] = JSON.stringify(inner);
    return true;
  }
  return setPath(body, located.path, text);
}

/** Sustituye el último mensaje de usuario en un array estilo OpenAI. */
export function patchOpenAIMessages(body, text) {
  patchUserText(body, { body: { kind: 'openai-messages' } }, text);
  return body;
}

/** Heurística genérica: reemplaza el último string de contenido. */
export function patchJsonMessages(body, text) {
  if (typeof body === 'string') return text;
  patchUserText(body, { body: { kind: 'generic' } }, text);
  return body;
}

const SKIP_KEYS = new Set([
  'model', 'id', 'uuid', 'role', 'type', 'conversation_id', 'parent_message_id',
  'timestamp', 'created_at', 'token', 'key', 'signature', 'csrf', 'nonce',
]);

function collectStrings(node, out, path, depth = 0) {
  if (depth > 8 || node == null) return;
  if (typeof node === 'string') {
    out.push({ path: [...path], value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, out, [...path, i], depth + 1));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k)) continue;
      collectStrings(v, out, [...path, k], depth + 1);
    }
  }
}

/** Sitios activos por defecto (todos, salvo que el usuario los desactive). */
export function allowedFor(settings, host) {
  const site = detectSite(host);
  const override = settings?.sites?.[site.id] || settings?.sites?.[host];
  if (override?.enabled === false) return false;
  return settings?.enabled !== false;
}

/**
 * Atajos de conversación: plantillas de texto del usuario para la IA.
 *
 * Son locales y del usuario. No se envían solas, no se sincronizan y no salen
 * del perfil. Se insertan en el cuadro del sitio para que la persona las edite
 * antes de enviar. Aquí sólo se valida y se rellena la plantilla; sin DOM y sin
 * red, para poder probarlo de forma determinista.
 */

export const MAX_PROMPTS = 40;
export const MAX_PROMPT_TITLE = 60;
export const MAX_PROMPT_TEXT = 4000;
/** Variables admitidas. Cualquier otra se deja tal cual y se informa. */
export const PROMPT_VARIABLES = ['seleccion', 'pestana', 'sitio', 'fecha'];

const VAR = /\{\{\s*([a-záéíóúñ]+)\s*\}\}/gi;

export function normalizePromptText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Valida y normaliza un atajo. Devuelve `{ ok, value }` o `{ ok:false, error }`.
 * El id lo decide quien llama (main), nunca la interfaz.
 */
export function validatePrompt(input = {}) {
  const title = normalizePromptText(input.title).slice(0, MAX_PROMPT_TITLE);
  const text = normalizePromptText(input.text);
  if (!title) return { ok: false, error: 'El atajo necesita un nombre.' };
  if (!text) return { ok: false, error: 'El atajo necesita un texto.' };
  if (text.length > MAX_PROMPT_TEXT)
    return { ok: false, error: `El texto supera ${MAX_PROMPT_TEXT} caracteres.` };
  return { ok: true, value: { title, text } };
}

/** Etiquetas de las variables usadas, en orden de aparición y sin repetir. */
export function promptVariables(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(VAR)) {
    const name = match[1].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Rellena la plantilla con los valores disponibles.
 *
 * - `missing` lista las variables que no tienen valor (no se borran: quedan
 *   visibles para que la persona las complete).
 * - `unknown` lista los nombres que no son variables admitidas; se dejan
 *   intactos porque pueden ser parte del texto.
 * Nunca recorta el texto ni normaliza el resultado.
 */
export function fillPrompt(text, values = {}) {
  const clean = String(text ?? '');
  const missing = new Set();
  const seen = new Set();
  const body = clean.replace(VAR, (whole, rawName) => {
    const name = rawName.toLowerCase();
    seen.add(name);
    if (!PROMPT_VARIABLES.includes(name)) return whole;
    const value = values[name];
    if (typeof value !== 'string' || !value) {
      missing.add(name);
      return whole;
    }
    return value;
  });
  return {
    text: body,
    missing: [...missing],
    unknown: [...seen].filter((name) => !PROMPT_VARIABLES.includes(name)),
  };
}

/** Lista acotada para el perfil: objetos planos, sin campos ajenos. */
export function sanitizePrompts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, MAX_PROMPTS)) {
    if (!item || typeof item !== 'object') continue;
    const valid = validatePrompt(item);
    if (!valid.ok) continue;
    const id = typeof item.id === 'string' && /^[a-z0-9-]{6,40}$/.test(item.id) ? item.id : null;
    out.push({ id, ...valid.value, updatedAt: Number(item.updatedAt) || Date.now() });
  }
  return out;
}

export function isPromptId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{6,40}$/.test(value);
}

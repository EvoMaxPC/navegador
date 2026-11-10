import { selectChatGptMessages, chatGptMessageContent } from './chatgptAdapter.js';

/**
 * Lectura del transporte DPU usado por ChatGPT en el modo web sin iniciar sesión.
 *
 * Ese modo entrega HTML parcial que Chromium aplica al documento. No es SSE ni
 * NDJSON: el texto final debe leerse del DOM una vez terminada la respuesta.
 */

const DPU_MIME = /^text\/vnd\.openai\.web-mobile-partial\+html(?:\s*;|$)/i;

const ANSWER_MARKERS = [
  'ChatGPT said:',
  'ChatGPT dijo:',
  'ChatGPT dice:',
  'ChatGPT respondió:',
  'ChatGPT responde:',
];

const USER_MARKERS = [
  'You said:',
  'You asked:',
  'Tú dijiste:',
  'Tú preguntaste:',
  'Dijiste:',
  'Has dicho:',
  'Usuario:',
];

const FOOTER_MARKERS = [
  'ChatGPT is AI and can make mistakes',
  'We use cookies',
];

export function isChatGptDpuMime(mimeType = '') {
  return DPU_MIME.test(String(mimeType || '').trim());
}

/**
 * Extrae la respuesta más reciente del texto visible del documento.
 * Exige que el prompt actual aparezca antes del marcador de respuesta: así no
 * vuelve a contar una respuesta anterior si el servidor devuelve un error DPU.
 */
/**
 * Extrae texto visible incluso cuando el cliente DPU no renderiza encabezados
 * como "ChatGPT said". La asociación se hace con la última aparición del prompt.
 */
export function extractChatGptVisibleAnswer(documentRef, prompt = '') {
  const roleSnapshot = readChatGptDpuAnswer(documentRef, prompt);
  // Si hay un nodo de usuario, su identidad manda: no caer al texto histórico
  // del body cuando el último prompt no coincide o todavía no tiene respuesta.
  if (roleSnapshot.user) return roleSnapshot.text;

  const body = String(documentRef?.body?.innerText || documentRef?.body?.textContent || '');
  const labelled = extractChatGptDpuAnswer(body, prompt);
  if (labelled) return labelled;

  const expected = String(prompt || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (!expected) return '';
  const normalized = body.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLocaleLowerCase();
  const promptIndex = lower.lastIndexOf(expected);
  if (promptIndex < 0) return '';

  let answer = normalized.slice(promptIndex + expected.length).trim();
  for (const marker of FOOTER_MARKERS) {
    const index = answer.toLocaleLowerCase().indexOf(marker.toLocaleLowerCase());
    if (index >= 0) answer = answer.slice(0, index).trim();
  }
  for (const marker of USER_MARKERS) {
    const index = answer.toLocaleLowerCase().indexOf(marker.toLocaleLowerCase());
    if (index >= 0) answer = answer.slice(0, index).trim();
  }
  for (const marker of ANSWER_MARKERS) {
    if (answer.toLocaleLowerCase().startsWith(marker.toLocaleLowerCase())) {
      answer = answer.slice(marker.length).trim();
      break;
    }
  }
  return answer;
}

export function extractChatGptDpuAnswer(bodyText, prompt = '') {
  const body = String(bodyText || '').replace(/\r\n?/g, '\n');
  if (!body.trim()) return '';

  let end = body.length;
  for (const marker of FOOTER_MARKERS) {
    const index = body.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  const region = body.slice(0, end);

  let marker = '';
  let markerIndex = -1;
  for (const candidate of ANSWER_MARKERS) {
    const index = region.lastIndexOf(candidate);
    if (index > markerIndex) {
      marker = candidate;
      markerIndex = index;
    }
  }
  if (markerIndex < 0) return '';

  const expected = String(prompt || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (expected) {
    let userMarker = '';
    let userMarkerIndex = -1;
    for (const candidate of USER_MARKERS) {
      const index = region.lastIndexOf(candidate);
      if (index > userMarkerIndex) {
        userMarker = candidate;
        userMarkerIndex = index;
      }
    }

    if (userMarkerIndex >= 0) {
      // El último prompt visible tiene que estar antes de la respuesta elegida.
      // Evita asociar el mismo prompt repetido con la respuesta del turno anterior.
      if (userMarkerIndex >= markerIndex) return '';
      const currentPrompt = region.slice(userMarkerIndex + userMarker.length, markerIndex)
        .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      if (!currentPrompt.includes(expected)) return '';
    } else {
      // Compatibilidad con layouts sin etiqueta textual de mensaje del usuario.
      const beforeAnswer = region.slice(0, markerIndex).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      if (!beforeAnswer.includes(expected)) return '';
    }
  }

  return region.slice(markerIndex + marker.length).trim();
}


/** Lee el mensaje assistant posterior al último usuario renderizado.
 * Los atributos de rol no dependen del idioma de las etiquetas de accesibilidad.
 * La lectura textual antigua queda como respaldo para layouts sin esos nodos.
 */
export function readChatGptDpuAnswer(document, prompt = '') {
  const { messages } = selectChatGptMessages(document);
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  if (userIndex >= 0) {
    const user = messages[userIndex].node;
    const assistant = messages.slice(userIndex + 1).findLast((message) => message.role === 'assistant')?.node || null;
    if (!assistant) return { text: '', user, assistant: null, body: '' };
    const content = chatGptMessageContent(assistant, 'assistant');
    return { text: String(content.innerText ?? content.textContent ?? '').trim(), user, assistant, body: '' };
  }

  const body = String(document?.body?.innerText || '');
  return { text: extractChatGptDpuAnswer(body, prompt), user: null, assistant: null, body };
}

/** Espera acotada a la aplicación del HTML; no instala observadores permanentes. */
export async function waitForChatGptDpuAnswer(document, prompt, before, {
  timeout = 5000, interval = 50, stableFor = 100, isCurrent = () => true, requireRole = false,
} = {}) {
  const start = Date.now();
  let previous = '', stableSince = start;
  while (Date.now() - start < timeout && isCurrent()) {
    const snapshot = readChatGptDpuAnswer(document, prompt);
    const fresh = !before?.text || snapshot.text !== before.text || snapshot.body !== before.body ||
      snapshot.user !== before.user || snapshot.assistant !== before.assistant;
    if (snapshot.text && fresh && (!requireRole || snapshot.assistant)) {
      if (snapshot.text !== previous) { previous = snapshot.text; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= stableFor) return snapshot.text;
    } else { previous = ''; stableSince = Date.now(); }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return '';
}


/** Compatibilidad con el lector autenticado recibido del remoto: mismo parser. */
export function extractChatGptAssistantDomText(document, prompt = '') {
  const snapshot = readChatGptDpuAnswer(document, prompt);
  return snapshot.assistant ? snapshot.text : '';
}

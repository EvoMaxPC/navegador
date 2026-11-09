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

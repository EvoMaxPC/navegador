// Lee el texto del cuerpo de un fetch SIN consumirlo ni modificarlo.
// Devuelve { text, reason }. Si text es null, reason explica por qué.
export const MAX_BODY = 5_000_000;

const NO = (reason) => ({ text: null, reason });
const OK = (text) => ({ text, reason: null });

const esFormulario = (tipo) =>
  /^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(tipo || '');

export async function readBody(input, init) {
  try {
    const body = init?.body;

    // Sin body en init: puede venir dentro de un Request.
    if (body === undefined) {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        if (input.bodyUsed) return NO('stream-o-desconocido');
        if (input.body === null) return NO('sin-cuerpo');
        if (esFormulario(input.headers.get('content-type'))) return NO('formulario');
        const declarado = Number(input.headers.get('content-length'));
        if (Number.isFinite(declarado) && declarado > MAX_BODY) return NO('demasiado-grande');
        const text = await input.clone().text();
        return text.length > MAX_BODY ? NO('demasiado-grande') : OK(text);
      }
      return NO('sin-cuerpo');
    }
    if (body === null) return NO('sin-cuerpo');

    if (typeof body === 'string') {
      return body.length > MAX_BODY ? NO('demasiado-grande') : OK(body);
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      if (body.size > MAX_BODY) return NO('demasiado-grande');
      return OK(await body.text()); // Blob se puede releer: el original queda intacto
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      if (body.byteLength > MAX_BODY) return NO('demasiado-grande');
      return OK(new TextDecoder().decode(body));
    }
    if ((typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
        (typeof FormData !== 'undefined' && body instanceof FormData)) {
      return NO('formulario');
    }
    return NO('stream-o-desconocido'); // ReadableStream u otro: no se toca
  } catch {
    return NO('stream-o-desconocido');
  }
}

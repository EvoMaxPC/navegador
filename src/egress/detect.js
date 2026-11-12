// Detección de datos sensibles en texto. Puro: sin E/S ni dependencias.
// Cada hallazgo es { type, severity, start, end }. NO lleva el valor: quien lo
// necesite lo corta del texto original, así un hallazgo nunca filtra el dato si
// se registra o serializa por error.
// Los formatos de clave son los conocidos al escribir este módulo; revisar con
// el tiempo y ampliar según se vean casos reales.

export const SEVERITY = Object.freeze({
  api_key: 'critical',
  card: 'critical',
  email: 'medium',
  dni_es: 'medium',
});

// Los lookbehind (?<!...) impiden empezar a mitad de una palabra y mantienen
// el coste lineal en textos largos.
const API_KEY_PATTERNS = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// PEM: la cabecera se localiza con una regex plana y el cierre con `indexOf`
// acotado a la ventana. La variante anterior expandía hasta 8000 caracteres por
// cabecera antes de rendirse, y con miles de cabeceras sin END eso se notaba.
const PEM_BEGIN = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----/g;
const PEM_WINDOW = 8000;
const pemEnd = (etiqueta) => `-----END ${etiqueta}PRIVATE KEY-----`;

// 14 a 19 dígitos, primer dígito 2-6, separadores simples. Con Luhn.
// Se excluye 13 dígitos y primer dígito 1/7/8/9 para no marcar marcas de
// tiempo en ms ni identificadores numéricos.
const CARD = /(?<!\d)[2-6](?:[ -]?\d){13,18}(?!\d)/g;

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

const DNI = /(?<![A-Za-z0-9])(\d{8})-?([A-Za-z])(?![A-Za-z0-9])/g;
const NIE = /(?<![A-Za-z0-9])([XYZxyz])-?(\d{7})-?([A-Za-z])(?![A-Za-z0-9])/g;
const LETRAS = 'TRWAGMYFPDXBNJZSQVHLCKE';

function luhn(digits) {
  let sum = 0;
  let doble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (doble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doble = !doble;
  }
  return sum % 10 === 0;
}

export function detectSensitive(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const raw = [];
  const push = (type, m) =>
    raw.push({ type, severity: SEVERITY[type], start: m.index, end: m.index + m[0].length });

  for (const re of API_KEY_PATTERNS) for (const m of text.matchAll(re)) push('api_key', m);

  // Un bloque sólo se toma entero si su END lleva la misma etiqueta y empieza
  // dentro de la ventana; si no, el hallazgo es la cabecera sola. Las búsquedas
  // de cada etiqueta van en orden creciente, así que el último resultado sirve
  // de caché: si no había END más adelante, tampoco lo habrá después.
  const pemCache = new Map();
  for (const m of text.matchAll(PEM_BEGIN)) {
    const etiqueta = m[1];
    const marcador = pemEnd(etiqueta);
    const desde = m.index + m[0].length;
    const previo = pemCache.get(etiqueta);
    let fin;
    if (previo && desde >= previo.desde && (previo.indice === -1 || previo.indice >= desde)) {
      fin = previo.indice;
    } else {
      fin = text.indexOf(marcador, desde);
    }
    pemCache.set(etiqueta, { desde, indice: fin });
    const cierre = fin !== -1 && fin <= desde + PEM_WINDOW ? fin + marcador.length : desde;
    raw.push({ type: 'api_key', severity: SEVERITY.api_key, start: m.index, end: cierre });
  }

  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 14 && digits.length <= 19 && luhn(digits)) push('card', m);
  }

  for (const m of text.matchAll(EMAIL)) push('email', m);

  for (const m of text.matchAll(DNI)) {
    if (LETRAS[Number(m[1]) % 23] === m[2].toUpperCase()) push('dni_es', m);
  }
  for (const m of text.matchAll(NIE)) {
    const prefijo = { X: 0, Y: 1, Z: 2 }[m[1].toUpperCase()];
    if (LETRAS[Number(`${prefijo}${m[2]}`) % 23] === m[3].toUpperCase()) push('dni_es', m);
  }

  // Orden por inicio (y el más largo primero); sin solapes.
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let ultimo = 0;
  for (const f of raw) {
    if (f.start >= ultimo) {
      out.push(f);
      ultimo = f.end;
    }
  }
  return out;
}

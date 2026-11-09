/**
 * Genera el icono de la aplicación sin dependencias externas.
 *
 * Escribe `build/icon.png` (512 px) y `build/icon.ico` (16–256 px, entradas PNG,
 * soportadas por Windows Vista en adelante). El dibujo se hace a 3× y se reduce
 * por promedio, que es suficiente anti-aliasing para un icono.
 *
 *   node scripts/make-icon.mjs
 *
 * También se puede importar (`generateIcons(dir)`) para que las pruebas armen el
 * icono en un directorio temporal sin depender de archivos generados.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SS = 3; // supermuestreo
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ---------------- dibujo ---------------- */

const lerp = (a, b, t) => a + (b - a) * t;

/** Distancia de un punto a un segmento. */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Color del icono en coordenadas normalizadas 0..1. */
function sample(u, v, size) {
  // Esquinas redondeadas.
  const radius = 0.22;
  const cx = Math.min(Math.max(u, radius), 1 - radius);
  const cy = Math.min(Math.max(v, radius), 1 - radius);
  const corner = Math.hypot(u - cx, v - cy);
  if (corner > radius) return [0, 0, 0, 0];

  // Fondo: degradado diagonal índigo → verde azulado.
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  const bg = [lerp(0x8f, 0x3e, t), lerp(0x9d, 0xe0, t), lerp(0xff, 0xb0, t), 255];

  // Letra «N»: dos verticales y una diagonal, en blanco.
  const stroke = 0.085;
  const left = 0.3;
  const right = 0.7;
  const top = 0.26;
  const bottom = 0.74;
  const d = Math.min(
    distanceToSegment(u, v, left, bottom, left, top),
    distanceToSegment(u, v, right, bottom, right, top),
    distanceToSegment(u, v, left, top, right, bottom),
  );
  // Suavizado del borde del trazo.
  const alpha = Math.min(1, Math.max(0, (stroke - d) * size * 0.5));
  if (alpha <= 0) return bg;
  return [lerp(bg[0], 255, alpha), lerp(bg[1], 255, alpha), lerp(bg[2], 255, alpha), 255];
}

/** Renderiza un tamaño con supermuestreo y devuelve RGBA. */
function render(size) {
  const big = size * SS;
  const acc = new Float32Array(size * size * 4);
  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const [r, g, b, a] = sample((x + 0.5) / big, (y + 0.5) / big, size);
      const tx = (x / SS) | 0;
      const ty = (y / SS) | 0;
      const i = (ty * size + tx) * 4;
      acc[i] += r * a;
      acc[i + 1] += g * a;
      acc[i + 2] += b * a;
      acc[i + 3] += a;
    }
  }
  const px = Buffer.alloc(size * size * 4);
  const samples = SS * SS;
  for (let i = 0; i < size * size; i += 1) {
    const a = acc[i * 4 + 3] / samples;
    if (a > 0) {
      px[i * 4] = Math.round(acc[i * 4] / acc[i * 4 + 3]);
      px[i * 4 + 1] = Math.round(acc[i * 4 + 1] / acc[i * 4 + 3]);
      px[i * 4 + 2] = Math.round(acc[i * 4 + 2] / acc[i * 4 + 3]);
    }
    px[i * 4 + 3] = Math.round(a);
  }
  return px;
}

/* ---------------- PNG ---------------- */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // profundidad
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filtro none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO ---------------- */

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

/* ---------------- salida ---------------- */

/**
 * Escribe `icon.ico` (7 tamaños), `icon.png` (512 px) e `icon-256.png` en `dir`.
 *
 * @param {string} dir
 * @returns {{ ico: string, png: string, preview: string }}
 */
export function generateIcons(dir) {
  mkdirSync(dir, { recursive: true });
  const images = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
  const biggest = images.find((image) => image.size === 256) || images.at(-1);

  const paths = {
    ico: resolve(dir, 'icon.ico'),
    png: resolve(dir, 'icon.png'),
    preview: resolve(dir, 'icon-256.png'),
  };
  writeFileSync(paths.png, encodePng(512, render(512)));
  writeFileSync(paths.ico, encodeIco(images));
  writeFileSync(paths.preview, biggest.png);
  return paths;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  generateIcons(resolve(root, 'build'));
  console.log(`iconos listos · icon.ico (${SIZES.join(', ')} px) · icon.png 512 px`);
}

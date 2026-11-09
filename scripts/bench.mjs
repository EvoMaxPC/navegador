/**
 * Banco de pruebas de rendimiento.
 *
 * Mide los caminos que se ejecutan en el uso real, no funciones sueltas:
 *
 *  - recepción de una respuesta en streaming (el camino más caliente: se ejecuta
 *    por cada token que llega, mientras el usuario mira),
 *  - envío de un mensaje con una conversación larga,
 *  - memoria EVO con un archivo poblado,
 *  - historial y sugerencias con miles de entradas,
 *  - coste de evaluar la capa inyectada en cada página,
 *  - arranque del proceso principal.
 *
 *   npm run bench                          # tabla con los números
 *   npm run bench -- --json                # además, la instantánea en JSON
 *   npm run bench -- --json-out=archivo    # la instantánea, sin ensuciar la consola
 *   npm run bench -- --reps=20             # más repeticiones (más estable)
 *
 * Los números son de este contenedor, no de la máquina del usuario: valen para
 * comparar antes/después y para detectar regresiones, no como promesa absoluta.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { StreamSentinel } from '../src/core/streamSentinel.js';
import { analyzeTail } from '../src/core/analysis.js';
import { enhancePrompt } from '../src/core/promptEngine.js';
import { createStreamFilter } from '../src/core/streamFilter.js';
import { HistoryStore } from '../src/nav/history.js';
import { BookmarkStore } from '../src/nav/bookmarks.js';
import { createMemory } from '../src/main/memory.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const found = process.argv.find((v) => v.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const reps = Number(arg('reps', 5));

/* ------------------------------------------------------------------ */
/* datos                                                              */
/* ------------------------------------------------------------------ */

const PARRAFO =
  'Para calcular el interés compuesto necesitás tres datos: el capital inicial, la tasa ' +
  'periódica y la cantidad de períodos. La fórmula es capital por uno más la tasa elevado ' +
  'al número de períodos. Si la tasa es anual y los períodos son meses, dividí la tasa por ' +
  'doce antes de aplicarla, porque mezclar unidades es el error más común. ';

const BUCLE =
  'Y entonces el proceso se repite una y otra vez, ' +
  'porque el bucle no tiene condición de salida y vuelve al mismo estado inicial. ';

/** Texto normal de ~20 000 caracteres. */
function textoLargo(chars = 20000) {
  let out = '';
  let n = 0;
  while (out.length < chars) out += `${n += 1}. ${PARRAFO}\n\n`;
  return out.slice(0, chars);
}

/** Texto que termina en un bucle claro (el caso que el centinela debe cortar). */
function textoConBucle(chars = 12000) {
  let out = textoLargo(Math.max(0, chars - 2000));
  while (out.length < chars) out += BUCLE;
  return out;
}

/** Aproxima lo que llega del modelo: deltas de 4 caracteres. */
function deltas(text, size = 4) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* medición                                                           */
/* ------------------------------------------------------------------ */

const resultados = [];

function medir(nombre, unidad, fn, { min = 1000 } = {}) {
  // Calentamiento: sin esto el primer número mide la compilación JIT, no el código.
  for (let i = 0; i < Math.min(3, reps); i += 1) fn();
  const muestras = [];
  for (let i = 0; i < reps; i += 1) {
    const t0 = performance.now();
    const ops = fn();
    const ms = performance.now() - t0;
    muestras.push({ ms, ops: ops || 1 });
  }
  muestras.sort((a, b) => a.ms - b.ms);
  const mejor = muestras[0];
  const mediana = muestras[Math.floor(muestras.length / 2)];
  const porOperacion = mejor.ms / mejor.ops;
  resultados.push({
    nombre,
    unidad,
    mejor: mejor.ms,
    mediana: mediana.ms,
    ops: mejor.ops,
    msPorOp: porOperacion,
    porSegundo: porOperacion > 0 ? 1000 / porOperacion : Infinity,
    // Cuando la medición hace N operaciones por vuelta, la tabla muestra el
    // costo por operación y el total entre paréntesis.
    mostrar: mejor.ops > 1 ? `${fmt(porOperacion, 3)} ms  (${fmt(mejor.ms, 2)} ms × ${mejor.ops})` : undefined,
    notaMin: min,
  });
  return mejor;
}

const fmt = (n, decimals = 2) =>
  Number.isFinite(n) ? n.toLocaleString('es-AR', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) : '—';

/* ------------------------------------------------------------------ */
/* 1. recepción: centinela sobre un stream                            */
/* ------------------------------------------------------------------ */

{
  const texto = textoLargo();
  const partes = deltas(texto);
  medir('centinela · texto normal (20 000 caracteres)', 'respuesta', () => {
    const sentinel = new StreamSentinel({ settings: {} });
    for (const delta of partes) sentinel.push(delta);
    if (sentinel.delivered.length === 0) throw new Error('no entregó texto');
    return 1;
  }, { reps: Math.max(3, Math.floor(reps / 2)) });

  const porChar = resultados.at(-1).msPorOp / texto.length;
  resultados.push({
    nombre: 'centinela · coste por carácter (texto normal)',
    unidad: 'µs/carácter',
    mejor: 0,
    mediana: 0,
    ops: texto.length,
    msPorOp: porChar,
    porSegundo: porChar > 0 ? 1000 / porChar : Infinity,
    mostrar: `${fmt(porChar * 1000, 3)} µs`,
  });
}

{
  const texto = textoConBucle();
  const partes = deltas(texto);
  let cortado = null;
  medir('centinela · texto con bucle (12 000 caracteres)', 'respuesta', () => {
    const sentinel = new StreamSentinel({ settings: {} });
    for (const delta of partes) sentinel.push(delta);
    cortado = sentinel.stopped ? sentinel.cutIndex : null;
    return 1;
  }, { reps: Math.max(3, Math.floor(reps / 2)) });
  if (cortado === null) throw new Error('el centinela no detectó el bucle: la medición no vale');
  console.log(`  (el bucle se cortó en el carácter ${cortado.toLocaleString('es-AR')})`);
}

{
  const tail = textoLargo(6000);
  const vueltas = 20;
  medir('análisis profundo (analyzeTail sobre 6 000 caracteres)', 'llamada', () => {
    for (let i = 0; i < vueltas; i += 1) analyzeTail(tail, {});
    return vueltas;
  });
}

/* ------------------------------------------------------------------ */
/* 2. recepción: filtro SSE completo                                  */
/* ------------------------------------------------------------------ */

async function medirSse() {
  const eventos = [];
  const texto = textoLargo(9000);
  for (const delta of deltas(texto, 40)) {
    eventos.push(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
  }
  eventos.push('data: [DONE]\n\n');
  const cuerpo = eventos.join('');
  const bytes = new TextEncoder().encode(cuerpo);
  const trozos = [];
  for (let i = 0; i < bytes.length; i += 512) trozos.push(bytes.slice(i, i + 512));

  const correr = async () => {
    const t0 = performance.now();
    const filter = createStreamFilter({ settings: {}, deltaPaths: ['choices[0].delta.content'] });
    const writer = filter.writable.getWriter();
    const reader = filter.readable.getReader();
    const leer = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })();
    for (const trozo of trozos) await writer.write(trozo);
    await writer.close();
    await leer;
    return performance.now() - t0;
  };

  await correr();
  const muestras = [];
  for (let i = 0; i < reps; i += 1) muestras.push(await correr());
  muestras.sort((a, b) => a - b);
  const mb = bytes.length / 1024 / 1024;
  resultados.push({
    nombre: 'filtro SSE · respuesta de 9 000 caracteres',
    unidad: 'respuesta',
    mejor: muestras[0],
    mediana: muestras[Math.floor(muestras.length / 2)],
    ops: 1,
    msPorOp: muestras[0],
    porSegundo: 1000 / muestras[0],
    mostrar: `${fmt(muestras[0], 2)} ms · ${fmt(mb / (muestras[0] / 1000), 1)} MB/s`,
  });
}

/* ------------------------------------------------------------------ */
/* 3. envío: motor saliente con conversación larga                     */
/* ------------------------------------------------------------------ */

{
  const historia = [];
  for (let i = 0; i < 24; i += 1) {
    historia.push({
      role: i % 2 ? 'assistant' : 'user',
      content: `${PARRAFO}\n\nDecisión ${i}: usar la tasa mensual. Pendiente: validar con el contador.`,
    });
  }
  const mensaje =
    'Seguimos con lo de ayer. Revisá el cálculo del interés y decime si el pendiente de la ' +
    'validación sigue abierto. Sé breve pero explicá el paso a paso, y acordate de que el ' +
    'informe va en español.';
  medir('motor saliente · mensaje con 24 turnos de historial', 'mensaje', () => {
    const out = enhancePrompt({ prompt: mensaje, history: historia, settings: {} });
    if (!out.enhanced) throw new Error('no devolvió texto');
    return 1;
  }, { reps: Math.max(3, Math.floor(reps / 2)) });
}

/* ------------------------------------------------------------------ */
/* 4. memoria EVO poblada                                             */
/* ------------------------------------------------------------------ */

async function medirMemoria() {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-bench-mem-'));
  try {
    const { memory } = createMemory({ dir, projectId: 'bench' });
    for (let i = 0; i < 300; i += 1) {
      memory.remember({
        role: i % 2 ? 'assistant' : 'user',
        content:
          `Turno ${i}. Decisión: fijar la tasa mensual en ${(1 + (i % 9) / 100).toFixed(2)}%. ` +
          `Restricción: el informe va en español y sin jerga. Pendiente: validar la planilla ${i}.`,
      });
    }
    const consulta = '¿qué decidimos sobre la tasa mensual y qué quedó pendiente del informe?';
    medir('memoria EVO · recuperación con 300 turnos', 'consulta', () => {
      const out = memory.recall(consulta, { limit: 12 });
      if (!out) throw new Error('sin resultado');
      return 1;
    });

    medir('memoria EVO · destilado de un turno', 'turno', () => {
      memory.remember({
        role: 'user',
        content: 'Decisión: publicar el jueves. Restricción: sin dependencias nuevas. Pendiente: revisar el ZIP.',
      });
      return 1;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 5. historial y sugerencias con miles de entradas                   */
/* ------------------------------------------------------------------ */

{
  const dir = mkdtempSync(join(tmpdir(), 'nexo-bench-hist-'));
  try {
    const history = new HistoryStore({ file: join(dir, 'history.json') });
    const hosts = ['chat.openai.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai'];
    for (let i = 0; i < 4000; i += 1) {
      history.add({
        url: `https://${hosts[i % hosts.length]}/c/${i}`,
        title: `Conversación ${i} sobre ${['interés', 'hipotecas', 'impuestos', 'ahorro'][i % 4]}`,
        visitTime: Date.now() - i * 60_000,
      });
    }
    medir('historial · búsqueda sobre 4 000 entradas', 'consulta', () => {
      history.search('interés compuesto', { limit: 50 });
      return 1;
    });
    medir('historial · sugerencias de la barra', 'consulta', () => {
      history.suggest('claude', { limit: 8 });
      return 1;
    });
    medir('historial · sitios frecuentes', 'consulta', () => {
      history.topSites({ limit: 8 });
      return 1;
    });

    // El camino real de la barra de direcciones: marcadores + historial + el
    // filtro de repetidos que hace el proceso principal, en cada tecla.
    const bookmarks = new BookmarkStore({ file: join(dir, 'bookmarks.json') });
    for (let i = 0; i < 200; i += 1) {
      bookmarks.add({ url: `https://${hosts[i % hosts.length]}/b/${i}`, title: `Marcador ${i} de finanzas` });
    }
    medir('barra de direcciones · sugerencias (200 marcadores + 4 000 visitas)', 'tecla', () => {
      const query = 'finanzas';
      const seen = new Set();
      const out = [...bookmarks.suggest(query, { limit: 4 }), ...history.suggest(query, { limit: 6 })]
        .filter((item) => (seen.has(item.url) ? false : (seen.add(item.url), true)))
        .slice(0, 8);
      if (!out.length) throw new Error('sin sugerencias');
      return 1;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 6. capa inyectada: tamaño y coste de evaluar en cada página        */
/* ------------------------------------------------------------------ */

{
  const ruta = join(root, 'build', 'inject.js');
  const fuente = readFileSync(ruta, 'utf8');
  const kb = statSync(ruta).size / 1024;
  const vueltas = 50;
  medir('inyección · evaluar el bundle en una página nueva', 'evaluación', () => {
    for (let i = 0; i < vueltas; i += 1) new Function(fuente);
    return vueltas;
  });
  resultados.push({
    nombre: 'inyección · tamaño del bundle',
    unidad: 'kB',
    mejor: kb,
    mediana: kb,
    ops: 1,
    msPorOp: kb,
    porSegundo: 0,
    mostrar: `${fmt(kb, 1)} kB`,
  });
}

/* ------------------------------------------------------------------ */
/* 7. arranque del proceso principal                                  */
/* ------------------------------------------------------------------ */

function medirArranque() {
  const script = `
    import { register } from 'node:module';
    import { dirname, join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const here = ${JSON.stringify(join(root, 'test'))};
    register('file://' + join(here, 'harness', 'loader.mjs'));
    const t0 = performance.now();
    const { journal } = await import('file://' + join(here, 'harness', 'electron-stub.mjs'));
    await import(${JSON.stringify(`file://${join(root, 'src/main/main.js')}`)});
    const esperar = () => new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 40 && journal.windows.length === 0; i += 1) await esperar();
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ ms, ventanas: journal.windows.length }));
    process.exit(0);
  `;
  const muestras = [];
  for (let i = 0; i < Math.max(3, reps); i += 1) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    const linea = (run.stdout || '').trim().split('\n').filter(Boolean).at(-1);
    if (!linea) throw new Error(`el arranque falló: ${run.stderr}`);
    muestras.push(JSON.parse(linea).ms);
  }
  muestras.sort((a, b) => a - b);
  resultados.push({
    nombre: 'arranque · proceso principal hasta la primera ventana',
    unidad: 'arranque',
    mejor: muestras[0],
    mediana: muestras[Math.floor(muestras.length / 2)],
    ops: 1,
    msPorOp: muestras[0],
    porSegundo: 1000 / muestras[0],
    mostrar: `${fmt(muestras[0], 1)} ms`,
  });
}

/* ------------------------------------------------------------------ */
/* ejecución                                                          */
/* ------------------------------------------------------------------ */

await medirSse();
await medirMemoria();
medirArranque();

console.log('\n── Nexo · rendimiento ──────────────────────────────────────────────────────────');
for (const r of resultados) {
  const valor = r.mostrar || `${fmt(r.mejor, 2)} ms (${fmt(r.porSegundo, 1)}/s)`;
  console.log(`${r.nombre.padEnd(58, '.')} ${valor.padStart(22)}`);
}
console.log('────────────────────────────────────────────────────────────────────────────────\n');

// `texto` es exactamente lo que muestra la tabla: la medida derivada (µs por
// carácter, tamaño en kB) se calcula una sola vez, acá.
const instantanea = Object.fromEntries(
  resultados.map((r) => [
    r.nombre,
    {
      ms: Number(r.msPorOp.toFixed(6)),
      ops: r.ops,
      unidad: r.unidad || '',
      texto: r.mostrar || '',
    },
  ]),
);

// `--json-out=archivo` deja la instantánea en un archivo sin ensuciar la
// consola: la usa la compilación de Windows para publicar sus números.
const guardar = process.argv.find((valor) => valor.startsWith('--json-out='));
if (guardar) {
  const destino = resolve(root, guardar.slice('--json-out='.length));
  writeFileSync(destino, `${JSON.stringify(instantanea, null, 2)}\n`, 'utf8');
  console.log(`instantánea guardada en ${destino}\n`);
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(instantanea, null, 2));
}

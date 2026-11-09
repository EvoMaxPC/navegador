/**
 * Presupuesto de rendimiento.
 *
 * Un navegador se degrada de a poco: nadie nota que una consulta pasó de 0,4 ms
 * a 2 ms hasta que la barra de direcciones se siente lenta con el historial
 * lleno. Estas pruebas fijan un techo por operación y fallan si alguien lo
 * cruza, con márgenes amplios para que no dependan de la máquina.
 *
 * Los números finos (para comparar optimizaciones) están en `npm run bench`.
 * Acá sólo se vigila que nada se dispare: son un trinquete, no un cronómetro.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeTail } from '../src/core/analysis.js';
import { StreamSentinel } from '../src/core/streamSentinel.js';
import { HistoryStore } from '../src/nav/history.js';
import { BookmarkStore } from '../src/nav/bookmarks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Mediana de `reps` ejecuciones, en milisegundos, con calentamiento previo. */
function mediana(reps, fn) {
  for (let i = 0; i < 3; i += 1) fn();
  const tiempos = [];
  for (let i = 0; i < reps; i += 1) {
    const t0 = performance.now();
    fn();
    tiempos.push(performance.now() - t0);
  }
  tiempos.sort((a, b) => a - b);
  return tiempos[Math.floor(tiempos.length / 2)];
}

const PIEZAS = [
  'El interés compuesto se calcula multiplicando el capital por uno más la tasa elevado al período.',
  'Para la hipoteca conviene comparar el costo financiero total y no sólo la tasa nominal.',
  'Los impuestos sobre los ingresos personales se escalonan por tramos progresivos.',
  'Un fondo de ahorro conservador prioriza liquidez antes que rentabilidad esperada.',
  'La inflación acumulada en doce meses no es la suma de las doce inflaciones mensuales.',
  'Al invertir en letras del tesoro hay que mirar la tasa efectiva anual y el plazo.',
];

function textoLargo(chars) {
  let out = '';
  let i = 0;
  while (out.length < chars) {
    out += `${PIEZAS[i % PIEZAS.length]} Caso ${i + 1}.\n\n`;
    i += 1;
  }
  return out.slice(0, chars);
}

test('el análisis del stream no se dispara con textos largos', () => {
  const texto = textoLargo(6000);
  const ms = mediana(20, () => analyzeTail(texto, {}));
  assert.ok(ms < 3, `analyzeTail sobre 6 000 caracteres tardó ${ms.toFixed(2)} ms (techo 3 ms)`);
});

test('el centinela procesa una respuesta completa en tiempo despreciable', () => {
  const texto = textoLargo(20_000);
  const ms = mediana(5, () => {
    const sentinel = new StreamSentinel();
    for (let i = 0; i < texto.length; i += 40) sentinel.push(texto.slice(i, i + 40));
  });
  assert.ok(ms < 40, `20 000 caracteres en deltas de 40 tardaron ${ms.toFixed(1)} ms (techo 40 ms)`);
  // El costo por carácter es la métrica que importa: no depende del largo.
  const porChar = (ms * 1000) / texto.length;
  assert.ok(porChar < 2, `${porChar.toFixed(3)} µs por carácter (techo 2 µs)`);
});

test('la barra de direcciones responde rápido con el historial lleno', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-perf-'));
  try {
    const history = new HistoryStore({ file: join(dir, 'history.json') });
    const hosts = ['banco.com', 'clima.gob.ar', 'noticias.com', 'tienda.com', 'docs.dev'];
    for (let i = 0; i < 4000; i += 1) {
      history.add({ url: `https://${hosts[i % hosts.length]}/p/${i}`, title: `Página ${i} de finanzas personales`, ts: Date.now() - i * 60_000 });
    }
    const bookmarks = new BookmarkStore({ file: join(dir, 'bookmarks.json') });
    for (let i = 0; i < 200; i += 1) {
      bookmarks.add({ url: `https://${hosts[i % hosts.length]}/b/${i}`, title: `Marcador ${i} de finanzas` });
    }

    // Calentamiento del índice: la primera consulta lo construye.
    history.search('finanzas');
    bookmarks.suggest('finanzas');

    const ms = mediana(10, () => {
      const seen = new Set();
      const out = [...bookmarks.suggest('finanzas', { limit: 4 }), ...history.suggest('finanzas', { limit: 6 })].filter(
        (item) => (seen.has(item.url) ? false : (seen.add(item.url), true)),
      );
      assert.ok(out.length > 0);
    });
    assert.ok(ms < 8, `sugerencias con 4 000 visitas tardaron ${ms.toFixed(2)} ms (techo 8 ms)`);

    // Y el índice tiene que seguir al día después de agregar una visita.
    history.add({ url: 'https://nuevo-sitio.ar/finanzas', title: 'Finanzas nuevas' });
    assert.equal(history.search('nuevo-sitio').length, 1, 'el índice no ve la visita recién agregada');
    history.clear();
    assert.equal(history.search('finanzas').length, 0, 'el índice sobrevive a un borrado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('el código que se inyecta en cada página sigue siendo chico', { skip: !existsSync(join(ROOT, 'build/inject.js')) }, () => {
  const code = readFileSync(join(ROOT, 'build/inject.js'), 'utf8');
  const kB = Buffer.byteLength(code) / 1024;
  assert.ok(kB < 60, `el bundle mide ${kB.toFixed(1)} kB (techo 60 kB)`);
  // Se compila en cada página nueva (acá sólo se mide el parseo: ejecutarlo
  // necesita un DOM de verdad, que no hay en este proceso).
  const ms = mediana(20, () => new Function(code));
  assert.ok(ms < 20, `compilar el bundle tardó ${ms.toFixed(2)} ms (techo 20 ms)`);
});

test('el informe de rendimiento se arma con lo que haya', async () => {
  const { formatMarkdown, normalizarBench } = await import('../scripts/reportar-rendimiento.mjs');
  const smoke = [
    '── prueba de humo ──',
    '✔ ventana',
    'tiempos: proceso 3,1 ms · ready 214,8 ms',
    'principal: 96,4 MB (heap 41,2 MB)',
    'procesos: 6 · 328,7 MB',
    'código previsto: 0',
  ].join('\n');
  const bench = { 'historial · búsqueda': { ms: 0.44, ops: 1 }, 'inyección · tamaño del bundle': { ms: 25.6, texto: '25,6 kB' } };

  assert.equal(normalizarBench(bench).length, 2);
  const texto = formatMarkdown({ smoke, bench, meta: { commit: 'abcdef1234', ref: 'main', fecha: '2026-11-09 09:00' } });
  assert.match(texto, /`abcdef1`/);
  assert.match(texto, /ready 214,8 ms/);
  assert.match(texto, /96,4 MB/);
  assert.match(texto, /historial · búsqueda/);
  assert.match(texto, /25,6 kB/);

  // Sin datos no rompe: deja constancia y sigue.
  const vacio = formatMarkdown({});
  assert.match(vacio, /no trajo medidas/);
  assert.ok(!vacio.includes('NaN'));
  assert.equal(normalizarBench(null).length, 0);
});

test('el informe de humo lleva las medidas y el publicador las encuentra', async () => {
  const { smokeReport, mark, marks } = await import('../src/main/perf.js');
  const { formatMarkdown } = await import('../scripts/reportar-rendimiento.mjs');

  mark('ready');
  mark('ventana');
  const informe = smokeReport({
    informe: '── prueba de humo ──\n✔ ventana\n✔ arrancó y funciona\n',
    app: { getAppMetrics: () => [{ type: 'browser', memory: { workingSetSize: 98_611 } }] },
    code: 0,
    extra: { gpu: 'composición software, webgl deshabilitado' },
  });

  // El archivo que lee `scripts/humo.mjs` sigue diciendo que arrancó.
  assert.match(informe, /arrancó y funciona/);
  assert.match(informe, /^tiempos: /m);
  assert.match(informe, /^principal: /m);
  assert.match(informe, /^procesos: 1 · 96,3 MB$/m);
  assert.match(informe, /^gpu: composición software/m);
  assert.equal(informe.endsWith('código previsto: 0\n'), true);
  assert.ok(marks().ventana >= marks().ready);

  // Y el publicador tiene que reconocer esas líneas aun con el prefijo nuevo.
  const cuerpo = formatMarkdown({ smoke: informe, meta: { commit: 'abcdef1234' } });
  assert.match(cuerpo, /ready \d/);
  assert.match(cuerpo, /96,3 MB/);
  assert.doesNotMatch(cuerpo, /no trajo medidas/);
  assert.match(cuerpo, /\| GPU \| composición software/);
});

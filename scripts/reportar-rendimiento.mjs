/**
 * Publica las medidas de rendimiento de cada compilación de Windows.
 *
 * La prueba de humo ya deja sus tiempos y su consumo de memoria en
 * `ci-humo.txt`, y `npm run bench` produce la tabla fina. Ese texto se pierde en
 * los registros de GitHub, que son difíciles de consultar y no se conservan de
 * forma útil. Este script lo convierte en un comentario de un issue fijo
 * («Rendimiento en Windows») para que haya un historial real de la evolución en
 * la máquina donde el navegador se distribuye.
 *
 *   node scripts/reportar-rendimiento.mjs                    # sólo imprime
 *   node scripts/reportar-rendimiento.mjs --publicar         # comenta en GitHub
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Título del issue que acumula el historial. */
export const ISSUE_TITLE = 'Rendimiento en Windows (informe automático)';
export const LABEL = 'rendimiento';

/**
 * Recorta un bloque del informe de humo.
 * @param {string} texto
 * @param {RegExp} patron
 */
function linea(texto, patron) {
  const found = texto.match(patron);
  return found ? found[0].trim() : null;
}

/**
 * El banco puede entregar la instantánea como objeto `{nombre: {ms, ops}}` o
 * como lista; acá se unifica para no depender del formato.
 *
 * @param {any} bench
 * @returns {Array<{nombre: string, ms: number, ops: number, kB: boolean}>}
 */
export function normalizarBench(bench) {
  if (!bench) return [];
  const base = Array.isArray(bench.resultados)
    ? bench.resultados.map((item) => ({
        nombre: item.nombre,
        ms: item.mediana ?? item.ms ?? 0,
        ops: item.ops ?? 1,
        texto: item.mostrar || '',
      }))
    : Object.entries(bench).map(([nombre, valor]) => ({
        nombre,
        ms: Number(valor?.ms) || 0,
        ops: Number(valor?.ops) || 1,
        texto: valor?.texto || '',
      }));
  return base.map((item) => ({ ...item, kB: /tamaño/i.test(item.nombre) }));
}

/**
 * Arma el comentario en Markdown a partir del informe de humo y del banco.
 *
 * Falla en silencio con lo que falte: un informe sin números sigue siendo un
 * informe, y nunca debe romper la compilación.
 *
 * @param {{ smoke?: string, bench?: any, meta?: Record<string, unknown> }} entrada
 * @returns {string}
 */
export function formatMarkdown({ smoke = '', bench = null, meta = {} } = {}) {
  const salida = [];
  const commit = meta.commit ? `\`${String(meta.commit).slice(0, 7)}\`` : 'sin commit';
  const ref = meta.ref ? ` · ${meta.ref}` : '';
  const fecha = meta.fecha || new Date().toISOString().slice(0, 16).replace('T', ' ');
  salida.push(`### ${commit}${ref} · ${fecha}`);
  salida.push('');

  const tiempos = linea(smoke, /^tiempos:.*$/m);
  const principal = linea(smoke, /^principal:.*$/m);
  const procesos = linea(smoke, /^procesos:.*$/m);
  const tipos = linea(smoke, /^por tipo:.*$/m);
  const notas = linea(smoke, /^notas:.*$/m);
  const gpu = linea(smoke, /^gpu:.*$/m);

  if (tiempos || principal || procesos) {
    salida.push('**Arranque y memoria (Windows, `nexo.exe --smoke`)**');
    salida.push('');
    salida.push('| medida | valor |');
    salida.push('| --- | --- |');
    if (tiempos) salida.push(`| tiempos | ${tiempos.replace(/^tiempos:\s*/, '')} |`);
    if (principal) salida.push(`| proceso principal | ${principal.replace(/^principal:\s*/, '')} |`);
    if (procesos) salida.push(`| todos los procesos | ${procesos.replace(/^procesos:\s*/, '')} |`);
    if (tipos) salida.push(`| por tipo | ${tipos.replace(/^por tipo:\s*/, '')} |`);
    if (gpu) salida.push(`| GPU | ${gpu.replace(/^gpu:\s*/, '')} |`);
    if (notas) salida.push(`| notas | ${notas.replace(/^notas:\s*/, '')} |`);
    salida.push('');
  } else {
    salida.push('_El informe de humo no trajo medidas: revisar el paso «Prueba de humo del ejecutable»._');
    salida.push('');
  }

  const filas = normalizarBench(bench);
  if (filas.length) {
    salida.push('**Banco de pruebas (`npm run bench`)**');
    salida.push('');
    salida.push('| operación | mediana |');
    salida.push('| --- | --- |');
    for (const item of filas) {
      const mediana = `${item.ms.toFixed(item.ms < 1 ? 3 : 2).replace('.', ',')} ms`;
      // Si el banco ya formateó la medida (µs por carácter, kB), se usa tal cual.
      const valor = item.texto || (item.ops > 1 ? `${mediana} ×${item.ops} operaciones` : mediana);
      salida.push(`| ${item.nombre} | ${valor} |`);
    }
    salida.push('');
  }

  salida.push(`<sub>Generado por \`scripts/reportar-rendimiento.mjs\` · run ${meta.run || 'local'}</sub>`);
  return `${salida.join('\n')}\n`;
}

/**
 * Devuelve el issue del historial, creándolo si no existe.
 *
 * @param {{ api: string, token: string, repo: string }} ctx
 * @returns {Promise<number>}
 */
async function issueDeRendimiento({ api, token, repo }) {
  const cabeceras = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nexo-rendimiento',
  };
  const busqueda = await fetch(`${api}/repos/${repo}/issues?state=all&per_page=50`, { headers: cabeceras });
  if (busqueda.ok) {
    const issues = await busqueda.json();
    const encontrado = issues.find((item) => item.title === ISSUE_TITLE && !item.pull_request);
    if (encontrado) return encontrado.number;
  }
  const creado = await fetch(`${api}/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...cabeceras, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: ISSUE_TITLE,
      labels: [LABEL],
      body: [
        'Historial de las medidas que deja cada compilación de Windows.',
        '',
        'Se completa solo: no hace falta escribir acá. Los números finos se',
        'reproducen en cualquier máquina con `npm run bench`, y los del arranque',
        'salen de la prueba de humo del ejecutable empaquetado.',
        '',
        'Ver `docs/RENDIMIENTO.md`.',
      ].join('\n'),
    }),
  });
  if (!creado.ok) throw new Error(`no se pudo crear el issue (${creado.status}): ${await creado.text()}`);
  const data = await creado.json();
  return data.number;
}

const invocadoDirectamente =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invocadoDirectamente) {
  const publicar = process.argv.includes('--publicar');
  const smokePath = resolve(root, arg('smoke', 'ci-humo.txt'));
  const benchPath = resolve(root, arg('bench', 'ci-bench.json'));

  const smoke = existsSync(smokePath) ? readFileSync(smokePath, 'utf8') : '';
  let bench = null;
  if (existsSync(benchPath)) {
    try {
      bench = JSON.parse(readFileSync(benchPath, 'utf8'));
    } catch {
      bench = null;
    }
  }

  const cuerpo = formatMarkdown({
    smoke,
    bench,
    meta: {
      commit: process.env.GITHUB_SHA || '',
      ref: process.env.GITHUB_REF_NAME || '',
      run: process.env.GITHUB_RUN_ID || '',
    },
  });
  process.stdout.write(cuerpo);

  if (!publicar) process.exit(0);

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.error('\n(sin GITHUB_TOKEN o GITHUB_REPOSITORY: no se publica)');
    process.exit(0);
  }
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  try {
    const numero = await issueDeRendimiento({ api, token, repo });
    const respuesta = await fetch(`${api}/repos/${repo}/issues/${numero}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'nexo-rendimiento',
      },
      body: JSON.stringify({ body: cuerpo }),
    });
    if (!respuesta.ok) throw new Error(`${respuesta.status}: ${await respuesta.text()}`);
    console.log(`\n✔ publicado en el issue #${numero}`);
  } catch (error) {
    // Publicar es un extra: nunca debe tumbar la compilación.
    console.error(`\n(no se pudo publicar: ${error.message})`);
  }
}

function arg(nombre, porDefecto) {
  const prefijo = `--${nombre}=`;
  const encontrado = process.argv.find((valor) => valor.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : porDefecto;
}

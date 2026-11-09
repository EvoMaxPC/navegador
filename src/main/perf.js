/**
 * Medición de arranque y consumo.
 *
 * El rendimiento de un navegador se juzga en dos números que el usuario siente:
 * cuánto tarda en aparecer la ventana y cuánta memoria ocupa con tres pestañas
 * abiertas. Sin medirlos, «optimizar» es adivinar.
 *
 * Durante el arranque se van dejando marcas; la prueba de humo las incluye en su
 * informe, así que cada compilación de Windows publica sus propios números.
 */

const t0 = performance.now();

/** Número con coma decimal, como el resto de la salida en español. */
const num = (valor, decimales = 1) => valor.toFixed(decimales).replace('.', ',');

/** @type {Record<string, number>} */
const marcas = {};

/** Deja una marca con el tiempo transcurrido desde que cargó el proceso principal. */
export function mark(name) {
  marcas[name] = Number((performance.now() - t0).toFixed(1));
  return marcas[name];
}

/**
 * Incorpora medidas que llegan desde la interfaz.
 *
 * El arranque tiene dos mitades: el proceso principal (marcas de arriba) y la
 * página de la shell, que se mide con `performance` en el renderer. Sin la
 * segunda mitad no se sabe si la lentitud es de Electron o de nuestro código.
 *
 * @param {Record<string, number>} datos
 */
export function absorb(datos) {
  if (!datos || typeof datos !== 'object') return marcas;
  for (const [nombre, valor] of Object.entries(datos)) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) continue;
    // Prefijo para no confundir una marca del renderer con una del proceso
    // principal. Se conserva el orden de llegada en el informe.
    const clave = nombre.startsWith('ui-') ? nombre : `ui-${nombre}`;
    marcas[clave] = Number(numero.toFixed(1));
  }
  return marcas;
}

/** Todas las marcas, en orden de aparición. */
export function marks() {
  return { ...marcas };
}

/** Tiempo total desde el inicio hasta la última marca. */
export function total() {
  const valores = Object.values(marcas);
  return valores.length ? Math.max(...valores) : Number((performance.now() - t0).toFixed(1));
}

/**
 * Consumo del proceso principal, ya formateado en español.
 * @returns {{rss: string, heap: string}}
 */
export function mainMemory() {
  const mem = process.memoryUsage();
  return {
    rss: num(mem.rss / 1024 / 1024),
    heap: num(mem.heapUsed / 1024 / 1024),
  };
}

/**
 * Consumo de todos los procesos (principal, renderizadores, GPU, red) según
 * Chromium. `app.getAppMetrics()` devuelve kilobytes en `memory.workingSetSize`.
 *
 * @param {{ getAppMetrics?: () => Array }} app
 * @returns {{processes: number, workingSet: string, byType: Record<string, string>}}
 */
export function appMemory(app) {
  const metrics = typeof app?.getAppMetrics === 'function' ? app.getAppMetrics() : [];
  const byType = {};
  let kb = 0;
  for (const metric of metrics) {
    const size = metric?.memory?.workingSetSize || 0;
    kb += size;
    const type = metric?.type || 'desconocido';
    byType[type] = (Number(byType[type] || 0) + size) / 1024;
  }
  const tipos = {};
  for (const [type, mb] of Object.entries(byType)) tipos[type] = num(mb);
  return {
    processes: metrics.length,
    workingSet: num(kb / 1024),
    byType: tipos,
  };
}

/**
 * Resumen legible para el informe de la prueba de humo.
 *
 * @param {{ app?: object, extra?: Record<string, unknown> }} [opts]
 * @returns {string}
 */
export function summary({ app = null, extra = {} } = {}) {
  const main = mainMemory();
  const all = app ? appMemory(app) : null;
  const tiempos = Object.entries(marks())
    .map(([name, ms]) => `${name} ${ms} ms`)
    .join(' · ');
  const partes = [`tiempos: ${tiempos || 'sin marcas'}`, `principal: ${main.rss} MB (heap ${main.heap} MB)`];
  if (all) {
    partes.push(`procesos: ${all.processes} · ${all.workingSet} MB`);
    const detalle = Object.entries(all.byType)
      .map(([type, mb]) => `${type} ${mb} MB`)
      .join(', ');
    if (detalle) partes.push(`por tipo: ${detalle}`);
  }
  for (const [key, value] of Object.entries(extra)) partes.push(`${key}: ${value}`);
  return partes.join('\n');
}

/**
 * Arma el texto que va al archivo de la prueba de humo: informe de
 * comprobaciones, medidas y código de salida.
 *
 * Se separa de `main.js` para poder probarlo sin Electron, y porque el orden de
 * las líneas importa: `scripts/humo.mjs` decide el veredicto buscando el texto
 * de éxito en este archivo.
 *
 * @param {{ informe: string, app?: object, code?: number|null, extra?: Record<string, unknown> }} entrada
 * @returns {string}
 */
export function smokeReport({ informe, app = null, code = null, extra = {} } = {}) {
  const partes = [String(informe || '').replace(/\n+$/, '')];
  partes.push('');
  partes.push('[medidas]');
  partes.push(summary({ app, extra }));
  if (code !== null) partes.push(`código previsto: ${code}`);
  return `${partes.join('\n')}\n`;
}

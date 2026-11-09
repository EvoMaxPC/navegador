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

/** @type {Record<string, number>} */
const marcas = {};

/** Deja una marca con el tiempo transcurrido desde que cargó el proceso principal. */
export function mark(name) {
  marcas[name] = Number((performance.now() - t0).toFixed(1));
  return marcas[name];
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
 * Consumo del proceso principal.
 * @returns {{rssMB: number, heapMB: number}}
 */
export function mainMemory() {
  const mem = process.memoryUsage();
  return {
    rssMB: Number((mem.rss / 1024 / 1024).toFixed(1)),
    heapMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
  };
}

/**
 * Consumo de todos los procesos (principal, renderizadores, GPU, red) según
 * Chromium. `app.getAppMetrics()` devuelve kilobytes en `memory.workingSetSize`.
 *
 * @param {{ getAppMetrics?: () => Array }} app
 * @returns {{processes: number, workingSetMB: number, byType: Record<string, number>}}
 */
export function appMemory(app) {
  const metrics = typeof app?.getAppMetrics === 'function' ? app.getAppMetrics() : [];
  const byType = {};
  let kb = 0;
  for (const metric of metrics) {
    const size = metric?.memory?.workingSetSize || 0;
    kb += size;
    const type = metric?.type || 'desconocido';
    byType[type] = Number((((byType[type] || 0) + size) / 1024).toFixed(1));
  }
  return {
    processes: metrics.length,
    workingSetMB: Number((kb / 1024).toFixed(1)),
    byType,
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
  const partes = [`tiempos: ${tiempos || 'sin marcas'}`, `principal: ${main.rssMB} MB (heap ${main.heapMB} MB)`];
  if (all) {
    partes.push(`procesos: ${all.processes} · ${all.workingSetMB} MB`);
    const detalle = Object.entries(all.byType)
      .map(([type, mb]) => `${type} ${mb} MB`)
      .join(', ');
    if (detalle) partes.push(`por tipo: ${detalle}`);
  }
  for (const [key, value] of Object.entries(extra)) partes.push(`${key}: ${value}`);
  return partes.join('\n');
}

/** Un trabajo por clave y cuadro. Sin intervalos, dependencias ni procesos extra. */
export function createFrameQueue(schedule = globalThis.requestAnimationFrame || ((run) => queueMicrotask(run))) {
  const pending = new Map();
  let scheduled = false;
  function flush() {
    scheduled = false;
    const tasks = [...pending.values()];
    pending.clear();
    for (const task of tasks) task();
  }
  return {
    schedule(key, task) {
      pending.set(key, task);
      if (!scheduled) { scheduled = true; schedule(flush); }
    },
    flush,
  };
}

/** Agrupa cambios del motor; una lectura en curso nunca pierde la actualización. */
export function createUnderstandingRefresh({
  refresh,
  isBusy,
  isActive,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  delay = 250,
}) {
  let dirty = false,
    timer = null,
    running = false,
    disposed = false;
  function queue() {
    if (timer === null && !disposed) timer = setTimer(run, delay);
  }
  async function run() {
    timer = null;
    if (disposed || !dirty || !isActive()) return;
    if (isBusy() || running) {
      queue();
      return;
    }
    dirty = false;
    running = true;
    try {
      await refresh();
    } finally {
      running = false;
      if (dirty) queue();
    }
  }
  return {
    schedule() {
      if (disposed) return;
      dirty = true;
      queue();
    },
    dispose() {
      disposed = true;
      dirty = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

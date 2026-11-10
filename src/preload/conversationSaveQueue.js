/** Agrupa revisiones del mismo documento: vista por cuadro, disco a lo sumo cada 500 ms. */
export function createConversationSaveQueue(save, delay = 500) {
  let pending = null, timer = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!pending) return;
    const batch = pending; pending = null;
    Promise.resolve().then(() => save(batch.payload)).then(
      result => batch.waiters.forEach(resolve => resolve(result)),
      () => batch.waiters.forEach(resolve => resolve({ ok: false })),
    );
  };
  return {
    publish(payload) {
      if (pending && pending.payload.href !== payload.href) flush();
      return new Promise(resolve => {
        if (!pending) pending = { payload, waiters: [] };
        pending.payload = payload; pending.waiters.push(resolve);
        if (!timer) { timer = setTimeout(flush, delay); timer?.unref?.(); }
      });
    },
    flush,
    cancel() {
      clearTimeout(timer); timer = null;
      pending?.waiters.forEach(resolve => resolve({ ok: false })); pending = null;
    },
  };
}

// Configuración del guard: valores válidos y normalización.
// mergeSettings no valida claves, así que cualquier lector debe pasar por aquí.
export const GUARD_MODES = Object.freeze(['off', 'observe', 'enforce']);

export const GUARD_DEFAULTS = Object.freeze({
  mode: 'off',
  onUnreadable: 'pass',
  decisionTimeoutMs: 120_000,
  allowSendCritical: false,
});

const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;

export function normalizeGuard(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const t = r.decisionTimeoutMs;
  return {
    mode: GUARD_MODES.includes(r.mode) ? r.mode : GUARD_DEFAULTS.mode,
    onUnreadable: r.onUnreadable === 'block' ? 'block' : 'pass',
    decisionTimeoutMs: typeof t === 'number' && Number.isFinite(t)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(t)))
      : GUARD_DEFAULTS.decisionTimeoutMs,
    allowSendCritical: r.allowSendCritical === true,
  };
}

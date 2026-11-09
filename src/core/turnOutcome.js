/** Clasificación del resultado; nunca infiere Stop de un AbortError genérico. */
export const TURN_OUTCOMES = {
  // Se conserva la señal de fin para deduplicar, sin contador asociado.
  completed: null,
  cancelled: 'turnsCancelled',
  failed: 'turnsFailed',
  unknown: 'turnsPerformed',
};

export function turnOutcome(payload = {}) {
  if (payload.stoppedByUser) return 'cancelled';
  if (payload.error || payload.outcome === 'failed') return 'failed';
  if (Object.hasOwn(TURN_OUTCOMES, payload.outcome)) return payload.outcome;
  if (payload.interrupted || payload.stopped || payload.finished === false) return 'unknown';
  return payload.finished === true ? 'completed' : 'unknown';
}

/** Señales explícitas del proveedor, no texto ni heurísticas de puntuación. */
export function outcomeFromEvent(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.error || json.type === 'error' || json.type === 'generation_error') return 'failed';
  const terminal = json.type === 'control' && json.detail?.kind === 'terminal-received'
    ? json.detail.terminalKind : null;
  if (terminal === 'error' || terminal === 'failed') return 'failed';
  if (terminal === 'cancelled' || terminal === 'canceled') return 'cancelled';
  if (terminal === 'complete' || json.type === 'message_stream_complete' || json.type === 'end') return 'completed';
  return null;
}

/** Presentación sin confundir desconocido con cero ni mezclar estimaciones con BPE. */
export function tokenCounterView(stats = {}) {
  const number = n => new Intl.NumberFormat('es-AR').format(Number(n) || 0);
  const display = (tokens, unknown, known) => unknown > 0 ? known > 0 || tokens > 0 ? `${number(tokens)} + ?` : '—' : number(tokens);
  const unavailableInput = (stats.unknownInputMessages || 0) + (stats.estimatedInputMessages || 0);
  const input = display(stats.inputTokens, unavailableInput, (stats.messages || 0) - unavailableInput);
  const unavailableOutput = (stats.unknownOutputMessages || 0) + (stats.estimatedOutputMessages || 0);
  const output = display(stats.outputBpeTokens, unavailableOutput, stats.bpeOutputMessages || 0);
  const detail = `Entrada: ${number(stats.inputTokens)} tokens BPE del texto original; ${number(stats.unknownInputMessages)} mensajes sin modelo/texto verificable; ${number(stats.estimatedInputTokens)} tokens estimados de otros proveedores (no sumados). Respuesta: ${number(stats.outputBpeTokens)} tokens BPE del texto visible; ${number(stats.unknownOutputMessages)} respuestas sin modelo/texto verificable; ${number(stats.estimatedOutputTokens)} tokens estimados de otros proveedores (no sumados). Correlación: ${number(stats.inputCorrelationUnverified)} envíos sin ID compartido. Contexto oculto y facturación: no observables.`;
  return { input, output, detail };
}

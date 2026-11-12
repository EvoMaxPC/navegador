// Decide qué hacer con unos hallazgos. Puro.
// Solo lo crítico interrumpe; lo demás se detecta y se registra, sin diálogo.
export function decide(findings, cfg) {
  const lista = Array.isArray(findings) ? findings : [];
  const criticos = lista.filter((f) => f && f.severity === 'critical');
  if (!criticos.length) return { action: 'pass', critical: 0, allowed: [], redactTypes: [] };
  const allowed = ['redact', 'cancel'];
  if (cfg && cfg.allowSendCritical === true) allowed.push('send');
  return {
    action: 'ask',
    critical: criticos.length,
    allowed,
    redactTypes: [...new Set(criticos.map((f) => f.type))],
  };
}

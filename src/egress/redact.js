// Sustituye hallazgos por placeholders. Puro salvo por el vault que recibe.
// `findings` debe venir de detectSensitive (ordenados, sin solapes).
export function redact(text, findings, vault, { only } = {}) {
  if (typeof text !== 'string' || !Array.isArray(findings) || !findings.length) return text;
  let out = '';
  let pos = 0;
  for (const f of findings) {
    if (only && !only.includes(f.type)) continue;
    if (f.start < pos) continue;
    out += text.slice(pos, f.start) + vault.placeholderFor(f.type, text.slice(f.start, f.end));
    pos = f.end;
  }
  return out + text.slice(pos);
}

// Resumen para mostrar al usuario: tipos y cantidades, NUNCA valores.
export function summarize(findings) {
  const mapa = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    const k = f.type;
    const prev = mapa.get(k) || { type: f.type, severity: f.severity, count: 0 };
    prev.count += 1;
    mapa.set(k, prev);
  }
  return [...mapa.values()];
}

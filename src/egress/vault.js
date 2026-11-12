// Placeholders estables [TIPO_N]. Solo memoria; el llamador decide su vida
// (una instancia por pestaña). Solo los tipos "reversibles" guardan el valor
// original; los críticos (tarjeta, clave) NUNCA se guardan: no hay motivo
// para poder restaurarlos.
export function createVault({ reversible = ['email', 'dni_es'], max = 500 } = {}) {
  const porValor = new Map();
  const porPlaceholder = new Map();
  const contadores = {};
  return {
    placeholderFor(type, value) {
      const guardar = reversible.includes(type);
      const clave = `${type}\u0000${value}`;
      if (guardar && porValor.has(clave)) return porValor.get(clave);
      contadores[type] = (contadores[type] || 0) + 1;
      const ph = `[${String(type).toUpperCase()}_${contadores[type]}]`;
      if (guardar && porValor.size < max) {
        porValor.set(clave, ph);
        porPlaceholder.set(ph, value);
      }
      return ph;
    },
    reverse(text) {
      if (typeof text !== 'string') return text;
      return text.replace(/\[[A-Z_]+_\d+\]/g, (m) => (porPlaceholder.has(m) ? porPlaceholder.get(m) : m));
    },
    clear() {
      porValor.clear();
      porPlaceholder.clear();
      for (const k of Object.keys(contadores)) delete contadores[k];
    },
    get size() {
      return porPlaceholder.size;
    },
  };
}

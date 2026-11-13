/**
 * Redacción de críticos en el texto que se inyecta, antes de que salga.
 *
 * El guardián de salida mira el texto del usuario (inject/index.js:685-721) y el
 * respaldo de red mira el cuerpo final (main.js:1420-1462). Entre los dos queda
 * un hueco: lo que el motor añade al mensaje —los bloques de EVO MEMORY y del
 * protocolo— no lo juzga nadie antes de salir, y EVO guarda los literales tal
 * cual los escribió el usuario (memory/store.js:105-118). Con `enforce`, una
 * memoria con una tarjeta entra en el bloque y la red frena el envío entero, sin
 * diálogo y sin que el usuario sepa por qué.
 *
 * Acá se cierra ese hueco en el proceso principal: `prepare` recibe el texto del
 * usuario y el texto mediado, y devuelve el mediado con los críticos ocultos.
 *
 * Reglas:
 *   · sólo `enforce` toca algo; `off` y `observe` devuelven el mismo string;
 *   · sólo se redactan los tipos críticos (card, api_key): email y DNI no;
 *   · el texto del usuario nunca se toca: si el literal ya estaba en lo que
 *     escribió, no se redacta (ya era suyo y el guardián de la capa es quien
 *     decide sobre él);
 *   · el marcador es el de `egress/vault.js`, no se reescribe;
 *   · un fallo de detección o redacción no deja pasar el literal.
 */
import { detectSensitive } from '../egress/detect.js';
import { redact, summarize } from '../egress/redact.js';
import { createVault } from '../egress/vault.js';

const CRITICAL = 'critical';

/** Peor caso si todo falla: no hay texto que enviar. */
const BLOCKED = { text: null, redacted: { count: 0, types: [] } };

/**
 * @param {{ original?: string, mediated?: string, mode?: string }} input
 * @returns {{ text: string|null, redacted: { count: number, types: string[] } }}
 *   `text: null` = no se puede enviar sin el literal (fallo del detector).
 */
export function redactInjected({ original = '', mediated = '', mode = 'off' } = {}) {
  const text = typeof mediated === 'string' ? mediated : '';
  if (mode !== 'enforce' || !text) return { text, redacted: { count: 0, types: [] } };

  let findings;
  try {
    findings = detectSensitive(text);
  } catch {
    // Sin detector no hay forma de saber qué se oculta: no se envía a ciegas.
    return BLOCKED;
  }
  const criticos = findings.filter((f) => f.severity === CRITICAL);
  if (!criticos.length) return { text, redacted: { count: 0, types: [] } };

  const userText = typeof original === 'string' ? original : '';
  // Se excluye el hallazgo cuyo literal el usuario ya había escrito: está en el
  // texto por él, no por la memoria, y tocarlo sería cambiar sus palabras.
  const ajenos = criticos.filter((f) => !userText.includes(text.slice(f.start, f.end)));
  if (!ajenos.length) return { text, redacted: { count: 0, types: [] } };

  let out;
  try {
    // Vault por envío: los críticos no se guardan para restaurar (vault.js:1-4),
    // así que no hay estado que conservar entre envíos, y el marcador sale
    // siempre desde 1 en vez de arrastrar contadores de toda la sesión.
    out = redact(text, ajenos, createVault(), { only: ajenos.map((f) => f.type) });
  } catch {
    return BLOCKED;
  }
  // Lo que no puede pasar es que el literal siga y nosotros digamos que se
  // ocultó: si alguno sobrevivió al marcador, no se envía.
  for (const f of ajenos) {
    if (out.includes(text.slice(f.start, f.end))) return BLOCKED;
  }

  const types = [...new Set(summarize(ajenos).map((s) => s.type))];
  return { text: out, redacted: { count: ajenos.length, types } };
}

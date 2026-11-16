// Respaldo del guardián en la red: ¿hay que frenar esta petición antes de que
// salga? Puro: sin Electron, sin E/S, sin relojes.
//
// Es una SEGUNDA barrera, no la principal. La capa inyectada decide con el
// diálogo del usuario (`egressGate`); esto sólo cubre el caso en que la capa no
// llegó a correr o su resultado se perdió. Por eso es más tosco: cancela y no
// ofrece redactar, porque en esta capa no hay forma de reescribir el cuerpo.
import { detectSensitive } from '../egress/detect.js';
import { guardSlots } from '../egress/slots.js';

/** Resumen para el diagnóstico: tipo y cantidad. NUNCA el valor. */
function summarize(findings) {
  const mapa = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    const prev = mapa.get(f.type) || { type: f.type, count: 0 };
    prev.count += 1;
    mapa.set(f.type, prev);
  }
  return [...mapa.values()];
}

const describe = (summary) => summary.map((s) => `${s.type}×${s.count}`).join(', ');

/**
 * Decide si la red debe frenar una petición.
 *
 * `config` es el egress ya normalizado (`normalizeEgress`) y el sitio ya se
 * decidió fuera: acá no se sabe de proveedores, sólo de cuerpos.
 *
 * Cancela SÓLO si se cumplen todas:
 *   · modo `enforce` (ni `off` ni `observe` frenan nada: observar es observar);
 *   · `allowSendCritical` no está activo (el usuario pidió poder enviar igual);
 *   · método POST (un GET no lleva el mensaje);
 *   · el cuerpo es texto y parsea como JSON;
 *   · los slots del último mensaje del usuario tienen algún hallazgo `critical`.
 *
 * Cualquier otra cosa devuelve `cancel: false` con su motivo. Falla abierto a
 * propósito: esta capa no puede sustituir la decisión de la capa inyectada.
 *
 * @param {{ method?: string, bodyText?: unknown, config?: object }} entrada
 * @returns {{ cancel: boolean, reason: string, summary: {type: string, count: number}[] }}
 */
export function inspectOutgoing({ method, bodyText, config } = {}) {
  const no = (reason) => ({ cancel: false, reason, summary: [] });

  if (config?.mode !== 'enforce') return no(`modo-${String(config?.mode || 'desconocido')}`);
  if (config?.allowSendCritical === true) return no('allowSendCritical');
  if (String(method || '').toUpperCase() !== 'POST') return no('metodo');
  if (typeof bodyText !== 'string' || !bodyText) return no('cuerpo-no-legible');

  let cuerpo = null;
  try {
    cuerpo = JSON.parse(bodyText);
  } catch {
    return no('json-invalido');
  }

  const slots = guardSlots(cuerpo);
  if (!slots.length) return no('sin-slots');

  const hallazgos = slots.flatMap((slot) => detectSensitive(slot));
  const criticos = hallazgos.filter((f) => f.severity === 'critical');
  if (!criticos.length) return no('sin-criticos');

  const summary = summarize(criticos);
  return { cancel: true, reason: `critico:${describe(summary)}`, summary };
}

/**
 * Ajustes por defecto y utilidades de fusión.
 *
 * Todos los ajustes viven en el perfil local del usuario (nunca en la nube).
 */

import { detectSite } from './sites.js';

export const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,
  /** Idioma de la interfaz; el de los protocolos se detecta por mensaje. */
  uiLocale: 'es',
  protocol: {
    level: 'equilibrado', // off | suave | equilibrado | agresivo
    placement: 'prefix', // prefix | suffix | both
    lang: 'auto', // auto | es | en
  },
  sending: {
    enabled: true,
    cleanWhitespace: true,
    dedupeLines: true,
    detectContradictions: true,
    resolveAmbiguity: true,
    wrapLongPaste: true,
    showDiff: true,
    requireConfirmation: false,
  },
  context: {
    enabled: true,
    budgetTokens: 6000,
    keepRecentTurns: 6,
  },
  receiving: {
    enabled: true,
    stopOnLoop: true,
    severityThreshold: 'medium', // low | medium | high
    repairMarkdown: true,
    stripLeakedTokens: true,
    detectRefusal: true,
    autoContinue: 2,
    autoContinueDelayMs: 600,
    // Caracteres que se retienen antes de mostrarlos, para poder cortar limpio.
    // Precisión ↔ latencia: 112 caracteres son ~28 tokens de retraso visual.
    holdbackChars: 112,
  },
  sites: {
    // Sobrescrituras por host; el resto usa `default`.
    default: { enabled: true, protocolLevel: null },
  },
  privacy: {
    localOnly: true,
    persistTranscripts: false,
  },
  logging: {
    maxEntries: 400,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fusión profunda de ajustes (el segundo gana), sin mutar las entradas. */
export function mergeSettings(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeSettings(out[key], value);
    else if (value !== undefined) out[key] = structuredClone(value);
  }
  return out;
}

/**
 * Ajustes efectivos para un host concreto.
 * La sobrescritura puede estar por host (`chatgpt.com`) o por id de adaptador
 * (`chatgpt`); se aceptan las dos.
 */
export function settingsForHost(settings, host) {
  const merged = mergeSettings(DEFAULT_SETTINGS, settings || {});
  const id = detectSite(host).id;
  const site = merged.sites?.[id] || merged.sites?.[host] || merged.sites?.default || {};
  if (site.enabled === false) merged.enabled = false;
  if (site.protocolLevel) merged.protocol.level = site.protocolLevel;
  return merged;
}

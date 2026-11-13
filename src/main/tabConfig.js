/**
 * Recorte de la configuración que sale hacia las pestañas.
 *
 * `engine.configFor` devuelve el perfil resuelto **completo** para un host. Eso
 * está bien para el proceso principal —el guardián y el motor lo usan entero—,
 * pero dos de sus consumidores corren dentro de la pestaña: el preload que
 * inyecta la capa y el mundo principal de la página. Ahí no se lee ni la mitad:
 * los atajos del usuario, sus preferencias de privacidad y de registro no
 * cruzan ese límite porque nada del código inyectado los consume.
 *
 * Esta función deja pasar sólo las hojas que la capa y sus lectores sí leen, y
 * copia los valores en vez de compartir referencias, para que el objeto que
 * viaja por IPC no pueda tocar el perfil en memoria.
 *
 * Lo que se conserva (cada hoja con su lector):
 *   · `enabled`               la puerta de inyección (preload/bridge.cjs:88-91)
 *   · `language`, `version`,
 *     `site`, `profiled`      identidad que anuncia la capa (preload/bridge.cjs:88-91)
 *   · `settings.sites`        habilitación por sitio (inject/index.js:111,195),
 *                             incluido `protocolLevel`, hoja que ya viene
 *                             aplicada a `settings.protocol.level` por
 *                             `settingsForHost` (core/settings.js:102)
 *   · `settings.memory`       `enabled` se lee en inject/index.js:1050 y
 *                             `maxItems`/`episodeEvery`/`projectId` en
 *                             main/engine.js:206-214
 *   · `settings.egress`       la puerta de salida (inject/index.js:515,543,691,1049)
 *   · `settings.receiving`    `autoContinue` (inject/index.js:1329,
 *                             preload/bridge.cjs:191-192) y las hojas del
 *                             centinela que viaja dentro de la capa
 *                             (core/streamSentinel.js:42-53)
 */

/** Hojas de `settings.receiving` que lee el centinela dentro de la pestaña. */
const RECEIVING_LEAVES = ['autoContinue', 'stopOnLoop', 'severityThreshold', 'minUnit', 'minRepeats', 'holdbackChars'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Copia superficial de las hojas presentes. Una rama que falta en la entrada no
 * se inventa: se omite, y el lector de turno aplica su propio valor por omisión.
 */
function pickLeaves(source, leaves) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const leaf of leaves) {
    if (source[leaf] !== undefined) out[leaf] = structuredClone(source[leaf]);
  }
  return out;
}

/** Copia de un mapa de sitios, sin compartir las filas con el perfil. */
function copySites(sites) {
  if (!isPlainObject(sites)) return undefined;
  const out = {};
  for (const [id, row] of Object.entries(sites)) out[id] = structuredClone(row);
  return out;
}

/**
 * Reduce la configuración de `configFor` a lo que la pestaña consume.
 *
 * @param {{
 *   enabled?: boolean, settings?: object, language?: string,
 *   version?: string, site?: string, profiled?: boolean
 * }} config
 * @returns {object} misma forma; sin mutar la entrada
 */
export function configForTab(config) {
  const source = isPlainObject(config) ? config : {};
  const settings = isPlainObject(source.settings) ? source.settings : {};

  const out = {};
  // Identidad de primer nivel: sólo si viene.
  for (const key of ['enabled', 'language', 'version', 'site', 'profiled']) {
    if (source[key] !== undefined) out[key] = source[key];
  }

  const reduced = {};
  // `settings.enabled` no es un duplicado de `config.enabled`: `settingsForHost`
  // lo apaga cuando el sitio está deshabilitado, y `isEvoMemoryEnabled` lo mira
  // desde el lector de la pestaña (preload/chatgptReader.js:13 → core/settings.js:108).
  if (settings.enabled !== undefined) reduced.enabled = settings.enabled;
  const sites = copySites(settings.sites);
  if (sites !== undefined) reduced.sites = sites;
  if (isPlainObject(settings.memory)) reduced.memory = structuredClone(settings.memory);
  if (isPlainObject(settings.egress)) reduced.egress = structuredClone(settings.egress);

  const receiving = pickLeaves(settings.receiving, RECEIVING_LEAVES);
  if (Object.keys(receiving).length) reduced.receiving = receiving;

  out.settings = reduced;
  return out;
}

/** Hojas de primer nivel de `settings` que una pestaña puede necesitar. */
const SETTINGS_LEAVES = ['enabled', 'egress'];

/**
 * El mismo recorte, pero sobre un bloque de ajustes sin resolver por host.
 *
 * Lo pide `nexo:settings:get` cuando el emisor no es la shell. El preload de la
 * pestaña usa de ahí `receiving.autoContinue` (en el bloque crudo, no en el
 * resuelto por host) y nada más; se conservan además las hojas que un lector de
 * la capa podría consultar para no romper una rama futura de `inject/`.
 *
 * @param {object} settings p. ej. `store.settings`
 * @returns {object} copia recortada; sin mutar la entrada
 */
export function settingsForTab(settings) {
  const source = isPlainObject(settings) ? settings : {};
  const out = {};
  for (const key of SETTINGS_LEAVES) {
    if (source[key] !== undefined) out[key] = structuredClone(source[key]);
  }
  const sites = copySites(source.sites);
  if (sites !== undefined) out.sites = sites;
  if (isPlainObject(source.memory)) out.memory = structuredClone(source.memory);

  const receiving = pickLeaves(source.receiving, RECEIVING_LEAVES);
  if (Object.keys(receiving).length) out.receiving = receiving;
  return out;
}

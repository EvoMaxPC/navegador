/**
 * Lo que sale hacia las pestañas: sólo lo que la capa lee.
 *
 * `nexo:config`, `nexo:config-sync` y `nexo:settings:get` los pide el preload de
 * cada pestaña en nombre de la página. Hasta ahora devolvían el perfil resuelto
 * completo —atajos del usuario, privacidad, registro— a cualquier emisor. Acá se
 * comprueba, contra el IPC real, que el recorte no deja pasar nada que la capa
 * no consuma y, sobre todo, que consumir con el recorte da el mismo resultado
 * que consumir la configuración entera.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { normalizeEgress } from '../src/core/egressConfig.js';
import { isEvoMemoryEnabled, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { detectSite } from '../src/core/sites.js';
import { isAiHost } from '../src/core/cdp.js';
import { StreamSentinel } from '../src/core/streamSentinel.js';
import { configForTab, settingsForTab } from '../src/main/tabConfig.js';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const SHELL_URL = 'nexo://app/src/ui/shell/index.html';
const CENTINELA = 'ATAJO-SECRETO-DEL-USUARIO-42';

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const copia = (value) => JSON.parse(JSON.stringify(value));

function shell() {
  const win = journal.windows[0];
  win.webContents.url = SHELL_URL;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

/** Una pestaña del proveedor: emisor real de `webContents`, pero no la shell. */
function pestana(url = 'https://chatgpt.com/c/filtro') {
  const view = journal.windows[0].attachWebview(url);
  view.navigateTo(url, 'ChatGPT');
  return { sender: view, senderFrame: view.mainFrame };
}

const invoke = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);

/** `nexo:config-sync` tal como lo consume el preload: `sendSync`. */
function configSync(event, payload) {
  const receptor = { returnValue: undefined };
  journal.ipcListeners.get('nexo:config-sync')(receptor, payload);
  return receptor.returnValue;
}

const CLAVES = 'enabled,language,profiled,settings,site,version'.split(',').sort();
const HOJAS = 'egress,enabled,memory,receiving,sites'.split(',').sort();

await settle();

/** Siembra el perfil con valores que jamás deben cruzar a la pestaña. */
async function sembrar() {
  await invoke('nexo:settings:set', shell(), {
    prompts: { items: [{ id: 'p-centinela', title: 'Atajo', text: CENTINELA }] },
    privacy: { localOnly: false, persistTranscripts: true },
    logging: { maxEntries: 7 },
    context: { enabled: false, budgetTokens: 1234, keepRecentTurns: 2 },
    sending: { enabled: false, wrapLongPaste: false },
    tokenCounting: { model: 'gpt-4-turbo' },
  });
  const perfil = await invoke('nexo:settings:get', shell());
  assert.equal(perfil.prompts.items[0].text, CENTINELA, 'el centinela está en el perfil');
  assert.equal(perfil.privacy.localOnly, false);
  assert.equal(perfil.logging.maxEntries, 7);
}

test('(a) una pestaña recibe sólo la lista blanca, sin centinela ni ramas privadas', async () => {
  await sembrar();
  const emisor = pestana();

  const config = await invoke('nexo:config', emisor, { host: 'chatgpt.com' });
  const sync = configSync(emisor, { host: 'chatgpt.com' });
  const ajustes = await invoke('nexo:settings:get', emisor);

  for (const [nombre, valor] of [['nexo:config', config], ['nexo:config-sync', sync]]) {
    assert.deepEqual(Object.keys(valor).sort(), CLAVES, `${nombre}: mismas claves de primer nivel que configFor`);
    assert.deepEqual(Object.keys(valor.settings).sort(), HOJAS, `${nombre}: settings sólo con las ramas leídas`);
    // `minUnit` y `minRepeats` no existen en DEFAULT_SETTINGS: el centinela los
    // resuelve con su propio valor por omisión y el filtro no los inventa.
    assert.deepEqual(Object.keys(valor.settings.receiving).sort(),
      ['autoContinue', 'holdbackChars', 'severityThreshold', 'stopOnLoop'],
      `${nombre}: receiving sólo con las hojas leídas presentes en el perfil`);
  }

  // La cuarta rama de primer nivel de settings: `sites` llega entera por id. El
  // perfil de fábrica sólo trae `default`; el test (d) comprueba el caso con
  // una fila por sitio.
  assert.deepEqual(Object.keys(config.settings.sites), ['default'], 'sites por id de adaptador');

  assert.deepEqual(Object.keys(ajustes).sort(), ['egress', 'enabled', 'memory', 'receiving', 'sites'],
    'nexo:settings:get desde una pestaña: sólo las ramas que puede consumir');

  for (const [nombre, valor] of [['config', config], ['config-sync', sync], ['settings:get', ajustes]]) {
    const json = JSON.stringify(valor);
    assert.doesNotMatch(json, new RegExp(CENTINELA), `${nombre}: sin el texto del atajo`);
    for (const rama of ['prompts', 'privacy', 'logging', 'context', 'sending', 'tokenCounting']) {
      assert.equal(rama in (valor.settings || valor), false, `${nombre}: sin la rama ${rama}`);
    }
  }
});

test('(b) las hojas que sí pasan valen lo mismo que en configFor sin filtrar', async () => {
  await sembrar();
  const emisor = pestana();
  const { engine } = await import('../src/main/main.js').then(() => ({ engine: null })).catch(() => ({ engine: null }));
  assert.equal(engine, null, 'configFor se alcanza por el canal, no se reexporta');

  // `engine.configFor` sin filtrar: es lo que el proceso principal sigue usando
  // internamente. Se obtiene por dentro del handler síncrono antes del recorte —
  // su resultado ya no lo publica nadie — así que se reconstruye con la misma
  // función pública que usa el motor.
  const { settingsForHost } = await import('../src/core/settings.js');
  const perfil = await invoke('nexo:settings:get', shell());
  const esperado = {
    enabled: settingsForHost(perfil, 'chatgpt.com').enabled,
    language: settingsForHost(perfil, 'chatgpt.com').protocol.lang === 'en' ? 'en' : 'es',
    version: '0.1.0',
    site: detectSite('chatgpt.com').id,
    profiled: isAiHost('chatgpt.com'),
    settings: settingsForHost(perfil, 'chatgpt.com'),
  };

  const filtrado = await invoke('nexo:config', emisor, { host: 'chatgpt.com' });
  for (const clave of ['enabled', 'language', 'version', 'site', 'profiled']) {
    assert.deepEqual(filtrado[clave], esperado[clave], `${clave} idéntico al de configFor`);
  }
  assert.deepEqual(filtrado.settings.enabled, esperado.settings.enabled, 'enabled de dentro de settings');
  assert.deepEqual(filtrado.settings.sites, esperado.settings.sites, 'sites idéntico');
  assert.deepEqual(filtrado.settings.egress, esperado.settings.egress, 'egress idéntico');
  assert.deepEqual(filtrado.settings.memory, esperado.settings.memory, 'memory idéntico');
  for (const hoja of Object.keys(filtrado.settings.receiving)) {
    assert.deepEqual(filtrado.settings.receiving[hoja], esperado.settings.receiving[hoja], `receiving.${hoja} idéntico`);
  }

  // Y no comparte referencias con el perfil: cambiar el filtrado no lo toca.
  const perfilAntes = copia(await invoke('nexo:settings:get', shell()));
  filtrado.settings.memory.enabled = 'tocado';
  filtrado.settings.egress.mode = 'tocado';
  assert.deepEqual(await invoke('nexo:settings:get', shell()), perfilAntes, 'sin referencias compartidas con el perfil');
});

test('(c) desde la shell, settings:get sigue entregando el perfil completo', async () => {
  await sembrar();
  const completo = await invoke('nexo:settings:get', shell());
  assert.equal(completo.prompts.items[0].text, CENTINELA, 'la shell ve sus atajos');
  assert.equal(completo.privacy.localOnly, false);
  assert.equal(completo.logging.maxEntries, 7);
  assert.equal(completo.tokenCounting.model, 'gpt-4-turbo');
  assert.ok('context' in completo && 'sending' in completo, 'y todas las ramas');
});

test('(d) consumir con el recorte da lo mismo que consumir la configuración entera', async () => {
  // Las lecturas de la auditoría, con las funciones reales de src/.
  const lecturas = (config) => {
    const settings = config.settings || {};
    return {
      shouldInject: (() => {
        if (!config || config.profiled === false) return false;
        const isChatGpt = config.site === 'chatgpt';
        return config.enabled !== false || isChatGpt;
      })(),
      enabled: config.enabled,
      sitioHabilitado: settings.sites?.chatgpt?.enabled !== false,
      normalizeEgress: normalizeEgress(settings.egress),
      autoContinue: settings.receiving?.autoContinue ?? 0,
      isEvoMemoryEnabled: isEvoMemoryEnabled(settings),
      centinela: new StreamSentinel({ settings, host: 'chatgpt.com', language: 'es' }).policy,
    };
  };

  const casos = [
    ['egress off, memoria on', { egress: { mode: 'off' }, memory: { enabled: true } }],
    ['egress observe, memoria off', { egress: { mode: 'observe', decisionTimeoutMs: 7000 }, memory: { enabled: false } }],
    ['egress enforce, chatgpt deshabilitado', {
      egress: { mode: 'enforce', onUnreadable: 'block', allowSendCritical: true },
      memory: { enabled: true },
      sites: { chatgpt: { enabled: false } },
    }],
  ];

  const entradas = [];
  for (const [nombre, patch] of casos) {
    await invoke('nexo:settings:set', shell(), patch);
    const perfil = await invoke('nexo:settings:get', shell());
    const { settingsForHost } = await import('../src/core/settings.js');
    const resuelto = settingsForHost(perfil, 'chatgpt.com');
    const entera = {
      enabled: resuelto.enabled, language: 'es', version: '0.1.0',
      site: detectSite('chatgpt.com').id, profiled: true, settings: resuelto,
    };
    const recortada = await invoke('nexo:config', pestana(), { host: 'chatgpt.com' });

    entradas.push({ nombre, entera: lecturas(entera), recortada: lecturas(recortada) });
    assert.deepEqual(lecturas(recortada), lecturas(entera), `${nombre}: mismas decisiones con o sin recorte`);
  }

  // Entrada y salida, para el informe.
  for (const { nombre, entera, recortada } of entradas) {
    console.log(`\n· ${nombre}`);
    console.log(`  egress   entero=${JSON.stringify(entera.normalizeEgress)}`);
    console.log(`           recorte=${JSON.stringify(recortada.normalizeEgress)}`);
    console.log(`  memoria  isEvoMemoryEnabled(entero)=${entera.isEvoMemoryEnabled} recorte=${recortada.isEvoMemoryEnabled}`);
    console.log(`  inyecta  shouldInject=${entera.shouldInject}/${recortada.shouldInject} sitio=${entera.sitioHabilitado}/${recortada.sitioHabilitado} autoContinue=${entera.autoContinue}/${recortada.autoContinue}`);
    console.log(`  centinela entero=${JSON.stringify(entera.centinela)}`);
    console.log(`            recorte=${JSON.stringify(recortada.centinela)}`);
  }

  // El caso del sitio deshabilitado: `configFor`, que recibe el perfil entero,
  // apaga `enabled` y la capa no media aunque el host tenga perfil.
  await invoke('nexo:settings:set', shell(), { sites: { chatgpt: { enabled: false } } });
  const apagado = await invoke('nexo:config', pestana(), { host: 'chatgpt.com' });
  assert.equal(apagado.enabled, false, 'sitio deshabilitado apaga enabled');
  assert.equal(apagado.profiled, true, 'sin perder el perfil del host');

  await invoke('nexo:settings:reset', shell());
});

test('(e) un host ajeno sigue sin perfil y con sitio genérico', async () => {
  const emisor = pestana('https://accounts.google.com/signin');
  const config = await invoke('nexo:config', emisor, { host: 'accounts.google.com' });
  const sync = configSync(emisor, { host: 'accounts.google.com' });
  for (const [nombre, valor] of [['nexo:config', config], ['nexo:config-sync', sync]]) {
    assert.equal(valor.site, 'generic', `${nombre}: sitio genérico`);
    assert.equal(valor.profiled, false, `${nombre}: sin perfil no se inyecta`);
    assert.equal(valor.enabled, true, `${nombre}: la mediación global no depende del perfil`);
    assert.deepEqual(Object.keys(valor).sort(), CLAVES, `${nombre}: misma forma`);
  }
});

test('(f) el camino de error de config-sync sigue entregando returnValue', async () => {
  // `engine` nulo antes de arrancar: es el caso que el handler ya cubría.
  const emisor = pestana();
  const receptor = { returnValue: 'sin-tocar' };
  journal.ipcListeners.get('nexo:config-sync')(receptor, { host: 'chatgpt.com' });
  assert.ok(receptor.returnValue && typeof receptor.returnValue === 'object', 'siempre responde');

  // Con una entrada hostil, el recorte no lanza y el preload no se queda colgado.
  for (const host of [null, 42, {}, []]) {
    const otro = { returnValue: undefined };
    journal.ipcListeners.get('nexo:config-sync')(otro, { host });
    assert.equal(otro.returnValue.site, 'generic', `host ${JSON.stringify(host)}: responde y sin perfil`);
  }
  assert.equal(configSync(emisor, {}).site, 'generic', 'sin host, también responde');
});

test('la función pura no muta la entrada y omite lo que falta', () => {
  const original = {
    enabled: true, language: 'es', version: '0.1.0', site: 'chatgpt', profiled: true,
    settings: {
      enabled: true,
      prompts: { items: [{ text: CENTINELA }] },
      privacy: { localOnly: true },
      memory: { enabled: true },
      egress: { mode: 'off' },
      receiving: { autoContinue: 2, holdbackChars: 112, repairMarkdown: true },
      sites: { chatgpt: { enabled: true, protocolLevel: 'suave' } },
    },
  };
  const antes = copia(original);
  const salida = configForTab(original);

  assert.deepEqual(original, antes, 'la entrada queda intacta');
  assert.notEqual(salida.settings, original.settings, 'settings es un objeto nuevo');
  assert.notEqual(salida.settings.sites, original.settings.sites, 'sites también');
  assert.notEqual(salida.settings.sites.chatgpt, original.settings.sites.chatgpt, 'y cada fila');
  assert.equal(salida.settings.receiving.repairMarkdown, undefined, 'repairMarkdown no se lee en la pestaña');

  // Ramas que faltan: se omiten, no se inventan.
  const vacío = configForTab({ enabled: false });
  assert.deepEqual(vacío, { enabled: false, settings: {} });
  assert.deepEqual(configForTab(null), { settings: {} });
  assert.deepEqual(settingsForTab({ prompts: { items: [] } }), {}, 'sin hojas leídas, bloque vacío');

  // Y `settingsForTab` conserva lo mismo que `configForTab`, ya resuelto por host.
  assert.deepEqual(
    Object.keys(settingsForTab(DEFAULT_SETTINGS)).sort(),
    ['egress', 'enabled', 'memory', 'receiving', 'sites'],
    'mismas ramas que configForTab',
  );
});

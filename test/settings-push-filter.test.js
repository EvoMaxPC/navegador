/**
 * El envío de ajustes hacia las pestañas también se recorta.
 *
 * `refreshGuestSettings` (src/main/main.js) manda `nexo:settings` a cada pestaña
 * de un sitio con perfil cuando la shell cambia o restablece los ajustes. El
 * bridge reenvía ese payload tal cual al mundo principal de la página
 * (preload/bridge.cjs:212-214), así que hasta ahora cualquier cambio de ajustes
 * publicaba el perfil entero —atajos del usuario incluidos— dentro de la página.
 *
 * Acá se comprueba, contra el código real y el envío real, que el payload lleva
 * sólo lo que la capa lee y que consumirlo da el mismo resultado que consumir el
 * payload completo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { normalizeEgress } from '../src/core/egressConfig.js';
import { isEvoMemoryEnabled, settingsForHost } from '../src/core/settings.js';
import { detectSite } from '../src/core/sites.js';
import { isAiHost } from '../src/core/cdp.js';
import { StreamSentinel } from '../src/core/streamSentinel.js';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const SHELL_URL = 'nexo://app/src/ui/shell/index.html';
const CENTINELA = 'ATAJO-SECRETO-DEL-USUARIO-77';

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const copia = (value) => JSON.parse(JSON.stringify(value));

function shell() {
  const win = journal.windows[0];
  win.webContents.url = SHELL_URL;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

const invoke = (channel, event, payload) => journal.ipcHandlers.get(channel)(event, payload);

/** Cambia los ajustes como lo hace la shell: es lo que dispara el envío. */
const cambiar = (patch) => invoke('nexo:settings:set', shell(), patch);

/** Último payload `nexo:settings` que recibió una pestaña. */
const ultimoEnvio = (view) => view.sent.findLast((entry) => entry.channel === 'nexo:settings')?.payload;

/** Lo que `configFor` devolvería sin recortar, reconstruido con su misma función. */
async function sinFiltrar(host) {
  const perfil = await invoke('nexo:settings:get', shell());
  const settings = settingsForHost(perfil, host);
  return {
    enabled: settings.enabled,
    settings,
    language: settings.protocol.lang === 'en' ? 'en' : 'es',
    version: '0.1.0',
    site: detectSite(host).id,
    profiled: isAiHost(host),
  };
}

const CLAVES = 'enabled,language,profiled,settings,site,version'.split(',').sort();
const HOJAS = 'egress,enabled,memory,receiving,sites'.split(',').sort();

await settle();

/** Sembrar el perfil con valores que no deben cruzar a la pestaña. */
async function sembrar() {
  await cambiar({
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
  assert.equal(perfil.context.budgetTokens, 1234);
  assert.equal(perfil.sending.enabled, false);
  assert.equal(perfil.tokenCounting.model, 'gpt-4-turbo');
}

test('(a) el envío a la pestaña no lleva el centinela ni las ramas privadas', async () => {
  // La pestaña se abre antes del cambio: `refreshGuestSettings` sólo alcanza a
  // las que ya existen y tienen perfil.
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/envio-filtrado');
  await sembrar();

  const payload = ultimoEnvio(view);
  assert.ok(payload, 'la pestaña recibió el cambio de ajustes');
  assert.deepEqual(Object.keys(payload).sort(), CLAVES, 'misma forma de primer nivel que configFor');
  assert.deepEqual(Object.keys(payload.settings).sort(), HOJAS, 'settings sólo con las ramas leídas');
  assert.deepEqual(Object.keys(payload.settings.receiving).sort(),
    ['autoContinue', 'holdbackChars', 'severityThreshold', 'stopOnLoop'],
    'receiving sólo con las hojas leídas presentes en el perfil');

  const json = JSON.stringify(payload);
  assert.equal(json.includes(CENTINELA), false, 'sin el texto del atajo');
  for (const rama of ['prompts', 'privacy', 'logging', 'context', 'sending', 'tokenCounting']) {
    assert.equal(rama in payload.settings, false, `sin la rama ${rama}`);
  }

  // Una pestaña de un host sin perfil no recibe nada, y la shell nunca.
  const ajeno = journal.windows[0].attachWebview('https://example.com/');
  await cambiar({ enabled: true });
  assert.equal(ultimoEnvio(ajeno), undefined, 'un host sin perfil no recibe ajustes');
  assert.equal(journal.windows[0].webContents.sent.some((e) => e.channel === 'nexo:settings'), false,
    'la shell no recibe este canal');
});

test('(b) las hojas permitidas valen lo mismo que en el configFor sin recortar', async () => {
  await sembrar();
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/envio-hojas');
  await cambiar({ enabled: true });

  const payload = ultimoEnvio(view);
  const entero = await sinFiltrar('chatgpt.com');

  for (const clave of ['enabled', 'language', 'version', 'site', 'profiled']) {
    assert.deepEqual(payload[clave], entero[clave], `${clave} idéntico al de configFor`);
  }
  for (const rama of ['enabled', 'sites', 'memory', 'egress']) {
    assert.deepEqual(payload.settings[rama], entero.settings[rama], `settings.${rama} idéntico`);
  }
  for (const hoja of Object.keys(payload.settings.receiving)) {
    assert.deepEqual(payload.settings.receiving[hoja], entero.settings.receiving[hoja], `receiving.${hoja} idéntico`);
  }

  // Y no hay referencias compartidas con el perfil.
  const perfilAntes = copia(await invoke('nexo:settings:get', shell()));
  payload.settings.memory.enabled = 'tocado';
  payload.settings.egress.mode = 'tocado';
  assert.deepEqual(await invoke('nexo:settings:get', shell()), perfilAntes, 'el perfil no se toca desde el payload');
});

test('(c) consumir el payload recortado da el mismo resultado que consumirlo entero', async () => {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/envio-consumo');

  // Las mismas lecturas que ejerce la capa y el preload de la pestaña.
  const lecturas = (config) => {
    const settings = config.settings || {};
    return {
      shouldInject: (() => {
        if (!config || config.profiled === false) return false;
        return config.enabled !== false || config.site === 'chatgpt';
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
    ['egress off, memoria on', { egress: { mode: 'off' }, memory: { enabled: true }, sites: { chatgpt: { enabled: true } } }],
    ['egress observe, memoria off', { egress: { mode: 'observe', decisionTimeoutMs: 7000 }, memory: { enabled: false }, sites: { chatgpt: { enabled: true } } }],
    ['egress enforce, chatgpt deshabilitado', {
      egress: { mode: 'enforce', onUnreadable: 'block', allowSendCritical: true },
      memory: { enabled: true },
      sites: { chatgpt: { enabled: false } },
    }],
  ];

  const salidas = [];
  for (const [nombre, patch] of casos) {
    await cambiar(patch);
    const recortado = ultimoEnvio(view);
    const entero = await sinFiltrar('chatgpt.com');
    const conRecorte = lecturas(recortado);
    const conEntero = lecturas(entero);
    salidas.push({ nombre, conRecorte, conEntero });
    assert.deepEqual(conRecorte, conEntero, `${nombre}: mismas decisiones con o sin recorte`);
  }

  for (const { nombre, conEntero, conRecorte } of salidas) {
    console.log(`\n· ${nombre}`);
    console.log(`  egress   entero=${JSON.stringify(conEntero.normalizeEgress)}`);
    console.log(`           recorte=${JSON.stringify(conRecorte.normalizeEgress)}`);
    console.log(`  memoria  isEvoMemoryEnabled entero=${conEntero.isEvoMemoryEnabled} recorte=${conRecorte.isEvoMemoryEnabled}`);
    console.log(`  inyecta  shouldInject entero=${conEntero.shouldInject} recorte=${conRecorte.shouldInject} · sitio entero=${conEntero.sitioHabilitado} recorte=${conRecorte.sitioHabilitado} · autoContinue ${conEntero.autoContinue}/${conRecorte.autoContinue}`);
    console.log(`  centinela entero=${JSON.stringify(conEntero.centinela)}`);
    console.log(`            recorte=${JSON.stringify(conRecorte.centinela)}`);
  }

  // El sitio deshabilitado, extremo a extremo: el payload apaga `enabled` y
  // conserva el perfil del host, que es lo que decide la inyección.
  assert.equal(salidas[2].conRecorte.enabled, false, 'sitio deshabilitado apaga enabled en el payload');
  assert.equal(salidas[2].conRecorte.sitioHabilitado, false, 'y la capa no media ese sitio');
  assert.equal(salidas[2].conRecorte.isEvoMemoryEnabled, false, 'ni el lector de la pestaña lee');

  await invoke('nexo:settings:reset', shell());
});

test('restablecer también envía el payload recortado', async () => {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/envio-reset');
  await sembrar();
  const antes = view.sent.filter((e) => e.channel === 'nexo:settings').length;

  await invoke('nexo:settings:reset', shell());
  const envios = view.sent.filter((e) => e.channel === 'nexo:settings');
  assert.equal(envios.length, antes + 1, 'el restablecimiento también avisa a la pestaña');
  const payload = envios.at(-1).payload;
  assert.deepEqual(Object.keys(payload.settings).sort(), HOJAS);
  assert.equal(JSON.stringify(payload).includes(CENTINELA), false, 'sin el atajo ya borrado tampoco');
});

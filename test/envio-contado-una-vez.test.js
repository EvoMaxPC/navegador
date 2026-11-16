/**
 * Un envío es un mensaje, aunque se anuncie por tres caminos.
 *
 * El gesto del cuadro («composer»), la lectura del cuerpo en la red («network»)
 * y la petición que anuncia la capa («request») describen el mismo envío. La
 * red lee el texto **ya mediado** (protocolo inyectado, memoria), así que su
 * huella no coincide con la del cuadro, que lleva el texto tal como lo escribió
 * la persona. Con las huellas distintas, el motor los tomaba por dos envíos:
 * `messages` subía de 0 a 2 y el panel mostraba dos «Mensaje enviado» para un
 * solo mensaje.
 *
 * Se ejecuta el motor y `main.js` reales sobre el arnés de Electron. Datos
 * sintéticos: ninguna tarjeta ni memoria real.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

const ORIGINAL = 'Hola, ¿me ayudas con esta receta de pan?';
const MEDIADO = `Protocolo de continuidad (equilibrado)\n\n${ORIGINAL}`;

async function mundo() {
  register('./harness/loader.mjs', import.meta.url);
  const { join } = await import('node:path');
  const { journal } = await import('./harness/electron-stub.mjs');
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  new EvoMemory({
    storage: fileStorage(join(journal.userData, 'evo-memory-envio-unico.json')),
    projectId: 'default',
  }).store.save({ force: true });

  await import('../src/main/main.js');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const shellEv = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (channel, ev, payload) => journal.ipcHandlers.get(channel)(ev, payload);
  const view = win.attachWebview('https://chatgpt.com/c/7c16b');
  const { EGRESS_DEFAULTS } = await import('../src/core/egressConfig.js');
  await invoke('nexo:settings:set', shellEv, {
    egress: { ...EGRESS_DEFAULTS, mode: 'observe' }, // observar: no frena la red
    context: { enabled: true },
    memory: { enabled: false },
    protocol: { level: 'equilibrado' },
  });

  const capa = (payload) => journal.ipcListeners.get('nexo:event')(
    { sender: view, senderFrame: view.mainFrame },
    { type: 'outgoing', payload },
  );
  const red = (cuerpo) => journal.webRequest.before.get('persist:nexo').listener({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    method: 'POST',
    resourceType: 'xhr',
    webContentsId: view.id,
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    uploadData: [{ bytes: Buffer.from(cuerpo, 'utf8') }],
  }, () => {});
  const mensajes = async () => (await invoke('nexo:stats', shellEv)).messages;
  // El registro del arnés se comparte entre bloques de prueba y el aviso de la
  // capa se sustituye por el de la red: se compara por identidad de entrada.
  const previas = new Set(await invoke('nexo:log', shellEv));
  const enviados = async () => (await invoke('nexo:log', shellEv))
    .filter((e) => !previas.has(e) && (e.code === 'outgoing' || e.code === 'outgoing-network'))
    .map((e) => ({ code: e.code, source: e.meta?.source, detail: e.detail }));

  /** Un envío completo, por los tres caminos, como en el PC. */
  let n = 0;
  const enviar = async ({ origen = ORIGINAL, mediado = MEDIADO, gesto = true, cuerpoRed = true, capaRequest = true } = {}) => {
    n += 1;
    if (gesto) {
      capa({ messageId: `composer-${n}`, source: 'composer', site: 'chatgpt', host: 'chatgpt.com',
        url: 'https://chatgpt.com/c/7c16b', chars: origen.length, textFound: true, mediated: false,
        promptHash: `h-origen-${n}` });
    }
    if (cuerpoRed) {
      red(JSON.stringify({ action: 'next', messages: [{ id: `prov-${n}`, author: { role: 'user' },
        content: { content_type: 'text', parts: [mediado] } }] }));
    }
    if (capaRequest) {
      capa({ messageId: `request-${n}`, source: 'request', site: 'chatgpt', host: 'chatgpt.com',
        url: 'https://chatgpt.com/backend-api/f/conversation', chars: origen.length, textFound: true,
        mediated: true, promptHash: `h-origen-${n}`, submissionId: `prov-${n}` });
    }
  };
  return { invoke, shellEv, enviar, mensajes, enviados };
}

test('un envío anunciado por gesto, red y capa cuenta UN mensaje y deja UN «Mensaje enviado»', async () => {
  const { enviar, mensajes, enviados } = await mundo();
  const antes = await mensajes();

  await enviar();

  assert.equal((await mensajes()) - antes, 1, 'un envío, un mensaje');
  const avisos = await enviados();
  assert.equal(avisos.length, 1, `un solo «Mensaje enviado», llegaron ${avisos.length}`);
  assert.equal(avisos[0].source, 'network', 'el que cuenta es el que leyó el cuerpo de la petición');
});

test('el aviso no afirma «salió sin cambios» cuando el texto viajó mediado', async () => {
  const { enviar, enviados } = await mundo();

  await enviar();

  for (const aviso of await enviados()) {
    assert.equal(/salió sin cambios/i.test(aviso.detail), false,
      `«${aviso.detail}» no puede afirmar que nada cambió`);
  }
});

test('no-regresión: dos envíos idénticos legítimos siguen contando dos', async () => {
  const { enviar, mensajes } = await mundo();
  const antes = await mensajes();

  await enviar();
  await enviar();

  assert.equal((await mensajes()) - antes, 2, 'dos envíos iguales son dos mensajes');
});

test('no-regresión: dos envíos distintos siguen contando dos', async () => {
  const { enviar, mensajes } = await mundo();
  const antes = await mensajes();

  await enviar({ origen: 'Primera pregunta sobre el pan', mediado: 'Protocolo\n\nPrimera pregunta sobre el pan' });
  await enviar({ origen: 'Segunda pregunta sobre el horno', mediado: 'Protocolo\n\nSegunda pregunta sobre el horno' });

  assert.equal((await mensajes()) - antes, 2, 'dos textos distintos son dos mensajes');
});

test('no-regresión: el gesto solo (sin petición detrás) sigue contando', async () => {
  const { enviar, mensajes } = await mundo();
  const antes = await mensajes();

  await enviar({ gesto: true, cuerpoRed: false, capaRequest: false });

  assert.equal((await mensajes()) - antes, 1, 'un envío cuyo cuerpo no se ve en la red sigue contando');
});

test('la secuencia del PC: gesto, red y capa dejan 1 mensaje y 1 aviso, sin «sin cambios»', async () => {
  const { enviar, mensajes, enviados } = await mundo();
  const antes = await mensajes();

  await enviar();

  assert.equal((await mensajes()) - antes, 1, 'el motor no sube de 0 a 2');
  const avisos = await enviados();
  assert.equal(avisos.length, 1, 'un solo «Mensaje enviado», no dos');
  assert.equal(avisos[0].source, 'network');
  assert.equal(/salió sin cambios/i.test(avisos[0].detail), false, 'el aviso no miente sobre el texto');
});

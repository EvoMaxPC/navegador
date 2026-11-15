/**
 * Un envío retenido por el guardián sigue siendo UN mensaje cuando su petición
 * cruza la red más tarde de lo que dura la ventana corta.
 *
 * El gesto del cuadro se anuncia solo a los `ESPERA_PETICION_MS` (2 500 ms,
 * `src/inject/index.js:181`). En `enforce` la petición espera al diálogo del
 * guardián, y esa espera puede durar el `decisionTimeoutMs` completo (120 000 ms
 * por omisión, `src/core/egressConfig.js:8`) más el `MARGEN_EGRESS_MS` de 5 000
 * (`src/inject/index.js:498`). Con la ventana de 10 s, el registro huérfano del
 * gesto ya no se fusionaba con su red y el panel contaba dos mensajes.
 *
 * Un registro huérfano —`sources` es exactamente `{'composer'}`— acepta la
 * primera fuente `network`/`request` de su pestaña hasta
 * `VENTANA_PETICION_PENDIENTE_MS` (130 000). Cualquier otro registro conserva
 * 10 000: un envío que ya tiene petición no alarga su ventana.
 *
 * El reloj se controla desde el test (`Date.now`), y se restaura en `finally`.
 * Datos sintéticos: ningún texto real ni dato detectado.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const RAIZ = new URL('..', import.meta.url).pathname;
const ORIGINAL = 'Hola, ¿me ayudas con esta receta de pan?';
const MEDIADO = `Protocolo de continuidad (equilibrado)\n\n${ORIGINAL}`;

/** Reloj manual: `Date.now` avanza sólo cuando el test lo pide. */
function reloj(desde = 1_700_000_000_000) {
  const real = Date.now;
  let ahora = desde;
  Date.now = () => ahora;
  return { avanzar: (ms) => { ahora += ms; }, restaurar: () => { Date.now = real; } };
}

/** El proceso principal real sobre el arnés de Electron (una sola app por proceso). */
async function mundo(etiqueta) {
  register('./harness/loader.mjs', import.meta.url);
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  const { journal } = await import('./harness/electron-stub.mjs');
  new EvoMemory({
    storage: fileStorage(join(journal.userData, `evo-memory-${etiqueta}.json`)),
    projectId: 'default',
  }).store.save({ force: true });
  await import('../src/main/main.js');
  await new Promise((r) => setTimeout(r, 80));

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const shellEv = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (canal, ev, payload) => journal.ipcHandlers.get(canal)(ev, payload);
  const view = win.attachWebview(`https://chatgpt.com/c/${etiqueta}`);
  view.url = `https://chatgpt.com/c/${etiqueta}`;
  const evView = { sender: view, senderFrame: view.mainFrame };
  const { EGRESS_DEFAULTS } = await import('../src/core/egressConfig.js');
  await invoke('nexo:settings:set', shellEv, {
    egress: { ...EGRESS_DEFAULTS, mode: 'observe' },
    context: { enabled: false },
    memory: { enabled: false },
  });

  const avisos = async (codigos) => (await invoke('nexo:log', shellEv))
    .filter((e) => codigos.includes(e.code));
  const capa = (payload) => journal.ipcListeners.get('nexo:event')(evView, { type: 'outgoing', payload });
  const red = (cuerpo) => journal.webRequest.before.get('persist:nexo').listener({
    url: 'https://chatgpt.com/backend-api/f/conversation',
    method: 'POST', resourceType: 'xhr', webContentsId: view.id,
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    uploadData: [{ bytes: Buffer.from(cuerpo, 'utf8') }],
  }, () => {});
  const cuerpo = (texto, id) => JSON.stringify({
    action: 'next',
    messages: [{ id, author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
  });
  const composer = (id, hash) => capa({ messageId: id, source: 'composer', host: 'chatgpt.com',
    url: view.url, chars: ORIGINAL.length, textFound: true, mediated: false, promptHash: hash });
  const request = (id, hash, submissionId) => capa({ messageId: id, source: 'request',
    host: 'chatgpt.com', url: 'https://chatgpt.com/backend-api/f/conversation',
    chars: ORIGINAL.length, textFound: true, mediated: true, promptHash: hash, submissionId });
  return {
    composer, request, red, cuerpo,
    mensajes: async () => (await invoke('nexo:stats', shellEv)).messages,
    /** Avisos de este envío: los del log anterior no cuentan. */
    enviadosDe: async (id) => (await avisos(['outgoing', 'outgoing-network']))
      .filter((e) => e.meta?.messageId === id),
    diagDe: async (id) => (await avisos(['diag-mensaje'])).filter((e) => e.meta?.messageIdHash === id),
  };
}

test('composer -> network a 12 s cuenta UN mensaje y deja un solo «Mensaje enviado»', async () => {
  const c = reloj();
  try {
    const { composer, red, cuerpo, mensajes, enviadosDe } = await mundo('pend-12s');
    const antes = await mensajes();
    composer('A-12s', 'h-origen');
    c.avanzar(12_000);
    red(cuerpo(MEDIADO, 'prov-12s'));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal((await mensajes()) - antes, 1, 'un envío con la red tardía sigue siendo un mensaje');
    const avisos = await enviadosDe('A-12s');
    assert.equal(avisos.length, 1, `un solo «Mensaje enviado», llegaron ${avisos.length}`);
  } finally { c.restaurar(); }
});

test('composer -> network a 129 s sigue contando uno (dentro de la ventana del guardián)', async () => {
  const c = reloj();
  try {
    const { composer, red, cuerpo, mensajes, enviadosDe } = await mundo('pend-129s');
    const antes = await mensajes();
    composer('A-129s', 'h-origen');
    c.avanzar(129_000);
    red(cuerpo(MEDIADO, 'prov-129s'));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal((await mensajes()) - antes, 1, '129 000 ms caben en VENTANA_PETICION_PENDIENTE_MS');
    assert.equal((await enviadosDe('A-129s')).length, 1, 'y no aparece un segundo aviso');
  } finally { c.restaurar(); }
});

test('composer -> network a 131 s ya no se fusiona: dos envíos distintos', async () => {
  const c = reloj();
  try {
    const { composer, red, cuerpo, mensajes } = await mundo('pend-131s');
    const antes = await mensajes();
    composer('A-131s', 'h-origen');
    c.avanzar(131_000);
    red(cuerpo(MEDIADO, 'prov-131s'));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal((await mensajes()) - antes, 2, 'más allá de la ventana, la red abre su propio registro');
  } finally { c.restaurar(); }
});

test('un gesto cancelado no se come el envío siguiente: composer A -> composer B -> network B', async () => {
  const c = reloj();
  try {
    const { composer, red, cuerpo, mensajes } = await mundo('pend-cancelado');
    const antes = await mensajes();
    composer('A-cancelado', 'h-a');          // se retuvo y no salió: no hay red
    c.avanzar(20_000);
    composer('B-nuevo', 'h-b');
    red(cuerpo(MEDIADO, 'prov-b'));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal((await mensajes()) - antes, 2, 'el gesto cancelado y el envío nuevo son dos mensajes');
  } finally { c.restaurar(); }
});

test('la ventana larga NO alcanza a un registro que ya tiene petición', async () => {
  const c = reloj();
  try {
    const { composer, red, request, cuerpo, mensajes } = await mundo('pend-con-peticion');
    const antes = await mensajes();
    // Envío 1 completo: gesto + red fusionados.
    composer('A1', 'h-1');
    red(cuerpo(MEDIADO, 'prov-1'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await mensajes()) - antes, 1, 'el primer envío cuenta uno');

    // Envío 2, 20 s después, sólo por capa/petición con otro submissionId.
    c.avanzar(20_000);
    request('C2-request', 'h-2', 'prov-2');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await mensajes()) - antes, 2, 'un envío nuevo con otro submissionId cuenta uno más');

    // Envío 3 avisado por la capa `request` (no es un gesto huérfano) y su red
    // 20 s después: aquí la ventana larga NO aplica, así que son dos registros.
    c.avanzar(20_000);
    request('C3-request', 'h-3', '');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await mensajes()) - antes, 3, 'el aviso de la petición cuenta por sí mismo');
    c.avanzar(20_000);
    red(cuerpo(MEDIADO, 'prov-3'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await mensajes()) - antes, 4,
      'un registro que NO es sólo gesto conserva la ventana corta y no se fusiona a 20 s');
  } finally { c.restaurar(); }
});

test('un segundo composer nunca se funde con el composer anterior', async () => {
  const c = reloj();
  try {
    const { composer, mensajes } = await mundo('pend-dos-gestos');
    const antes = await mensajes();
    composer('A-gesto', 'h-a');
    c.avanzar(20_000);
    composer('B-gesto', 'h-b');
    await new Promise((r) => setTimeout(r, 40));

    assert.equal((await mensajes()) - antes, 2, 'dos gestos son dos mensajes, aunque la ventana sea larga');
  } finally { c.restaurar(); }
});

/* ------------------------------------------------------------------ */
/* `+Nms`: `diagOn` se fija al importar `main.js`, así que cada valor  */
/* de NEXO_DIAG necesita su propio proceso.                            */
/* ------------------------------------------------------------------ */

const HIJO = `
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const RAIZ = process.cwd();
register(pathToFileURL(join(RAIZ, 'test/harness/loader.mjs')).href, import.meta.url);
const { journal } = await import(pathToFileURL(join(RAIZ, 'test/harness/electron-stub.mjs')).href);
const { EvoMemory } = await import(pathToFileURL(join(RAIZ, 'src/memory/engine.js')).href);
const { fileStorage } = await import(pathToFileURL(join(RAIZ, 'src/main/files.js')).href);
new EvoMemory({ storage: fileStorage(join(journal.userData, 'evo-diag.json')), projectId: 'default' }).store.save({ force: true });
await import(pathToFileURL(join(RAIZ, 'src/main/main.js')).href);
await new Promise((r) => setTimeout(r, 80));
const win = journal.windows[0], shell = win.webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const ev0 = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (c, e, p) => journal.ipcHandlers.get(c)(e, p);
const { EGRESS_DEFAULTS } = await import(pathToFileURL(join(RAIZ, 'src/core/egressConfig.js')).href);
await invoke('nexo:settings:set', ev0, { egress: { ...EGRESS_DEFAULTS, mode: 'observe' },
  context: { enabled: false }, memory: { enabled: false } });
const view = win.attachWebview('https://chatgpt.com/c/diag-hijo');
view.url = 'https://chatgpt.com/c/diag-hijo';
const ev = { sender: view, senderFrame: view.mainFrame };
const real = Date.now;
let ahora = 1_700_000_000_000;
Date.now = () => ahora;
const capa = (id) => journal.ipcListeners.get('nexo:event')(ev, { type: 'outgoing', payload: {
  messageId: id, source: 'composer', host: 'chatgpt.com', url: view.url, chars: 10,
  textFound: true, promptHash: 'h' + id } });
capa('A'); ahora += 4321; capa('B'); ahora += 10; capa('C');
Date.now = real;
const diag = (await invoke('nexo:log', ev0)).filter((e) => e.code === 'diag-mensaje').map((e) => e.detail);
process.stdout.write('##' + JSON.stringify(diag) + '##');
`;

function correr(nexoDiag) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', HIJO], {
    cwd: RAIZ, encoding: 'utf8',
    env: { ...process.env, NEXO_DIAG: nexoDiag },
  });
  const bruto = String(r.stdout || '');
  const marca = bruto.match(/##(.*)##/s);
  assert.ok(marca, `el hijo con NEXO_DIAG=${nexoDiag} terminó y publicó su resultado (stderr: ${String(r.stderr).slice(-400)})`);
  return JSON.parse(marca[1]);
}

test('con NEXO_DIAG=1 el detalle trae «+Nms» y el primero dice «primero»', () => {
  // El registro entrega lo más nuevo primero: se lee en orden de llegada.
  const detalles = correr('1').reverse();
  assert.equal(detalles.length, 3, `un aviso por envío: ${JSON.stringify(detalles)}`);
  assert.ok(detalles[0].endsWith('primero'), `el primero lo dice: ${detalles[0]}`);
  assert.ok(detalles[1].includes('· +4321ms'), `el segundo mide desde el primero: ${detalles[1]}`);
  assert.ok(detalles[2].includes('· +10ms'), `el tercero mide desde el segundo: ${detalles[2]}`);
});

test('sin NEXO_DIAG no hay ningún diag-mensaje', () => {
  assert.deepEqual(correr('0'), [], 'con la variable apagada no se publica nada');
  assert.deepEqual(correr(''), [], 'ni cuando la variable no existe');
});

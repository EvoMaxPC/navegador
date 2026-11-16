/**
 * Canales de la shell sin pruebas: el emisor lo decide el proceso principal.
 *
 * `nexo:memory:{pin,forget,handoff,clear}`, `nexo:history:{top,remove,clear}`,
 * `nexo:bookmarks:{folders,clear,remove}`, `nexo:permissions:{for,set,sites,clear}`,
 * `nexo:zoom:list`, `nexo:session:clear` y `nexo:shell:config` estaban al alcance
 * de cualquier emisor con `ipcRenderer` —una pestaña inyectada también— y no
 * tenían ninguna prueba. Estos canales no tenían llamador ajeno conocido: el
 * único que los invoca es `src/preload/shell.cjs`.
 *
 * La prueba va por tabla sobre los diecisiete canales envueltos: con un emisor
 * ajeno se recibe el valor vacío del tipo que el canal devuelve normalmente y el
 * efecto no ocurre; con la shell se comporta como antes.
 *
 * `nexo:zoom:{get,set}` y `nexo:profile:stats` quedan fuera de esta etapa porque
 * `test/main-boot.test.js` y `test/destructive-shell-ipc.test.js` ya los invocan
 * con un emisor que no es la shell.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

const invoke = (channel, event, payload) => {
  const handler = journal.ipcHandlers.get(channel);
  assert.equal(typeof handler, 'function', `la aplicación registra ${channel}`);
  return handler(event, payload);
};

await settle();

const SHELL_URL = 'nexo://app/src/ui/shell/index.html';

/** La shell tal como la ve el proceso principal. */
function shell() {
  const win = journal.windows[0];
  win.webContents.url = SHELL_URL;
  return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
}

/** Una pestaña que se declara con la URL de la shell, pero no es de la ventana. */
function impostora() {
  const view = journal.windows[0].attachWebview(SHELL_URL);
  return { sender: view, senderFrame: view.mainFrame };
}

/** Una pestaña real de un sitio: el emisor que produce el preload de la capa. */
function pestana(url = 'https://chatgpt.com/c/capa') {
  const view = journal.windows[0].attachWebview(url);
  return { sender: view, senderFrame: view.mainFrame };
}

const esVacio = (valor) => valor === null || (Array.isArray(valor) && valor.length === 0);

// ---------------------------------------------------------------------------
// Tabla de canales envueltos: canal | valor denegado esperado
// ---------------------------------------------------------------------------

const VACIO = {
  'nexo:memory:pin': (v) => v.ok === false,
  'nexo:memory:forget': (v) => v.ok === false,
  'nexo:memory:handoff': esVacio,
  'nexo:memory:clear': (v) => v.ok === false,
  'nexo:history:top': (v) => Array.isArray(v) && v.length === 0,
  'nexo:history:remove': (v) => v.ok === false,
  'nexo:history:clear': (v) => v.removed === 0,
  'nexo:bookmarks:folders': (v) => Array.isArray(v) && v.length === 0,
  'nexo:bookmarks:clear': (v) => v.removed === 0,
  'nexo:bookmarks:remove': (v) => v.ok === false,
  'nexo:permissions:for': (v) => Array.isArray(v) && v.length === 0,
  'nexo:permissions:set': (v) => v.ok === false,
  'nexo:permissions:sites': (v) => Array.isArray(v) && v.length === 0,
  'nexo:permissions:clear': (v) => v.ok === false,
  'nexo:zoom:list': (v) => Array.isArray(v) && v.length === 0,
  'nexo:session:clear': (v) => v.ok === false,
  'nexo:shell:config': esVacio,
};

const CANALES = Object.keys(VACIO);

test('1) un emisor ajeno recibe el valor vacío en los diecisiete canales envueltos', async () => {
  const vistos = [];
  for (const canal of CANALES) {
    const valor = await invoke(canal, impostora());
    assert.ok(VACIO[canal](valor), `${canal} niega con el valor vacío de su tipo (recibido: ${JSON.stringify(valor)})`);
    vistos.push(canal);
  }
  assert.deepEqual(vistos, CANALES, 'se comprobaron todos los canales de la tabla');
  assert.equal(CANALES.length, 17, 'la tabla cubre los diecisiete canales envueltos');
});

test('2) una pestaña real de un sitio tampoco entra, aunque tenga webContents propio', async () => {
  for (const canal of CANALES) {
    const valor = await invoke(canal, pestana());
    assert.ok(VACIO[canal](valor), `${canal} niega también a una pestaña del sitio`);
  }
});

test('3) con la shell, los mismos canales se comportan como antes', async () => {
  // Efectos reales a través de la shell: marcador, permiso, memoria, sesión.
  assert.deepEqual(await invoke('nexo:bookmarks:folders', shell()), [], 'sin carpetas propias todavía');

  const importado = await invoke('nexo:memory:import', {}, {
    projectId: 'default',
    sections: { decision: [{ text: `Decisión sembrada para la tabla ${'y'.repeat(30)}` }] },
  });
  assert.ok(importado.added >= 1, 'la siembra entra por el único canal que sigue abierto al arnés');

  const lista = await invoke('nexo:memory:list', {});
  assert.ok(lista.length >= 1, 'hay algo que recordar');
  const objetivo = lista[0];

  // memoria:pin / handoff / clear, con la shell.
  assert.deepEqual(await invoke('nexo:memory:pin', shell(), { id: objetivo.id, pinned: true }), { ok: true });
  const paquete = await invoke('nexo:memory:handoff', shell());
  assert.equal(typeof paquete, 'object', 'la shell sí recibe el paquete de continuidad');
  assert.ok(Array.isArray(paquete.sections.decision), 'con sus secciones');

  // permisos: set, for, sites y clear.
  assert.deepEqual(
    await invoke('nexo:permissions:set', shell(), { host: 'claude.ai', permission: 'notifications', value: 'allow' }),
    { ok: true },
  );
  const sitios = await invoke('nexo:permissions:sites', shell());
  assert.ok(sitios.some((s) => s.host === 'claude.ai'), 'el sitio con regla propia aparece');
  const reglas = await invoke('nexo:permissions:for', shell(), 'claude.ai');
  assert.ok(reglas.some((r) => r.permission === 'notifications' && r.value === 'allow'));
  assert.deepEqual(await invoke('nexo:permissions:clear', shell(), 'claude.ai'), { ok: true });

  // session:clear sobre una sesión guardada.
  const win = journal.windows[0];
  win.webContents.url = SHELL_URL;
  await invoke('nexo:session:capture', {
    windows: [{ activeIndex: 0, tabs: [{ url: 'https://chatgpt.com/c/tabla', title: 'Tabla' }] }],
  });
  assert.deepEqual(await invoke('nexo:session:clear', shell()), { ok: true }, 'la shell sí limpia la sesión');
  assert.equal(await invoke('nexo:session:restore'), null, 'y ya no hay sesión que restaurar');

  // shell:config con la shell.
  const config = await invoke('nexo:shell:config', shell());
  assert.equal(typeof config?.version, 'string', 'la shell recibe la configuración de arranque');

  // memoria:clear al final, para no dejar la siembra.
  assert.equal((await invoke('nexo:memory:clear', shell())).ok, true, 'la shell sí vacía la memoria');
});

test('4) la denegación no deja efectos: el estado queda intacto', async () => {
  const antes = {
    memoria: (await invoke('nexo:memory:list', {})).length,
    marcadores: (await invoke('nexo:bookmarks:list', {}, {})).length,
    top: (await invoke('nexo:history:top', shell(), { limit: 5 })).length,
    permisos: (await invoke('nexo:permissions:sites', shell())).length,
    zoom: (await invoke('nexo:zoom:list', shell())).length,
  };

  const ajeno = impostora();
  await invoke('nexo:memory:clear', ajeno);
  await invoke('nexo:bookmarks:clear', ajeno);
  await invoke('nexo:history:clear', ajeno, { range: 'all' });
  await invoke('nexo:permissions:clear', ajeno, 'claude.ai');
  await invoke('nexo:session:clear', ajeno);
  await invoke('nexo:memory:pin', ajeno, { id: 'lo-que-sea' });

  assert.deepEqual(
    {
      memoria: (await invoke('nexo:memory:list', {})).length,
      marcadores: (await invoke('nexo:bookmarks:list', {}, {})).length,
      top: (await invoke('nexo:history:top', shell(), { limit: 5 })).length,
      permisos: (await invoke('nexo:permissions:sites', shell())).length,
      zoom: (await invoke('nexo:zoom:list', shell())).length,
    },
    antes,
    'ningún canal cambió el estado observable',
  );
});

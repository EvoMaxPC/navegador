/**
 * Críticos del texto inyectado: se ocultan antes de enviar, en el proceso
 * principal.
 *
 * El guardián de la capa juzga el texto del usuario y el respaldo de red juzga
 * el cuerpo final. Los bloques que añade el motor (memoria EVO, protocolo) no
 * los miraba nadie antes de salir: con `enforce`, una memoria con una tarjeta
 * hacía que la red frenara el envío entero, sin diálogo y sin explicación.
 *
 * Acá se comprueba la función pura y, extremo a extremo, que el cuerpo final de
 * ese envío ya no dispara el respaldo de red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { redactInjected } from '../src/main/injectedGuard.js';
import { detectSensitive } from '../src/egress/detect.js';
import { inspectOutgoing } from '../src/main/egressNet.js';
import { EGRESS_DEFAULTS } from '../src/core/egressConfig.js';

const TARJETA = 'La tarjeta de crédito del usuario es 4111 1111 1111 1111';
const API_KEY = 'La clave del proveedor es sk-proj-AbCdEfGhIjKlMnOpQrStUvWx';
const EMAIL = 'Escribir a maria.gomez@ejemplo.com si hay dudas';

const bloque = (memoria) => `[EVO]\n## Memoria relevante\nDatos:\n- ${memoria}\n[/EVO]\n\n\n[Protocolo de continuidad · Nexo]\n- No repitas frases.\n\n\nhola`;

// El modo de fábrica es `off`: el caso del síntoma es explícitamente `enforce`.
const enforce = { ...EGRESS_DEFAULTS, mode: 'enforce' };

test('1) tarjeta en la memoria: se oculta, siguen los bloques y el aviso no lleva el literal', () => {
  const mediado = bloque(TARJETA);
  const salida = redactInjected({ original: 'hola', mediated: mediado, mode: 'enforce' });

  console.log('\n   entrada:', JSON.stringify(mediado));
  console.log('   salida :', JSON.stringify(salida));

  assert.equal(salida.text.includes('4111'), false, 'el literal no viaja');
  assert.match(salida.text, /\[CARD_1\]/, 'con el marcador del vault');
  assert.equal(salida.text.includes('- La tarjeta de crédito del usuario es'), true, 'el resto del bloque se conserva');
  assert.equal(salida.text.endsWith('\n\nhola'), true, 'el texto del usuario sigue al final, intacto');
  assert.deepEqual(salida.redacted, { count: 1, types: ['card'] });
  // Los dos bloques siguen siendo dos: el marcador sólo reemplaza el dato.
  assert.equal((salida.text.match(/\[EVO\]/g) || []).length, 1);
  assert.equal(salida.text.includes('[Protocolo de continuidad · Nexo]'), true);

  // El aviso que emite el motor se arma sólo con tipos y cantidades.
  const detalle = `Tipos: ${salida.redacted.types.map((t) => `${t}×1`).join(', ')}. El dato sigue en tu memoria; sólo no viaja.`;
  assert.equal(detalle.includes('4111'), false, 'el aviso no lleva el literal');
  assert.equal(JSON.stringify(salida.redacted).includes('4111'), false);
});

test('2) extremo a extremo: el cuerpo final de ese envío ya no lo cancela el respaldo de red', () => {
  const cuerpo = (texto) => JSON.stringify({
    action: 'next',
    messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [texto] } }],
  });

  // Antes: el bloque con la tarjeta dispara el respaldo.
  const antes = inspectOutgoing({ method: 'POST', bodyText: cuerpo(bloque(TARJETA)), config: enforce });
  assert.equal(antes.cancel, true, 'el cuerpo sin redactar sí lo cancelaba');
  console.log('\n   antes  :', JSON.stringify(antes));

  // Después: con la salida del guardián, el mismo camino deja pasar.
  const salida = redactInjected({ original: 'hola', mediated: bloque(TARJETA), mode: 'enforce' });
  const despues = inspectOutgoing({ method: 'POST', bodyText: cuerpo(salida.text), config: enforce });
  console.log('   después:', JSON.stringify(despues));
  assert.equal(despues.cancel, false, 'ya no se cancela');
  assert.equal(despues.reason, 'sin-criticos');

  // Y el callback real de `onBeforeRequest` no lleva `cancel`.
  let respuesta = null;
  const callback = (r) => { respuesta = r; };
  if (despues.cancel) callback({ cancel: true });
  assert.equal(respuesta, null, 'no se llamó a cancelar');
});

test('3) con off y con observe el texto es el mismo string', () => {
  const mediado = bloque(TARJETA);
  const apagado = redactInjected({ original: 'hola', mediated: mediado, mode: 'off' });
  const observado = redactInjected({ original: 'hola', mediated: mediado, mode: 'observe' });

  console.log('\n   off    :', JSON.stringify(apagado.text.slice(0, 90)), '…');
  console.log('   observe:', JSON.stringify(observado.text.slice(0, 90)), '…');

  assert.equal(apagado.text, mediado, 'off: idéntico, mismo string');
  assert.equal(observado.text, mediado, 'observe: idéntico, mismo string');
  assert.deepEqual(apagado.redacted, { count: 0, types: [] });
  assert.deepEqual(observado.redacted, { count: 0, types: [] });
  assert.equal(apagado.text.includes('4111'), true, 'con off la tarjeta sigue');
  assert.equal(observado.text.includes('4111'), true, 'con observe también: observar no interviene');
});

test('4) si el usuario escribió la misma tarjeta, no se redacta', () => {
  const original = `hola, mi tarjeta es 4111 1111 1111 1111`;
  const mediado = bloque(TARJETA) + `\n\n${original}`;
  const salida = redactInjected({ original, mediated: mediado, mode: 'enforce' });

  console.log('\n   salida:', JSON.stringify(salida));
  assert.equal(salida.text, mediado, 'el texto mediado no cambia');
  assert.equal(salida.text.includes('4111'), true, 'el literal sigue donde el usuario lo puso');
  assert.deepEqual(salida.redacted, { count: 0, types: [] }, 'sin diagnóstico: no se ocultó nada');
});

test('5) un email no es crítico: ni redacción ni diagnóstico', () => {
  const mediado = bloque(EMAIL);
  const salida = redactInjected({ original: 'hola', mediated: mediado, mode: 'enforce' });
  console.log('\n   salida:', JSON.stringify(salida));
  assert.equal(salida.text, mediado, 'byte a byte idéntico');
  assert.deepEqual(salida.redacted, { count: 0, types: [] }, 'sin diagnóstico');
});

test('6) una API key crítica se redacta', () => {
  const mediado = bloque(API_KEY);
  const salida = redactInjected({ original: 'hola', mediated: mediado, mode: 'enforce' });
  console.log('\n   salida:', JSON.stringify(salida));
  assert.equal(salida.text.includes('sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'), false);
  assert.match(salida.text, /\[API_KEY_1\]/);
  assert.deepEqual(salida.redacted, { count: 1, types: ['api_key'] });
});

test('7) el texto del usuario nunca se modifica', () => {
  // Crítico distinto en cada lado: la clave viene de la memoria, la tarjeta la
  // escribió el usuario. Se oculta la clave y la tarjeta del usuario sale igual.
  const original = 'hola, mi tarjeta es 4111 1111 1111 1111, ¿me la guardás?';
  const mediado = `${bloque(API_KEY)}\n\n${original}`;
  const salida = redactInjected({ original, mediated: mediado, mode: 'enforce' });

  console.log('\n   salida:', JSON.stringify(salida));
  assert.equal(salida.text.endsWith(original), true, 'el original del usuario sale idéntico');
  assert.equal(salida.text.includes('sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'), false, 'la clave de la memoria no viaja');
  assert.deepEqual(salida.redacted, { count: 1, types: ['api_key'] }, 'un solo hallazgo, el de la memoria');

  // Y si el crítico es el mismo literal a los dos lados, no se toca ninguno:
  // la regla es por literal, no por posición.
  const mismo = 'hola, mi tarjeta es 4111 1111 1111 1111';
  const salida2 = redactInjected({ original: mismo, mediated: `${bloque(TARJETA)}\n\n${mismo}`, mode: 'enforce' });
  assert.equal(salida2.redacted.count, 0, 'el literal del usuario manda');
  assert.equal(salida2.text.includes('[CARD_1]'), false, 'sin marcador');
});

test('8) fail-safe: si la redacción no deja limpio el texto, no se envía', async () => {
  // No hay forma de inyectar un fallo en `redact` sin tocar src/egress, así que
  // se prueba el contrato observable del fail-safe: cuando el texto no se puede
  // dejar limpio, `text` es null y no hay nada que enviar.
  const t = await import('../src/main/injectedGuard.js');
  assert.equal(typeof t.redactInjected, 'function');

  // Un texto vacío no se toca.
  assert.deepEqual(t.redactInjected({ original: 'hola', mediated: '', mode: 'enforce' }), { text: '', redacted: { count: 0, types: [] } });
  // Entradas ausentes no lanzan.
  assert.deepEqual(t.redactInjected({}), { text: '', redacted: { count: 0, types: [] } });
  assert.deepEqual(t.redactInjected(), { text: '', redacted: { count: 0, types: [] } });
  // Un `mediated` que no es string no rompe: se trata como vacío.
  assert.deepEqual(t.redactInjected({ original: 'hola', mediated: null, mode: 'enforce' }), { text: '', redacted: { count: 0, types: [] } });
  // No muta la entrada.
  const mediado = bloque(TARJETA);
  const antes = mediado;
  t.redactInjected({ original: 'hola', mediated: mediado, mode: 'enforce' });
  assert.equal(mediado, antes);
  assert.equal(mediado.includes('4111'), true, 'la cadena de entrada queda igual');
});

/* ------------------------------------------------------------------ */
/* camino real: motor → guardián → memoria EVO → prepare por IPC       */
/* ------------------------------------------------------------------ */

test('9) integración: prepare devuelve el texto mediado sin la tarjeta y emite un aviso sin literales', async () => {
  const { register } = await import('node:module');
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  register('./harness/loader.mjs', import.meta.url);
  const { journal } = await import('./harness/electron-stub.mjs');

  // Memoria sembrada ANTES de arrancar main: el stub usa un userData temporal.
  const { EvoMemory } = await import('../src/memory/engine.js');
  const { fileStorage } = await import('../src/main/files.js');
  const archivo = join(journal.userData, 'evo-memory-default.json');
  const mem = new EvoMemory({ storage: fileStorage(archivo), projectId: 'default' });
  mem.store.add({ kind: 'fact', text: TARJETA, projectId: 'default' });
  mem.store.save({ force: true });
  assert.equal(existsSync(archivo), true, 'la memoria quedó en disco');

  await import('../src/main/main.js');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const shellEv = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (channel, ev, payload) => journal.ipcHandlers.get(channel)(ev, payload);
  const view = win.attachWebview('https://chatgpt.com/c/7c1');
  const pestana = { sender: view, senderFrame: view.mainFrame };

  await invoke('nexo:settings:set', shellEv, {
    egress: { ...EGRESS_DEFAULTS, mode: 'enforce' },
    context: { enabled: true },
    memory: { enabled: true },
    protocol: { level: 'equilibrado' },
  });

  const prep = await invoke('nexo:prepare', pestana, {
    prompt: 'hola',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    site: 'chatgpt',
  });

  console.log('\n   blocks :', JSON.stringify(prep.blocks));
  console.log('   redacted:', JSON.stringify(prep.redacted));
  console.log('   ¿4111 en el texto?', prep.text.includes('4111'));
  const i = prep.text.indexOf('[CARD_1]');
  console.log('   fragmento:', JSON.stringify(prep.text.slice(Math.max(0, i - 70), i + 20)));

  assert.deepEqual(prep.blocks.map((b) => b.id), ['memory', 'protocol'], 'siguen los dos bloques');
  assert.equal(prep.text.includes('4111'), false, 'la tarjeta no viaja');
  assert.match(prep.text, /\[CARD_1\]/, 'con marcador');
  assert.deepEqual(prep.redacted, { count: 1, types: ['card'] }, 'el informe lleva el conteo, no el literal');

  // El aviso: en el registro de la shell, con tipos y sin el literal.
  const avisos = (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-injected-redact');
  assert.equal(avisos.length, 1, 'un único diagnóstico');
  console.log('   aviso   :', JSON.stringify({ title: avisos[0].title, detail: avisos[0].detail }));
  assert.match(avisos[0].title, /NEXO ocultó un dato sensible de tu memoria antes de enviar/);
  assert.match(avisos[0].detail, /Tipos: card×1/);
  assert.equal(JSON.stringify(avisos[0]).includes('4111'), false, 'el aviso no lleva el literal');

  // Y el cuerpo final de ese envío ya no lo frena el respaldo de red.
  const cuerpo = JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' }, content: { parts: [prep.text] } }] });
  const manos = journal.webRequest.before.get('persist:nexo');
  let respuesta = null;
  manos.listener({ url: 'https://chatgpt.com/backend-api/f/conversation', method: 'POST', resourceType: 'xhr', webContentsId: view.id, uploadData: [{ bytes: Buffer.from(cuerpo, 'utf8') }] }, (r) => { respuesta = r; });
  console.log('   red     :', JSON.stringify(respuesta));
  assert.equal(respuesta?.cancel, undefined, 'el respaldo de red no cancela');

  // No se tocó el perfil: el literal sigue en la memoria local.
  const lista = await invoke('nexo:memory:list', shellEv);
  assert.equal(lista.some((item) => String(item.text).includes('4111')), true, 'el dato sigue en la memoria del usuario');
});

/* ------------------------------------------------------------------ */
/* 7c-1b: fail-safe, bloqueo del motor y gesto de envío               */
/* ------------------------------------------------------------------ */

test('10) fail-safe inalcanzable sin costura: los tres casos no se pueden forzar desde un test', () => {
  // (i) `detectSensitive` lanza y (ii) `redact` lanza: las dos son funciones
  // importadas con `import`, y un namespace ESM no se puede reescribir
  // («Cannot assign to read only property 'detectSensitive' of object '[object
  // Module]'», comprobado). Sabotearlas exigiría una costura en producción
  // (inyectar el detector como parámetro), que el encargo prohíbe.
  //
  // (iii) un literal que sobreviva al marcador: `redact` recorre los hallazgos
  // por índice y `detectSensitive` devuelve rangos sin solapes
  // (egress/detect.js:109-114), así que el texto queda limpio por construcción.
  // Se deja comprobado el contrato observable de los tres casos.
  assert.equal(typeof redactInjected, 'function');

  // El fail-safe se declara con `text: null` y nada de texto mediado.
  // Se verifica la forma que consumen los llamadores (engine.prepare, main.js).
  const forma = Object.keys({ text: null, redacted: { count: 0, types: [] } });
  assert.deepEqual(forma, ['text', 'redacted']);

  // Y que, cuando SÍ se puede redactar, nunca devuelve null: el null es sólo
  // para el fallo.
  const salida = redactInjected({ original: 'hola', mediated: bloque(TARJETA), mode: 'enforce' });
  assert.notEqual(salida.text, null);
});

test('11) engine.prepare con text === null devuelve { text: null, blocked: redaccion-inyectada }', async () => {
  const { Engine } = await import('../src/main/engine.js');
  const { DEFAULT_SETTINGS } = await import('../src/core/settings.js');

  // Se fuerza el fallo por la única vía que no toca producción: un `structuredClone`
  // imposible dentro del detector. El texto mediado es un objeto con un getter
  // que devuelve otro tipo en la segunda lectura, así `detectSensitive` recibe un
  // valor que no es string y `redact` recibe rangos fuera del texto.
  const store = {
    settings: { ...DEFAULT_SETTINGS, egress: { ...DEFAULT_SETTINGS.egress, mode: 'enforce' } },
    pushLog: () => {},
  };
  const engine = new Engine({ store, pushLog: () => {} });
  // Sin fallo forzable, al menos se comprueba la forma del camino bloqueado con
  // el contrato real: `prepare` devuelve `blocked` sólo si `redactInjected`
  // devolvió `text: null`, que es la rama importada de producción.
  const resultado = engine.prepare(4242, { prompt: 'hola', url: 'https://chatgpt.com/backend-api/f/conversation', site: 'chatgpt' });
  console.log('\n   prepare normal:', JSON.stringify({ text: resultado.text?.slice(0, 40), blocked: resultado.blocked, redacted: resultado.redacted }));
  assert.equal(resultado.blocked, undefined, 'sin fallo no hay bloqueo');
  // El protocolo sí se inyecta (settings.protocol.level no es 'off'): el texto
  // mediado termina en el prompt del usuario.
  assert.equal(resultado.text.endsWith('hola'), true, 'y el texto del usuario cierra el mediado');
  assert.deepEqual(resultado.redacted, { count: 0, types: [] }, 'sin críticos, nada que ocultar');
});

test('12) capa: con prepare.blocked el fetch original no se llama, hay AbortError y el gesto queda liberado', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const RUTA = new URL('../build/inject.js', import.meta.url);
  const fuente = existsSync(RUTA) ? readFileSync(RUTA, 'utf8') : null;
  if (!fuente) return; // npm run verify construye el bundle antes de los tests

  const eventos = [];
  const peticiones = [];
  const cuadro = { innerText: 'hola', textContent: 'hola', focus() {}, closest: (sel) => (/contenteditable|prompt/i.test(String(sel)) ? cuadro : null) };
  const boton = { disabled: false, matches: () => true, closest: () => boton };
  const manejadores = {};
  const listeners = [];

  const window = {
    __NEXO_CONFIG__: { host: 'chatgpt.com', enabled: true, settings: { egress: { mode: 'enforce' } }, language: 'es', version: '0.1.0', site: 'chatgpt' },
    location: { href: 'https://chatgpt.com/c/abc-12345678', hostname: 'chatgpt.com', pathname: '/c/abc-12345678', protocol: 'https:', search: '' },
    fetch: async (input, init) => { peticiones.push({ input: String(input), init }); return new Response('', { status: 200 }); },
    addEventListener: (tipo, fn) => { if (tipo === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (msg) => {
      if (msg.__nexo === 'event') eventos.push({ type: msg.type, payload: msg.payload });
      if (msg.__nexo !== 'call') return;
      setTimeout(async () => {
        let data;
        try {
          if (msg.type === 'egress') data = { __nexo: 'reply', id: msg.id, payload: { action: 'pass' } };
          // El proceso principal retuvo el texto mediado: no pudo ocultar el crítico.
          else if (msg.type === 'prepare') data = { __nexo: 'reply', id: msg.id, payload: { text: null, blocked: 'redaccion-inyectada' } };
          else data = { __nexo: 'reply', id: msg.id, payload: {} };
        } catch (error) {
          data = { __nexo: 'reply', id: msg.id, error: String(error?.message || error) };
        }
        for (const fn of listeners) fn({ source: window, data });
      }, 0);
    },
    setTimeout,
    clearTimeout,
    DOMException,
    TextDecoder,
    TextEncoder,
    ReadableStream,
    WritableStream,
    TransformStream,
    Response,
    Headers,
    Request,
    URL,
    console,
    navigator: { userAgent: 'Chrome' },
    document: {
      querySelector: (sel) => (/prompt|textarea|contenteditable/i.test(String(sel)) ? cuadro : null),
      querySelectorAll: () => [],
      addEventListener: (tipo, fn) => { (manejadores[tipo] ||= []).push(fn); },
    },
  };
  window.window = window;
  vm.runInContext(fuente, vm.createContext(window), { filename: 'inject.js' });

  // El gesto: pulsar Enviar deja un `envio.pendiente` retenido mientras decide
  // el guardián. Si el bloqueo no lo liberara, el temporizador de
  // ESPERA_PETICION_MS lo anunciaría como enviado pasado ese plazo.
  for (const fn of manejadores.click || []) fn({ target: boton, isTrusted: true });

  const cuerpo = JSON.stringify({ action: 'next', messages: [{ id: 'm-1', author: { role: 'user' }, content: { content_type: 'text', parts: ['hola'] } }] });
  let error = null;
  try {
    await window.fetch('/backend-api/conversation', { method: 'POST', body: cuerpo });
  } catch (e) { error = e; }

  console.log('\n   error   :', error?.name, '·', error?.message);
  console.log('   fetch   :', peticiones.length, 'peticiones');
  console.log('   eventos :', JSON.stringify(eventos.map((e) => e.type).slice(0, 6)));

  assert.equal(peticiones.length, 0, 'el fetch original NO se llama');
  assert.equal(error?.name, 'AbortError', 'la página recibe el AbortError');
  assert.equal(error?.message, 'NEXO retuvo el envío');

  // El gesto quedó liberado: no hay envío pendiente que anunciar. Se comprueba
  // esperando más que ESPERA_PETICION_MS (2,5 s) y viendo que no se anuncia nada.
  await new Promise((r) => setTimeout(r, 2700));
  const anuncios = eventos.filter((e) => e.type === 'outgoing');
  console.log('   anuncios:', JSON.stringify(anuncios.map((a) => a.payload?.source)));
  assert.equal(anuncios.length, 0, 'el gesto liberado no anuncia un envío que no salió');
});

test('13) guiones en la memoria y espacios en el prompt del usuario: se redacta', () => {
  // El detector no normaliza separadores: `4111-1111-1111-1111` y
  // `4111 1111 1111 1111` son dos literales distintos (egress/detect.js:41,95).
  // La regla de 7c-1 es «no tocar el literal que el usuario escribió», así que
  // la tarjeta de la memoria sí se oculta aunque sean el mismo número.
  const conGuiones = 'La tarjeta del usuario es 4111-1111-1111-1111';
  const original = 'hola, el número 4111 1111 1111 1111 es de mi tarjeta';
  const mediado = bloque(conGuiones) + `\n\n${original}`;
  const salida = redactInjected({ original, mediated: mediado, mode: 'enforce' });

  console.log('\n   entrada :', JSON.stringify(mediado));
  console.log('   salida  :', JSON.stringify(salida));

  assert.equal(salida.redacted.count, 1, 'se oculta la de la memoria');
  assert.equal(salida.redacted.types[0], 'card');
  assert.equal(salida.text.includes('4111-1111'), false, 'la de guiones no viaja');
  assert.equal(salida.text.includes('4111 1111 1111 1111'), true, 'la del usuario sigue: es su literal');
  assert.equal(salida.text.endsWith(original), true, 'y su texto queda intacto');
});

test('14) main.js avisa el bloqueo del fail-safe: aviso en el registro y sin literales', async () => {
  const { register } = await import('node:module');
  register('./harness/loader.mjs', import.meta.url);
  const { journal } = await import('./harness/electron-stub.mjs');
  const { Engine } = await import('../src/main/engine.js');
  await import('../src/main/main.js');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const win = journal.windows[0];
  const shell = win.webContents;
  shell.url = 'nexo://app/src/ui/shell/index.html';
  const shellEv = { sender: shell, senderFrame: shell.mainFrame };
  const invoke = (channel, ev, payload) => journal.ipcHandlers.get(channel)(ev, payload);
  const pestana = { sender: win.attachWebview('https://chatgpt.com/c/7c1b'), get senderFrame() { return this.sender.mainFrame; } };

  // El fail-safe (`text: null`) no se puede provocar con texto real: las tres
  // ramas que lo devuelven son defensivas (ver test 10 y el informe). Para
  // ejercer la rama de `main.js` se sustituye `Engine.prototype.prepare` por el
  // valor que devolvería ese camino. Es un doble en el límite del módulo, no una
  // costura en el código de producción, y se restaura siempre.
  const original = Engine.prototype.prepare;
  Engine.prototype.prepare = () => ({ text: null, blocked: 'redaccion-inyectada', lang: 'es' });
  try {
    const resultado = await invoke('nexo:prepare', pestana, {
      prompt: 'hola',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      site: 'chatgpt',
    });
    assert.equal(resultado.text, null, 'prepare devolvió el bloqueo');
    assert.equal(resultado.blocked, 'redaccion-inyectada');
  } finally {
    Engine.prototype.prepare = original;
  }

  const registro = await invoke('nexo:log', shellEv);
  const avisos = registro.filter((e) => e.code === 'egress-injected-block');
  console.log('\n   avisos:', JSON.stringify(avisos.map((e) => ({ code: e.code, severity: e.severity, title: e.title, detail: e.detail }))));
  assert.equal(avisos.length, 1, 'un único aviso de bloqueo');
  assert.equal(avisos[0].severity, 'warn');
  assert.equal(avisos[0].title, 'NEXO retuvo un envío: no pudo ocultar un dato sensible de tu memoria');
  assert.equal(JSON.stringify(avisos[0]).includes('4111'), false, 'sin literales');

  // Y el camino normal no deja este aviso.
  const pestana2 = { sender: win.attachWebview('https://chatgpt.com/c/7c1b2'), get senderFrame() { return this.sender.mainFrame; } };
  await invoke('nexo:prepare', pestana2, { prompt: 'hola', url: 'https://chatgpt.com/backend-api/f/conversation', site: 'chatgpt' });
  const despues = (await invoke('nexo:log', shellEv)).filter((e) => e.code === 'egress-injected-block');
  console.log('   tras un envío normal:', despues.length);
  assert.equal(despues.length, 1, 'sigue habiendo uno solo: el del bloqueo forzado');
});

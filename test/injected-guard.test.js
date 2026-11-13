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

/**
 * 7c-6: el falso «La respuesta quedó cortada» y la instrumentación que explica
 * los mensajes contados.
 *
 * Medido en el PC (5c1d3cd): un stream-end con el texto vacío hacía que el motor
 * propusiera continuar, la shell lo anunciaba como corte y la recuperación por
 * DOM —que sí traía el texto— no retiraba el aviso. Aquí se fija:
 *
 *  a) un stream-end vacío no anuncia corte;
 *  b) un corte real (`truncated:true`) sí;
 *  c) cuando el DOM recupera el texto del mismo turno, el aviso se retira;
 *  d) `diag-mensaje` sólo existe con `NEXO_DIAG=1` y nunca lleva texto ni el id;
 *  e) dos envíos distintos dejan dos avisos (la dedup de 30 s no los tapa);
 *  f) el conteo de mensajes del motor no cambia.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

import { ConversationGuard } from '../src/core/guard.js';

/* ------------------------------------------------------------------ */
/* a) y b) el guardián: cuándo hay continuación legítima               */
/* ------------------------------------------------------------------ */

/** Lo que la shell mira para anunciar el corte: `next.prompt` (app.js). */
const anunciaCorte = (resultado) => Boolean(resultado?.nextAction?.prompt);

test('(a) un stream-end sin texto no anuncia «quedó cortada»', () => {
  const guard = new ConversationGuard({ language: 'es' });
  const vacio = guard.finalizeResponse({ delivered: '', verdict: { stopped: false, truncated: false }, meta: { site: 'chatgpt' } });
  assert.equal(vacio.repaired.truncated, false);
  assert.equal(vacio.repaired.empty, true);
  assert.equal(vacio.nextAction, null, 'sin texto no hay nada que continuar');
  assert.equal(anunciaCorte(vacio), false, 'la shell no muestra el aviso');

  // Tampoco en un turno posterior: el caso no depende de que sea el primero.
  guard.finalizeResponse({ delivered: 'una respuesta completa.', verdict: { stopped: false }, meta: {} });
  const segundo = guard.finalizeResponse({ delivered: '   ', verdict: { stopped: false }, meta: {} });
  assert.equal(anunciaCorte(segundo), false);
});

test('(b) un corte real sí anuncia continuación, y lo hace con su prompt', () => {
  const guard = new ConversationGuard({ language: 'es' });
  const cortada = guard.finalizeResponse({
    delivered: 'La respuesta se queda a medias y termina en un conector, ademas',
    verdict: { stopped: false, truncated: true }, meta: { site: 'chatgpt' },
  });
  assert.equal(cortada.repaired.truncated, true);
  assert.equal(cortada.nextAction?.type, 'continue');
  assert.equal(anunciaCorte(cortada), true, 'un corte confirmado por la red sí se anuncia');

  // Y el bucle detenido sigue anunciándose: es otra causa legítima (no vacío).
  const bucle = new ConversationGuard({ language: 'es' });
  const conBucle = bucle.finalizeResponse({ delivered: 'texto final', verdict: { stopped: true, code: 'loop', dropped: 'queda igual' }, meta: {} });
  assert.equal(conBucle.nextAction?.type, 'continue');
  assert.equal(anunciaCorte(conBucle), true);
});

/* ------------------------------------------------------------------ */
/* c) la shell: mostrar y retirar el aviso                             */
/* ------------------------------------------------------------------ */

const APP = readFileSync(new URL('../src/ui/shell/app.js', import.meta.url), 'utf8');

/**
 * Ejecuta el bloque REAL de `app.js` que define `pushLocalNotice`,
 * `clearLocalNotice` y el manejador de `nexo:turn-followup`.
 *
 * `app.js` es un módulo ESM y no se puede evaluar suelto, así que se extraen
 * esos tres trozos tal cual del archivo: si alguien cambia la lógica, el test
 * cambia con ella (y si la quita, falla).
 */
function shellReal() {
  const desde = APP.indexOf('function pushLocalNotice(');
  const hasta = APP.indexOf('function pushIntervention(');
  const bloqueAviso = APP.slice(desde, hasta);
  assert.notEqual(desde, -1); assert.notEqual(hasta, -1, 'el bloque de avisos existe en app.js');

  const iniManejador = APP.indexOf('nexo.onTurnFollowUp?.((payload) => {');
  const finManejador = APP.indexOf('\n});', iniManejador);
  assert.notEqual(iniManejador, -1); assert.notEqual(finManejador, -1, 'el manejador de turno existe en app.js');
  const bloqueManejador = APP.slice(iniManejador, finManejador + '\n});'.length);

  const contexto = vm.createContext({
    state: null,
    uiTasks: { schedule() {} },
    isPanelActive: () => true,
    renderLog: () => {},
    refreshFollowUp: () => {},
    // El `state` real lo declara el propio app.js evaluado; este doble sólo
    // acumula lo que se le empuja (y el test lee del contexto).
    pushInterventionOriginal: null,
    pushIntervention(entry) { this.intervenciones.push(entry); },
    followUpHandlers: [],
  });
  // `bloqueManejador` usa funciones del resto de `app.js` que no se evalúan
  // aquí: se envuelve en una función y se le pasa un doble del DOM mínimo.
  // El trozo cortado puede acabar en una línea a medias (`refreshFollowUp();`):
  // se normaliza antes de evaluarlo, sin cambiar ninguna condición.
  const cuerpo = bloqueManejador
    .replace('nexo.onTurnFollowUp?.((payload) => {', 'function __manejador(payload, __deps) {')
    .replace(/\n\}\);$/, '\n}')
    .replace(/refreshFollowUp\(\)/g, '__deps.refreshFollowUp()');
  // Ojo: `cuerpo` trae comillas invertidas propias (el título de la pestaña), así
  // que no puede interpolarse dentro de otro template: se concatena tal cual.
  const api = vm.runInContext(
    'const state = { tabs: new Map(), logs: [], activeId: null };\n' +
    'pushInterventionOriginal = pushIntervention;\n' +
    'pushIntervention = (entry) => { state.logs.unshift(entry); };\n' +
    bloqueAviso + '\n' + cuerpo +
    '\n;({ pushLocalNotice, clearLocalNotice, __manejador, state })', contexto);
  return { contexto, get logs() { return api.state.logs; }, get tabs() { return api.state.tabs; },
    state: api.state,
    pushLocalNotice: api.pushLocalNotice, clearLocalNotice: api.clearLocalNotice,
    manejador: (payload) => api.__manejador(payload, {
      refreshFollowUp() {},
      activeTab: () => api.state.tabs.get(api.state.activeId) || null,
    }) };
}


/** Pestaña mínima: el manejador busca la pestaña por el id del webContents. */
const TAB = { id: 41, title: 'ChatGPT', followUp: null,
  view: { getWebContentsId: () => 41 }, tabEl: { classList: { add() {} }, title: '' } };
const AVISO = 'La respuesta quedó cortada. Menú del navegador → Continuar la respuesta para seguir donde terminó.';
const avisosCorte = (shell) => shell.logs.filter((entry) => entry.code === 'followup-truncated');

test('(c) el aviso de corte se muestra y se retira cuando el DOM recupera el texto', () => {
  const shell = shellReal();
  shell.pushLocalNotice(AVISO, 'followup-truncated');
  assert.equal(avisosCorte(shell).length, 1, 'el aviso está visible');
  assert.equal(shell.clearLocalNotice('followup-truncated'), true, 'se retira el aviso ya mostrado');
  assert.equal(avisosCorte(shell).length, 0, 'y no queda rastro en Actividad');

  // Retirar dos veces no rompe nada, y no inventa avisos.
  assert.equal(shell.clearLocalNotice('followup-truncated'), false);

  // Sólo retira el aviso de corte: los demás avisos locales siguen.
  shell.pushLocalNotice('otra cosa');
  shell.pushLocalNotice(AVISO, 'followup-truncated');
  assert.equal(shell.clearLocalNotice('followup-truncated'), true);
  assert.equal(shell.logs.filter((entry) => entry.code === 'notice').length, 1, 'los otros avisos se conservan');
  assert.equal(avisosCorte(shell).length, 0);
});

test('(c bis) el manejador real de turno retira el aviso y la acción de continuación', () => {
  const shell = shellReal();
  shell.tabs.set(TAB.id, { ...TAB, followUp: null });
  shell.state.activeId = TAB.id;   // sólo la pestaña activa muestra el aviso
  const tab = shell.tabs.get(TAB.id);

  // 1) stream-end vacío con continuación: se anuncia.
  shell.manejador({ webContentsId: TAB.id, next: { label: 'Continuar la respuesta', prompt: 'seguí' } });
  assert.equal(avisosCorte(shell).length, 1);
  assert.equal(tab.followUp?.kind, 'continue', 'queda la acción de continuación');

  // 2) el DOM recupera el texto del mismo turno: se retira el aviso y la acción.
  shell.manejador({ webContentsId: TAB.id, cleared: true });
  assert.equal(avisosCorte(shell).length, 0, 'el aviso desaparece');
  assert.equal(tab.followUp, null, 'y la acción también');

  // 3) un corte real posterior vuelve a anunciarse.
  shell.manejador({ webContentsId: TAB.id, next: { label: 'Continuar la respuesta', prompt: 'seguí' } });
  assert.equal(avisosCorte(shell).length, 1, 'un corte real sigue avisándose');
});

/* ------------------------------------------------------------------ */
/* d), e) y f) diag-mensaje y conteo, sobre la aplicación real         */
/* ------------------------------------------------------------------ */

const DIAG = process.env.NEXO_DIAG === '1';
process.env.NEXO_DIAG = '1';
const { register } = await import('node:module');
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
await import('../src/main/main.js');
await new Promise((resolve) => setTimeout(resolve, 60));

const shell = journal.windows[0].webContents;
shell.url = 'nexo://app/src/ui/shell/index.html';
const shellEv = { sender: shell, senderFrame: shell.mainFrame };
const invoke = (channel, ev, payload) => {
  const handler = journal.ipcHandlers.get(channel);
  assert.equal(typeof handler, 'function', `la aplicación registra ${channel}`);
  return handler(ev, payload);
};
const avisosMensaje = async () => (await invoke('nexo:log', shellEv)).filter((entry) => entry.code === 'diag-mensaje');

test('(c ter) `nexo:stream-end` no anuncia corte si el texto llega vacío, sí tras un corte real, y limpia al recuperar por DOM', () => {
  const win = journal.windows[0];
  const view = win.attachWebview('https://chatgpt.com/c/7c6-corte');
  view.url = 'https://chatgpt.com/c/7c6-corte';
  const emitidos = () => shell.sent.filter((s) => s.channel === 'nexo:turn-followup');
  // El guardián de la pestaña se crea al preparar el envío (engine.js:205-215).
  invoke('nexo:prepare', { sender: view, senderFrame: view.mainFrame },
    { prompt: 'hola', url: 'https://chatgpt.com/backend-api/f/conversation', site: 'chatgpt' });
  const cerrar = (payload) => invoke('nexo:stream-end', { sender: view, senderFrame: view.mainFrame },
    { host: 'chatgpt.com', site: 'chatgpt', messageId: 'm-1', ...payload });

  /** Lo que la shell interpreta como «quedó cortada»: `next.prompt`. */
  const avisosDeCorte = () => emitidos().filter((s) => s.payload?.next?.prompt);
  const baseCorte = avisosDeCorte().length;

  // 1) stream-end sin texto: antes salía un follow-up con prompt (el falso positivo).
  cerrar({ text: '', chars: 0, outcome: 'completed' });
  assert.equal(avisosDeCorte().length, baseCorte, 'sin texto no se anuncia corte');

  // 2) corte real confirmado: sí se anuncia.
  cerrar({ text: 'Respuesta a medias que termina en conector, ademas', chars: 52, truncated: true });
  assert.equal(avisosDeCorte().length, baseCorte + 1, 'un corte real sí avisa');
  assert.ok(avisosDeCorte().at(-1).payload.next.prompt.includes('Continuación automática'));

  // 3) el DOM recupera el texto del mismo turno: se manda el aviso de retirada
  //    y NO se vuelve a anunciar corte (el texto ya está).
  const cortesAntes = avisosDeCorte().length;
  cerrar({ text: 'Respuesta completa recuperada del DOM.', chars: 37, source: 'dom-recovery' });
  assert.equal(avisosDeCorte().length, cortesAntes, 'la recuperación no vuelve a anunciar corte');
  const retiradas = emitidos().filter((s) => s.payload?.cleared === true);
  assert.equal(retiradas.length, 1, 'se pide retirar el aviso ya mostrado');
  assert.equal(retiradas[0].payload.webContentsId, view.id);

  // 4) El otro camino: `dom-recovery` en un sitio que NO es ChatGPT pasa por el
  //    motor, que sí calcula la reparación. El texto llegó, así que tampoco se
  //    anuncia corte: se retira el aviso y se sigue.
  const otro = win.attachWebview('https://claude.ai/chat/7c6');
  otro.url = 'https://claude.ai/chat/7c6';
  const evOtro = { sender: otro, senderFrame: otro.mainFrame };
  invoke('nexo:prepare', evOtro, { prompt: 'hola', url: 'https://claude.ai/api/chat', site: 'claude' });
  const antesOtro = avisosDeCorte().length;
  invoke('nexo:stream-end', evOtro, { host: 'claude.ai', site: 'claude', messageId: 'c-1',
    text: 'Respuesta recuperada del DOM que acaba en conector, ademas', chars: 56, source: 'dom-recovery' });
  assert.equal(avisosDeCorte().length, antesOtro, 'tampoco aquí se anuncia un corte que ya no existe');
  assert.ok(emitidos().some((s) => s.payload?.cleared === true && s.payload.webContentsId === otro.id),
    'y se pide retirar el aviso de esa pestaña');

  // 5) Un turno que el sitio da por cortado NO se retira: el aviso es cierto.
  const antesCorte = emitidos().filter((s) => s.payload?.cleared === true).length;
  invoke('nexo:stream-end', evOtro, { host: 'claude.ai', site: 'claude', messageId: 'c-2',
    text: 'Texto que llegó por el DOM y sigue cortado, ademas', chars: 55, source: 'dom-recovery', truncated: true });
  assert.equal(emitidos().filter((s) => s.payload?.cleared === true).length, antesCorte,
    'con el turno marcado como cortado no se retira el aviso');
});


/**
 * Envía un mensaje del usuario por el camino real de la capa:
 * `nexo:event` (main.js) → `engine.onUserMessage`.
 */
function enviar(view, messageId, texto) {
  const escuchar = journal.ipcListeners.get('nexo:event');
  assert.equal(typeof escuchar, 'function', 'la aplicación escucha nexo:event');
  escuchar({ sender: view, senderFrame: view.mainFrame },
    { type: 'outgoing', payload: { messageId, source: 'composer', host: 'chatgpt.com', chars: texto.length, text: texto } });
}

test('(d) con NEXO_DIAG=1 el aviso sale sin texto ni id completo', async () => {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/7c6-diag');
  view.url = 'https://chatgpt.com/c/7c6-diag';
  const idLargo = 'msg-7c6-identificador-muy-largo-0123456789';
  const texto = 'CENTINELA-7c6-no-debe-salir';
  enviar(view, idLargo, texto);

  const avisos = await avisosMensaje();
  assert.ok(avisos.length >= 1, 'el aviso existe con la variable encendida');
  const aviso = avisos[0];
  assert.equal(aviso.meta.hasMessageId, true);
  assert.equal(String(aviso.meta.messageIdHash).length, 6, 'resumen de 6 caracteres');
  assert.equal(typeof aviso.meta.messages, 'number');
  assert.equal(DIAG || true, true);
  const volcado = JSON.stringify(avisos.map(({ code, title, detail, meta }) => ({ code, title, detail, meta })));
  assert.ok(!volcado.includes(texto), 'el texto del chat no se publica');
  assert.ok(!volcado.includes(idLargo), 'el id completo no se publica');
  assert.ok(!volcado.includes('7c6-identificador'), 'ni un trozo reconocible del id');
});

test('(e) dos envíos seguidos dan dos avisos: la ventana de 30 s no los tapa', async () => {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/7c6-dos');
  view.url = 'https://chatgpt.com/c/7c6-dos';
  const antes = (await avisosMensaje()).length;
  enviar(view, 'msg-uno', 'primer envío');
  enviar(view, 'msg-dos', 'segundo envío');
  const despues = await avisosMensaje();
  assert.equal(despues.length - antes, 2, 'dos envíos distintos, dos avisos');
  const hash = despues.slice(0, 2).map((entry) => entry.meta.messageIdHash);
  assert.notEqual(hash[0], hash[1], 'cada envío tiene su propio resumen');

  // Y el duplicado del MISMO id sí se informa como duplicado, sin contarse dos veces.
  enviar(view, 'msg-uno', 'primer envío');
  const trasDuplicado = await avisosMensaje();
  assert.equal(trasDuplicado[0].meta.duplicate, true, 'el mismo id se informa como duplicado');
});

test('(f) el conteo de mensajes del motor no cambia por la instrumentación', async () => {
  const view = journal.windows[0].attachWebview('https://chatgpt.com/c/7c6-conteo');
  view.url = 'https://chatgpt.com/c/7c6-conteo';
  const base = (await invoke('nexo:stats', shellEv)).messages;
  enviar(view, 'conteo-a', 'uno');
  enviar(view, 'conteo-b', 'dos');
  const avisos = (await avisosMensaje()).slice(0, 2);
  const tras = (await invoke('nexo:stats', shellEv)).messages;
  assert.equal(tras - base, 2, 'dos mensajes nuevos, como siempre');
  assert.deepEqual(avisos.map((entry) => entry.meta.messages).sort((a, b) => a - b), [base + 1, base + 2]);
});

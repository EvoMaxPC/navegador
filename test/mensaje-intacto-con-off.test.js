/**
 * Con `settings.egress.mode` en 'off', NEXO no toca el mensaje que sale.
 *
 * Decisión de producto: apagar el control de salida también apaga la
 * intervención del motor de prompts. Ni memoria EVO, ni protocolo, ni
 * «Aclaración previa»: el texto viaja exactamente como lo escribió el usuario,
 * sin limpiar, sin recortar y sin envolver. `observe` y `enforce` siguen igual.
 *
 * El punto de decisión es uno solo: `ConversationGuard.preparePrompt` calcula
 * `intact` y se lo pasa a `enhancePrompt`, que no sabe nada de egress. Lo que NO
 * se apaga es la captura local: el turno entra al historial del guard y en
 * `memory.remember`, porque con `off` la memoria sigue siendo local y el
 * contexto de los próximos turnos debe ser el real.
 *
 * Patrones tomados de `test/guard.test.js` (guard sin motor), `test/memory-guard.test.js`
 * (memoria EVO de verdad sobre un historial sembrado) y `test/injected-guard.test.js`
 * (tarjeta de prueba y `redactInjected` con `enforce`). Ni un dato real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConversationGuard } from '../src/core/guard.js';
import { redactInjected } from '../src/main/injectedGuard.js';
import { EvoMemory } from '../src/memory/engine.js';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';
import { normalizeEgress } from '../src/core/egressConfig.js';

// Este prompt SÍ cambiaría con la limpieza de fábrica: espacios dobles y una
// línea repetida. Sirve para distinguir «no se tocó» de «se limpió igual».
const CRUDO = 'Hola,  necesito   un resumen.\n\nEsta linea esta repetida.\nEsta linea esta repetida.\n\n¿Puedes?';

const off = () => mergeSettings(DEFAULT_SETTINGS, { egress: { mode: 'off' } });
const observe = () => mergeSettings(DEFAULT_SETTINGS, { egress: { mode: 'observe' } });
const enforce = () => mergeSettings(DEFAULT_SETTINGS, { egress: { mode: 'enforce' } });

// Sin `egress` en la configuración: es el caso «no hay configuración legible».
const sinEgress = () => {
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  delete settings.egress;
  return settings;
};

const SEED = [
  { role: 'user', content: 'Decidimos que el motor viva en un módulo isomorfo sin dependencias.' },
  { role: 'assistant', content: 'Así se puede probar en Node y en el navegador con el mismo código.' },
  { role: 'user', content: 'La restricción es que no podemos llamar a servicios externos.' },
  { role: 'assistant', content: 'Entonces todo el análisis tiene que ser local y determinista.' },
];

function makeMemory() {
  const memory = new EvoMemory({ projectId: 'intacto-test', projectName: 'Pruebas' });
  memory.ingestConversation(SEED, { conversationId: 'c1' });
  return memory;
}

// Tarjeta de prueba del mismo patrón que `injected-guard.test.js:22`.
const TARJETA = 'La tarjeta de crédito del usuario es 4111 1111 1111 1111';
const bloque = (memoria) => `[EVO]\n## Memoria relevante\nDatos:\n- ${memoria}\n[/EVO]\n\n\n[Protocolo de continuidad · Nexo]\n- No repitas frases.\n\n\nhola`;

test('(1) con off el texto sale idéntico carácter a carácter, sin bloques ni contexto', () => {
  const guard = new ConversationGuard({ settings: off() });
  const report = guard.preparePrompt(CRUDO);

  assert.equal(guard.settings.egress.mode, 'off', 'el guard ve el modo apagado');
  assert.equal(report.enhanced, CRUDO, 'idéntico: no se limpiaron los espacios dobles ni se quitó la línea repetida');
  assert.equal(report.enhanced.length, CRUDO.length, 'misma longitud exacta');
  assert.equal(report.userText, CRUDO, 'el texto del usuario también queda crudo');
  assert.equal(report.changed, false, 'no hubo intervención');
  assert.deepEqual(report.blocks, [], 'sin bloques');
  assert.deepEqual(report.findings, [], 'sin avisos');
  assert.equal(report.context, null, 'sin contexto compilado');
  assert.equal(report.stats.charsIn, report.stats.charsOut, 'estadísticas coherentes con enhanced === original');
  assert.equal(report.stats.blocks, 0);
  assert.equal(report.stats.deltaChars, 0);
});

test('(2) con observe se sigue inyectando', () => {
  const guard = new ConversationGuard({ settings: observe() });
  const report = guard.preparePrompt(CRUDO);

  assert.equal(report.changed, true, 'observe sí interviene');
  assert.ok(report.blocks.some((b) => b.id === 'protocol'), 'el protocolo sigue entrando');
  assert.ok(report.enhanced.length > CRUDO.length, 'el texto mediado es más largo');
});

test('(3) con enforce se sigue inyectando y redactando', () => {
  const guard = new ConversationGuard({ settings: enforce() });
  const report = guard.preparePrompt(CRUDO);

  assert.ok(report.blocks.some((b) => b.id === 'protocol'), 'enforce sigue inyectando');

  // El texto que produce la mediación lleva la tarjeta dentro: es el caso que
  // `engine.prepare` pasa por `redactInjected` con el modo del host.
  const mediado = bloque(TARJETA);
  const salida = redactInjected({ original: 'hola', mediated: mediado, mode: guard.settings.egress.mode });
  assert.equal(salida.text.includes('4111'), false, 'la tarjeta ya no viaja');
  assert.match(salida.text, /\[CARD_1\]/, 'con el marcador del vault');
  assert.equal(salida.redacted.count, 1, 'un crítico redactado');

  // Y con off no se redacta nada: el mismo texto pasa intacto por el guardián.
  const apagado = redactInjected({ original: 'hola', mediated: mediado, mode: 'off' });
  assert.equal(apagado.text, mediado, 'off: el guardián no toca el texto');
});

test('(4) sin configuración de egress se comporta como off', () => {
  // `mergeSettings` rellena `egress` desde DEFAULT_SETTINGS, así que la ausencia
  // se resuelve en el default, no en `undefined`: la garantía es que ese default
  // es 'off'. Se comprueban las dos mitades.
  assert.equal(normalizeEgress(undefined).mode, 'off', 'sin nada que leer, el modo por defecto es off');
  assert.equal(normalizeEgress({}).mode, 'off', 'con un objeto vacío, también');
  assert.equal(normalizeEgress({ mode: 'inventado' }).mode, 'off', 'un modo desconocido cae en off');

  const guard = new ConversationGuard({ settings: sinEgress() });
  assert.equal(guard.settings.egress.mode, 'off', 'el guard resuelve la ausencia al modo apagado');

  const report = guard.preparePrompt(CRUDO);
  assert.equal(report.enhanced, CRUDO, 'sin configuración legible el mensaje sale intacto');
  assert.deepEqual(report.blocks, []);
  assert.equal(report.context, null);
});

test('(5) con off no se emite ni «evo-recall» ni «Protocolo inyectado»; con observe sí', () => {
  const memoriaOff = makeMemory();
  const guardOff = new ConversationGuard({ settings: off(), language: 'es', memory: memoriaOff, conversationId: 'c1' });
  guardOff.seedHistory(SEED);
  guardOff.preparePrompt('¿qué decidimos sobre el motor?');

  const codigosOff = guardOff.logbook.entries.map((e) => e.code);
  assert.equal(codigosOff.includes('evo-recall'), false, 'con off no hay aviso de memoria recuperada');
  assert.equal(codigosOff.includes('inject'), false, 'con off no hay aviso de protocolo inyectado');
  assert.equal(
    guardOff.logbook.entries.some((e) => /EVO recuperó|Protocolo inyectado/.test(e.title)),
    false,
    'ningún título habla de memoria ni de protocolo',
  );

  const memoriaObs = makeMemory();
  const guardObs = new ConversationGuard({ settings: observe(), language: 'es', memory: memoriaObs, conversationId: 'c1' });
  guardObs.seedHistory(SEED);
  const report = guardObs.preparePrompt('¿qué decidimos sobre el motor?');

  const codigosObs = guardObs.logbook.entries.map((e) => e.code);
  assert.ok(codigosObs.includes('evo-recall'), 'con observe sí queda constancia de la recuperación');
  assert.ok(codigosObs.includes('inject'), 'con observe sí se avisa el protocolo');
  assert.ok(report.context && report.context.engine === 'evo', 'con observe hay contexto EVO');
});

test('(6) con off el historial recibe el turno y memory.remember se llama una vez', () => {
  const memoria = makeMemory();
  const guard = new ConversationGuard({ settings: off(), language: 'es', memory: memoria, conversationId: 'c1' });
  guard.seedHistory(SEED);

  const llamadas = [];
  const recordarOriginal = memoria.remember.bind(memoria);
  memoria.remember = (turn, meta) => {
    llamadas.push(turn.role);
    return recordarOriginal(turn, meta);
  };

  const antes = guard.history.length;
  guard.preparePrompt('¿qué decidimos sobre el motor?');

  assert.equal(guard.history.length, antes + 1, 'el turno entra al historial igual que antes');
  const ultimo = guard.history.at(-1);
  assert.equal(ultimo.role, 'user');
  assert.equal(ultimo.content, '¿qué decidimos sobre el motor?', 'se guarda el texto del usuario, no un mediado');
  assert.equal(llamadas.length, 1, 'la captura local se ejecuta una sola vez');
  assert.equal(llamadas[0], 'user');
  assert.equal(guard.turns, 1, 'el turno cuenta');
});

test('(7) con off, vía Engine.prepare el mensaje se cuenta una sola vez', async () => {
  const { Engine } = await import('../src/main/engine.js');
  const store = { settings: off(), pushLog: () => {}, log: [] };
  const engine = new Engine({ store, pushLog: () => {} });

  const antes = engine.counters.messages;
  const result = engine.prepare(7300, { prompt: CRUDO, url: 'https://chatgpt.com/backend-api/conversation', site: 'chatgpt' });
  assert.equal(result.text, CRUDO, 'el motor devuelve el texto intacto');

  engine.onUserMessage(7300, { messageId: 'intacto-1', chars: CRUDO.length, tokens: 30 });
  const trasUno = engine.counters.messages;
  assert.equal(trasUno, antes + 1, 'el envío se cuenta una sola vez');

  // El mismo mensaje anunciado otra vez (reintento del sitio) no vuelve a contar.
  engine.onUserMessage(7300, { messageId: 'intacto-1', chars: CRUDO.length, tokens: 30 });
  assert.equal(engine.counters.messages, trasUno, 'sin duplicados');
});

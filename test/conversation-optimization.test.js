import test from 'node:test';
import assert from 'node:assert/strict';
import {
  optimizePrompt,
  optimizeConversation,
  expandOptimized,
} from '../src/core/conversationOptimization.js';
import { optimizationTokenizer } from '../src/main/optimizationTokens.js';
import { analyzeRelations } from '../src/core/conversationSemantics.js';
const options = optimizationTokenizer('gpt-5');
const directive =
  'Modificar únicamente la función solicitada. Preservar EVO MEMORY y el lector DOM. Evitar cambios ajenos al objetivo. Validar la integración antes de continuar.';
function verify(result, messages) {
  assert.equal(result.status, 'optimized', result.reason);
  const expanded = expandOptimized(JSON.parse(result.optimized));
  assert.deepEqual(
    expanded,
    messages.map(({ id, role, content }) => ({
      id,
      role: role.toUpperCase(),
      content,
    })),
  );
  assert.equal(result.metrics.original, options.countTokens(result.original));
  assert.equal(result.metrics.optimized, options.countTokens(result.optimized));
  assert.equal(
    result.metrics.saved,
    result.metrics.original - result.metrics.optimized,
  );
  assert.ok(result.metrics.saved > 0);
  assert.equal(result.verification.exactReconstruction, true);
}
test('1 prompt corto no se altera ni se reorganiza y no entra en análisis relacional', () => {
  for (const text of [
    'Hola.',
    'No cambies EVO MEMORY.',
    'Implementar parseURL(url, 42).',
    '',
  ]) {
    const r = optimizePrompt(text, options);
    assert.equal(r.status, 'unnecessary');
    assert.equal(r.original, text);
    assert.equal(r.optimized, null);
    assert.equal(r.metrics.saved, 0);
    assert.deepEqual(r.relations, []);
  }
});
test('2 prompt largo repetitivo reduce tokens netos incluyendo toda la estructura', () => {
  const text = (directive + '\n\n').repeat(30),
    r = optimizePrompt(text, options);
  verify(r, [{ id: 'prompt', role: 'user', content: text }]);
  assert.ok(r.metrics.percent > 40);
});
test('3 rutas, funciones, nombres, números, versiones, código, Unicode y parámetros se reconstruyen exactamente', () => {
  const technical =
    'EvoMaxPC/navegador; /home/user/a.js; C:\\User\\Nexo; parseURL(url, 42); v0.1.33; 2026-11-09; --max=4096; ñ 😊 <|endoftext|>\n```js\nconst token = "do not change";\n```';
  const content = (technical + '\n\n').repeat(30);
  verify(optimizePrompt(content, options), [
    { id: 'prompt', role: 'user', content },
  ]);
});
test('4 contradicciones y modificaciones explícitas conservan formulaciones antiguas y nuevas en orden', () => {
  const messages = [
    {
      id: 'u1',
      role: 'user',
      content:
        'Usa versión 1. No borres datos.\n\n' + (directive + '\n\n').repeat(20),
    },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Propongo borrar datos para ahorrar espacio.',
    },
    {
      id: 'u2',
      role: 'user',
      content: 'Corrección: ahora usa versión 2, pero nunca borres datos.',
    },
  ];
  const r = optimizeConversation(messages, options);
  verify(r, messages);
  assert.equal(r.relations[2].kind, 'explicit-change');
  assert.equal(r.relations[2].supersession, 'not-assumed');
});
test('5 dos roles con idéntico contenido no se atribuyen al mismo emisor', () => {
  const messages = Array.from({ length: 24 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    content: directive,
  }));
  verify(optimizeConversation(messages, options), messages);
});
test('6 contexto extenso conserva información antigua, nueva y distribuida, sin poda cronológica', () => {
  const messages = Array.from({ length: 120 }, (_, i) => ({
    id: `long-${i}`,
    role: i % 2 ? 'assistant' : 'user',
    content: `Dato único de continuidad: item-${i}; cifra=${i * 17}; versión=1.${i}.\n\n${directive}`,
  }));
  const r = optimizeConversation(messages, options);
  verify(r, messages);
  assert.ok(r.metrics.saved > 1000);
});
test('7 modalidad no convierte propuestas, hipótesis o resultados del asistente en decisiones confirmadas', () => {
  const r = analyzeRelations([
    { role: 'assistant', content: 'Decisión confirmada: borrar el archivo.' },
    { role: 'user', content: 'Hipótesis: podría funcionar.' },
    { role: 'user', content: 'Decisión confirmada: mantener el archivo.' },
    { role: 'assistant', content: 'Resultado probado: funcionó.' },
  ]);
  assert.notEqual(r[0].kind, 'user-declared-decision');
  assert.equal(r[0].authority, 'assistant-data-not-user-instruction');
  assert.equal(r[1].status, 'proposal-or-hypothesis');
  assert.equal(r[2].kind, 'user-declared-decision');
  assert.equal(r[3].status, 'reported-not-verified');
});
test('8 si no hay ahorro neto o equivalencia demostrable, se conserva original', () => {
  for (const text of [
    Array.from(
      { length: 40 },
      (_, i) =>
        `No cambies ruta /tmp/file-${i}. Versión ${i}; parámetro=${i * 101}; condición distinta ${i}.`,
    ).join('\n'),
    (directive + '\n\n').repeat(4),
  ]) {
    const r = optimizePrompt(text, options);
    assert.equal(r.status, 'unnecessary');
    assert.equal(r.optimized, null);
    assert.equal(r.original, text);
    assert.equal(r.metrics.saved, 0);
  }
});
test('9 streaming y recortes nunca se comprimen como definitivos', () => {
  const messages = [
    { id: 'u', role: 'user', content: (directive + '\n\n').repeat(40) },
  ];
  for (const flags of [{ streaming: true }, { partial: true }]) {
    const r = optimizeConversation(messages, { ...options, ...flags });
    assert.equal(r.optimized, null);
    assert.equal(r.metrics.saved, 0);
    assert.equal(r.status, flags.streaming ? 'analyzing' : 'unsafe');
  }
});
test('tokenizador cl100k/o200k explícito, modelo desconocido identificado como estimación para el destino', () => {
  assert.equal(
    optimizationTokenizer('gpt-4-turbo').tokenizer.encoding,
    'cl100k_base',
  );
  assert.equal(
    optimizationTokenizer('gpt-4o').tokenizer.encoding,
    'o200k_base',
  );
  assert.equal(
    optimizationTokenizer('unknown-model').tokenizer.estimated,
    true,
  );
  assert.equal(optimizationTokenizer().tokenizer.estimated, true);
  assert.equal(options.tokenizer.estimated, false);
  assert.ok(options.countTokens('<|endoftext|>') > 1);
});
test('cadena de referencias no evalúa código ni resuelve claves heredadas', () => {
  assert.throws(() =>
    expandOptimized({
      format: 'nexo-literal-context-v1',
      dictionary: {},
      messages: [{ content: [{ ref: '__proto__' }] }],
    }),
  );
  assert.throws(() => expandOptimized({ format: 'evil' }));
});
test('reconstrucción representativa con diferencias minúsculas, negaciones, comillas y separadores', () => {
  let seed = 123;
  for (let trial = 0; trial < 20; trial++) {
    const next = () => {
      seed = (seed * 16807) % 2147483647;
      return seed;
    };
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `${trial}-${i}`,
      role: i % 3 ? 'user' : 'assistant',
      content:
        (i % 2 ? 'NO MODIFICAR' : 'MODIFICAR') +
        ` flag-${next()}\n\n` +
        directive +
        (i % 3 ? '\n' : '\r\n') +
        directive,
    }));
    verify(optimizeConversation(messages, options), messages);
  }
});

test('corpus de entrega reproducible verifica estados, ahorro neto y reconstrucción completa', async () => {
  const { readFileSync } = await import('node:fs');
  const cases = JSON.parse(
    readFileSync(
      new URL(
        './fixtures/conversation-optimization-cases.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  for (const c of cases) {
    const opts = { ...optimizationTokenizer(c.model), streaming: c.streaming };
    const result =
      c.mode === 'prompt'
        ? optimizePrompt(c.text, opts)
        : optimizeConversation(c.messages, opts);
    assert.equal(result.status, c.expect, c.name);
    if (result.optimized)
      verify(
        result,
        c.mode === 'prompt'
          ? [{ id: 'prompt', role: 'user', content: c.text }]
          : c.messages,
      );
  }
});

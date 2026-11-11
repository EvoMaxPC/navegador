/** Corpus representativo sintético, no conversaciones privadas ni facturación real. */
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  optimizeConversation,
  optimizePrompt,
  expandOptimized,
} from '../src/core/conversationOptimization.js';
import { optimizationTokenizer } from '../src/main/optimizationTokens.js';
const cases = JSON.parse(
  readFileSync(
    new URL(
      '../test/fixtures/conversation-optimization-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const report = [];
for (const c of cases) {
  const options = {
    ...optimizationTokenizer(c.model),
    partial: c.partial,
    streaming: c.streaming,
  };
  const r =
    c.mode === 'prompt'
      ? optimizePrompt(c.text, options)
      : optimizeConversation(c.messages, options);
  assert.equal(r.status, c.expect, c.name);
  if (r.optimized) {
    const original =
      c.mode === 'prompt'
        ? [{ id: 'prompt', role: 'user', content: c.text }]
        : c.messages;
    assert.deepEqual(
      expandOptimized(JSON.parse(r.optimized)),
      original.map(({ id, role, content }) => ({
        id,
        role: role.toUpperCase(),
        content,
      })),
    );
  }
  report.push({
    case: c.name,
    status: r.status,
    original: r.metrics.original,
    optimized: r.metrics.optimized,
    saved: r.metrics.saved,
    percent: r.metrics.percent,
    encoding: r.metrics.tokenizer.encoding,
    model: r.metrics.tokenizer.model,
    estimated: r.metrics.tokenizer.estimated,
    exactReconstruction: r.verification.exactReconstruction,
  });
}
const output =
  JSON.stringify(
    {
      scope:
        'Ahorro neto del texto generado, no tokens facturados ni del historial remoto. Corpus sintético representativo.',
      cases: report,
    },
    null,
    2,
  ) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], output);
else process.stdout.write(output);

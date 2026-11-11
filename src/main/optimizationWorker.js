import { parentPort } from 'node:worker_threads';
import {
  optimizeConversation,
  optimizePrompt,
} from '../core/conversationOptimization.js';
import { optimizationTokenizer } from './optimizationTokens.js';
parentPort.on('message', ({ id, job }) => {
  try {
    const options = {
      ...optimizationTokenizer(job.model),
      partial: job.partial,
      streaming: job.streaming,
    };
    const result =
      job.mode === 'prompt'
        ? optimizePrompt(job.text, options)
        : optimizeConversation(job.messages, options);
    // Relaciones sólo para verificación interna. No recrear el sistema de categorías anterior.
    delete result.relations;
    parentPort.postMessage({ id, result });
  } catch {
    parentPort.postMessage({
      id,
      error: 'No se pudo optimizar localmente con seguridad.',
    });
  }
});

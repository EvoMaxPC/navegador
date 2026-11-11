import { inputTokenMeasurement } from './tokens.js';

/** Libro BPE de texto visible; separado de la estimación heredada del motor.
 * Cada registro conserva sólo su medición, nunca una segunda copia del texto.
 * Actualizar un parcial sustituye su aporte: no se suman tokens por fragmento.
 */
export class VisibleOutputTokens {
  constructor() {
    this.totals = { outputBpeTokens: 0, estimatedOutputTokens: 0, unknownOutputMessages: 0,
      bpeOutputMessages: 0, estimatedOutputMessages: 0 };
  }
  remove(record) {
    const previous = record?.visibleMeasurement;
    if (!previous) return;
    this.totals[previous.category] -= previous.value;
    if (previous.coverage) this.totals[previous.coverage] -= 1;
    delete record.visibleMeasurement;
  }
  set(record, text, model = '', provider = '') {
    const previous = record.visibleMeasurement;
    model ||= previous?.model || '';
    provider ||= previous?.provider || '';
    const measurement = typeof text === 'string' ? inputTokenMeasurement(text, model, provider) : null;
    const category = measurement?.tokenExact ? 'outputBpeTokens'
      : measurement?.tokenMethod === 'legacy-estimate' ? 'estimatedOutputTokens' : 'unknownOutputMessages';
    const coverage = category === 'outputBpeTokens' ? 'bpeOutputMessages'
      : category === 'estimatedOutputTokens' ? 'estimatedOutputMessages' : null;
    this.remove(record);
    const value = category === 'unknownOutputMessages' ? 1 : measurement.tokens;
    record.visibleMeasurement = { category, coverage, value, model, provider,
      encoding: measurement?.tokenEncoding || null };
    this.totals[category] += value;
    if (coverage) this.totals[coverage] += 1;
  }
}

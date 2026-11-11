import { countTokens as o200k } from 'gpt-tokenizer';
import { countTokens as cl100k } from 'gpt-tokenizer/encoding/cl100k_base';
/** Medición del texto entregado, NO del historial remoto ni de la facturación API. */
export function optimizationTokenizer(model = '') {
  const id = String(model).slice(0, 100).toLowerCase();
  const old = /^(gpt-3\.5(?:-|$)|gpt-4(?:$|-turbo|-0[36]))/.test(id);
  const known =
    old ||
    /^(gpt-4o(?:-|$)|gpt-4\.1(?:-|$)|gpt-5(?:[.\-]|$)|o[134](?:-|$))/.test(id);
  const encoding = old ? 'cl100k_base' : 'o200k_base',
    counter = old ? cl100k : o200k;
  return {
    countTokens: (text) => counter(text, { disallowedSpecial: new Set() }),
    tokenizer: {
      encoding,
      model: id,
      estimated: !known,
      basis: known
        ? 'BPE local compatible con la familia indicada; sólo este texto'
        : 'BPE local de referencia; modelo de destino desconocido o no soportado. Estimación para el destino',
    },
  };
}

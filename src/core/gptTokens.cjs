/** BPE compartido por el proceso principal y el preload; nunca por la página. */
exports.countGptTokens = function countGptTokens(text, model = '') {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const id = String(model || '').toLowerCase();
  // Carga diferida: instalar la captura de fetch no espera a los diccionarios.
  if (/^(gpt-3\.5|gpt-4(?:-|$))/.test(id) && !/^gpt-4(?:\.1|o)/.test(id)) {
    return require('gpt-tokenizer/encoding/cl100k_base').countTokens(text);
  }
  return require('gpt-tokenizer').countTokens(text);
};

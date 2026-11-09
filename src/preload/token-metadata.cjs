/** Convierte el metadato del envío a BPE sin cargar diccionarios en la página. */
const { countGptTokens } = require('../core/gptTokens.cjs');

exports.outgoingMetadata = function outgoingMetadata(payload = {}) {
  const { tokenText, ...metadata } = payload;
  const provider = String(payload.host || payload.site || '').toLowerCase();
  if (typeof tokenText === 'string' && (provider.includes('chatgpt') || provider.includes('openai'))) {
    metadata.tokens = countGptTokens(tokenText, payload.model);
  }
  return metadata;
};

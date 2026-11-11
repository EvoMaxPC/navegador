/** Cuenta el texto original en preload; no lo reenvía al registro ni a la página. */
const { countGptTokens, resolveModelForEncoding } = require('../core/gptTokens.cjs');
exports.outgoingMetadata = function outgoingMetadata(payload = {}) {
  const { tokenText, ...metadata } = payload;
  const provider = String(payload.host || payload.site || '').toLowerCase();
  const openai = [
    'chatgpt',
    'openai',
    'chatgpt.com',
    'chat.openai.com',
    'api.openai.com',
  ].includes(provider);
  if (typeof tokenText === 'string' && openai) {
    const resolved =
      payload.textFound === false ? null : resolveModelForEncoding(payload.model);
    // Un nombre desconocido puede usar el modelo más cercano de su familia.
    // Sin familia inequívoca, se conserva null; nunca se inventa GPT-5.
    metadata.tokens = resolved ? countGptTokens(tokenText, resolved.model) : null;
    metadata.tokenEncoding = resolved?.encoding || null;
    metadata.tokenExact = Boolean(resolved?.exact);
    metadata.tokenMethod =
      payload.textFound === false
        ? 'unreadable'
        : resolved
          ? resolved.exact ? 'bpe-original' : 'bpe-nearest-model'
          : 'unknown-model';
    metadata.tokenModel = resolved?.model || null;
  } else {
    metadata.tokenExact = false;
    metadata.tokenEncoding = null;
    metadata.tokenMethod =
      typeof tokenText === 'string' && !openai
        ? 'legacy-estimate'
        : 'unverified';
  }
  return metadata;
};

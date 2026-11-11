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
    // Sin modelo catalogado no hay encoding verificado; el compositor además
    // sólo prueba que hubo un gesto, no qué modelo atenderá la petición.
    const resolved =
      payload.textFound === false ? null : resolveModelForEncoding(payload.model);
    // Un modelo desconocido («auto», gpt-6) no se sustituye por otro: quedaría
    // un número con encoding ajeno presentado como si fuera del modelo real.
    metadata.tokens = resolved ? countGptTokens(tokenText, resolved.model) : null;
    metadata.tokenEncoding = resolved?.encoding || null;
    metadata.tokenExact = Boolean(resolved);
    metadata.tokenMethod =
      payload.textFound === false ? 'unreadable'
        : resolved ? 'bpe-original' : 'unknown-model';
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

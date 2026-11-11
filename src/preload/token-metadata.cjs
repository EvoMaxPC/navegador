/** Cuenta el texto original en preload; no lo reenvía al registro ni a la página. */
const { countGptTokens, encodingForModel } = require('../core/gptTokens.cjs');
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
    const encoding =
      payload.textFound === false ? null : encodingForModel(payload.model);
    metadata.tokens = encoding
      ? countGptTokens(tokenText, payload.model)
      : null;
    metadata.tokenEncoding = encoding;
    metadata.tokenExact = Boolean(encoding);
    metadata.tokenMethod =
      payload.textFound === false
        ? 'unreadable'
        : encoding
          ? 'bpe-original'
          : 'unknown-model';
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

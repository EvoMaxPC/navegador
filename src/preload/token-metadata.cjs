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
    // El evento del compositor de ChatGPT no siempre conoce el modelo activo.
    // o200k_base da un conteo BPE útil, explícitamente aproximado, hasta que
    // el sitio exponga el identificador del modelo.
    const chatGptWeb = ['chatgpt', 'chatgpt.com', 'chat.openai.com'].includes(provider);
    const fallbackModel = !encoding && chatGptWeb ? 'gpt-5-chat-latest' : payload.model;
    const fallbackEncoding = !encoding && chatGptWeb && payload.textFound !== false ? 'o200k_base' : null;
    metadata.tokens = encoding
      ? countGptTokens(tokenText, payload.model)
      : fallbackEncoding
        ? countGptTokens(tokenText, fallbackModel)
        : null;
    metadata.tokenEncoding = encoding || fallbackEncoding;
    metadata.tokenExact = Boolean(encoding);
    metadata.tokenMethod =
      payload.textFound === false
        ? 'unreadable'
        : encoding
          ? 'bpe-original'
          : fallbackEncoding
            ? 'bpe-default'
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

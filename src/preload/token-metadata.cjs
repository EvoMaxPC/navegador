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
    // El compositor sólo prueba que hubo un gesto; no prueba qué modelo
    // atenderá la petición. Esperar a la metadata de red antes de aplicar BPE.
    const awaitingModel = payload.source === 'composer' && !String(payload.model || '').trim();
    const resolved =
      payload.textFound === false || awaitingModel ? null : resolveModelForEncoding(payload.model);
    // Un nombre desconocido siempre usa un tokenizer de referencia; si no
    // hay familia reconocible, resolveModelForEncoding elige GPT-5.
    metadata.tokens = resolved ? countGptTokens(tokenText, resolved.model) : null;
    metadata.tokenEncoding = resolved?.encoding || null;
    metadata.tokenExact = Boolean(resolved?.exact);
    metadata.tokenMethod =
      payload.textFound === false
        ? 'unreadable'
        : awaitingModel
          ? 'unverified'
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

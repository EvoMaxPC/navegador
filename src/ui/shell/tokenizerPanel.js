/** Calculadora local: texto original, resultado numérico y encoding explícito. */
export function createTokenizerPanel({ root, api }) {
  const form = root.querySelector('#tokenizerForm');
  const text = root.querySelector('#tokenizerText');
  const model = root.querySelector('#tokenizerModel');
  const count = root.querySelector('#tokenizerCount');
  const clear = root.querySelector('#tokenizerClear');
  const output = root.querySelector('#tokenizerResult');
  const status = root.querySelector('#tokenizerStatus');
  let ready = false, loading = null, busy = false, revision = 0;
  function invalidate() {
    revision++;
    output.textContent = '—';
    status.textContent = 'Texto o modelo modificado. Pulsá Contar tokens.';
  }
  text.addEventListener('input', invalidate);
  model.addEventListener('change', invalidate);
  clear.addEventListener('click', () => {
    revision++;
    text.value = '';
    output.textContent = '0';
    status.textContent = 'Texto vacío: 0 tokens.';
    text.focus();
  });
  async function refresh() {
    if (ready) return;
    if (loading) return loading;
    status.textContent = 'Cargando modelos verificados…';
    loading = (async () => {
      try {
        const config = await api.models();
        if (!config?.ok || !Array.isArray(config.models) || !config.models.length) throw Error(config?.error || 'No hay modelos disponibles.');
        model.replaceChildren();
        for (const item of config.models) {
          const option = root.ownerDocument.createElement('option');
          option.value = item.id;
          option.textContent = `${item.id} · ${item.encoding}`;
          model.append(option);
        }
        model.value = config.defaultModel;
        text.maxLength = config.maxTextLength;
        ready = true;
        model.disabled = false;
        count.disabled = false;
        status.textContent = 'Pegá o escribí un texto y pulsá Contar tokens.';
      } catch (error) {
        status.textContent = `No se pudo preparar el tokenizador: ${error.message}. Volvé a abrir la pestaña para reintentar.`;
      }
    })();
    try { await loading; } finally { loading = null; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ready || busy) return;
    busy = true;
    count.disabled = true;
    output.textContent = '—';
    status.textContent = 'Contando tokens…';
    const ticket = revision;
    try {
      const result = await api.count({ text: text.value, model: model.value });
      if (ticket !== revision) return;
      if (!result?.ok || !Number.isSafeInteger(result.tokens) || result.tokens < 0) throw Error(result?.error || 'No se recibió un conteo válido.');
      output.textContent = new Intl.NumberFormat('es-AR').format(result.tokens);
      status.textContent = `${result.model} · ${result.encoding} · BPE sobre el texto original.`;
    } catch (error) {
      if (ticket === revision) status.textContent = `No se pudo contar: ${error.message}`;
    } finally {
      busy = false;
      count.disabled = !ready;
    }
  });
  return { refresh };
}

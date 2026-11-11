/** Calculadora local: texto original, resultado numérico y encoding explícito. */
export function createTokenizerPanel({ root, api, clipboard = globalThis.navigator?.clipboard, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const form = root.querySelector('#tokenizerForm');
  const text = root.querySelector('#tokenizerText');
  const model = root.querySelector('#tokenizerModel');
  const count = root.querySelector('#tokenizerCount');
  const clear = root.querySelector('#tokenizerClear');
  const copy = root.querySelector('#tokenizerCopy');
  const words = root.querySelector('#tokenizerWords');
  const chars = root.querySelector('#tokenizerChars');
  const output = root.querySelector('#tokenizerResult');
  const status = root.querySelector('#tokenizerStatus');
  let ready = false, loading = null, busy = false, revision = 0, timer = null, currentCount = 0;
  function auxiliary() {
    words.textContent = String((text.value.match(/\S+/gu) || []).length);
    chars.textContent = String(text.value.length);
  }
  function schedule() {
    clearTimer(timer);
    if (ready) timer = setTimer(() => { timer = null; return calculate(); }, 250);
  }
  function invalidate() {
    revision++;
    currentCount = null;
    copy.disabled = true;
    auxiliary();
    output.textContent = '—';
    status.textContent = 'Texto o modelo modificado. Calculando…';
    schedule();
  }
  text.addEventListener('input', invalidate);
  model.addEventListener('change', invalidate);
  clear.addEventListener('click', () => {
    clearTimer(timer);
    revision++;
    text.value = '';
    currentCount = 0;
    copy.disabled = !ready;
    auxiliary();
    output.textContent = '0';
    status.textContent = 'Texto vacío: 0 tokens.';
    text.focus();
  });
  copy.addEventListener('click', async () => {
    if (!ready || currentCount === null) return;
    const ticket = revision;
    try {
      if (!clipboard?.writeText) throw Error('Portapapeles no disponible.');
      await clipboard.writeText(`Tokens: ${currentCount} | Modelo: ${model.value} | Palabras: ${words.textContent} | Caracteres: ${chars.textContent}`);
      if (ticket === revision) status.textContent = 'Resultado copiado.';
    } catch (error) { if (ticket === revision) status.textContent = `No se pudo copiar: ${error.message}`; }
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
        copy.disabled = currentCount === null;
        auxiliary();
        status.textContent = 'Pegá o escribí un texto. Se cuenta automáticamente o al pulsar Contar tokens.';
        if (text.value) invalidate();
      } catch (error) {
        status.textContent = `No se pudo preparar el tokenizador: ${error.message}. Volvé a abrir la pestaña para reintentar.`;
      }
    })();
    try { await loading; } finally { loading = null; }
  }
  async function calculate() {
    clearTimer(timer);
    if (!ready || busy) return;
    busy = true;
    count.disabled = true;
    currentCount = null;
    copy.disabled = true;
    auxiliary();
    output.textContent = '—';
    status.textContent = 'Contando tokens…';
    const ticket = revision;
    try {
      const result = await api.count({ text: text.value, model: model.value });
      if (ticket !== revision) return;
      if (!result?.ok || !Number.isSafeInteger(result.tokens) || result.tokens < 0) throw Error(result?.error || 'No se recibió un conteo válido.');
      currentCount = result.tokens;
      copy.disabled = false;
      output.textContent = new Intl.NumberFormat('es-AR').format(result.tokens);
      status.textContent = `${result.model} · ${result.encoding} · BPE sobre el texto original.`;
    } catch (error) {
      if (ticket === revision) status.textContent = `No se pudo contar: ${error.message}`;
    } finally {
      busy = false;
      count.disabled = !ready;
      if (ticket !== revision && currentCount === null) schedule();
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); return calculate(); });
  return { refresh };
}

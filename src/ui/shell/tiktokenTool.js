export function createTiktokenTool({ nexo, root }) {
  if (!root || !nexo?.tiktoken?.count) return;
  root.innerHTML = `
    <div class="panel-intro">
      <p class="eyebrow">HERRAMIENTA LOCAL · BPE</p>
      <h2>Tokenizador Tiktoken</h2>
      <p>Pegá un texto y obtené la cantidad de tokens que produce el encoding del modelo.</p>
    </div>
    <div class="panel-head"><h2>Texto</h2></div>
    <textarea id="tiktokenText" rows="12" placeholder="Pegá o escribí tu texto aquí…" style="width:100%;min-height:220px;resize:vertical;padding:14px;border:1px solid var(--line,#444);border-radius:12px;background:var(--surface,#171a20);color:var(--text,#fff);font:inherit;"></textarea>
    <label class="row" style="margin-top:14px"><span>Modelo</span><select id="tiktokenModel"><option value="gpt-4o">GPT-4o · o200k_base</option><option value="gpt-4.1">GPT-4.1 · o200k_base</option><option value="gpt-4">GPT-4 · cl100k_base</option><option value="gpt-3.5-turbo">GPT-3.5 Turbo · cl100k_base</option></select></label>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0">
      <div class="stat-card"><small>Tokens</small><strong id="tiktokenCount">0</strong></div>
      <div class="stat-card"><small>Palabras</small><strong id="tiktokenWords">0</strong></div>
      <div class="stat-card"><small>Caracteres</small><strong id="tiktokenChars">0</strong></div>
    </div>
    <p class="note" id="tiktokenStatus" aria-live="polite">Esperando texto.</p>
    <div class="mem-actions"><button class="ghost" id="tiktokenCopy">Copiar resultado</button><button class="ghost" id="tiktokenClear">Limpiar</button></div>
  `;
  const text = root.querySelector('#tiktokenText');
  const model = root.querySelector('#tiktokenModel');
  const count = root.querySelector('#tiktokenCount');
  const words = root.querySelector('#tiktokenWords');
  const chars = root.querySelector('#tiktokenChars');
  const status = root.querySelector('#tiktokenStatus');
  let revision = 0;
  let currentCount = 0;
  async function update() {
    const current = ++revision;
    const value = text.value;
    words.textContent = value.trim() ? String(value.trim().split(/\\s+/u).length) : '0';
    chars.textContent = String(value.length);
    if (!value) { currentCount = 0; count.textContent = '0'; status.textContent = 'Esperando texto.'; return; }
    count.textContent = '…';
    status.textContent = 'Calculando BPE…';
    try {
      const result = await nexo.tiktoken.count(value, model.value);
      if (current !== revision) return;
      if (!Number.isSafeInteger(result)) throw new Error('Encoding no disponible para este modelo.');
      currentCount = result;
      count.textContent = new Intl.NumberFormat('es-AR').format(result);
      status.textContent = 'Conteo BPE calculado localmente.';
    } catch (error) {
      if (current !== revision) return;
      currentCount = null;
      count.textContent = '—';
      status.textContent = error?.message || 'No se pudo calcular el conteo.';
    }
  }
  text.addEventListener('input', update);
  model.addEventListener('change', update);
  root.querySelector('#tiktokenClear').addEventListener('click', () => { text.value = ''; update(); text.focus(); });
  root.querySelector('#tiktokenCopy').addEventListener('click', async () => {
    if (currentCount === null) return;
    await navigator.clipboard.writeText(`Tokens: ${currentCount} | Modelo: ${model.value} | Palabras: ${words.textContent} | Caracteres: ${chars.textContent}`);
    status.textContent = 'Resultado copiado.';
  });
}

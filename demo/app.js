/**
 * Sala de pruebas de Nexo.
 *
 * El «modelo» de la izquierda es un guion; la mediación de la derecha es el
 * motor real, ejecutándose dentro del navegador.
 */

import { ConversationGuard, estimateTokens } from '../src/core/index.js';
import { SCENARIOS, scenarioById, SEED_HISTORY } from './simulator.js';

const $ = (id) => document.getElementById(id);

const els = {
  intro: $('intro'),
  transcript: $('transcript'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('send'),
  composerMeta: $('composerMeta'),
  scenario: $('scenario'),
  scenarioHint: $('scenarioHint'),
  engine: $('engine'),
  reset: $('reset'),
  protocolLevel: $('protocolLevel'),
  threshold: $('threshold'),
  autoContinue: $('autoContinue'),
  speed: $('speed'),
  blockChips: $('blockChips'),
  warnings: $('warnings'),
  promptPreview: $('promptPreview'),
  tokenPill: $('tokenPill'),
  log: $('log'),
  logCount: $('logCount'),
  mDelivered: $('mDelivered'),
  mDropped: $('mDropped'),
  mLoop: $('mLoop'),
  mContext: $('mContext'),
};

const state = {
  scenario: SCENARIOS[0].id,
  history: SEED_HISTORY.slice(),
  busy: false,
  totals: { delivered: 0, dropped: 0, loops: 0, contextTokens: 0 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Markdown mínimo, para que el texto se lea como en un chat real. */
function mdToHtml(text) {
  return escapeHtml(text)
    .split('\n')
    .map((line) => {
      if (/^#{1,6}\s+/.test(line)) return `<h3>${line.replace(/^#{1,6}\s+/, '')}</h3>`;
      return line
        .replace(/^([-*+])\s+/, '• ')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    })
    .join('\n');
}

function renderStream(el, text, streaming) {
  el.innerHTML = mdToHtml(text) + (streaming ? '<span class="caret"></span>' : '');
  const box = el.closest('.stream');
  if (box) box.scrollTop = box.scrollHeight;
}

const scrollTranscript = () => {
  els.transcript.scrollTop = els.transcript.scrollHeight;
};

function autoGrow() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(180, els.prompt.scrollHeight)}px`;
}

/* ------------------------------------------------------------------ */
/* ajustes                                                             */
/* ------------------------------------------------------------------ */

function currentSettings() {
  return {
    enabled: els.engine.checked,
    protocol: { level: els.protocolLevel.value, placement: 'prefix', lang: 'auto' },
    receiving: {
      severityThreshold: els.threshold.value,
      stopOnLoop: true,
      autoContinue: 2,
    },
    context: { enabled: true, budgetTokens: 260, keepRecentTurns: 4 },
  };
}

/* ------------------------------------------------------------------ */
/* panel del mensaje mediado                                           */
/* ------------------------------------------------------------------ */

function renderPromptPanel(report, rawPrompt) {
  if (report === undefined) {
    els.blockChips.innerHTML = '<span class="chip">esperando mensaje</span>';
    els.warnings.innerHTML =
      '<div class="warning info"><strong>Nada enviado todavía</strong>Al enviar verás acá el mensaje exacto que recibe el modelo, con los bloques que añade Nexo.</div>';
    els.promptPreview.textContent = '';
    els.tokenPill.textContent = '—';
    return;
  }
  if (!report) {
    els.blockChips.innerHTML = '<span class="chip">motor desactivado</span>';
    els.warnings.innerHTML =
      '<div class="warning"><strong>Sin mediación</strong>El mensaje viaja tal cual se escribió y la respuesta se muestra sin filtrar.</div>';
    els.promptPreview.innerHTML = `<span class="usr">${escapeHtml(rawPrompt)}</span>`;
    els.tokenPill.textContent = `${estimateTokens(rawPrompt)} tokens`;
    return;
  }

  const chips = report.blocks.map((b) => `<span class="chip on">${escapeHtml(b.label)}</span>`);
  if (report.stats.injectedTokens > 0) chips.push(`<span class="chip mint">+${report.stats.injectedTokens} tok</span>`);
  if (!report.blocks.length) chips.push('<span class="chip">sin inyecciones</span>');
  els.blockChips.innerHTML = chips.join('');

  els.warnings.innerHTML = report.findings.length
    ? report.findings
        .map(
          (f) => `<div class="warning ${f.level === 'warn' ? '' : 'info'}">
            <strong>${escapeHtml(f.title)}</strong>${escapeHtml(f.detail || '')}
          </div>`,
        )
        .join('')
    : '<div class="warning info"><strong>Mensaje limpio</strong>Sin contradicciones, referencias sueltas ni exceso de contexto.</div>';

  let html = escapeHtml(report.enhanced);
  for (const block of report.blocks) {
    const safe = escapeHtml(block.text);
    if (safe) html = html.replace(safe, `<span class="blk">${safe}</span>`);
  }
  els.promptPreview.innerHTML = html;
  els.tokenPill.textContent = `${report.stats.tokensIn} → ${report.stats.tokensOut} tok`;
}

/* ------------------------------------------------------------------ */
/* registro                                                            */
/* ------------------------------------------------------------------ */

const KIND_LABEL = { sending: 'envío', receiving: 'recepción', context: 'contexto', system: 'sistema' };

function renderLog(entries) {
  els.logCount.textContent = String(entries.length);
  if (!entries.length) {
    els.log.innerHTML = '<li class="log-empty">Sin intervenciones todavía. Enviá un mensaje.</li>';
    return;
  }
  els.log.innerHTML = entries
    .slice(0, 40)
    .map(
      (e) => `<li class="log-item ${e.severity || 'info'}">
        <div class="top">
          <span class="kind ${e.kind}">${KIND_LABEL[e.kind] || e.kind}</span>
          <span class="title">${escapeHtml(e.title || e.code || '')}</span>
        </div>
        ${e.detail ? `<div class="detail">${escapeHtml(e.detail)}</div>` : ''}
      </li>`,
    )
    .join('');
}

function renderMetrics() {
  els.mDelivered.textContent = state.totals.delivered.toLocaleString('es-AR');
  els.mDropped.textContent = state.totals.dropped.toLocaleString('es-AR');
  els.mLoop.textContent = String(state.totals.loops);
  els.mContext.textContent = Math.round(state.totals.contextTokens).toLocaleString('es-AR');
}

/* ------------------------------------------------------------------ */
/* intercambio                                                         */
/* ------------------------------------------------------------------ */

function createExchange(prompt) {
  if (els.transcript.contains(els.intro)) els.intro.remove();

  const wrap = document.createElement('article');
  wrap.className = 'exchange';
  wrap.innerHTML = `
    <div class="exchange-head">
      <span class="who">Vos</span>
      <span class="text">${escapeHtml(prompt)}</span>
    </div>
    <div class="compare">
      <div class="card raw">
        <div class="card-head">
          <span class="card-title"><span class="dot"></span>Modelo · texto crudo</span>
          <span class="badge" data-role="rawBadge">generando…</span>
        </div>
        <div class="stream" data-role="rawBox"><div data-role="raw"></div></div>
        <div class="card-foot" data-role="rawFoot"></div>
      </div>
      <div class="card nexo">
        <div class="card-head">
          <span class="card-title"><span class="dot"></span>Nexo · texto entregado</span>
          <span class="badge" data-role="nexoBadge">analizando…</span>
        </div>
        <div class="stream" data-role="nexoBox"><div data-role="nexo"></div></div>
        <div class="card-foot" data-role="nexoFoot"></div>
      </div>
    </div>`;

  els.transcript.appendChild(wrap);
  scrollTranscript();

  const q = (role) => wrap.querySelector(`[data-role="${role}"]`);
  return {
    root: wrap,
    rawBox: q('rawBox'),
    raw: q('raw'),
    nexoBox: q('nexoBox'),
    nexo: q('nexo'),
    rawBadge: q('rawBadge'),
    nexoBadge: q('nexoBadge'),
    rawFoot: q('rawFoot'),
    nexoFoot: q('nexoFoot'),
  };
}

function addCutMarker(ui, ev) {
  const marker = document.createElement('div');
  marker.className = 'cut-marker';
  marker.textContent = `Bucle cortado · ${ev.code} ×${ev.repeats ?? 2} · ${ev.droppedChars} caracteres descartados`;
  ui.nexoBox.appendChild(marker);
  ui.nexoBadge.textContent = ev.code;
  ui.nexoBadge.classList.add('cut');
}

/* ------------------------------------------------------------------ */
/* flujo principal                                                     */
/* ------------------------------------------------------------------ */

async function handleSubmit(event) {
  event.preventDefault();
  if (state.busy) return;

  const scenario = scenarioById(state.scenario);
  const prompt = els.prompt.value.trim() || scenario.prompt;
  const settings = currentSettings();
  const engineOn = settings.enabled;

  state.busy = true;
  els.send.disabled = true;
  els.prompt.blur();

  const guard = new ConversationGuard({ settings, language: 'es' });
  guard.seedHistory(state.history);

  let report = null;
  if (engineOn) {
    report = guard.preparePrompt(prompt);
    if (report.context) {
      state.totals.contextTokens += Math.max(0, report.context.tokensBefore - report.context.tokensAfter);
    }
  }
  renderPromptPanel(report, prompt);
  renderLog(engineOn ? guard.logbook.entries : []);

  const ui = createExchange(prompt);
  ui.rawBadge.textContent = 'streaming';
  ui.nexoBadge.textContent = engineOn ? 'analizando' : 'sin filtro';

  const turn = engineOn ? guard.beginResponse() : null;
  const delay = Math.max(0, 40 - Number(els.speed.value));
  const chunkSize = 6;

  let delivered = '';
  let stopped = false;
  let loopEvent = null;

  for (let i = 0; i < scenario.raw.length; i += chunkSize) {
    const delta = scenario.raw.slice(i, i + chunkSize);

    // Izquierda: siempre lo que el modelo escribió.
    renderStream(ui.raw, scenario.raw.slice(0, i + chunkSize), true);

    if (!engineOn) {
      delivered += delta;
      renderStream(ui.nexo, delivered, true);
      await sleep(delay);
      continue;
    }

    if (!stopped) {
      const result = turn.push(delta);
      if (result.emit) {
        delivered += result.emit;
        renderStream(ui.nexo, delivered, true);
      }
      if (result.stopped) {
        stopped = true;
        loopEvent = result.events.find((e) => e.type === 'loop') || null;
        if (loopEvent) addCutMarker(ui, loopEvent);
      }
    }
    await sleep(delay);
  }

  renderStream(ui.raw, scenario.raw, false);
  ui.rawFoot.textContent = `${scenario.raw.length} caracteres generados`;

  if (stopped) {
    ui.rawBadge.textContent = 'bucle infinito';
    ui.rawBadge.classList.add('cut');
    const note = document.createElement('div');
    note.className = 'recovering';
    note.textContent = '…y el modelo habría seguido repitiendo hasta agotar el contexto.';
    ui.nexoBox.appendChild(note);
  }

  if (!engineOn) {
    ui.rawBadge.textContent = 'completo';
    ui.nexoBadge.textContent = 'sin filtrar';
    ui.nexoBadge.classList.add('ok');
    ui.nexoFoot.textContent = `${delivered.length} caracteres mostrados`;
    state.busy = false;
    els.send.disabled = false;
    return;
  }

  // Cierre del turno: reparación + decisión de continuación.
  const done = turn.complete();
  renderStream(ui.nexo, stopped ? delivered : done.repaired.text, false);

  state.totals.delivered += done.repaired.text.length;
  state.totals.dropped += Math.max(0, done.verdict.droppedChars);
  if (stopped) state.totals.loops += 1;

  ui.nexoFoot.textContent = [
    `${done.repaired.text.length} caracteres entregados`,
    done.verdict.droppedChars ? `${done.verdict.droppedChars} descartados` : null,
    done.repaired.fixes.length ? `${done.repaired.fixes.length} reparación(es)` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const autoContinue = els.autoContinue.checked;
  const shouldContinue = autoContinue && scenario.continuation && (stopped || done.repaired.needsContinue);

  if (shouldContinue) {
    await sleep(520);

    const divider = document.createElement('div');
    divider.className = 'cont-divider';
    divider.textContent = 'continuación automática · sin repetir';
    ui.nexoBox.appendChild(divider);

    const contEl = document.createElement('div');
    contEl.className = 'cont';
    ui.nexoBox.appendChild(contEl);

    const contTurn = guard.beginResponse();
    let contDelivered = '';
    for (let i = 0; i < scenario.continuation.length; i += chunkSize) {
      const result = contTurn.push(scenario.continuation.slice(i, i + chunkSize));
      if (result.emit) {
        contDelivered += result.emit;
        renderStream(contEl, contDelivered, true);
      }
      ui.nexoBox.scrollTop = ui.nexoBox.scrollHeight;
      await sleep(delay);
    }
    const contDone = contTurn.complete();
    renderStream(contEl, contDone.repaired.text || contDelivered, false);
    state.totals.delivered += contDone.repaired.text.length;

    ui.nexoBadge.textContent = 'completo';
    ui.nexoBadge.classList.remove('cut');
    ui.nexoBadge.classList.add('ok');
  } else if (stopped) {
    ui.nexoBadge.textContent = 'cortado';
  } else if (done.repaired.refusal) {
    ui.nexoBadge.textContent = 'negativa';
    ui.nexoBadge.classList.add('cut');
  } else if (done.repaired.empty) {
    ui.nexoBadge.textContent = 'vacía';
    ui.nexoBadge.classList.add('cut');
  } else {
    ui.nexoBadge.textContent = 'completo';
    ui.nexoBadge.classList.add('ok');
  }

  // Sugerencias de recuperación (negativas, respuestas vacías…).
  if (done.suggestions.length) {
    const box = document.createElement('div');
    box.className = 'chips';
    box.style.marginTop = '12px';
    box.innerHTML = done.suggestions
      .map((s) => `<button type="button" class="chip on" data-prompt="${escapeHtml(s.prompt || '')}">${escapeHtml(s.label)}</button>`)
      .join('');
    box.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        els.prompt.value = btn.dataset.prompt || '';
        autoGrow();
        els.prompt.focus();
        updateComposerMeta();
      });
    });
    ui.nexoBox.appendChild(box);
  }

  state.history = guard.history.map((t) => ({ role: t.role, content: t.content })).slice(-14);

  renderLog(guard.logbook.entries);
  renderMetrics();
  scrollTranscript();

  els.prompt.value = '';
  autoGrow();
  updateComposerMeta();
  state.busy = false;
  els.send.disabled = false;
  els.prompt.focus();
}

/* ------------------------------------------------------------------ */
/* arranque                                                            */
/* ------------------------------------------------------------------ */

function updateComposerMeta() {
  const tokens = estimateTokens(els.prompt.value);
  const level = els.engine.checked ? `protocolo ${els.protocolLevel.value}` : 'sin mediación';
  els.composerMeta.textContent = `${tokens} tokens · ${level} · respuesta simulada`;
}

function loadScenario(id) {
  state.scenario = id;
  const s = scenarioById(id);
  els.scenario.value = id;
  els.scenarioHint.textContent = s.hint;
  els.prompt.value = s.prompt;
  els.prompt.placeholder = `Ejemplo: ${s.prompt}`;
  autoGrow();
  updateComposerMeta();
}

els.scenario.innerHTML = SCENARIOS.map(
  (s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`,
).join('');

els.scenario.addEventListener('change', () => loadScenario(els.scenario.value));
els.prompt.addEventListener('input', () => {
  autoGrow();
  updateComposerMeta();
});
els.protocolLevel.addEventListener('change', updateComposerMeta);
els.engine.addEventListener('change', updateComposerMeta);
els.composer.addEventListener('submit', handleSubmit);

els.reset.addEventListener('click', () => {
  if (!state.busy) location.reload();
});

loadScenario(state.scenario);
renderMetrics();
renderLog([]);
renderPromptPanel(undefined, els.prompt.value);

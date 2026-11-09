/**
 * Centinela de streaming.
 *
 * Recibe los deltas de texto a medida que llegan y decide, en tiempo real, si
 * el modelo entró en un bucle. Cuando lo detecta, deja de entregar texto al
 * cliente y marca la posición exacta del corte.
 *
 * Dos decisiones de diseño sostienen la precisión:
 *
 *  1. **Búfer de retención** (`holdbackChars`): nunca se entrega el final del
 *     texto en el mismo instante en que llega. Se retienen los últimos ~64
 *     caracteres, así que cuando la repetición se detecta todavía está en el
 *     búfer y se puede descartar entera. Sin esto, lo repetido ya estaría
 *     pintado en pantalla y solo se podría "tapar".
 *
 *  2. **Sonda barata antes del análisis caro**: una repetición implica que el
 *     final del texto ya apareció antes. Se comprueba eso con `indexOf` y solo
 *     entonces se ejecuta la función Z completa. El coste por token se mantiene
 *     despreciable incluso en respuestas de 20 000 caracteres.
 */

import { analyzeTail, detectTruncation } from './analysis.js';
import { codeFenceState, excerpt, tokenizeWithSpans } from './text.js';

const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3 };

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class StreamSentinel {
  /**
   * @param {{
   *   settings?: object,
   *   host?: string,
   *   language?: string,
   *   holdbackChars?: number,
   *   onEvent?: (event: object) => void
   * }} [opts]
   */
  constructor(opts = {}) {
    const receiving = opts.settings?.receiving || {};
    this.policy = {
      threshold: receiving.severityThreshold || 'medium',
      stopOnLoop: receiving.stopOnLoop !== false,
      minUnit: receiving.minUnit ?? 40,
      minRepeats: receiving.minRepeats ?? 2,
    };
    // Presupuesto de precisión: para cortar limpiamente en el inicio de una
    // repetición hay que retener al menos una unidad repetida completa. Si el
    // búfer fuese menor, el comienzo del bucle ya estaría en pantalla.
    const need = this.policy.minUnit * this.policy.minRepeats + 32;
    this.holdback = Math.max(0, opts.holdbackChars ?? receiving.holdbackChars ?? need);
    this.probeLength = 32;
    this.deepCheckEvery = 512;
    this.host = opts.host || null;
    this.language = opts.language || 'es';
    this.onEvent = opts.onEvent || null;

    this.raw = '';
    this.delivered = '';
    this.stopped = false;
    this.stopReason = null;
    this.interventions = [];
    this.warned = new Set();
    this.lastCheck = 0;
    this.lastCut = null;
    this.cutIndex = null;
  }

  #emitEvent(event) {
    this.interventions.push(event);
    if (this.onEvent) this.onEvent(event);
  }

  /**
   * Procesa un fragmento nuevo.
   * @param {string} delta
   * @returns {{emit: string, stopped: boolean, events: object[]}}
   */
  push(delta) {
    if (!delta) return { emit: '', stopped: this.stopped, events: [] };
    this.raw += delta;
    const events = [];

    if (!this.stopped) {
      const verdict = this.#inspectIfDue();
      if (verdict.loop) {
        this.stopped = true;
        this.stopReason = verdict.type;
        this.cutIndex = Math.max(this.delivered.length, verdict.cutIndex);
        this.lastCut = {
          type: verdict.type,
          severity: verdict.severity,
          at: this.cutIndex,
          unit: verdict.detail?.unit || verdict.detail?.words || verdict.detail?.line || verdict.detail?.token || '',
          repeats: verdict.detail?.repeats || null,
        };

        const event = {
          type: 'loop',
          kind: 'receiving',
          code: verdict.type,
          severity: verdict.severity,
          at: this.cutIndex,
          droppedChars: Math.max(0, this.raw.length - this.cutIndex),
          unit: excerpt(this.lastCut.unit, 140),
          repeats: this.lastCut.repeats,
          message: describeLoop(this.lastCut, this.language),
          analysis: {
            diversity: verdict.signals?.diversity ?? null,
            entropy: verdict.signals?.entropy ?? null,
          },
        };
        events.push(event);
        this.#emitEvent(event);
      }
    }

    const limit = this.stopped
      ? this.cutIndex
      : Math.max(0, this.raw.length - this.holdback);
    const end = Math.min(Math.max(limit, this.delivered.length), this.raw.length);
    const emit = this.raw.slice(this.delivered.length, end);
    this.delivered += emit;

    return { emit, stopped: this.stopped, events };
  }

  /**
   * Análisis programado: sonda barata en cada bloque de 24 caracteres y
   * análisis completo cuando la sonda dispara o cada 512 caracteres.
   */
  #inspectIfDue() {
    const since = this.raw.length - this.lastCheck;
    if (since < 24) return { loop: false };
    this.lastCheck = this.raw.length;

    const probe = this.#probeMatches() || this.#stutterProbe();
    if (!probe && since < this.deepCheckEvery) return { loop: false };
    return this.#inspect();
  }

  /** ¿El final del texto ya apareció antes? Condición necesaria de repetición. */
  #probeMatches() {
    const k = this.probeLength;
    if (this.raw.length < k * 2) return false;
    const tail = this.raw.slice(-k).toLowerCase();
    if (tail.trim().length < 12) return false;
    const from = Math.max(0, this.raw.length - 6000);
    const window = this.raw.slice(from, this.raw.length - k).toLowerCase();
    return window.indexOf(tail) !== -1;
  }

  /**
   * Sonda de tartamudeo: cinco o más repeticiones seguidas de la misma palabra.
   * Es O(1) sobre los últimos 160 caracteres y no depende del final del texto.
   */
  #stutterProbe() {
    const win = this.raw.slice(-160).toLowerCase();
    return /(\b[\p{L}\p{N}]+\b)(?:[ \t]+\1){4,}/u.test(win);
  }

  /** Análisis real del texto acumulado. */
  #inspect() {
    const fence = codeFenceState(this.raw);
    // Dentro de un bloque de código la repetición puede ser legítima
    // (plantillas, boilerplate): se exige más evidencia antes de cortar.
    const strict = fence.open;
    const policy = {
      ...this.policy,
      minUnit: strict ? 160 : this.policy.minUnit,
      minRepeats: strict ? 3 : this.policy.minRepeats,
    };

    const analysis = analyzeTail(this.raw, { policy });
    if (!analysis.loop) return { loop: false };

    const threshold = SEVERITY_RANK[this.policy.threshold] ?? 2;
    if (SEVERITY_RANK[analysis.severity] < threshold || !this.policy.stopOnLoop) {
      // Se registra como aviso (una sola vez por tipo) sin cortar la generación.
      if (!this.warned.has(analysis.type)) {
        this.warned.add(analysis.type);
        this.#emitEvent({
          type: 'warning',
          kind: 'receiving',
          code: analysis.type,
          severity: analysis.severity,
          message: describeLoop(
            { type: analysis.type, severity: analysis.severity, repeats: analysis.detail?.repeats },
            this.language,
          ),
        });
      }
      return { loop: false };
    }

    return {
      loop: true,
      severity: analysis.severity,
      type: analysis.type,
      detail: analysis.detail,
      signals: analysis.signals,
      cutIndex: this.#cutIndexFor(analysis),
    };
  }

  /** Traduce la detección a un índice de corte en el texto acumulado. */
  #cutIndexFor(analysis) {
    const detail = analysis.detail || {};
    switch (analysis.type) {
      case 'repeat-unit':
      case 'repeat-tokens': {
        const at = detail.cutAt ?? detail.start;
        return typeof at === 'number' ? this.#alignCut(at) : this.raw.length;
      }
      case 'line-loop': {
        const first = detail.firstLine;
        if (typeof first !== 'number') return this.raw.length;
        const lines = this.raw.split('\n');
        return lines.slice(0, Math.max(0, first)).join('\n').length + 1;
      }
      case 'paragraph-loop': {
        const needle = (detail.block || '').toLowerCase().slice(0, 40);
        if (!needle) return this.raw.length;
        const lower = this.raw.toLowerCase();
        const first = lower.indexOf(needle);
        const second = first >= 0 ? lower.indexOf(needle, first + 10) : -1;
        return second > 0 ? second : this.raw.length;
      }
      case 'stutter': {
        const token = detail.token || '';
        if (!token) return this.#alignCut(this.raw.length);
        const spans = tokenizeWithSpans(this.raw);
        let end = spans.length - 1;
        while (end >= 0 && spans[end].token !== token) end -= 1;
        if (end < 0) return this.#alignCut(this.raw.length);
        let start = end;
        while (start > 0 && spans[start - 1].token === token) start -= 1;
        // Se conserva una sola aparición de la palabra y se descarta la tirada.
        return spans[start].start + token.length;
      }
      default:
        return this.#alignCut(Math.max(0, this.raw.length - 1));
    }
  }

  /**
   * Alinea el corte a un límite natural (párrafo o frase) cercano.
   * Cortar a mitad de palabra es peor que cortar un poco antes: el usuario ve
   * una respuesta que termina bien y una continuación con sentido.
   */
  #alignCut(at) {
    const floor = Math.max(this.delivered.length, at - 400);
    const seg = this.raw.slice(floor, at);
    const par = seg.lastIndexOf('\n\n');
    if (par >= 0) return floor + par;
    let best = -1;
    for (const mark of ['. ', '.\n', '? ', '! ', '…\n', ':\n']) {
      const idx = seg.lastIndexOf(mark);
      if (idx > best) best = idx;
    }
    if (best >= 0) return floor + best + 1;
    return at;
  }

  /**
   * Cierra el stream: entrega lo retenido, revisa truncamiento y devuelve el
   * veredicto completo del turno.
   */
  finish() {
    let emit = '';
    if (!this.stopped) {
      emit = this.raw.slice(this.delivered.length);
      this.delivered += emit;
    }

    const trunc = detectTruncation(this.delivered);
    const verdict = {
      emit,
      stopped: this.stopped,
      stopReason: this.stopReason,
      chars: this.delivered.length,
      droppedChars: Math.max(0, this.raw.length - this.delivered.length),
      truncated: trunc.truncated,
      truncationReason: trunc.reason,
      interventions: this.interventions,
      delivered: this.delivered,
      dropped: this.raw.slice(this.delivered.length),
    };

    if (trunc.truncated && !this.stopped) {
      const event = {
        type: 'truncation',
        kind: 'receiving',
        code: trunc.reason,
        severity: 'medium',
        message:
          this.language === 'en'
            ? 'The answer ended mid-sentence; it can be continued without repeating.'
            : 'La respuesta terminó a mitad de frase; se puede continuar sin repetir.',
      };
      verdict.interventions.push(event);
      this.#emitEvent(event);
    }
    return verdict;
  }

  /** Texto entregado hasta ahora. */
  get text() {
    return this.delivered;
  }
}

/** Descripción legible de un bucle detectado. */
export function describeLoop(cut, lang = 'es') {
  const repeats = cut.repeats || 2;
  const labels = {
    'repeat-unit': lang === 'en' ? 'Repeated block' : 'Bloque repetido',
    'repeat-tokens': lang === 'en' ? 'Repeated phrase' : 'Frase repetida',
    stutter: lang === 'en' ? 'Stuttering token' : 'Tartamudeo',
    'line-loop': lang === 'en' ? 'Repeated lines' : 'Líneas repetidas',
    'paragraph-loop': lang === 'en' ? 'Repeated paragraphs' : 'Párrafos repetidos',
    degeneration: lang === 'en' ? 'Degenerate vocabulary' : 'Vocabulario degenerado',
  };
  const label = labels[cut.type] || cut.type || 'Bucle';
  return lang === 'en'
    ? `${label} detected ×${repeats}: generation stopped before showing the loop.`
    : `${label} detectado ×${repeats}: generación detenida antes de mostrar el bucle.`;
}

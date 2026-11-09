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
import { codeFenceState, excerpt, tokenizeWithStarts } from './text.js';

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
    this.host = opts.host || null;
    this.language = opts.language || 'es';
    this.onEvent = opts.onEvent || null;

    this.raw = '';
    /**
     * Copia en minúsculas del texto acumulado, mantenida al día por delta.
     * Antes cada sonda recortaba e pasaba a minúsculas 6 000 caracteres: cada 24
     * caracteres del modelo se generaba basura equivalente a 250 veces la
     * respuesta. Con la copia incremental el costo pasa a ser una vez por delta.
     */
    this.low = '';
    this.delivered = '';
    this.stopped = false;
    this.stopReason = null;
    this.interventions = [];
    this.warned = new Set();
    this.lastCheck = 0;
    this.lastDeepCheck = 0;
    /** Cada cuántos caracteres se hace el análisis completo aunque la sonda no dispare. */
    this.deepCheckEvery = opts.deepCheckEvery ?? 1200;
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
    const lowDelta = delta.toLowerCase();
    if (lowDelta.length === delta.length) {
      this.low += lowDelta;
    } else {
      // Casos raros (İ, ligaduras): la conversión cambia longitudes y las
      // posiciones dejarían de coincidir. Se recalcula entera, una vez.
      this.low = this.raw.toLowerCase();
    }
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
    const length = this.raw.length;
    if (length - this.lastCheck < 24) return { loop: false };
    this.lastCheck = length;

    const probe = this.#probeMatches() || this.#stutterProbe();
    // El análisis completo corre cuando la sonda dispara o cada
    // `deepCheckEvery` caracteres. Antes el contador se reiniciaba en cada
    // sonda de 24 caracteres, así que esa segunda condición no se cumplía nunca.
    if (!probe && length - this.lastDeepCheck < this.deepCheckEvery) return { loop: false };
    this.lastDeepCheck = length;
    return this.#inspect();
  }

  /** ¿El final del texto ya apareció antes? Condición necesaria de repetición. */
  #probeMatches() {
    const k = this.probeLength;
    const n = this.low.length;
    if (n < k * 2) return false;
    const tailStart = n - k;
    const from = Math.max(0, n - 6000);
    if (tailStart <= from) return false;
    const tail = this.low.slice(tailStart);
    // Menos de 12 caracteres de contenido: no hay nada que comparar.
    if (tail.trim().length < 12) return false;
    // `lastIndexOf` recorre hacia atrás sin recortar el texto en minúsculas:
    // antes cada sonda copiaba 6 000 caracteres sólo para buscar 32.
    return this.low.lastIndexOf(tail, tailStart - 1) >= from;
  }

  /**
   * Sonda de tartamudeo: cinco o más repeticiones seguidas de la misma palabra.
   *
   * Se recorre a mano la ventana de 160 caracteres en lugar de usar una
   * expresión regular con retrorreferencia: la versión con regex era una de las
   * partes más caras del camino por token.
   */
  #stutterProbe() {
    const n = this.low.length;
    if (n < 32) return false;
    const win = this.low.slice(Math.max(0, n - 160));
    let run = 0;
    let prevStart = -1;
    let prevEnd = -1;
    let i = 0;
    while (i < win.length) {
      // Salto de separadores: cualquier espacio o salto de línea.
      while (i < win.length && win.charCodeAt(i) <= 32) i += 1;
      const start = i;
      while (i < win.length && win.charCodeAt(i) > 32) i += 1;
      if (i === start) break;
      const same =
        prevStart >= 0 &&
        i - start === prevEnd - prevStart &&
        win.startsWith(win.slice(prevStart, prevEnd), start);
      if (same) {
        run += 1;
        if (run >= 4) return true; // el primero + 4 repeticiones = 5 seguidas
      } else {
        run = 0;
      }
      prevStart = start;
      prevEnd = i;
    }
    return false;
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
        // Se reutiliza la copia en minúsculas que mantiene `push`.
        const lower = this.low.length === this.raw.length ? this.low : this.raw.toLowerCase();
        const first = lower.indexOf(needle);
        const second = first >= 0 ? lower.indexOf(needle, first + 10) : -1;
        return second > 0 ? second : this.raw.length;
      }
      case 'stutter': {
        const token = detail.token || '';
        if (!token) return this.#alignCut(this.raw.length);
        const { tokens, starts } = tokenizeWithStarts(this.raw);
        let end = tokens.length - 1;
        while (end >= 0 && tokens[end] !== token) end -= 1;
        if (end < 0) return this.#alignCut(this.raw.length);
        let start = end;
        while (start > 0 && tokens[start - 1] === token) start -= 1;
        // Se conserva una sola aparición de la palabra y se descarta la tirada.
        return starts[start] + token.length;
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

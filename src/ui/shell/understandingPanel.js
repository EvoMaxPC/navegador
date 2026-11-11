import { createUnderstandingRefresh } from './understandingRefresh.js';
const STATES = {
  analyzing: 'Analizando',
  unnecessary: 'Sin necesidad de optimización',
  optimized: 'Optimización realizada',
  unsafe: 'No se pudo optimizar con seguridad',
};
const element = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
/**
 * Única pantalla automática; sin formularios, clasificación ni administración.
 *
 * El panel es de sólo lectura sobre la conversación: no reemplaza mensajes ni
 * envía nada. Lo único que puede hacer con el resultado es entregarlo al
 * portapapeles o al cuadro del sitio, siempre con un gesto de la persona.
 */
export function createUnderstandingPanel({
  nexo,
  root,
  activeTab,
  insertText = (text) =>
    nexo.insertText?.(text) ??
    nexo.advanced?.action({
      action: 'insert-text',
      webContentsId: activeTab()?.view?.getWebContentsId?.(),
      text,
    }),
  copyText = (text) => globalThis.navigator?.clipboard?.writeText(text),
  maxInsert = 20000,
}) {
  let ticket = 0,
    busy = false,
    disposed = false,
    targetId = null;
  const target = () => {
    try {
      return activeTab()?.view.getWebContentsId() ?? null;
    } catch {
      return null;
    }
  };
  const auto = createUnderstandingRefresh({
    refresh,
    isBusy: () => busy,
    isActive: () => root.classList.contains('active'),
  });
  const status = element('p', 'Analizando', 'work-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const body = element('div', undefined, 'work-content');
  // Aviso de la acción elegida: dice qué pasó y qué falta hacer, sin fingir
  // que el contexto ya se envió.
  const delivery = element('p', '', 'note work-delivery');
  delivery.setAttribute('role', 'status');
  delivery.setAttribute('aria-live', 'polite');
  root.replaceChildren(status, body);

  async function deliver(text, mode) {
    if (typeof text !== 'string' || !text) return;
    if (text.length > maxInsert) {
      delivery.textContent = `El contexto optimizado tiene ${text.length} caracteres y el cuadro admite ${maxInsert}. Copialo por partes o reducí la conversación.`;
      return;
    }
    if (mode === 'copy') {
      try {
        await copyText(text);
        delivery.textContent = 'Contexto copiado. Pegalo en el cuadro cuando quieras; no se envió nada.';
      } catch {
        delivery.textContent = 'No se pudo usar el portapapeles. Consultá el contenido optimizado y copialo a mano.';
      }
      return;
    }
    try {
      const result = await insertText(text);
      delivery.textContent = result && result.ok === false
        ? (result.error || 'No se pudo escribir en el cuadro del sitio.')
        : 'Contexto escrito en el cuadro del sitio. Revisalo y enviá vos: no se envió nada.';
    } catch {
      delivery.textContent = 'No se pudo escribir en el cuadro del sitio. Revisá que la pestaña siga abierta.';
    }
  }
  async function refresh() {
    const id = target(),
      request = ++ticket;
    targetId = id;
    if (!id) {
      status.textContent = 'Analizando · abrí una conversación de ChatGPT.';
      body.replaceChildren();
      return;
    }
    busy = true;
    try {
      const result = await nexo.understanding.read({
        webContentsId: id,
        includeText: true,
      });
      if (disposed || request !== ticket || target() !== id) return;
      if (!result?.ok) {
        status.textContent = 'No se pudo optimizar con seguridad';
        body.replaceChildren(
          element(
            'p',
            result?.error || 'No se pudo consultar la conversación.',
            'note',
          ),
        );
        return;
      }
      status.textContent = STATES[result.status] || STATES.unsafe;
      render(result);
    } catch {
      if (request === ticket) {
        status.textContent = STATES.unsafe;
        body.replaceChildren(
          element('p', 'El contenido original no fue modificado.', 'note'),
        );
      }
    } finally {
      if (request === ticket) busy = false;
    }
  }
  function render(result) {
    body.replaceChildren(
      element('h2', 'Comprensión · ahorro de tokens'),
      element('p', result.reason, 'note'),
    );
    const metrics = result.metrics,
      stats = element('dl', undefined, 'optimization-metrics');
    for (const [name, value] of [
      ['Tokens originales', metrics?.original],
      ['Tokens optimizados', metrics?.optimized],
      ['Tokens ahorrados', metrics?.saved],
      ['Reducción', metrics ? `${metrics.percent}%` : null],
    ])
      stats.append(
        element('dt', name),
        element('dd', value == null ? '—' : String(value)),
      );
    body.append(stats);
    if (metrics) {
      body.append(
        element(
          'p',
          `${metrics.tokenizer.estimated ? 'Estimación para el destino' : 'BPE local compatible'} · ${metrics.tokenizer.encoding}${metrics.tokenizer.model ? ` · ${metrics.tokenizer.model}` : ''}. Se mide este texto, no el consumo facturado ni el historial que ChatGPT vuelve a enviar.`,
          'note',
        ),
      );
    }
    body.append(
      element(
        'p',
        'Fuente: lector DOM independiente de EVO Memory. Sólo mensajes cargados y reconocidos. Las respuestas del asistente no son decisiones del usuario ni resultados verificados.',
        'note',
      ),
    );
    if (result.coverage?.clipped)
      body.append(
        element(
          'p',
          'Lectura parcial por límites: no se comprime como si fuera un historial completo.',
          'note',
        ),
      );
    if (result.status === 'optimized' && result.optimized) {
      body.append(
        element('h3', 'Contexto optimizado'),
        element('pre', result.optimized, 'mem-text'),
      );
      body.append(
        element(
          'p',
          'Redundancias mediante diccionario y referencias en orden. Reconstrucción literal verificada. No es un resumen libre ni una nueva instrucción.',
          'note',
        ),
      );
      // Entrega explícita: la persona decide si lo usa y lo envía. El panel
      // nunca reemplaza ni envía el contexto por su cuenta.
      const actions = element('div', undefined, 'work-actions');
      const insert = element('button', 'Escribir en el cuadro', 'ghost work-primary');
      insert.type = 'button';
      const overLimit = result.optimized.length > maxInsert;
      insert.disabled = overLimit;
      if (overLimit) insert.title = `El cuadro admite ${maxInsert} caracteres`;
      insert.addEventListener('click', () => {
        delivery.textContent = 'Escribiendo en el cuadro…';
        deliver(result.optimized, 'insert');
      });
      const copy = element('button', 'Copiar el contexto', 'ghost');
      copy.type = 'button';
      copy.addEventListener('click', () => deliver(result.optimized, 'copy'));
      actions.append(insert, copy);
      body.append(
        actions,
        delivery,
        element(
          'p',
          'Se escribe en el cuadro del sitio para que lo revises: no se envía solo ni reemplaza los mensajes anteriores.',
          'note',
        ),
      );
    }
    if (result.original) {
      const original = element('details');
      original.append(
        element('summary', 'Consultar contenido original'),
        element('pre', result.original, 'mem-text'),
      );
      body.append(original);
    }
    body.append(
      element(
        'p',
        'Resultado local consultable. No reemplaza silenciosamente los envíos ni elimina el historial remoto de ChatGPT.',
        'note',
      ),
    );
  }
  const off = nexo.on('nexo:understanding-changed', (p) => {
    if (p.webContentsId === targetId) auto.schedule();
  });
  return {
    refresh,
    changed() {
      ticket++;
      busy = false;
      body.replaceChildren();
      if (root.classList.contains('active')) return refresh();
    },
    dispose() {
      disposed = true;
      ticket++;
      auto.dispose();
      if (typeof off === 'function') off();
    },
  };
}

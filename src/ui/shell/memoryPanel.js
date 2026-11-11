/** Sólo presentación. No guarda, captura ni modifica conversaciones. */
export function memoryReadout({ enabled, live, conversations = [], loaded = false }) {
  if (enabled === false) return { state: 'disabled', title: 'EVO Memory desactivada', detail: 'No se muestran recuerdos. Comprensión sigue activa.' };
  if (live?.strategy === 'direct-console-injection') return {
    state: 'ram', title: 'Lectura de respaldo · RAM', detail: 'Esta lectura no confirma persistencia en disco.',
  };
  if (live?.turns?.length) return {
    state: 'reading', title: live.streaming ? 'Conversación en curso' : 'Lectura disponible',
    detail: `${live.turns.length} mensajes en RAM. Consultá el registro en Historial; esta vista no verifica el archivo en disco.`,
  };
  return loaded ? { state: 'local', title: 'Registro local consultado',
    detail: `${conversations.length} conversaciones disponibles. Sin lectura activa; no es una verificación del disco.`,
  } : { state: 'idle', title: 'Sin lectura activa', detail: 'El registro local todavía no se consultó.' };
}

/** Solapas accesibles y anclaje; las acciones de datos las suministra la shell. */
export function createMemoryPanel({ root, browser, pin, onSelect = () => {} }) {
  const tabs = [...root.querySelectorAll('[data-memory-section]')];
  const panes = [...root.querySelectorAll('.memory-pane')];
  const tools = root.querySelector('.memory-tools');
  let selected = 'conversation';
  function select(name) {
    if (!tabs.some((tab) => tab.dataset.memorySection === name)) return;
    selected = name;
    for (const tab of tabs) {
      const active = tab.dataset.memorySection === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const pane of panes) pane.hidden = pane.id !== `memory-pane-${name}`;
    tools.hidden = name !== 'conversation';
    onSelect(name);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab.dataset.memorySection));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    });
  });
  pin.addEventListener('click', () => {
    const floating = !browser.classList.contains('panel-floating');
    browser.classList.toggle('panel-floating', floating);
    pin.setAttribute('aria-pressed', String(!floating));
    pin.setAttribute('aria-label', floating ? 'Fijar panel EVO' : 'Desfijar panel EVO');
    pin.title = floating ? 'Fijar: reservar espacio junto a la página' : 'Desfijar: mostrar el panel sobre la página';
  });
  return { select, get selected() { return selected; } };
}

/** Oculta sólo el contenido EVO; nunca el panel hermano de Comprensión. */
export function setMemoryPanelAvailability(root, enabled) {
  root.classList.toggle('evo-memory-disabled', !enabled);
  root.querySelector('#memoryDisabledNotice').hidden = enabled;
}

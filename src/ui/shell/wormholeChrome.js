/** Sólo presentación y preferencia de menú; no accede a motores ni al DOM de los sitios. */
export function createWormholeChrome({
  browser,
  leftButton,
  leftMenu,
  rightMenu,
  modeInput,
  closeButton,
  setSidebar,
  saveMode,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let mode = 'auto',
    timer = null,
    inside = false;
  function left(open) {
    browser.classList.toggle('left-menu-open', open);
    leftButton.setAttribute('aria-expanded', String(open));
    leftMenu.inert = !open;
  }
  function collapse(fromPointer = false) {
    if (mode === 'fixed' || (fromPointer && inside)) return;
    const focused = rightMenu.contains?.(document.activeElement);
    // Una selección hecha con mouse no debe dejar el modo automático abierto.
    // Al ocultar su contenido, no dejamos el foco en un control invisible.
    if (fromPointer && focused) document.activeElement?.blur?.();
    if (fromPointer || !focused) setSidebar(false);
  }
  function apply(value) {
    mode = value === 'fixed' ? 'fixed' : 'auto';
    browser.dataset.rightMenuMode = mode;
    modeInput.value = mode;
    closeButton.disabled = mode === 'fixed';
    closeButton.title =
      mode === 'fixed'
        ? 'Menú fijo: elegí modo automático en Ajustes para contraerlo'
        : 'Cerrar panel';
    setSidebar(
      mode === 'fixed' ||
        inside ||
        Boolean(rightMenu.contains?.(document.activeElement)),
    );
  }
  left(false);
  apply('auto');
  leftButton.addEventListener('click', () =>
    left(!browser.classList.contains('left-menu-open')),
  );
  leftMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      left(false);
      leftButton.focus();
    }
  });
  rightMenu.addEventListener('pointerenter', () => {
    inside = true;
    clearTimer(timer);
    if (mode === 'auto') setSidebar(true);
  });
  rightMenu.addEventListener('pointerleave', () => {
    inside = false;
    clearTimer(timer);
    timer = setTimer(() => collapse(true), 250);
  });
  rightMenu.addEventListener('focusin', () => {
    clearTimer(timer);
    if (mode === 'auto') setSidebar(true);
  });
  rightMenu.addEventListener('focusout', () => {
    if (!inside) {
      clearTimer(timer);
      timer = setTimer(collapse, 250);
    }
  });
  modeInput.addEventListener('change', async () => {
    const previous = mode,
      value = modeInput.value;
    modeInput.disabled = true;
    try {
      const saved = await saveMode(value);
      if (saved) apply(value);
      else apply(previous);
    } catch {
      apply(previous);
    } finally {
      modeInput.disabled = false;
    }
  });
  return {
    apply,
    get mode() {
      return mode;
    },
    dispose() {
      clearTimer(timer);
    },
  };
}

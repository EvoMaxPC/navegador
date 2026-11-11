import {
  COMMAND_DEFS,
  TOOLBAR_COMMANDS,
  DEFAULT_BINDINGS,
  acceleratorFor,
  bindingForEvent,
  shortcutConflicts,
} from '../../nav/shortcuts.js';
import { DEFAULT_BROWSER_PREFS } from '../../nav/browserPreferences.js';
const LABELS = {
  ...Object.fromEntries(COMMAND_DEFS.map((c) => [c.id, c.label])),
  extensions: 'Extensiones · no disponible',
};
const PATHS = {
  'work-dossier': 'M4 3h16v18H4ZM8 7h8M8 12h8M8 17h5',
  home: 'm3 10 9-7 9 7v10H4V10m5 10v-7h6v7',
  downloads: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  bookmarks: 'M6 3h12v18l-6-4-6 4Z',
  history: 'M3 12a9 9 0 1 0 3-6M3 3v6h6m6-2v5l3 2',
  screenshot: 'M4 7h4l2-3h4l2 3h4v13H4ZM8 13a4 4 0 1 0 8 0 4 4 0 0 0-8 0',
  translate:
    'M3 5h12M9 3v2m-4 3c2 5 5 7 9 8M13 5c-1 6-5 10-10 12m12 4 4-11 4 11m-7-3h6',
  reader: 'M4 3h16v18H4Zm4 5h8m-8 4h8m-8 4h5',
  split: 'M3 4h18v16H3Zm9 0v16',
  memory: 'M8 3H5v18h14V3h-3M8 3v6h8V3m-8 12h8',
  workspaces: 'M3 4h8v7H3Zm10 0h8v7h-8ZM3 13h8v7H3Zm10 0h8v7h-8Z',
  settings: 'M4 7h16M4 17h16M8 3v8m8 2v8',
};
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', PATHS[id] || 'M5 6h14M5 12h14M5 18h14');
  svg.append(path);
  return svg;
}
function button(label, fn, cls = 'ghost') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
export function createBrowserTools(api) {
  const {
    nexo,
    state,
    activeTab,
    createTab,
    activateTab,
    closeTab,
    runCommand,
    notice,
    scheduleSessionCapture,
  } = api;
  const platform = navigator.platform.includes('Mac') ? 'darwin' : 'linux';
  let prefs = structuredClone(DEFAULT_BROWSER_PREFS),
    workspace = 'main',
    splitId = null,
    bookmarksVisible = false,
    lastContext = null,
    lastActiveId = null;
  const toolbar = document.getElementById('quickTools');
  const bookmarkBar = document.getElementById('bookmarkBar');
  const menu = document.createElement('div');
  menu.className = 'context-surface';
  menu.role = 'menu';
  menu.hidden = true;
  document.body.append(menu);
  const modal = document.createElement('dialog');
  modal.className = 'tools-dialog';
  document.body.append(modal);
  let returnFocus = null;
  const recordShortcuts = (enabled) =>
    nexo.advanced
      .action({ action: 'shortcut-record', enabled })
      .catch(() => {});
  modal.addEventListener('close', () => {
    recordShortcuts(false);
    window.speechSynthesis?.cancel();
    modal.replaceChildren();
    returnFocus?.focus?.();
  });
  function dialog(title) {
    if (modal.open) modal.close();
    returnFocus = document.activeElement;
    modal.replaceChildren();
    const header = document.createElement('header');
    const h = document.createElement('h2');
    h.textContent = title;
    header.append(
      h,
      button('Cerrar', () => modal.close(), 'icon-label'),
    );
    modal.append(header);
    modal.showModal();
    return modal;
  }
  function note(text, parent = modal) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = text;
    parent.append(p);
    return p;
  }
  function visibleTabs() {
    return [...state.tabs.values()]
      .filter((t) => (t.workspaceId || 'main') === workspace)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  }
  function refreshLayout() {
    for (const tab of state.tabs.values()) {
      tab.tabEl.hidden = (tab.workspaceId || 'main') !== workspace;
      tab.tabEl.classList.toggle('pinned', Boolean(tab.pinned));
      tab.tabEl.title = `${tab.title}${tab.pinned ? ' · fijada' : ''}${tab.muted ? ' · sin sonido' : ''}`;
    }
    const ordered = visibleTabs();
    for (const tab of ordered)
      document.getElementById('tabs').append(tab.tabEl);
    const selected = state.tabs.get(splitId);
    if (
      !selected ||
      selected.workspaceId !== workspace ||
      selected.id === state.activeId
    )
      splitId = null;
    document
      .getElementById('viewport')
      .classList.toggle('split-view', Boolean(splitId));
    for (const tab of state.tabs.values()) {
      tab.view.classList.toggle('split-secondary', tab.id === splitId);
      tab.view.classList.toggle(
        'split-primary',
        Boolean(splitId) && tab.id === state.activeId,
      );
      tab.view.classList.toggle(
        'hidden',
        tab.id !== state.activeId && tab.id !== splitId,
      );
    }
    // Boolean explícito: sin barra lateral, la comparación devolvía null y el
    // botón quedaba con aria-pressed="null", que no es un valor válido.
    const panelOpen = (command) =>
      document.querySelector('.browser.with-sidebar') &&
      document.querySelector('.stab.active')?.dataset.panel ===
        (command === 'work-dossier' ? 'work' : command);
    toolbar.querySelectorAll('[data-command]').forEach((b) => {
      const command = b.dataset.command;
      const pressed =
        (command === 'split' && Boolean(splitId)) ||
        ([
          'memory',
          'user-understanding',
          'work-dossier',
          'downloads',
          'history',
          'bookmarks',
          'settings',
        ].includes(command) &&
          Boolean(panelOpen(command)));
      b.setAttribute('aria-pressed', String(Boolean(pressed)));
    });
    document.getElementById('workspaceLabel').textContent =
      prefs.workspaces.find((w) => w.id === workspace)?.name || 'Principal';
  }
  function selectWorkspace(id) {
    if (!prefs.workspaces.some((w) => w.id === id)) return;
    workspace = id;
    splitId = null;
    const next = visibleTabs()[0];
    if (next) activateTab(next.id);
    else createTab(undefined, { workspaceId: id });
    refreshLayout();
  }
  async function persist(next) {
    const result = await nexo.advanced.setPreferences(next);
    if (!result?.ok) {
      notice(result?.error || 'No se pudo guardar la configuración');
      return false;
    }
    prefs = result.prefs;
    api.onPreferences?.(prefs);
    renderToolbar();
    return true;
  }
  async function privileged(action, extra = {}) {
    const tab = activeTab();
    const capture = action.startsWith('capture-');
    const control = toolbar.querySelector('[data-command="screenshot"]');
    if (capture) {
      notice('Generando captura… podés seguir navegando.');
      control?.setAttribute('aria-busy', 'true');
    }
    try {
      const result = await nexo.advanced.action({
        action,
        webContentsId: tab?.view.getWebContentsId(),
        ...extra,
      });
      if (!result?.ok && !result?.cancelled)
        notice(result?.error || 'La acción no está disponible');
      if (result?.note) notice(result.note);
      return result;
    } catch (error) {
      notice(error.message);
      return { ok: false };
    } finally {
      if (capture) control?.removeAttribute('aria-busy');
    }
  }
  function renderToolbar() {
    toolbar.replaceChildren();
    for (const id of prefs.toolbar) {
      const b = button('', () => runCommand({ type: id }), 'icon-btn');
      b.append(icon(id));
      b.dataset.command = id;
      b.disabled = id === 'extensions';
      b.title = `${LABELS[id]}${acceleratorFor(id, platform, prefs.shortcuts) ? ' · ' + acceleratorFor(id, platform, prefs.shortcuts) : ''}`;
      b.setAttribute('aria-label', LABELS[id]);
      b.setAttribute('aria-pressed', 'false');
      toolbar.append(b);
    }
    const edit = button('', () => configureToolbar(), 'icon-btn');
    edit.append(icon('settings'));
    edit.title = 'Personalizar accesos rápidos';
    edit.setAttribute('aria-label', edit.title);
    toolbar.append(edit);
    refreshLayout();
  }
  function popup(items, x, y) {
    (modal.open ? modal : document.body).append(menu);
    menu.replaceChildren();
    let lastFocus = document.activeElement;
    for (const item of items) {
      if (item.type === 'separator') {
        const hr = document.createElement('hr');
        hr.role = 'separator';
        menu.append(hr);
        continue;
      }
      const b = button(
        item.label,
        () => {
          menu.hidden = true;
          lastFocus?.focus?.();
          Promise.resolve()
            .then(item.run)
            .catch((e) => notice(e.message));
        },
        'context-item',
      );
      b.role = 'menuitem';
      b.prepend(
        icon(
          /imagen|captur/i.test(item.label)
            ? 'screenshot'
            : /enlace|dirección/i.test(item.label)
              ? 'home'
              : /copiar|guardar|favorit/i.test(item.label)
                ? 'bookmarks'
                : /lectura|leer|texto/i.test(item.label)
                  ? 'reader'
                  : 'settings',
        ),
      );
      menu.append(b);
    }
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.maxHeight = `${Math.max(60, innerHeight - 16)}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
    menu.querySelector('button')?.focus();
    menu.onkeydown = (event) => {
      const all = [...menu.querySelectorAll('button')];
      let i = all.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        menu.hidden = true;
        lastFocus?.focus();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        i =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? all.length - 1
              : (i + (event.key === 'ArrowDown' ? 1 : -1) + all.length) %
                all.length;
        all[i]?.focus();
      }
    };
  }
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!menu.contains(event.target)) menu.hidden = true;
    },
    true,
  );
  window.addEventListener('blur', () => {
    menu.hidden = true;
  });
  window.addEventListener('resize', () => {
    menu.hidden = true;
  });
  function nativeContext(data) {
    const tab = [...state.tabs.values()].find((t) => {
      try {
        return t.view.getWebContentsId() === data.webContentsId;
      } catch {
        return false;
      }
    });
    if (!tab || tab.workspaceId !== workspace) return;
    const rect = tab.view.getBoundingClientRect();
    lastContext = { ...data, expires: Date.now() + 30000 };
    popup(
      data.items.map((item) =>
        item.type === 'separator'
          ? item
          : {
              label: item.label,
              run: () => {
                lastContext = null;
                return nexo.advanced
                  .context({ token: data.token, id: item.id })
                  .then((r) => {
                    if (!r?.ok) notice(r?.error || 'Acción no disponible');
                  });
              },
            },
      ),
      rect.left + data.x,
      rect.top + data.y,
    );
  }
  nexo.on('nexo:context-menu', (data) => {
    if (!data.shell) {
      nativeContext(data);
    } else
      popup(
        data.items.map((i) =>
          i.type === 'separator'
            ? i
            : {
                label: i.label,
                run: () =>
                  nexo.advanced
                    .context({ token: data.token, id: i.id })
                    .then((result) => {
                      if (!result?.ok)
                        notice(
                          result?.error || 'La acción ya no está disponible',
                        );
                    }),
              },
        ),
        data.x,
        data.y,
      );
  });
  nexo.on('nexo:downloads-changed', (stats) => {
    if (typeof stats?.active !== 'number') return;
    const control = toolbar.querySelector('[data-command="downloads"]');
    if (!control) return;
    control.classList.toggle('has-downloads', stats.active > 0);
    control.title = stats.active
      ? `Descargas · ${stats.active} activas`
      : 'Descargas';
  });
  function tabMenu(tab, event) {
    event.preventDefault();
    const list = visibleTabs(),
      index = list.indexOf(tab);
    const actions = [
      { label: 'Nueva pestaña', run: () => createTab() },
      {
        label: 'Duplicar pestaña',
        run: () => createTab(tab.url, { workspaceId: tab.workspaceId }),
      },
      {
        label: tab.pinned ? 'Desfijar pestaña' : 'Fijar pestaña',
        run: () => {
          tab.pinned = !tab.pinned;
          refreshLayout();
          scheduleSessionCapture();
        },
      },
      {
        label: tab.muted ? 'Activar sonido' : 'Silenciar pestaña',
        run: () => {
          tab.muted = !tab.muted;
          tab.view.setAudioMuted(tab.muted);
          refreshLayout();
        },
      },
      // Mismo diálogo que el botón de la cabecera: una sola forma de buscar
      // pestañas, también desde el menú contextual.
      ...(api.searchTabs
        ? [{ label: 'Buscar pestañas…', run: () => api.searchTabs() }]
        : []),
      { label: 'Cerrar pestaña', run: () => closeTab(tab.id) },
    ];
    const others = list.filter((t) => t !== tab && !t.pinned);
    if (others.length)
      actions.push({
        label: 'Cerrar otras pestañas no fijadas',
        run: () => others.forEach((t) => closeTab(t.id)),
      });
    const right = list.slice(index + 1).filter((t) => !t.pinned);
    if (right.length)
      actions.push({
        label: 'Cerrar pestañas a la derecha no fijadas',
        run: () => right.forEach((t) => closeTab(t.id)),
      });
    if (state.closed.length)
      actions.push({
        label: 'Restaurar pestaña cerrada',
        run: () => runCommand({ type: 'reopen-tab' }),
      });
    for (const w of prefs.workspaces.filter((w) => w.id !== tab.workspaceId))
      actions.push({
        label: `Mover a ${w.name}`,
        run: () => {
          tab.workspaceId = w.id;
          if (tab.id === state.activeId) {
            const next = visibleTabs()[0];
            if (next) activateTab(next.id);
            else createTab(undefined, { workspaceId: workspace });
          }
          refreshLayout();
          scheduleSessionCapture();
        },
      });
    actions.push({
      label: 'Copiar dirección de página',
      run: async () => {
        activateTab(tab.id);
        await privileged('copy-url');
      },
    });
    popup(actions, event.clientX, event.clientY);
  }
  function configureToolbar() {
    dialog('Personalizar accesos rápidos');
    note(
      'Agregá, ocultá y reordená botones. Los cambios se guardan en este perfil.',
    );
    const panel = document.createElement('div');
    modal.append(panel);
    const draw = () => {
      panel.replaceChildren();
      for (const id of TOOLBAR_COMMANDS) {
        const row = document.createElement('div');
        row.className = 'tool-config-row';
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = prefs.toolbar.includes(id);
        input.onchange = async () => {
          await persist({
            ...prefs,
            toolbar: input.checked
              ? [...prefs.toolbar, id]
              : prefs.toolbar.filter((v) => v !== id),
          });
          draw();
        };
        label.append(input, document.createTextNode(LABELS[id]));
        row.append(label);
        panel.append(row);
      }
      const title = document.createElement('h3');
      title.textContent = 'Orden de los botones visibles';
      panel.append(title);
      for (const [i, id] of prefs.toolbar.entries()) {
        const row = document.createElement('div');
        row.className = 'tool-config-row';
        const text = document.createElement('span');
        text.textContent = LABELS[id];
        row.append(text);
        for (const delta of [-1, 1]) {
          const b = button(delta < 0 ? '↑' : '↓', async () => {
            const toolbar = [...prefs.toolbar];
            [toolbar[i], toolbar[i + delta]] = [toolbar[i + delta], toolbar[i]];
            await persist({ ...prefs, toolbar });
            draw();
          });
          b.disabled = i + delta < 0 || i + delta >= prefs.toolbar.length;
          b.setAttribute(
            'aria-label',
            `${delta < 0 ? 'Subir' : 'Bajar'} ${LABELS[id]}`,
          );
          row.append(b);
        }
        panel.append(row);
      }
    };
    draw();
    note(
      'Extensiones: no existe un gestor compatible en esta versión. No se ofrece un botón operativo ficticio.',
    );
  }
  function configureKeys() {
    dialog('Atajos, buscador e idiomas');
    note(
      'Ctrl se interpreta como Command en macOS. AltGr y combinaciones sin modificador no se capturan, salvo F3/F11/Escape. Los atajos del navegador configurados aquí son globales dentro de Nexo.',
    );
    const draft = { ...DEFAULT_BINDINGS, ...prefs.shortcuts };
    const feedback = note('');
    const list = document.createElement('div');
    list.className = 'keyboard-settings';
    modal.append(list);
    for (const command of COMMAND_DEFS.filter((c) => c.id !== 'escape')) {
      const row = document.createElement('label');
      row.className = 'shortcut-row';
      const text = document.createElement('span');
      text.textContent = command.label;
      const field = document.createElement('input');
      field.value = draft[command.id] || '';
      field.setAttribute('aria-label', `Atajo: ${command.label}`);
      field.placeholder = 'Sin atajo';
      field.addEventListener('focus', () => recordShortcuts(true));
      field.addEventListener('blur', () => recordShortcuts(false));
      field.onkeydown = (event) => {
        if (event.key === 'Tab') return;
        event.preventDefault();
        if (event.key === 'Backspace' || event.key === 'Delete')
          field.value = '';
        else if (event.key === 'Escape') return;
        else {
          const binding = bindingForEvent(
            event,
            navigator.platform.includes('Mac') ? 'darwin' : 'linux',
          );
          if (binding) field.value = binding;
        }
        draft[command.id] = field.value;
        feedback.textContent = shortcutConflicts(draft).join('\n');
      };
      row.append(text, field);
      list.append(row);
    }
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Buscador predeterminado');
    for (const [value, label] of [
      ['duckduckgo', 'DuckDuckGo'],
      ['google', 'Google'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = prefs.search;
    modal.append(select);
    const spelling = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = prefs.spellcheck;
    spelling.append(
      check,
      document.createTextNode(' Habilitar corrector ortográfico de Chromium'),
    );
    modal.append(spelling);
    const languages = document.createElement('input');
    languages.value = prefs.spellLanguages.join(',');
    languages.setAttribute(
      'aria-label',
      'Idiomas del corrector separados por coma',
    );
    modal.append(languages);
    note(
      `Idiomas disponibles: ${(prefs.availableSpellLanguages || []).join(', ') || 'dependen de la instalación de Electron'}. Las páginas pueden desactivar la edición o el corrector.`,
    );
    modal.append(
      button('Guardar', async () => {
        const errors = shortcutConflicts(draft);
        if (errors.length) {
          feedback.textContent = errors.join('\n');
          return;
        }
        if (
          await persist({
            ...prefs,
            shortcuts: draft,
            search: select.value,
            spellcheck: check.checked,
            spellLanguages: languages.value.split(',').map((v) => v.trim()),
          })
        )
          modal.close();
      }),
      button('Restaurar atajos predeterminados', async () => {
        if (await persist({ ...prefs, shortcuts: {} })) configureKeys();
      }),
    );
  }
  function workspaces() {
    dialog('Espacios de trabajo');
    note(
      'Agrupan pestañas del mismo perfil. No son perfiles aislados ni navegación privada.',
    );
    for (const w of prefs.workspaces)
      modal.append(
        button(`${w.id === workspace ? '● ' : ''}${w.name}`, () => {
          selectWorkspace(w.id);
          modal.close();
        }),
      );
    const input = document.createElement('input');
    input.placeholder = 'Nombre del nuevo espacio';
    input.maxLength = 50;
    input.setAttribute('aria-label', 'Nombre del espacio');
    modal.append(
      input,
      button('Crear espacio', async () => {
        const name = input.value.trim();
        if (!name) return;
        if (prefs.workspaces.length >= 20) {
          notice('Límite: 20 espacios');
          return;
        }
        const id = `space-${Date.now().toString(36)}`;
        if (
          await persist({
            ...prefs,
            workspaces: [...prefs.workspaces, { id, name }],
          })
        ) {
          selectWorkspace(id);
          modal.close();
        }
      }),
    );
  }
  async function toggleBookmarkBar() {
    bookmarksVisible = !bookmarksVisible;
    bookmarkBar.hidden = !bookmarksVisible;
    if (!bookmarksVisible) return;
    bookmarkBar.replaceChildren();
    const items = await nexo.bookmarks.list({});
    if (!items.length) {
      bookmarkBar.textContent = 'Sin favoritos. Agregá una página con Ctrl+D.';
      return;
    }
    for (const item of items.slice(0, 30)) {
      const b = button(
        item.title || item.url,
        () => api.navigate(item.url),
        'bookmark-shortcut',
      );
      b.title = item.url;
      bookmarkBar.append(b);
    }
  }
  function commandCenter() {
    menu.hidden = true;
    dialog('Centro de comandos');
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Buscar una acción…';
    input.setAttribute('aria-label', 'Buscar comandos');
    const list = document.createElement('div');
    list.className = 'command-results';
    modal.append(input, list);
    note(
      'Para descargar una imagen original: clic derecho sobre la imagen. Las acciones contextuales disponibles durante 30 segundos también aparecen aquí.',
    );
    // Navegación de teclado completa: flechas recorren resultados, Inicio/Fin
    // van a los extremos y Escape vuelve al buscador antes de cerrar.
    let cursor = -1;
    const focusResult = (index) => {
      const buttons = [...list.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) return;
      cursor = (index + buttons.length) % buttons.length;
      buttons[cursor].focus();
    };
    const render = () => {
      list.replaceChildren();
      cursor = -1;
      let commands = COMMAND_DEFS.filter(
        (c) => c.id !== 'escape' && c.id !== 'command-center',
      );
      const query = input.value.toLocaleLowerCase();
      // Coincide por nombre o por atajo escrito («shift a», «ctrl j»).
      const matches = (c) => {
        if (!query.trim()) return true;
        if (c.label.toLocaleLowerCase().includes(query)) return true;
        // «ctrl j», «ctrl+j» y «ctrlj» encuentran el mismo atajo.
        const compact = (text) => text.toLocaleLowerCase().replace(/[\s+]/g, '');
        return compact(acceleratorFor(c.id, platform, prefs.shortcuts)).includes(compact(query));
      };
      for (const c of commands.filter(matches)) {
        const b = button(
          `${c.label}   ${acceleratorFor(c.id, platform, prefs.shortcuts)}`,
          () => {
            modal.close();
            runCommand({ type: c.id });
          },
          'command-result',
        );
        b.disabled =
          (!activeTab() &&
            ![
              'new-tab',
              'reopen-tab',
              'workspaces',
              'workspace-new',
              'work-dossier',
              'history',
              'downloads',
              'bookmarks',
              'memory',
              'settings',
              'keyboard-settings',
              'toolbar-settings',
              'fullscreen',
              'toggle-sidebar',
              'toggle-engine',
              'activity',
              'sites',
              'bookmark-bar',
            ].includes(c.id)) ||
          (c.id === 'reopen-tab' && !state.closed.length) ||
          (c.id === 'move-workspace' && prefs.workspaces.length < 2) ||
          (c.id === 'close-others' &&
            !visibleTabs().some((t) => t !== activeTab() && !t.pinned)) ||
          (c.id === 'close-right' &&
            !visibleTabs()
              .slice(visibleTabs().indexOf(activeTab()) + 1)
              .some((t) => !t.pinned));
        list.append(b);
      }
      if (lastContext && lastContext.expires > Date.now())
        for (const item of lastContext.items.filter(
          (i) =>
            i.id &&
            !i.commandId &&
            i.label
              .toLocaleLowerCase()
              .includes(input.value.toLocaleLowerCase()),
        )) {
          const token = lastContext.token;
          list.append(
            button(
              item.label,
              async () => {
                lastContext = null;
                modal.close();
                const result = await nexo.advanced.context({
                  token,
                  id: item.id,
                });
                if (!result?.ok)
                  notice(result?.error || 'El contexto ya no está disponible');
              },
              'command-result',
            ),
          );
        }
    };
    input.oninput = render;
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusResult(e.key === 'ArrowDown' ? 0 : -1);
      } else if (e.key === 'Enter') list.querySelector('button:not(:disabled)')?.click();
    };
    list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusResult(cursor + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusResult(e.key === 'Home' ? 0 : -1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.focus();
      }
    });
    render();
    input.focus();
  }
  function reading(data) {
    dialog(data.title || 'Lectura');
    const actions = document.createElement('div');
    const body = document.createElement(data.source ? 'pre' : 'article');
    body.className = data.source ? 'source-reading' : 'reader-content';
    body.textContent = data.text;
    modal.append(actions, body);
    if (!data.source) {
      if ('speechSynthesis' in window) {
        actions.append(
          button('Leer en voz alta', () => {
            speechSynthesis.cancel();
            const speech = new SpeechSynthesisUtterance(
              data.text.slice(0, 50000),
            );
            speech.lang = 'es';
            speechSynthesis.speak(speech);
          }),
          button('Detener lectura', () => speechSynthesis.cancel()),
        );
        note(
          'Lectura con las voces disponibles del sistema; algunos proveedores de voz pueden usar servicios de red.',
          actions,
        );
      } else
        note('Síntesis de voz no disponible en esta instalación.', actions);
    }
    if (data.speak && 'speechSynthesis' in window)
      notice('Selección preparada. Elegí Leer en voz alta para iniciar.');
  }
  nexo.on('nexo:reading', reading);
  nexo.on('nexo:browser-prefs', (next) => {
    prefs = { ...prefs, ...next };
    api.onPreferences?.(prefs);
    renderToolbar();
  });
  function rectangularCapture() {
    const tab = activeTab();
    if (!tab) return;
    const bounds = tab.view.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.className = 'capture-overlay';
    overlay.style.cssText = `left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px`;
    overlay.tabIndex = 0;
    overlay.setAttribute(
      'aria-label',
      'Arrastrá para seleccionar. Escape cancela.',
    );
    const area = document.createElement('div');
    area.className = 'capture-rectangle';
    overlay.append(area);
    document.body.append(overlay);
    overlay.focus();
    let start;
    overlay.onkeydown = (e) => {
      if (e.key === 'Escape') overlay.remove();
    };
    overlay.onpointerdown = (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
      overlay.setPointerCapture(e.pointerId);
    };
    const rectangle = (e) => ({
      x: Math.max(0, Math.min(start.x, e.clientX - bounds.left)),
      y: Math.max(0, Math.min(start.y, e.clientY - bounds.top)),
      width: Math.min(
        bounds.width,
        Math.abs(e.clientX - bounds.left - start.x),
      ),
      height: Math.min(
        bounds.height,
        Math.abs(e.clientY - bounds.top - start.y),
      ),
    });
    overlay.onpointermove = (e) => {
      if (!start) return;
      const r = rectangle(e);
      area.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;
    };
    overlay.onpointerup = async (e) => {
      if (!start) return;
      const r = rectangle(e);
      r.width = Math.min(r.width, bounds.width - r.x);
      r.height = Math.min(r.height, bounds.height - r.y);
      overlay.remove();
      if (r.width < 2 || r.height < 2) return;
      try {
        const result = await nexo.advanced.action({
          action: 'capture-region',
          webContentsId: tab.view.getWebContentsId(),
          rect: r,
        });
        if (!result?.ok && !result?.cancelled)
          notice(result?.error || 'No se pudo capturar');
      } catch (error) {
        notice(error.message);
      }
    };
  }
  const remote = {
    print: 'print',
    'save-page': 'save-page',
    screenshot: 'capture-visible',
    'screenshot-full': 'capture-full',
    'screenshot-copy': 'capture-copy',
    fullscreen: 'fullscreen',
    translate: 'translate',
    reader: 'reader',
    'copy-url': 'copy-url',
    'share-page': 'share-page',
    'view-source': 'view-source',
  };
  function handle(command) {
    if (
      command.type === 'reader' &&
      modal.open &&
      modal.querySelector('.reader-content')
    ) {
      modal.close();
      return true;
    }
    if (remote[command.type]) {
      privileged(remote[command.type]);
      return true;
    }
    switch (command.type) {
      case 'command-center':
        commandCenter();
        return true;
      case 'keyboard-settings':
        configureKeys();
        return true;
      case 'toolbar-settings':
        configureToolbar();
        return true;
      case 'workspaces':
      case 'workspace-new':
        workspaces();
        return true;
      case 'bookmark-bar':
        toggleBookmarkBar().catch((e) => notice(e.message));
        return true;
      case 'screenshot-region':
        rectangularCapture();
        return true;
      case 'close-others': {
        const current = activeTab();
        if (current)
          visibleTabs()
            .filter((t) => t !== current && !t.pinned)
            .forEach((t) => closeTab(t.id));
        return true;
      }
      case 'close-right': {
        const list = visibleTabs(),
          index = list.indexOf(activeTab());
        if (index >= 0)
          list
            .slice(index + 1)
            .filter((t) => !t.pinned)
            .forEach((t) => closeTab(t.id));
        return true;
      }
      case 'move-workspace': {
        const tab = activeTab();
        if (!tab) return true;
        dialog('Mover pestaña a otro espacio');
        for (const w of prefs.workspaces.filter(
          (w) => w.id !== tab.workspaceId,
        ))
          modal.append(
            button(w.name, () => {
              tab.workspaceId = w.id;
              const next = visibleTabs()[0];
              if (next) activateTab(next.id);
              else createTab(undefined, { workspaceId: workspace });
              refreshLayout();
              scheduleSessionCapture();
              modal.close();
            }),
          );
        return true;
      }
      case 'duplicate-tab': {
        const t = activeTab();
        if (t) createTab(t.url, { workspaceId: t.workspaceId });
        return true;
      }
      case 'pin-tab': {
        const t = activeTab();
        if (t) {
          t.pinned = !t.pinned;
          refreshLayout();
          scheduleSessionCapture();
        }
        return true;
      }
      case 'mute-tab': {
        const t = activeTab();
        if (t) {
          t.muted = !t.muted;
          t.view.setAudioMuted(t.muted);
          refreshLayout();
        }
        return true;
      }
      case 'split': {
        if (splitId) {
          splitId = null;
          refreshLayout();
          return true;
        }
        const candidates = visibleTabs().filter((t) => t.id !== state.activeId);
        if (!candidates.length) {
          notice('Abrí otra pestaña en este espacio para dividir la vista.');
          return true;
        }
        dialog('Elegir segunda pestaña');
        for (const t of candidates)
          modal.append(
            button(t.title || t.url, () => {
              splitId = t.id;
              modal.close();
              refreshLayout();
            }),
          );
        return true;
      }
      default:
        return false;
    }
  }
  return {
    handle,
    setRightMenuMode:mode=>persist({...prefs,rightMenuMode:mode}),
    setUIZoom:level=>persist({...prefs,uiZoom:level}),
    get uiZoom(){return prefs.uiZoom||1;},
    tabMenu,
    refreshLayout,
    visibleTabs,
    get workspace() {
      return workspace;
    },
    get searchBase() {
      return prefs.search === 'google'
        ? 'https://www.google.com/search?q='
        : 'https://duckduckgo.com/?q=';
    },
    workspaceName(id) {
      return prefs.workspaces.find((w) => w.id === id)?.name || id;
    },
    resolveWorkspace(id) {
      return prefs.workspaces.some((w) => w.id === id) ? id : 'main';
    },
    clearContext() {
      menu.hidden = true;
      lastContext = null;
    },
    activated(tab) {
      if (lastActiveId !== tab.id) {
        menu.hidden = true;
        lastContext = null;
      }
      if (splitId === tab.id && lastActiveId && state.tabs.has(lastActiveId))
        splitId = lastActiveId;
      workspace = tab.workspaceId || 'main';
      lastActiveId = tab.id;
      refreshLayout();
    },
    async load() {
      try {
        const next = await nexo.advanced.preferences();
        if (next) prefs = next;
      } catch {
        notice('No se pudieron cargar las preferencias de herramientas.');
      }
      api.onPreferences?.(prefs);
      renderToolbar();
    },
  };
}

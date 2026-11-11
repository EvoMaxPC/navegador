/** Herramientas de navegador. Sólo acepta órdenes de la shell exacta y su frame principal. */
import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  clipboard,
  dialog,
  nativeImage,
  ShareMenu,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  browserPreferences,
  DEFAULT_BROWSER_PREFS,
} from '../nav/browserPreferences.js';
import { commandFor } from '../nav/shortcuts.js';
import { safeExternalUrl } from './validate.js';
import { sanitizeFilename } from '../nav/downloads.js';
const SHELL_URL = 'nexo://app/src/ui/shell/index.html';
const safeWeb = (value) => {
  const url = safeExternalUrl(value);
  return url && /^https?:/.test(url) ? url : null;
};
const bounded = (value) => String(value || '').slice(0, 50000);
export function installAdvancedBrowser({
  getProfile,
  downloadItems,
  broadcast,
  onPreferences,
  onCaptureEvidence,
}) {
  const file = join(app.getPath('userData'), 'browser-tools.json');
  let prefs;
  try {
    prefs = browserPreferences(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    prefs = browserPreferences(DEFAULT_BROWSER_PREFS);
  }
  const guests = new Map(),
    contexts = new Map(),
    busy = new Set(),
    recording = new Set();
  let saving = Promise.resolve();
  function trusted(event) {
    return (
      event.senderFrame === event.sender.mainFrame &&
      event.sender.getURL() === SHELL_URL &&
      BrowserWindow.getAllWindows().some((w) => w.webContents === event.sender)
    );
  }
  function target(sender, id) {
    const entry = guests.get(Number(id));
    if (!entry || entry.owner !== sender || entry.contents.isDestroyed())
      throw Error('Pestaña ajena o cerrada');
    return entry.contents;
  }
  const emit = (owner, type, extra = {}) => {
    if (!owner.isDestroyed()) owner.send('nexo:command', { type, ...extra });
  };
  function availableSpelling(session) {
    return session.availableSpellCheckerLanguages || [];
  }
  function applySpelling(contents) {
    contents.session.setSpellCheckerEnabled(prefs.spellcheck);
    const available = availableSpelling(contents.session);
    const languages = prefs.spellLanguages.filter((l) => available.includes(l));
    if (languages.length) contents.session.setSpellCheckerLanguages(languages);
  }
  function handleInput(event, input, contents, owner) {
    if (
      input.type !== 'keyDown' ||
      input.isComposing ||
      (contents === owner && recording.has(owner.id))
    )
      return;
    const command = commandFor(input, {
      platform: process.platform,
      bindings: prefs.shortcuts,
    });
    if (!command || command === 'escape') return;
    event.preventDefault();
    emit(owner, command, {
      webContentsId: contents.getType() === 'webview' ? contents.id : undefined,
    });
  }
  async function external(owner, url) {
    const allowed = safeWeb(url);
    if (!allowed) return;
    const choice = await dialog.showMessageBox(
      BrowserWindow.fromWebContents(owner),
      {
        type: 'question',
        buttons: ['Cancelar', 'Abrir servicio externo'],
        defaultId: 0,
        cancelId: 0,
        message:
          'Esta acción envía la URL o el texto seleccionado a un servicio externo.',
        detail: new URL(allowed).hostname,
      },
    );
    if (choice.response === 1) emit(owner, 'open', { url: allowed });
  }
  function newWindow(url) {
    const allowed = safeWeb(url);
    if (!allowed) return;
    const w = new BrowserWindow({
      width: 1100,
      height: 800,
      backgroundColor: '#07090d',
      webPreferences: {
        partition: 'persist:nexo',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: prefs.spellcheck,
      },
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('context-menu', (_event, p) => {
      const items = [];
      const add = (label, click) => items.push({ label, click });
      const link = safeWeb(p.linkURL),
        src = safeWeb(p.srcURL);
      if (link) {
        add('Abrir enlace en esta ventana', () => w.loadURL(link));
        add('Copiar enlace', () => clipboard.writeText(link));
        add('Guardar enlace como…', () => download(w.webContents, link, true));
      }
      if (p.mediaType === 'image') {
        if (src) {
          add('Abrir imagen original', () => w.loadURL(src));
          add('Guardar imagen original…', () =>
            download(w.webContents, src, true),
          );
          add('Copiar dirección de imagen', () => clipboard.writeText(src));
        }
        if (p.hasImageContents)
          add('Copiar imagen', () => w.webContents.copyImageAt(p.x, p.y));
      }
      if (p.isEditable) {
        for (const [label, method, flag] of [
          ['Deshacer', 'undo', 'canUndo'],
          ['Rehacer', 'redo', 'canRedo'],
          ['Cortar', 'cut', 'canCut'],
          ['Copiar', 'copy', 'canCopy'],
          ['Pegar', 'paste', 'canPaste'],
          ['Seleccionar todo', 'selectAll', 'canSelectAll'],
        ])
          if (p.editFlags?.[flag]) add(label, () => w.webContents[method]());
      } else if (p.selectionText) add('Copiar', () => w.webContents.copy());
      if (!items.length) {
        if (w.webContents.navigationHistory.canGoBack())
          add('Atrás', () => w.webContents.navigationHistory.goBack());
        if (w.webContents.navigationHistory.canGoForward())
          add('Adelante', () => w.webContents.navigationHistory.goForward());
        add('Recargar', () => w.webContents.reload());
        add('Imprimir…', () => w.webContents.print({ silent: false }));
      }
      if (w.webContents.isDevToolsOpened())
        add('Inspeccionar', () => w.webContents.inspectElement(p.x, p.y));
      if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
    });
    w.webContents.on('will-navigate', (event, next) => {
      if (!safeWeb(next)) event.preventDefault();
    });
    w.loadURL(allowed).catch(() => {});
  }
  function download(contents, url, saveAs) {
    const allowed = safeWeb(url);
    if (!allowed)
      throw Error(
        'Sólo descargas HTTP/HTTPS originales; no se eluden restricciones del sitio.',
      );
    // No se descarga dos veces ni se convierte una imagen: DownloadItem decide el formato original.
    // Sin setSavePath: Electron ofrece el diálogo nativo de ubicación/nombre.
    contents.downloadURL(allowed);
  }
  async function saveImage(owner, image, title = 'Captura Nexo') {
    if (image.isEmpty()) throw Error('La página no produjo una imagen');
    const selected = await dialog.showSaveDialog(
      BrowserWindow.fromWebContents(owner),
      {
        title,
        defaultPath: join(app.getPath('pictures'), `Nexo-${Date.now()}.png`),
        filters: [{ name: 'PNG', extensions: ['png'] }],
      },
    );
    if (selected.canceled || !selected.filePath)
      return { ok: false, cancelled: true };
    await writeFile(selected.filePath, image.toPNG());
    return { ok: true };
  }
  async function capture(owner, contents, mode, rect) {
    if (busy.has(contents.id)) throw Error('Hay una captura en curso');
    busy.add(contents.id);
    const href = contents.getURL();
    let attached = false,
      navigated = false;
    const releaseOwned = () => {
      if (!attached) return;
      attached = false;
      if (!contents.isDestroyed() && contents.debugger.isAttached())
        contents.debugger.detach();
    };
    const onNavigation = (_event, _url, _inPage, main) => {
      if (!main) return;
      navigated = true;
      // Antes del observador normal: no bloquear su attach ni separar su sesión nueva.
      releaseOwned();
    };
    contents.prependListener('did-start-navigation', onNavigation);
    try {
      let image;
      if (mode === 'region' && !rect)
        throw Error('Falta el rectángulo de captura');
      if (mode === 'full') {
        // No se desengancha un depurador ajeno (incluido el observador de Nexo).
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach('1.3');
          attached = true;
        }
        const layout = await contents.debugger.sendCommand(
          'Page.getLayoutMetrics',
        );
        const size = layout.cssContentSize || layout.contentSize;
        if (
          !size ||
          size.width > 16384 ||
          size.height > 32768 ||
          size.width * size.height > 40000000
        )
          throw Error(
            'Página demasiado grande: usá captura visible o rectangular (límite 40 MP).',
          );
        const result = await contents.debugger.sendCommand(
          'Page.captureScreenshot',
          {
            format: 'png',
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width: Math.ceil(size.width),
              height: Math.ceil(size.height),
              scale: 1,
            },
          },
        );
        image = nativeImage.createFromBuffer(
          Buffer.from(result.data, 'base64'),
        );
      } else {
        let area;
        if (rect) {
          const values = ['x', 'y', 'width', 'height'].map((k) => rect[k]);
          if (
            !values.every(Number.isFinite) ||
            rect.x < 0 ||
            rect.y < 0 ||
            rect.width < 1 ||
            rect.height < 1 ||
            rect.width * rect.height > 40000000
          )
            throw Error('Rectángulo inválido');
          area = Object.fromEntries(
            ['x', 'y', 'width', 'height'].map((k) => [k, Math.round(rect[k])]),
          );
        }
        image = area
          ? await contents.capturePage(area)
          : await contents.capturePage();
      }
      releaseOwned();
      if (navigated || contents.isDestroyed() || contents.getURL() !== href)
        throw Error('La página cambió durante la captura. Reintentá.');
      if (image.isEmpty())
        throw Error('No se pudo obtener la imagen de la página');
      if (mode === 'copy') {
        clipboard.writeImage(image);
        return { ok: true };
      }
      const choice = await dialog.showMessageBox(
        BrowserWindow.fromWebContents(owner),
        {
          type: 'question',
          message: 'Captura lista',
          buttons: ['Guardar PNG…', 'Copiar imagen', 'Cancelar'],
          defaultId: 0,
          cancelId: 2,
        },
      );
      if (choice.response === 1) {
        clipboard.writeImage(image);
        return { ok: true, note: 'Captura copiada al portapapeles' };
      }
      if (choice.response !== 0) return { ok: false, cancelled: true };
      return await saveImage(owner, image);
    } finally {
      try {
        releaseOwned();
      } finally {
        contents.removeListener('did-start-navigation', onNavigation);
        busy.delete(contents.id);
      }
    }
  }
  async function action(owner, contents, kind, payload = {}) {
    const url = contents ? safeWeb(contents.getURL()) : null;
    switch (kind) {
      case 'print':
        return await new Promise((resolve) =>
          contents.print(
            { silent: false, printBackground: true },
            (ok, error) => resolve({ ok, error }),
          ),
        );
      case 'save-page': {
        if (!url)
          throw Error('Guardar página sólo está disponible en páginas web');
        const result = await dialog.showSaveDialog(
          BrowserWindow.fromWebContents(owner),
          {
            title: 'Guardar página completa',
            defaultPath: join(
              app.getPath('downloads'),
              sanitizeFilename(contents.getTitle() || 'pagina') + '.html',
            ),
            filters: [{ name: 'Página HTML', extensions: ['html'] }],
          },
        );
        if (result.canceled) return { ok: false, cancelled: true };
        await contents.savePage(result.filePath, 'HTMLComplete');
        return { ok: true };
      }
      case 'capture-visible':
        return capture(owner, contents, 'visible');
      case 'capture-full':
        return capture(owner, contents, 'full');
      case 'capture-copy':
        return capture(owner, contents, 'copy');
      case 'capture-region':
        return capture(owner, contents, 'region', payload.rect);
      case 'copy-url':
        clipboard.writeText(contents.getURL().slice(0, 8192));
        return { ok: true };
      /*
       * Insertar texto en el cuadro del sitio (atajos de conversación y
       * reutilización de fragmentos). Sólo el shell puede pedirlo —el preload
       * de la página no expone este canal—; se escribe en el foco real y se
       * reemplaza la selección como haría el portapapeles. Nunca envía: la
       * persona revisa y pulsa Enviar.
       */
      case 'insert-text': {
        const text = bounded(payload.text).slice(0, 20000);
        if (!text) throw Error('No hay texto para insertar');
        contents.focus();
        contents.insertText(text);
        return { ok: true, chars: text.length };
      }
      case 'fullscreen': {
        const w = BrowserWindow.fromWebContents(owner);
        w.setFullScreen(!w.isFullScreen());
        return { ok: true };
      }
      case 'translate':
        if (url)
          await external(
            owner,
            `https://translate.google.com/translate?sl=auto&tl=es&u=${encodeURIComponent(url)}`,
          );
        else throw Error('No hay una página web para traducir');
        return { ok: true };
      case 'share-page':
        if (!url) throw Error('No hay una dirección web para compartir');
        if (process.platform === 'darwin')
          new ShareMenu({ urls: [url] }).popup({
            window: BrowserWindow.fromWebContents(owner),
          });
        else clipboard.writeText(url);
        return {
          ok: true,
          note:
            process.platform === 'darwin'
              ? 'Menú de compartir abierto'
              : 'Dirección copiada para compartir',
        };
      case 'reader': {
        const data = await contents.executeJavaScript(
          `(()=>{const n=document.querySelector('article')||document.querySelector('main')||document.body;return {title:document.title.slice(0,300),text:(n?.innerText||'').slice(0,1000000)};})()`,
          false,
        );
        owner.send('nexo:reading', {
          title: String(data?.title || 'Lectura').slice(0, 300),
          text: String(data?.text || 'No se encontró texto legible.').slice(
            0,
            1000000,
          ),
        });
        return { ok: true };
      }
      case 'view-source': {
        const html = await contents.executeJavaScript(
          `document.documentElement.outerHTML.slice(0,1000000)`,
          false,
        );
        owner.send('nexo:reading', {
          title: 'Código DOM actual · no es la respuesta HTTP original',
          text: String(html).slice(0, 1000000),
          source: true,
        });
        return { ok: true };
      }
      case 'download-control': {
        const id = String(payload.id || '');
        const profile = getProfile();
        const entry = downloadItems.get(id);
        if (payload.operation === 'remove') {
          if (entry)
            throw Error('No se elimina una descarga activa del historial');
          const old = profile?.downloads.items.length || 0;
          profile.downloads.items = profile.downloads.items.filter(
            (i) => i.id !== id,
          );
          profile.downloads.dirty = old !== profile.downloads.items.length;
          profile.downloads.save();
        } else {
          if (!entry) throw Error('La descarga ya no está activa');
          if (payload.operation === 'pause') entry.item.pause();
          else if (
            payload.operation === 'resume' &&
            (entry.item.isPaused() || entry.item.canResume())
          )
            entry.item.resume();
          else throw Error('Esta descarga no permite esa operación');
        }
        broadcast('nexo:downloads-changed', {});
        return { ok: true };
      }
      default:
        throw Error('Acción no permitida');
    }
  }
  function contextMenu(contents, owner, params) {
    // params llega del evento nativo, jamás de postMessage ni del preload de una página.
    const entries = [],
      actions = new Map();
    let sequence = 0;
    const aliases = {
      Atrás: 'back',
      Adelante: 'forward',
      Recargar: 'reload',
      'Guardar página como…': 'save-page',
      'Imprimir…': 'print',
      'Traducir página (externo)': 'translate',
      'Buscar en la página': 'find',
      'Ver código DOM actual': 'view-source',
    };
    const add = (label, run) => {
      const id = String(++sequence);
      entries.push({ id, label, commandId: aliases[label] || null });
      actions.set(id, run);
    };
    const sep = () => {
      if (entries.length && entries.at(-1).type !== 'separator')
        entries.push({ type: 'separator' });
    };
    const open = (url) => emit(owner, 'open', { url });
    const link = safeWeb(params.linkURL),
      image = safeWeb(params.srcURL),
      selection =
        params.inputFieldType === 'password'
          ? ''
          : bounded(params.selectionText);
    // Un texto seleccionado en una página se puede reutilizar sin copiarlo a
    // mano. Con campos de contraseña no se ofrece: no se lee ni se copia.
    if (selection && !params.isEditable) {
      add('Copiar selección', () => clipboard.writeText(selection));
      add('Buscar la selección en la web', () =>
        emit(owner, 'open', {
          url: `https://duckduckgo.com/?q=${encodeURIComponent(selection.slice(0, 400))}`,
        }),
      );
      sep();
    }
    if (link) {
      add('Abrir enlace en pestaña nueva', () => open(link));
      add('Abrir enlace en ventana nueva', () => newWindow(link));
      add('Copiar dirección del enlace', () => clipboard.writeText(link));
      if (params.linkText)
        add('Copiar texto del enlace', () =>
          clipboard.writeText(bounded(params.linkText)),
        );
      add('Guardar enlace como…', () => download(contents, link, true));
      add('Descargar enlace', () => download(contents, link, false));
      sep();
    }
    if (params.mediaType === 'image') {
      if (image) {
        add('Abrir imagen en pestaña nueva', () => open(image));
        add('Abrir imagen en ventana nueva', () => newWindow(image));
        add('Abrir imagen en tamaño original', () => contents.loadURL(image));
        add('Guardar imagen como…', () => download(contents, image, true));
        add('Descargar imagen original', () =>
          download(contents, image, false),
        );
        add('Copiar dirección de imagen', () => clipboard.writeText(image));
        add('Buscar imagen con Google Lens (externo)', () =>
          external(
            owner,
            `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(image)}`,
          ),
        );
      }
      if (params.hasImageContents)
        add('Copiar imagen', () => contents.copyImageAt(params.x, params.y));
      sep();
    }
    if (params.isEditable) {
      const flags = params.editFlags || {};
      for (const [label, method, flag] of [
        ['Deshacer', 'undo', 'canUndo'],
        ['Rehacer', 'redo', 'canRedo'],
        ['Cortar', 'cut', 'canCut'],
        ['Copiar', 'copy', 'canCopy'],
        ['Pegar', 'paste', 'canPaste'],
        ['Seleccionar todo', 'selectAll', 'canSelectAll'],
      ])
        if (flags[flag]) add(label, () => contents[method]());
      if (prefs.spellcheck && params.misspelledWord) {
        for (const word of (params.dictionarySuggestions || []).slice(0, 6))
          add(word, () => contents.replaceMisspelling(word));
        add('Añadir palabra al diccionario', () =>
          contents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord,
          ),
        );
      }
      add('Idiomas y corrector…', () => emit(owner, 'keyboard-settings'));
      sep();
    } else if (selection) {
      add('Copiar selección', () => contents.copy());
    }
    if (selection) {
      if (safeWeb(contents.getURL()) && onCaptureEvidence)
        add('Conservar selección en expediente…', () =>
          onCaptureEvidence(owner, contents, params),
        );
      add('Buscar selección en Google', () =>
        open(
          `https://www.google.com/search?q=${encodeURIComponent(selection.slice(0, 2000))}`,
        ),
      );
      add('Buscar con el buscador configurado', () =>
        open(
          (prefs.search === 'google'
            ? 'https://www.google.com/search?q='
            : 'https://duckduckgo.com/?q=') +
            encodeURIComponent(selection.slice(0, 2000)),
        ),
      );
      add('Traducir selección (Google, externo)', () =>
        external(
          owner,
          `https://translate.google.com/?sl=auto&tl=es&op=translate&text=${encodeURIComponent(selection.slice(0, 5000))}`,
        ),
      );
      add('Leer selección', () =>
        owner.send('nexo:reading', {
          title: 'Selección para lectura',
          text: selection,
          speak: true,
        }),
      );
      if (process.platform === 'darwin')
        add('Compartir selección…', () =>
          new ShareMenu({ texts: [selection] }).popup({
            window: BrowserWindow.fromWebContents(owner),
          }),
        );
      else
        add('Copiar selección para compartir', () =>
          clipboard.writeText(selection),
        );
      sep();
    }
    if (
      contents.getType() === 'webview' &&
      !link &&
      !selection &&
      !params.isEditable &&
      params.mediaType !== 'image'
    ) {
      if (contents.navigationHistory.canGoBack())
        add('Atrás', () => contents.navigationHistory.goBack());
      if (contents.navigationHistory.canGoForward())
        add('Adelante', () => contents.navigationHistory.goForward());
      add('Recargar', () => contents.reload());
      if (safeWeb(contents.getURL()))
        add('Guardar página como…', () => action(owner, contents, 'save-page'));
      add('Imprimir…', () => action(owner, contents, 'print'));
      if (safeWeb(contents.getURL()))
        add('Traducir página (externo)', () =>
          action(owner, contents, 'translate'),
        );
      add('Buscar en la página', () =>
        emit(owner, 'find', { webContentsId: contents.id }),
      );
      add('Ver código DOM actual', () =>
        action(owner, contents, 'view-source'),
      );
      sep();
    }
    if (contents.isDevToolsOpened())
      add('Inspeccionar elemento', () =>
        contents.inspectElement(params.x, params.y),
      );
    while (entries.at(-1)?.type === 'separator') entries.pop();
    if (!entries.length) return;
    const token = randomUUID();
    contexts.set(owner.id, {
      token,
      contents,
      href: contents.getURL(),
      actions,
      expires: Date.now() + 30000,
    });
    owner.send('nexo:context-menu', {
      token,
      webContentsId: contents.id,
      x: params.x,
      y: params.y,
      items: entries,
      shell: contents === owner,
    });
  }
  function attachGuest(contents, owner) {
    guests.set(contents.id, { contents, owner });
    applySpelling(contents);
    contents.on('context-menu', (_event, params) =>
      contextMenu(contents, owner, params),
    );
    contents.once('destroyed', () => {
      guests.delete(contents.id);
      const current = contexts.get(owner.id);
      if (current?.contents === contents) contexts.delete(owner.id);
    });
    contents.on('did-start-navigation', (_e, _url, _inPage, main) => {
      if (main && contexts.get(owner.id)?.contents === contents)
        contexts.delete(owner.id);
    });
  }
  ipcMain.handle('nexo:advanced:prefs', (event) =>
    trusted(event)
      ? {
          ...prefs,
          availableSpellLanguages: availableSpelling(event.sender.session),
        }
      : null,
  );
  ipcMain.handle('nexo:advanced:set-prefs', async (event, input) => {
    if (!trusted(event)) return { ok: false, error: 'Remitente no autorizado' };
    try {
      const next = browserPreferences(input);
      const data = JSON.stringify(next);
      saving = saving
        .catch(() => {})
        .then(async () => {
          await mkdir(app.getPath('userData'), { recursive: true });
          await writeFile(file + '.tmp', data);
          await rename(file + '.tmp', file);
        });
      await saving;
      prefs = next;
      for(const window of BrowserWindow.getAllWindows())if(!window.webContents.isDestroyed()&&window.webContents.getURL()===SHELL_URL)window.webContents.setZoomFactor(prefs.uiZoom);
      for (const { contents } of guests.values())
        if (!contents.isDestroyed()) applySpelling(contents);
      onPreferences?.(prefs);
      broadcast('nexo:browser-prefs', prefs);
      return { ok: true, prefs };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('nexo:advanced:action', async (event, payload = {}) => {
    if (!trusted(event)) return { ok: false, error: 'Remitente no autorizado' };
    try {
      if (payload.action === 'shortcut-record') {
        if (payload.enabled === true) recording.add(event.sender.id);
        else recording.delete(event.sender.id);
        event.sender.setIgnoreMenuShortcuts(payload.enabled === true);
        return { ok: true };
      }
      if (payload.action === 'fullscreen')
        return await action(event.sender, null, 'fullscreen');
      if (payload.action === 'download-control')
        return await action(event.sender, null, payload.action, payload);
      return await action(
        event.sender,
        target(event.sender, payload.webContentsId),
        payload.action,
        payload,
      );
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('nexo:advanced:context', async (event, payload = {}) => {
    if (!trusted(event)) return { ok: false, error: 'Remitente no autorizado' };
    const context = contexts.get(event.sender.id);
    contexts.delete(event.sender.id);
    if (
      !context ||
      context.token !== payload.token ||
      context.expires < Date.now() ||
      context.contents.isDestroyed() ||
      context.contents.getURL() !== context.href
    )
      return { ok: false, error: 'El menú expiró o la página cambió' };
    try {
      const run = context.actions.get(payload.id);
      if (!run) throw Error('Acción de contexto inválida');
      const result = await run();
      return result && typeof result === 'object' && 'ok' in result
        ? result
        : { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  return {
    resolveGuest: target,
    attachGuest,
    handleInput,
    attachShell(owner) {
      owner.on('context-menu', (_event, params) =>
        contextMenu(owner, owner, params),
      );
      owner.on('before-input-event', (event, input) =>
        handleInput(event, input, owner, owner),
      );
      owner.once('destroyed', () => {
        contexts.delete(owner.id);
        recording.delete(owner.id);
      });
      owner.on('blur', () => {
        recording.delete(owner.id);
        owner.setIgnoreMenuShortcuts(false);
      });
    },
    get preferences() {
      return prefs;
    },
  };
}

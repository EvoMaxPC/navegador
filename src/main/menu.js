/** Menú de aplicación. Los comandos viajan a la interfaz como eventos. */

import { Menu, app, shell } from 'electron';

/**
 * @param {{send: (channel: string, payload?: any) => void}} bridge
 */
export function buildMenu({ send }) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'Acerca de Nexo' },
              { type: 'separator' },
              { label: 'Ajustes de mediación…', accelerator: 'Cmd+,', click: () => send('nexo:command', { type: 'settings' }) },
              { type: 'separator' },
              { role: 'hide', label: 'Ocultar Nexo' },
              { role: 'quit', label: 'Salir de Nexo' },
            ],
          },
        ]
      : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Pestaña nueva', accelerator: 'CmdOrCtrl+T', click: () => send('nexo:command', { type: 'new-tab' }) },
        { label: 'Cerrar pestaña', accelerator: 'CmdOrCtrl+W', click: () => send('nexo:command', { type: 'close-tab' }) },
        { type: 'separator' },
        { label: 'Abrir ChatGPT', click: () => send('nexo:command', { type: 'open', url: 'https://chatgpt.com' }) },
        { label: 'Abrir Claude', click: () => send('nexo:command', { type: 'open', url: 'https://claude.ai' }) },
        { label: 'Abrir Gemini', click: () => send('nexo:command', { type: 'open', url: 'https://gemini.google.com' }) },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close', label: 'Cerrar ventana' }] : [{ role: 'quit', label: 'Salir' }]),
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { role: 'forceReload', label: 'Forzar recarga' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamaño normal' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
      ],
    },
    {
      label: 'Nexo',
      submenu: [
        {
          label: 'Activar/desactivar mediación',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => send('nexo:command', { type: 'toggle-engine' }),
        },
        {
          label: 'Mostrar panel de intervenciones',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => send('nexo:command', { type: 'toggle-sidebar' }),
        },
        { type: 'separator' },
        {
          label: 'Cómo funciona',
          click: () => shell.openExternal('https://github.com/EvoMaxPC/navegador#readme'),
        },
      ],
    },
    {
      label: 'Ayuda',
      role: 'help',
      submenu: [
        {
          label: 'Abrir sala de pruebas',
          click: () => send('nexo:command', { type: 'open', url: 'nexo://demo' }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

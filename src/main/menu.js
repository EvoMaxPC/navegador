/** Menú de aplicación. Los comandos viajan a la interfaz como eventos. */

import { Menu, app, shell } from 'electron';
import { acceleratorFor } from '../nav/shortcuts.js';

/**
 * @param {{send: (channel: string, payload?: any) => void}} bridge
 */
export function buildMenu({ send, bindings = {} }) {
  const isMac = process.platform === 'darwin';
  const acc = (command) => acceleratorFor(command, process.platform, bindings);
  const run = (command, extra = {}) => () => send('nexo:command', { type: command, ...extra });

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: 'Acerca de Nexo' },
              { type: 'separator' },
              { label: 'Ajustes…', accelerator: acc('settings'), click: run('settings') },
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
        { label: 'Pestaña nueva', accelerator: acc('new-tab'), click: run('new-tab') },
        { label: 'Reabrir pestaña cerrada', accelerator: acc('reopen-tab'), click: run('reopen-tab') },
        { label:'Buscar pestañas…',accelerator:acc('tab-search'),click:run('tab-search') },
        { label:'Menú del navegador',accelerator:acc('browser-menu'),click:run('browser-menu') },
        { label:'Atajos de conversación…',accelerator:acc('prompt-list'),click:run('prompt-list') },
        { label:'Insertar un atajo en el cuadro',click:run('prompt-bar') },
        { label:'Centro de comandos',accelerator:acc('command-center'),click:run('command-center') },
        { label:'Guardar página…',accelerator:acc('save-page'),click:run('save-page') },
        { label:'Imprimir…',accelerator:acc('print'),click:run('print') },
        { label: 'Cerrar pestaña', accelerator: acc('close-tab'), click: run('close-tab') },
        { type: 'separator' },
        { type: 'separator' },
        { label: 'Pestaña siguiente', accelerator: acc('next-tab'), click: run('next-tab') },
        { label: 'Pestaña anterior', accelerator: acc('prev-tab'), click: run('prev-tab') },
        {
          label: 'Ir a la pestaña',
          submenu: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
            label: n === 9 ? 'Última (9)' : String(n),
            accelerator: acc(`tab-${n}`),
            click: run(`tab-${n}`),
          })),
        },
        { type: 'separator' },
        { label: 'Historial', accelerator: acc('history'), click: run('history') },
        { label: 'Marcadores', click: run('bookmarks') },
        { label: 'Descargas', accelerator: acc('downloads'), click: run('downloads') },
        { type: 'separator' },
        { label: 'Abrir sitio…', accelerator: acc('focus-omnibox'), click: run('focus-omnibox') },
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
        { type: 'separator' },
        { label: 'Buscar en la página', accelerator: acc('find'), click: run('find') },
        { label: 'Buscar siguiente', accelerator: acc('find-next'), click: run('find-next') },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { label: 'Recargar', accelerator: acc('reload'), click: run('reload') },
        { label: 'Forzar recarga', accelerator: acc('hard-reload'), click: run('hard-reload') },
        { type: 'separator' },
        { label: 'Acercar', accelerator: acc('zoom-in'), click: run('zoom-in') },
        { label: 'Alejar', accelerator: acc('zoom-out'), click: run('zoom-out') },
        { label: 'Tamaño normal', accelerator: acc('zoom-reset'), click: run('zoom-reset') },
        { type: 'separator' },
        { label: 'Pantalla completa', accelerator:acc('fullscreen'),click:run('fullscreen') },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo', accelerator:null },
      ],
    },
    {
      label: 'Nexo',
      submenu: [
        { label: 'Comprensión del usuario', accelerator: acc('user-understanding'), click: run('user-understanding') },
        { label: 'Expediente del objetivo', accelerator: acc('work-dossier'), click: run('work-dossier') },
        { label: 'Panel EVO', accelerator: acc('toggle-sidebar'), click: run('toggle-sidebar') },
        { label:'Captura de pantalla',accelerator:acc('screenshot'),click:run('screenshot') },
        { label:'Espacios de trabajo',accelerator:acc('workspaces'),click:run('workspaces') },
        { label:'Pantalla de lectura',accelerator:acc('reader'),click:run('reader') },
        { label:'Personalizar barra y teclado',click:run('keyboard-settings') },
        { label: 'Memoria', accelerator: acc('memory'), click: run('memory') },
        { label: 'Actividad', click: run('activity') },
        { label: 'Sitios y permisos', click: run('sites') },
        { type: 'separator' },
        {
          label: 'Activar o desactivar mediación',
          accelerator: acc('toggle-engine'),
          click: run('toggle-engine'),
        },
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
        { label: 'Abrir sala de pruebas', click: run('open', { url: 'nexo://demo' }) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

# Primer cambio — menús y zoom de NEXO AI

## Alcance de esta revisión

Se trabaja sobre la interfaz que ya existía en la rama, sin rehacer el inicio,
el fondo, la cabecera, los iconos de identidad ni las opciones de navegación.
Los motores, EVO Memory, lectura DOM, Comprensión y sus datos no se modifican.

La rama ya tenía la retirada de Repetición, menú izquierdo cerrado inicialmente,
zoom de interfaz y panel derecho compacto con preferencia automático/fijo.
Se conserva esa implementación y se ajustan exclusivamente dos detalles:

1. El botón existente del menú izquierdo incorpora un identificador hamburguesa
   de tres líneas visible y un nombre accesible explícito. Mantiene su identidad,
   ubicación, control por clic, Escape y `aria-expanded`.
2. En modo automático, retirar el mouse contrae el panel incluso después de haber
   seleccionado un control. Antes, el foco de ese control podía mantenerlo abierto.
   Se retira el foco de los controles que quedarían ocultos. El modo fijo no se
   contrae. Se conserva la expansión por foco para usuarios de teclado.

No se trasladan opciones de un lado al otro: se mantienen los menús y controles
existentes, con sus destinos y callbacks actuales. La barra derecha sigue siendo
translúcida y compacta, sin alterar su diseño ni añadir opciones nuevas.

## Resultado por requisito

| Requisito | Resultado |
|---|---|
| Repetición de la conversación | No aparece como opción en ninguno de los menús; sin su pestaña/panel independiente. Se conserva el lector compartido con EVO. |
| Menú izquierdo | Cerrado al iniciar; hamburguesa abre y vuelve a cerrar. Escape también cierra. |
| Zoom | Aumentar, disminuir y restablecer al 100%; porcentaje actualizado. No sustituye ni modifica el zoom por sitio existente. |
| Barra derecha | Compacta al iniciar con configuración predeterminada; iconos visibles y contenido extendido oculto. |
| Automático | Hover expande; salir contrae tras 250 ms, también después de seleccionar un control. |
| Fijo | Permanece expandido al retirar el mouse. |
| Persistencia | `rightMenuMode` se guarda en `browser-tools.json`; la siguiente instancia recupera la elección. También recupera `uiZoom`. |

La preferencia guardada tiene prioridad en el siguiente arranque: si el usuario
eligió Fijo, el menú vuelve expandido. Una instalación sin esa elección inicia en
Automático, compacta.

## Pruebas ejecutadas

- **Focalizadas: 67 correctas, 0 fallos, 0 omitidas.** Menús, hamburguesa,
  eliminación de navegación Repetición, zoom y preferencias, contratos de shell,
  aislamiento IPC y regresiones de EVO/almacenes.
- **Suite completa `npm test`: 808 totales, 807 correctas, 0 fallos, 1 omitida.**
  La omitida requiere el entorno de empaquetado Windows/Electron.
- **Chromium real: 24 comprobaciones correctas**, sin errores JS/HTTP. Apertura y
  cierre, icono hamburguesa visible, dock compacto, hover, modo fijo, regreso a
  Automático después de enfocar Ajustes, persistencia en la vista web, aumento,
  disminución y reset del zoom, adaptación y movimiento reducido.
- **Reinicio con procesos independientes:** un primer proceso carga el main de
  producción con Electron simulado, guarda Fijo y zoom 125% y termina. Un segundo
  proceso arranca con el mismo perfil en disco, recupera los valores y aplica el
  zoom a la shell. No comparten estado JavaScript en memoria.

La prueba de Chromium utiliza el adaptador web de desarrollo; no sustituye a
Electron. La prueba de reinicio usa disco real y main de producción, pero Electron
simulado. **No se ha ejecutado una validación manual del binario en Windows real.**

## Archivos de esta revisión

- `src/ui/shell/index.html`: identificador hamburguesa y nombre accesible.
- `src/ui/shell/wormhole.css`: estilo local del identificador, sin rediseño global.
- `src/ui/shell/wormholeChrome.js`: contracción por salida del mouse.
- `test/wormhole-identity.test.js`: contrato hamburguesa y comportamiento automático.
- `test/wormhole-main.test.js`: recuperación en un segundo proceso independiente.
- Documentación de esta revisión y actualización de la explicación del modo automático.

Registros y capturas: `/home/user/deliveries/nexo-menus/`.

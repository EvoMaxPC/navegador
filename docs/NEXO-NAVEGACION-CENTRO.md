# Centro de navegación de Nexo

Estado: implementado en la shell (`arena/4678aef7-navegador`), verificado en la
vista de interfaz web y con pruebas automatizadas. No se probó en una ventana
Electron nueva ni en Windows en esta etapa.

## Qué se agregó

### 1. Buscador de pestañas

- Botón de lupa junto a las pestañas con el **número de pestañas abiertas**.
- Atajo **Ctrl+Shift+A** (Command+Shift+A en macOS) y entrada en el menú del
  navegador, el menú contextual de pestaña, el menú de aplicación y
  `Ctrl+K → Buscar en las pestañas abiertas y cerradas`.
- Busca en **pestañas abiertas de todos los espacios** y en las **últimas 25
  cerradas de la sesión**, por título, dirección y nombre del espacio.
- Coincidencia sin distinguir mayúsculas ni acentos; varias palabras se combinan
  (por ejemplo «mozilla css»).
- Filtro «Todos los espacios / Este espacio»; las pestañas del espacio actual y
  las fijadas aparecen primero.
- Cada fila indica espacio, estado (Actual, Fijada, Sin sonido) y muestra el
  origen sin credenciales (`usuario:clave@host` nunca se muestra).
- Reabrir una cerrada usa la misma pila `state.closed` que Ctrl+Shift+T y la
  quita de la pila; el cierre de una fila usa el mismo `closeTab` de la shell.

### 2. Menú del navegador

- Botón de menú en la cabecera y atajo **Alt+F**.
- Cuatro bloques con acciones **reales y existentes**: navegar (nueva pestaña,
  buscar, reabrir), biblioteca (favoritos, historial, descargas), trabajo
  (espacios, vista dividida, lectura, captura) y NEXO (EVO Memory, tokenizador,
  centro de comandos, ajustes), con el atajo vigente de cada una.
- Los ítems no aplicables se deshabilitan (por ejemplo, reabrir sin pestañas
  cerradas) y las funciones de panel abren el panel correspondiente.

### 3. Practicidad y accesibilidad

- El recorrido con flechas/Inicio/Fin de la tira de pestañas usa ahora el **orden
  visible del espacio activo** (antes recorría el orden de creación e incluía
  pestañas ocultas de otros espacios).
- El centro de comandos (Ctrl+K) se recorre con flechas, Inicio/Fin y Escape
  vuelve al buscador; además acepta el atajo escrito (`ctrl j`, `ctrl+j`).
- Se corrigió `aria-pressed="null"` en la barra rápida: los botones de panel sin
  barra lateral abierta publicaban un valor ARIA inválido (violación crítica
  detectada con axe-core). Ahora siempre es `true`/`false`.
- Escape cierra el diálogo y devuelve el foco al botón que lo abrió; un clic en
  el fondo también cierra; sólo se abre un diálogo a la vez.
- La hoja nueva respeta `prefers-reduced-motion`, tiene foco visible propio y se
  adapta a una columna por debajo de 720 px (sin recursos remotos).

## Archivos

| Archivo | Cambio |
| --- | --- |
| `src/ui/shell/navigationModel.js` | Nuevo. Búsqueda/orden/salto de foco puros, sin DOM ni red. |
| `src/ui/shell/navigationHub.js` | Nuevo. Diálogo de pestañas y menú; usa `state`, `createTab`, `activateTab`, `closeTab` y `runCommand` reales. |
| `src/ui/shell/navigationHub.css` | Nuevo. Presentación, responsive y movimiento reducido. |
| `src/ui/shell/index.html` | Botones de lupa (con contador) y menú; hoja nueva. |
| `src/ui/shell/app.js` | Integración, orden visible del teclado, refresco del contador. |
| `src/ui/shell/browserTools.js` | Entrada «Buscar pestañas…» en el menú contextual, teclado del centro de comandos y `aria-pressed` válido. |
| `src/nav/shortcuts.js` | `tab-search` (Ctrl+Shift+A) y `browser-menu` (Alt+F). Ctrl+A sigue reservado. |
| `src/main/menu.js` | Las dos entradas nuevas en Archivo. |
| `dev/serve.mjs`, `scripts/verificar.mjs` | Vista web y checklist manual actualizados. |
| `test/navigation-hub.test.js` | 10 pruebas del modelo, atajos, HTML, CSS y menú. |
| `test/advanced-tools.test.js` | 2 pruebas de accesibilidad y teclado del centro de comandos. |

## Verificación

- Suite completa tras la etapa 2: **1688 pruebas, 1687 aprobadas, 0 fallos,
  1 omitida** (la misma omitida previa).
- Los 13 fallos que traían los commits remotos de contadores se corrigieron en
  `23facfa`: el «tokenizer más cercano» inventaba compatibilidad (gpt-6 contado
  con o200k_base de GPT-5). Ahora un modelo no catalogado queda desconocido y
  el texto del envío se conserva hasta poder medirlo con el modelo real.
- Vista de interfaz (`node dev/serve.mjs 3417 --browser`), automatizada con
  Chromium headless: apertura/cierre/reapertura desde el buscador, filtro por
  espacio, búsqueda sin resultados, Escape, menú y cambio a panel Tokenizador,
  teclado de pestañas y del centro de comandos. Sin errores de consola.
- axe-core (WCAG 2 A/AA) sobre la shell cerrada, el buscador y el menú: **0
  violaciones**.

## Etapa 2 · interacción con la IA (2026-11)

### Atajos de conversación

Panel nuevo (**Atajos**, `Ctrl+Shift+P`, menú de la aplicación y del navegador)
con plantillas propias para conversar con la IA. Variables admitidas:
`{{seleccion}}` (texto seleccionado en la página), `{{pestana}}`, `{{sitio}}` y
`{{fecha}}`. Las que no tienen valor **quedan visibles** para completarlas: no
se reemplazan por vacío ni por texto inventado.

- Inserción con la acción nativa `insert-text` del proceso principal: escribe en
  el cuadro del sitio en el foco actual y **nunca envía**. La interfaz lo dice
  explícitamente y la prueba lo verifica (sin `submit` ni clic de envío).
- El texto no se interpreta como HTML ni como código: se inserta literal.
- Persistencia atómica sobre `Store` (temporal + fsync + rename). Si el disco
  falla, el guardado devuelve error y **no** se publica una lista en RAM.
- Validación y acotado en `src/core/prompts.js` (máximo 40 atajos, 60/4000
  caracteres, ids acotados); la interfaz no es la frontera de confianza.
- Sólo la shell puede listar, editar y renderizar: el preload de la página no
  expone `nexo:prompts:*` ni `insert-text`.

### Siguiente paso tras cada turno

El motor ya calculaba reparaciones, sugerencias de recuperación y la
continuación cuando una respuesta se corta; se descartaban antes de llegar a la
interfaz. Ahora el principal publica `nexo:turn-followup` (sólo si hay algo
útil) y la barra de la pestaña activa ofrece:

- **Escribir en el cuadro**: inserta la continuación o la sugerencia para que la
  persona la revise y la envíe. No se envía sola.
- **Descartar**: quita la sugerencia de esa pestaña.
- Aviso de reparaciones aplicadas (markdown, tokens de plantilla) en Actividad.

Los avisos aparecen sólo en la pestaña activa; las demás quedan marcadas para
encontrarlas al cambiar. El evento no incluye el texto de la respuesta ni se
reenvía a la página.

## Límites explícitos

- No hay sincronización entre dispositivos, perfiles privados/aislados,
  extensiones ni gestor de contraseñas. El menú no ofrece esas entradas.
- Los atajos de conversación son texto del usuario: no son agentes autónomos ni
  ejecutan acciones. La sugerencia de continuación tampoco se envía sola.
- El relleno de `{{seleccion}}` en la vista web no tiene selección real de una
  página Electron; en la aplicación se toma la selección de la pestaña activa.
- Un espacio de trabajo **no** aísla cookies ni sesiones: sólo agrupa pestañas.
- El buscador de pestañas es local; no consulta motores ni historial remoto.
- La vista web no reproduce Electron: requiere confirmación visual en la
  aplicación empaquetada, que no se ejecutó en este entorno.

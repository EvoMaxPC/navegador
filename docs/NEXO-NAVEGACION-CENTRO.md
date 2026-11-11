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

- Suite completa: **1671 pruebas, 1670 aprobadas, 0 fallos, 1 omitida**
  (la misma omitida previa).
- Vista de interfaz (`node dev/serve.mjs 3417 --browser`), automatizada con
  Chromium headless: apertura/cierre/reapertura desde el buscador, filtro por
  espacio, búsqueda sin resultados, Escape, menú y cambio a panel Tokenizador,
  teclado de pestañas y del centro de comandos. Sin errores de consola.
- axe-core (WCAG 2 A/AA) sobre la shell cerrada, el buscador y el menú: **0
  violaciones**.

## Límites explícitos

- No hay sincronización entre dispositivos, perfiles privados/aislados,
  extensiones ni gestor de contraseñas. El menú no ofrece esas entradas.
- Un espacio de trabajo **no** aísla cookies ni sesiones: sólo agrupa pestañas.
- El buscador de pestañas es local; no consulta motores ni historial remoto.
- La vista web no reproduce Electron: requiere confirmación visual en la
  aplicación empaquetada, que no se ejecutó en este entorno.

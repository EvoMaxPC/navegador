# El navegador

Etapa 2 del plan de EVO BROWSER: **Nexo como navegador usable de verdad**, sin
depender de la mediación. Si el motor de mediación está apagado, si EVO MEMORY
está vacío o si un adaptador falla, las pestañas siguen navegando igual.

> Este documento distingue explícitamente **lo que está implementado** de **lo
> que falta**, y cada punto trae la prueba que lo demuestra. Nada se declara
> terminado por compilar.

---

## 1. Qué está implementado

| Función | Módulo | Cómo funciona | Prueba |
| --- | --- | --- | --- |
| Navegación a cualquier URL | `src/ui/shell/app.js` + `src/nav/url.js` | La barra resuelve URL o búsqueda con una sola función compartida | `test/nav-stores.test.js` (resolución de entrada) |
| Pestañas múltiples | shell | `<webview>` por pestaña, con scroll cuando no entran | contrato de IDs |
| Página de pestaña nueva | `src/ui/start/index.html` | Búsqueda web + accesos a las IA y sitios de trabajo | carga local, sin red |
| Historial persistente | `src/nav/history.js` | Una fila por visita, dedupe de recargas, búsqueda con acentos y sitios más visitados | 9 pruebas |
| Marcadores | `src/nav/bookmarks.js` | Estrella en la barra, carpetas simples, sin duplicados por URL | 3 pruebas |
| Descargas | `src/nav/downloads.js` + `will-download` | Progreso, cancelación, abrir archivo y mostrar en carpeta | 4 pruebas |
| Restauración de sesión | `src/nav/session.js` | Guarda pestañas y pestaña activa; reabre al arrancar | 4 pruebas |
| Buscar en la página | shell + `findInPage` | Barra flotante con «3 de 12», anterior y siguiente | manual (requiere Chromium) |
| Zoom por sitio | `src/nav/zoom.js` | Escala fija de 0,5× a 2,5×, recordado por host | 2 pruebas |
| Permisos por sitio | `src/nav/permissions.js` | Catálogo con valor por defecto; se cambia por sitio en el panel | 5 pruebas |
| Cookies y almacenamiento | `session.clearStorageData` | Borrado selectivo desde *Sitios → Datos guardados* | manual |
| Atajos de teclado | `src/nav/shortcuts.js` + menú | Una tabla única alimenta el menú nativo y la interfaz | 2 pruebas |
| Navegación sin mediación | `src/core/guard.js` | El motor nunca bloquea: todo error cae a passthrough | `test/memory-guard.test.js` + manual |

Datos guardados en el directorio del perfil (`app.getPath('userData')`):

```
history.json      bookmarks.json    downloads.json
session.json      permissions.json  zoom.json
nexo-profile.json evo-memory-*.json
```

Todos con escritura atómica (`.tmp` + renombrar): un cierre de golpe no deja el
archivo a medias.

---

## 2. Atajos

| Atajo | Acción |
| --- | --- |
| `Ctrl/Cmd + T` | Pestaña nueva |
| `Ctrl/Cmd + W` | Cerrar pestaña |
| `Ctrl/Cmd + Shift + T` | Reabrir pestaña cerrada |
| `Ctrl/Cmd + Tab` / `Shift + Tab` | Pestaña siguiente / anterior |
| `Ctrl/Cmd + 1…9` | Ir a la pestaña |
| `Ctrl/Cmd + L` | Barra de direcciones |
| `Ctrl/Cmd + R` / `Shift + R` | Recargar / forzar recarga |
| `Ctrl/Cmd + F` · `F3` · `Shift + F` | Buscar en la página · siguiente · anterior |
| `Ctrl/Cmd + D` | Marcar la página |
| `Ctrl/Cmd + H` · `J` | Historial · Descargas |
| `Ctrl/Cmd + +` · `−` · `0` | Zoom del sitio |
| `Ctrl/Cmd + Shift + I` | Panel EVO |
| `Ctrl/Cmd + Shift + M` | Activar/desactivar mediación |
| `Esc` | Cerrar el buscador o las sugerencias |

---

## 3. Cómo verificar que navega (prueba real, en tu máquina)

Estas pruebas **no** se pueden hacer en el entorno de desarrollo del agente (no
hay display ni binario de Electron). Hay que correrlas localmente:

```bash
npm install
npm start          # build de inyección + Electron
```

Checklist de aceptación de la etapa 2:

1. **Navegación general** — abrir `https://es.wikipedia.org`, `https://github.com`,
   `https://news.ycombinator.com`. Verificar que renderizan y que los enlaces
   internos funcionan.
2. **Pestañas** — abrir 6 pestañas, cambiar con `Ctrl+Tab` y `Ctrl+3`, cerrar una
   con el medio del ratón (`Ctrl+W`) y reabrirla con `Ctrl+Shift+T`.
3. **Historial** — navegar 5 sitios, abrir *Historial*, buscar una palabra del
   título, hacer clic en el resultado y comprobar que vuelve a esa página.
4. **Persistencia** — cerrar la aplicación por completo y volver a abrirla: las
   pestañas, el historial, los marcadores y el zoom por sitio siguen ahí.
5. **Marcadores** — marcar con la estrella, desmarcar, ver la estrella llena y
   vacía, y comprobar que el marcador aparece en el panel.
6. **Descargas** — bajar un archivo (por ejemplo un PDF), ver el progreso, abrirlo
   desde el panel con «abrir» y ubicarlo con «carpeta».
7. **Buscar en página** — `Ctrl+F`, escribir una palabra, ver «n de m», navegar
   con `Enter` y cerrar con `Esc`.
8. **Zoom** — `Ctrl++` dos veces en ChatGPT, comprobar que solo cambia ese sitio,
   y que se mantiene después de recargar.
9. **Permisos** — entrar a un sitio que pida notificaciones; verificar que se
   deniega, que aparece la intervención en *Actividad* y que al poner «permitir»
   en *Sitios* el pedido siguiente se concede.
10. **Mediación apagada** — desactivar el motor (`Ctrl+Shift+M`) y repetir los
    puntos 1 y 3. La navegación debe ser idéntica.
11. **Borrado** — *Sitios → Datos guardados → Borrar todo*, y comprobar que el
    historial, los marcadores y las sesiones de los sitios desaparecieron.

Si algo de esta lista falla, la etapa 2 no está terminada, por más que las
pruebas automáticas estén en verde.

---

## 4. Qué falta (etapa 3)

| Falta | Impacto | Nota |
| --- | --- | --- |
| Migrar de `<webview>` a `WebContentsView` | Necesario para el canal CDP por pestaña | El canal A (página) funciona hoy con `<webview>` |
| Gestión de ventanas múltiples | Uso intensivo | La sesión ya se guarda con formato multi-ventana |
| Perfiles e incógnito | Privacidad avanzada | Requiere particiones por perfil |
| Menú contextual | Comodidad | Copiar dirección, abrir en pestaña nueva, guardar imagen |
| Autocompletado del historial en la barra con frecuencia | Pulido | Hoy ordena por coincidencia y cercanía |
| Gestor de cookies por sitio | Control fino | Hoy se borra todo o nada |
| Traducción, lector, modo oscuro forzado | Extras | No son requisito de esta etapa |

---

## 5. Pruebas automáticas de esta etapa

```bash
npm test
```

- `test/nav-stores.test.js` — 34 pruebas de URL, historial, marcadores, descargas,
  sesión, permisos, zoom, atajos y perfil completo.
- `test/main-boot.test.js` — 14 pruebas que importan el proceso principal real
  contra un Electron falso: arranque de la ventana, esquema `nexo://` con control
  de ruta, menú, permisos de la partición, historial, marcadores, zoom, descargas,
  sesión, sugerencias, borrado de datos, memoria y recuperación de una pestaña
  caída.
- `test/shell-contract.test.js` — 9 pruebas de contrato entre HTML, interfaz,
  preload y proceso principal: identificadores huérfanos, canales IPC sin
  handler, métodos del puente inexistentes y permisos concedidos sin política.

La prueba de contrato existe porque el error más probable de esta etapa no es de
lógica: es un `id` que cambió de nombre o un canal IPC que nadie escucha. Con la
ventana cerrada, eso no se ve; con estas pruebas, falla en consola.

El navegador también se compila y se prueba empaquetado: ver
[`EMPAQUETADO.md`](EMPAQUETADO.md) (`npm run dist:win`, `npm run smoke`) y
[`AUDITORIA.md`](AUDITORIA.md) para lo que se corrigió en la última pasada.

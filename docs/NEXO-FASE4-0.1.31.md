# Nexo 0.1.31 — Fase 4: funciones avanzadas

## Estado de entrega

Implementación sobre la arquitectura existente, sin rediseño general: identidad BLACK & ELECTRIC BLUE conservada. Código fuente actualizado; **no es un ejecutable compilado**. Cambios locales en `arena/4678aef7-navegador`, sobre e700c0f. No se hizo commit ni push de esta fase, para no activar CI.

**Validación realizada exclusivamente estática:** lectura de integración, formato, `node --check` de módulos modificados y `git diff --check`. No se ejecutaron la aplicación, suites de pruebas, benchmarks, build ni CI. Los tests nuevos son casos preparados, no resultados. Las validaciones de 0.1.30 no acreditan esta versión.

## Implementación y puntos de entrada

- `src/nav/shortcuts.js`: registro compartido `COMMAND_DEFS`, bindings, normalización de eventos DOM/Electron, conflictos y catálogo de barra.
- `src/nav/browserPreferences.js`: preferencias acotadas de barra, teclado, buscador, corrector y espacios de trabajo; independientes de la memoria EVO.
- `src/main/advancedBrowser.js`: instalación de IPC avanzado, `contextMenu`, `capture`, `action`, ventanas web simples, descargas y validación de propietarios. Acciones privilegiadas resueltas en main.
- `src/main/main.js`: instalación de herramientas, conexión shell/guests, entrada de teclado central, autorización de IPC heredado de descargas, diálogos de ubicación y seguimiento de DownloadItem.
- `src/main/menu.js`: menú de aplicación conectado al registro central.
- `src/preload/shell.cjs`: puente avanzado y eventos permitidos para la shell; no se expone este puente a páginas web.
- `src/ui/shell/browserTools.js`: menús contextuales con iconos y teclado, centro Ctrl+K, barra personalizable, ajustes de teclado, lector, captura rectangular, workspaces y split.
- `src/ui/shell/app.js`: `runBrowserCommand`, integración de pestañas, estado fijado/silenciado/workspace, restauración, descargas y buscador.
- `src/ui/shell/index.html`, `styles.css`: superficies graphite/azul, barra, ajustes, disposición dividida y selector de captura. Sin rediseño de marca.
- `src/nav/downloads.js`: preservación de descargas activas/interrumpidas y fin real del registro.
- `src/nav/session.js`, `src/main/validate.js`: metadatos de workspace con validación y compatibilidad con sesiones previas.
- `dev/preview.js`: compatibilidad de interfaz con mensajes explícitos de indisponibilidad cuando falta Electron; no simula capturas ni descargas.
- `package.json`, `package-lock.json`: versión 0.1.31, sin dependencias nuevas.
- `test/advanced-tools.test.js`: casos preparados para registro, conflictos, preferencias y contratos de seguridad. Adaptaciones en `test/main-boot.test.js`, `test/nav-stores.test.js`, `test/shell-contract.test.js` y `test/harness/electron-stub.mjs`. **No ejecutados.**

## Menús contextuales

Los menús se construyen con contexto nativo de Electron. No se derivan de mensajes enviados por páginas.

| Objetivo | Acciones implementadas según aplicabilidad |
|---|---|
| Imagen HTTP(S) | Abrir en pestaña/ventana, abrir recurso original, guardar como, descargar original, copiar URL, Google Lens externo con confirmación. Copiar píxeles sólo si Electron informa contenido de imagen. |
| Enlace HTTP(S) | Abrir pestaña/ventana, copiar dirección/texto, guardar como y descargar. |
| Selección no secreta | Copiar, buscar en Google o buscador configurado, traducir externamente, abrir lectura, compartir nativo en macOS o copiar para compartir en otros sistemas. |
| Editable | Deshacer/rehacer/cortar/copiar/pegar/seleccionar según `editFlags`; sugerencias ortográficas, diccionario e idiomas cuando procede. No se extrae selección de contraseña. |
| Página | Atrás/adelante si hay historial, recargar, guardar, imprimir, traducir externamente, buscar, ver DOM actual; inspección según disponibilidad. |
| Pestaña | Nueva, duplicar, fijar/desfijar, silenciar, cerrar, cerrar otras/derecha no fijadas, restaurar, mover de espacio y copiar URL. |

Menús con iconos lineales, posición limitada al área de ventana, navegación por flechas/Home/End, Enter y Escape. El menú se integra con la capa superior de diálogos. Los contextos del renderer se invalidan al activar otra pestaña o comenzar carga. Ctrl+K reutiliza acciones aplicables y evita repetir alias de comandos genéricos.

## Barra rápida, teclado y herramientas

La barra permite agregar/quitar, reordenar y ocultar herramientas. Catálogo: inicio, descargas, favoritos, historial, captura, traducción, lectura, split, EVO MEMORY, workspaces y ajustes. Extensiones se identifica explícitamente como no disponible; no es un comando funcional ficticio. Incluye ARIA, tooltips y estados de aplicabilidad. Barra de favoritos independiente.

Ajustes de teclado: consultar, grabar combinación, detectar conflictos, desasignar y restaurar defaults. Durante grabación se evita ejecutar el comando que se está registrando. Se rechazan combinaciones de edición reservadas, Ctrl+Alt/AltGr y algunas reservas del sistema. No se registran hotkeys globales del SO; los comandos globales del navegador pueden operar dentro de campos de edición. Compatibilidad y colisiones dependientes de plataforma aún requieren revisión en ejecución.

### Atajos predeterminados

| Combinación | Función |
|---|---|
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | Nueva / cerrar / restaurar pestaña |
| Ctrl+Shift+D | Duplicar pestaña |
| Ctrl+Tab / Ctrl+Shift+Tab | Siguiente / anterior |
| Ctrl+1…8 / Ctrl+9 | Pestaña por posición del espacio actual / última |
| Ctrl+L | Dirección |
| Alt+Left / Alt+Right / Alt+Home | Atrás / adelante / inicio |
| Ctrl+R / Ctrl+Shift+R | Recarga / recarga forzada |
| Ctrl+K | Centro de comandos |
| Ctrl+H / Ctrl+J / Ctrl+D | Historial / descargas / agregar favorito |
| Ctrl+Shift+B | Mostrar/ocultar barra de favoritos |
| Ctrl+F / F3 / Shift+F3 | Buscar / siguiente / anterior |
| Ctrl+P / Ctrl+S | Imprimir / guardar página |
| Ctrl+Plus / Ctrl+Minus / Ctrl+0 | Zoom por sitio / restablecer |
| F11 | Pantalla completa |
| Ctrl+Shift+M / Ctrl+Shift+I | EVO MEMORY / panel EVO |
| Ctrl+Shift+S | Captura visible |
| Ctrl+Shift+E / Ctrl+Shift+F | Espacios / lectura |
| Ctrl+Comma | Ajustes |
| Escape | Cerrar herramienta |

En macOS se adapta Ctrl a Command. Ctrl+Shift+N no se asigna: no existe una sesión privada implementada. Captura completa/rectangular y otras acciones sin combinación se encuentran por Ctrl+K o menú.

## Descargas y capturas

Se reutiliza el gestor y `DownloadItem` de Electron: progreso, cancelación, pausa/reanudación cuando el item lo permite, abrir completada, mostrar carpeta, historial y retirar registro terminado. Guardar como utiliza diálogo con nombre saneado; las descargas de recursos conservan el cuerpo/formato original servido, sin recomprimir ni sustituir por screenshot. Cerrar el panel o cambiar pestaña no cancela el item; su continuidad al destruir la pestaña depende de Electron. No se crea una segunda descarga para pausar/reanudar.

Captura visible y rectangular por `capturePage`; completa por CDP `Page.captureScreenshot`, en PNG. Selector posterior Guardar/Copiar/Cancelar y diálogo de ubicación. Se rechaza una captura si la página navega mientras se obtiene y se comprueba imagen no vacía. Captura completa limitada a 40 MP, ancho 16384 y alto 32768; el rectángulo se valida en main. No se altera el DOM para capturar. Se libera solamente el debugger adquirido por esta operación, antes de navegar y antes del diálogo; no se separa deliberadamente el observador existente de EVO. Requiere validación de convivencia CDP real.

## Seguridad y preservación

- Se mantienen contextIsolation y separación shell/páginas. Las ventanas web auxiliares usan sandbox, sin Node ni preload privilegiado y navegación HTTP(S).
- IPC avanzado comprueba shell exacta, mainFrame, BrowserWindow y propietario del webContents invitado.
- Capacidades de contexto generadas en main: token aleatorio, uso único, 30 segundos, propietario, URL y navegación. No se aceptan URLs/funciones arbitrarias del renderer para ejecutar una acción contextual.
- Los handlers heredados de descargas también exigen shell autorizada; abrir archivo exige descarga completada.
- Servicios externos de traducción/búsqueda inversa requieren acción y confirmación explícitas. Las búsquedas de selección son acciones deliberadas del menú.
- Preferencias, nombres, IDs, rectángulos y operaciones se validan/acotan; credenciales y contenido de conversaciones no se incorporan a esta documentación.
- No se modificó el pipeline de mediación, memoria, deduplicación, presupuestos o persistencia EVO. Esto es una afirmación de alcance del cambio, no una prueba de ausencia de regresiones.

## Limitaciones explícitas

1. Nuevas ventanas son ventanas web simples con contexto nativo básico, no nuevas shells completas con toolbar/EVO. Comparten perfil; menú global/atajos pueden conservar destino en la shell principal.
2. Workspaces organizan pestañas del mismo perfil; no aíslan cookies, permisos o cuentas. Barra de favoritos visible y split son estado de ventana, no persistencia de disposición completa.
3. No hay modo privado ni gestor real de extensiones en esta fase.
4. Descarga contextual original limitada a HTTP(S); no se promete blob/data ni saltar restricciones del servidor. El recurso puede variar por negociación, autenticación o respuestas del servidor. Copiar imagen no equivale a conservar bytes originales en clipboard.
5. Pausa/reanudación depende del servidor y del DownloadItem vivo. No se implementa reanudación de red después de reiniciar; el historial no la simula.
6. Lector básico basado en texto del DOM, no motor avanzado de extracción. Voz sólo mediante acción explícita y speechSynthesis disponible; las voces del sistema pueden usar red. Ver código muestra DOM serializado actual, no bytes originales HTTP.
7. Traducción usa Google externo, no motor local; búsqueda inversa comparte URL de imagen. Compartir nativo sólo donde existe soporte; en otros sistemas se copia enlace/texto.
8. Inicio conserva su destino existente; buscador configurable afecta omnibox y búsqueda contextual, no redefine todos los destinos iniciales.
9. Corrector depende de idiomas disponibles en Electron/SO. Aplicación a pestañas ya abiertas y fallos después de persistir preferencias pendientes de validar.
10. Límite de tamaño de captura, páginas protegidas, escalado DPI, zoom, clipboard y convivencia con DevTools pueden impedir operaciones; se informan errores, no se fabrican resultados.

## Validación pendiente — no realizada

- Ejecutar suites existentes y nuevas; revisar contratos, sesión retrocompatible y arranque real Electron.
- Windows/macOS/Linux y teclados ES/LatAm: AltGr, Plus, Command, Cmd+H (posible colisión con ocultar aplicación), edición y grabación de atajos.
- Menús en páginas, shell, diálogos, pestañas y ventanas auxiliares; foco, límites, accesibilidad y coexistencia de eventos nativos/renderer.
- Descargas reales con/sin Range, autenticación, cancelación, cierre de pestaña/panel, interrumpidas, diálogo y errores de disco.
- Captura visible/full/rect a distintos DPI/zoom, imágenes grandes, páginas dinámicas, navegación durante captura, DevTools y observador EVO conectado.
- Traducción confirmada, voz disponible/no disponible, lectura, corrector/idiomas y permisos; compartir en macOS y fallback.
- Persistencia/restauración de toolbar/teclado/workspaces, split, fijado/silencio, historial/favoritos y zoom por sitio.
- Regresión completa de navegación, permisos, sesiones, EVO, contadores, memoria y captura/persistencia. No se atribuye a esta fase ningún resultado de rendimiento previo.

## Proyecto completo

El ZIP de entrega incluye archivos fuente versionados y archivos nuevos de esta fase, documentación, tests y recursos del proyecto. Excluye `.git`, dependencias instaladas, builds, perfiles de usuario y artefactos temporales. La lista exacta se encuentra en `docs/NEXO-FASE4-ARCHIVOS.txt`; el SHA-256 acompaña al ZIP. Instalar/compilar/ejecutar queda para la fase de validación autorizada.

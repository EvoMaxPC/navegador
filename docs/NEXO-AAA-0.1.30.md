# NEXO BLACK & ELECTRIC BLUE · terminación AAA · 0.1.30

## Implementado directamente

Continuación del rediseño sobre el repositorio existente, con la referencia negra/azul como guía de composición. No se reconstruye el navegador ni se sustituye Electron por una maqueta.

- Negro dominante, grafito y acentos azul eléctrico/hielo. Cristal ahumado mediante transparencias, gradientes y reflejos finos; sin blur global ni filtros sobre webviews.
- Barra superior con logo, pestañas, crear pestaña, navegación, Inicio, direcciones, seguridad y marcadores. La pestaña activa ahora tiene indicador inferior azul. Los controles de ventana siguen siendo los nativos del sistema.
- Rail izquierdo de ocho secciones, compacto y accesible a distintos anchos.
- Inicio espacial con recursos SVG locales y seis accesos. ChatGPT, Google y YouTube utilizan trazados de marca de Simple Icons, servidos localmente y atribuidos en `src/ui/assets/services/README.md`.
- Tres tarjetas inferiores: rendimiento con valores no disponibles indicados por «—»; EVO MEMORY con acceso visual al panel; seguridad describe mecanismos realmente configurados, sin prometer protección total.
- EVO MEMORY con icono propio, botón real de fijar/desfijar y cerrar. Fijado reserva ancho; desfijado superpone el panel sin recrear ni recargar el webview. Este estado de presentación dura la sesión de la interfaz; no modifica configuración persistente.
- Conversación, Historial y Favoritos ahora son **tres vistas independientes**, con selección ARIA y teclado (izquierda/derecha/Home/End). Favoritos consulta los marcadores reales con el IPC existente y permite abrirlos; no se inventó una segunda base de conversaciones favoritas.
- La conversación conserva texto literal y separación visual por rol. Captura técnica y herramientas de continuidad siguen presentes, plegables, sin dominar la lista de mensajes.
- Estado inferior de memoria distingue lectura RAM, respaldo directo, guardado desactivado y registro local consultado. **Consultar el registro en memoria no equivale a verificar el archivo en disco.** La interfaz no presenta esa lectura como confirmación de persistencia.
- Botones con estados coherentes: principal azul, secundario grafito, borde premium, iconográficos, destructivo discreto, foco, presión breve, deshabilitado y carga. Aparición de vistas mediante transform/opacity de 120–160 ms; sin animaciones permanentes y con movimiento reducido respetado.
- Sin dependencias nuevas de ejecución, sin polling de consumo ni nuevos watchers de ChatGPT.

## Funciones preservadas y límites honestos

Preloads, contratos IPC, captura, recuperación y almacenamiento EVO no se modifican. Se reutilizan las llamadas y acciones existentes. Historial, descargas, marcadores, ajustes, repetición y herramientas de memoria permanecen disponibles.

La página de inicio sigue sin acceso al perfil ni IPC. Por eso la tarjeta EVO no duplica datos privados o indicadores inventados: la conversación, cantidad de mensajes, registro y estado se muestran en el panel real. CPU/RAM/GPU no están expuestos a la UI; se señalan como no disponibles. No se añadió un modo Turbo ficticio. La disponibilidad de red viene de `navigator.onLine`, no es una medición de velocidad.

EVO LABS y PIXELVERSE siguen sin destino ni activos de marca suministrados en el proyecto, y Extensiones no tiene gestor implementado. Se conservan explícitamente deshabilitados en lugar de inventar acciones. Los destinos anteriores de IA y trabajo permanecen en Más aplicaciones.

### Corrección funcional detectada por la prueba real

La ejecución Windows inicial de esta iteración (`42765316972`) pasó captura, texto literal, archivo de memoria, anclaje, favoritos, historial y atrás/adelante, pero falló al regresar a Inicio. El servidor del protocolo `nexo://` estaba registrado sólo en la sesión principal: las pestañas usan `persist:nexo`.

Se corrigió **sólo el registro del mismo handler de recursos internos en esa sesión**, manteniendo la lista pública y bloqueos originales. No se cambió la arquitectura, el preload, los permisos, el motor ni la persistencia. Se añadió un test de regresión que comprueba inicio, CSS/JS e iconos y rechaza archivos de main, preload y package. No se relajó el bloqueo de navegaciones iniciadas por sitios remotos.

## Archivos modificados en esta iteración

- `src/ui/shell/index.html`, `styles.css`, `app.js`: composición refinada, vistas, anclaje y estados.
- `src/ui/shell/memoryPanel.js`: controlador de presentación accesible y etiquetas de estado; no guarda datos.
- `src/ui/start/index.html`, `start.css`: marcas, tarjetas y ajuste de altura.
- `src/ui/assets/services/{openai,google,youtube}.svg`, `README.md`: trazados locales y atribución CC0.
- `src/main/main.js`: mismo servidor de recursos internos registrado también en la sesión de pestañas.
- `test/blue-interface.test.js`, `test/memory-panel.test.js`: contratos y estados de presentación.
- `test/main-boot.test.js`, `test/harness/electron-stub.mjs`: regresión del protocolo por sesión.
- `scripts/probes/repetition-electron.cjs`: prueba real ampliada de UI/navegación y evidencia.
- `.github/workflows/compilar-windows.yml`: conservar informes y capturas de validación como artefacto.
- `package.json`, `package-lock.json`, `dev/preview.js`: versión 0.1.30, sin dependencias añadidas.

## Validación local

- `npm run verify`: **715 tests, 714 correctos, 1 omitido, 0 fallos**. Bundle de inyección generado/verificado.
- Pruebas focales de interfaz y presentación: 24 correctas. Regresión del arranque/protocolo: 32 correctas.
- QA Chromium: botones y atajos de pestañas, omnibox, rail, abrir/cerrar panel, fijar/desfijar, tres vistas de memoria, teclado, Más aplicaciones y herramientas secundarias.
- 1600×1000, 1366×768, 1024×768, 768×900 y 480×820; sin desbordes horizontales. En ancho estrecho, panel superpuesto y rail compacto.
- Sin errores JS/HTTP en el recorrido automatizado de interfaz.
- Axe-core (WCAG 2 A/AA y 2.1 AA): 0 infracciones detectadas en cada una de las tres vistas de memoria; 30 comprobaciones correctas por vista. Es una auditoría automatizada, no certificación completa ni sustituto de revisión humana.

## Comparación local antes/después

Baseline `e26c9b8` (0.1.29) frente a la nueva UI 0.1.30. Chromium headless, viewport 1600×1000, recursos locales, 10 contextos nuevos por versión, espera fija 600 ms y GC antes de leer heap. Se informa la mediana; no se realizó prueba estadística ni medición de FPS. Los tiempos de layout/estilos son trabajo acumulado de CDP, no latencia de interacción.

| Medida | Antes 0.1.29 | Después 0.1.30 | Cambio |
|---|---:|---:|---:|
| DOM interactivo (ms) | 19.50 | 18.55 | -4.9% |
| Heap JS tras GC (bytes) | 1285428.00 | 1294664.00 | +0.7% |
| Nodos DOM | 1446.00 | 1536.00 | +6.2% |
| Layout acumulado (ms) | 26.74 | 25.55 | -4.4% |
| Estilos acumulados (ms) | 16.69 | 16.85 | +1.0% |

El heap aumenta unos 9 KB (+0,7 %) y los estilos se mantienen prácticamente iguales en esta muestra. Las diferencias pequeñas de tiempos pueden ser ruido. **No se afirma que el navegador sea más rápido ni que consuma menos CPU/RAM.** El perfil corresponde a la vista UI, no al conjunto de procesos de Electron. No se midió fluidez mediante FPS ni batería.

## Reproducción y evidencia

Aplicación: `npm ci`, `npm run verify`, `npm start`. Windows: `npm run dist:win`.

Vista UI: `node dev/serve.mjs 3300 --browser`; no incorpora motor ni datos del perfil de Electron. Las capturas locales se identifican como vista UI sin conversaciones reales.

El ZIP de proyecto incluye código completo, este informe y `evidencia/`: capturas, mediciones JSON, resultados locales, auditoría de accesibilidad y diagnóstico del fallo que permitió corregir Inicio. No incluye `.git`, `node_modules` ni artefactos pesados.

El harness de evidencia `aaa-qa.cjs` usa `playwright-core` y `@sparticuz/chromium` instalados fuera del producto. `NEXO_QA_MODULES` indica su carpeta con package.json y `NEXO_QA_OUT` la salida. Servir el baseline 0.1.29 en puerto 3400 y la versión nueva en 3300; en Linux pueden requerirse bibliotecas nativas de Chromium. No se añaden estas herramientas como dependencias del navegador.

Las capturas de Electron del artefacto de validación usan **conversaciones de fixture HTTPS local**, no una cuenta autenticada ni conversaciones del usuario. La prueba lee el JSON de memoria en disco para comprobar literalidad, pero no modifica el motor. Queda pendiente la revisión manual en el equipo del usuario y una cuenta autenticada de ChatGPT.

## Resultado Windows final

[Run 42765742587 — success](https://github.com/EvoMaxPC/navegador/actions/runs/42765742587), código `5b0a38a6b3b98a6a74f0cd1593291d56166aa66f`.

Pasaron: verificación automática, integración Electron con fixture HTTPS, benchmark, empaquetado y humo del ejecutable. La integración ampliada comprueba anclaje real, favoritos guardados por IPC, historial EVO, historial de navegación, atrás/adelante, Inicio, carga de iconos por protocolo interno y crear/cerrar pestañas, además de las pruebas anteriores de texto literal y archivo de memoria.

- [Windows x64 compilado](https://github.com/EvoMaxPC/navegador/actions/runs/42765742587/artifacts/13738968925): artefacto `Nexo-win32-x64`, 158 497 076 bytes; digest del artefacto GitHub `sha256:11c4a57648cae0341e109bc56d86183fbdcc5f0ec70ff5b1a84adf882c9cd838`. No es el hash del ZIP interior.
- [Evidencia Windows](https://github.com/EvoMaxPC/navegador/actions/runs/42765742587/artifacts/13738639890): `Nexo-validacion`, con `ci-repetition.json`, `ci-bench.json`, `ci-humo.txt` y capturas de Electron. El JSON incluye una muestra de CPU y working set por proceso al terminar la integración; no representa uso cotidiano ni comparación controlada de CPU entre versiones.
- Los binarios e informes Windows permanecen en GitHub. El sandbox no pudo descargar el artefacto de validación porque el host de almacenamiento de Actions no está permitido; no se afirma haber inspeccionado localmente esos PNG ni sus valores de CPU. El estado de los pasos y el informe público se consultaron mediante la API de GitHub.

### Windows: RAM y arranque observados

Fuentes: [0.1.29](https://github.com/EvoMaxPC/navegador/issues/1#issuecomment-6760098582) y [0.1.30](https://github.com/EvoMaxPC/navegador/issues/1#issuecomment-6760328773), publicados por el harness de humo existente.

| Medida | 0.1.29 | 0.1.30 |
|---|---:|---:|
| Memoria total informada | 408,4 MB | 423,7 MB |
| Proceso principal | 114,9 MB | 116,0 MB |
| Procesos | 5 | 5 |
| Marca shell | 362,3 ms | 369,1 ms |
| Bundle de inyección | 61,2 kB | 61,2 kB |

La memoria total observada aumenta 15,3 MB (~3,7 %). Son ejecuciones individuales en runners Windows, no un ensayo controlado sobre el mismo equipo; además 0.1.30 corrige la carga interna de Inicio en la sesión de pestañas. No se puede atribuir el incremento exclusivamente al estilo ni concluir una mejora de velocidad. La GPU del runner informa composición/rasterizado por software y WebGL no disponible: no representa la aceleración gráfica de un equipo del usuario. No hay comparación controlada de CPU ni FPS; esos puntos quedan expresamente sin validar para uso real.

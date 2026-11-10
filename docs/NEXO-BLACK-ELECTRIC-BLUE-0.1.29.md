# NEXO BLACK & ELECTRIC BLUE · 0.1.29

## Implementación

Rediseño sobre el shell existente, no una aplicación reconstruida. La referencia azul/negra suministrada determina la composición: pestañas y navegación arriba, rail izquierdo, inicio con NEXO y búsqueda, seis accesos, tres tarjetas, panel EVO MEMORY a la derecha y estado abajo. Se moderaron el brillo y los efectos; el espacio/planeta es un SVG local de menos de 3 KB. No hay fuentes remotas, nuevas dependencias de ejecución, blur global ni animaciones permanentes.

- Paleta negro/grafito, azul eléctrico y hielo; paneles con gradientes suaves y bordes finos.
- Inicio, historial, IA, memoria, actividad, permisos y ajustes conectados a las acciones existentes.
- ChatGPT, Google y YouTube navegables. EVO LABS y PIXELVERSE sin destino definido en el proyecto: se muestran deshabilitados, con explicación, en vez de inventar URLs.
- «Más aplicaciones» conserva Claude, Gemini, Perplexity, DeepSeek, Copilot, Le Chat, Ollama local y los cuatro destinos de trabajo originales. Ollama conserva su destino local deliberadamente: sólo sirve si el usuario ejecuta ese servicio en su equipo.
- Todas las solapas y funciones originales siguen disponibles: repetición, actividad, memoria, historial, marcadores, descargas, sitios, ajustes y acerca de.
- Conversación e historial guardado desplazan al contenido real de memoria. Favoritos abre los marcadores existentes; no se inventó una segunda base de favoritos de conversaciones.
- CPU/RAM/GPU aparecen «—»: no existe una fuente de esos consumos en el renderer. La red sólo muestra `navigator.onLine`, no velocidad ni garantía de acceso a Internet. Versión desde configuración; estado de mediación desde ajustes.
- Extensiones deshabilitado y explicado: no había gestor de extensiones implementado. No se añadió un interruptor Turbo ficticio ni promesas de protección total.
- Nombres accesibles también con rail colapsado, foco visible, controles deshabilitados, navegación de solapas por teclado y `prefers-reduced-motion`.
- En anchos pequeños, rail compacto y panel lateral superpuesto; sin desbordes horizontales. Las páginas internas pueden desplazarse verticalmente para mantener todas las funciones.
- Controles de ventana nativos de Electron preservados. La vista web no representa esa barra de título del sistema operativo.

## Separación de responsabilidades

El commit `30ec481` preserva el respaldo DOM pendiente anterior al pedido visual (incluidos sus tests, revisión de fuente/carreras y advertencia de respaldo en RAM). No se atribuye a este rediseño. El respaldo directo no confirma por sí solo persistencia en disco.

El rediseño se implementó en `4caf08d` y la corrección de nombres accesibles en `cb2d9f3`. No modifica motor EVO, persistencia, preloads, canales IPC ni proceso principal. Los nuevos accesos del shell delegan en funciones existentes. Inicio sigue sin IPC ni acceso al perfil.

### Archivos del rediseño

- `src/ui/shell/index.html`: composición, rail, navegación de memoria y estado.
- `src/ui/shell/styles.css`: paleta y geometría, controles y adaptabilidad.
- `src/ui/shell/app.js`: enlaces a acciones existentes, versión y disponibilidad de red; altura del chrome mediante ResizeObserver, sin polling.
- `src/ui/start/index.html`, `start.css`, `start.js`: inicio, búsqueda y aplicaciones desplegables.
- `src/ui/assets/nexo-mark.svg`, `orbit.svg`: marca y fondo espacial locales.
- `dev/serve.mjs`, `dev/preview.js`: rutas de assets y aviso explícito de vista UI sin Electron.
- `test/blue-interface.test.js`: contratos visuales, destinos, recursos y accesibilidad del rail.
- `package.json`, `package-lock.json`: versión 0.1.29, sin nuevas dependencias.

## Validación

### Local

`npm run verify`: **705 tests, 704 correctos, 1 omitido, 0 fallos**. Incluye generación/verificación del bundle. `git diff --check` correcto. Tests focales de interfaz/contrato: 15 correctos.

QA de interfaz en Chromium headless con el adaptador explícito de vista web, no Electron:

- Crear/cerrar pestañas con botón y Ctrl+T / Ctrl+W; Ctrl+L.
- Abrir actividad, historial, seguridad, ajustes, memoria y solapas secundarias.
- Cerrar/reabrir panel; conversación, historial guardado y marcadores.
- Abrir/cerrar más aplicaciones y comprobar los once accesos conservados.
- Comprobar controles no disponibles sin simular funciones.
- 1600×1000, 1366×768, 1024×768, 768×900 y 480×820; sin desborde horizontal.
- Sin errores JS ni respuestas HTTP de error durante el recorrido de QA.

**Límites:** el adaptador web no navega a los servicios externos y no representa el motor, datos del perfil ni persistencia de Electron. No se probó una cuenta real autenticada de ChatGPT ni el checklist manual del equipo Windows del usuario.

### Windows x64

[Compilación 42764125860](https://github.com/EvoMaxPC/navegador/actions/runs/42764125860), código `cb2d9f31de73285e750edcd0388f9286bfde0454`: **success**. Pasaron verificación automática, conversación en Electron real con fixture HTTPS, benchmark, empaquetado y humo del ejecutable.

[Descargar artefacto Windows](https://github.com/EvoMaxPC/navegador/actions/runs/42764125860/artifacts/13739046698).

- Artefacto: `Nexo-win32-x64`, ID `13739046698`.
- Tamaño del artefacto GitHub: 158 193 028 bytes.
- Digest del artefacto GitHub: `sha256:771e9b2fe7b7d039b4750899c739673891934fff90533b86afb684f7184661d1` (no se presenta como hash del ZIP interior).
- Los logs completos no pudieron descargarse desde este sandbox: la red rechaza el host de almacenamiento de logs de Actions. El estado y cada paso se verificaron con la API de GitHub.

## Rendimiento antes/después

Comparación local de **UI**, no de consumo global ni de velocidad de navegación. Baseline `30ec481` (interfaz anterior, mismo respaldo DOM) frente al rediseño; Chromium headless, viewport 1600×1000, 10 contextos nuevos por versión, espera fija de 600 ms, GC antes de leer heap. Medianas, sin inferencia estadística. Los valores de layout/estilos son trabajo acumulado informado por CDP, no latencia de interacción. Recursos servidos localmente.

| Métrica | Antes | Después | Cambio |
|---|---:|---:|---:|
| DOM interactivo (ms) | 20.60 | 19.15 | -7.0% |
| Heap JS tras GC (bytes) | 1232316.00 | 1285428.00 | +4.3% |
| Nodos DOM | 1278.00 | 1446.00 | +13.1% |
| Layout acumulado (ms) | 27.90 | 31.41 | +12.6% |
| Recálculo de estilos acumulado (ms) | 12.69 | 18.74 | +47.8% |
El heap aumenta aproximadamente 53 KB y se añaden 168 nodos. Layout y estilos cuestan más con la composición nueva. La diferencia pequeña en DOM interactivo es sensible al ruido y **no demuestra una mejora de rendimiento general**. No se midieron FPS, GPU, consumo total de Electron ni navegación de sitios reales. No se prometen reducciones de RAM o aceleración Turbo.

El bundle de inyección se mantiene separado de los estilos. No se añadieron procesos, watchers del DOM de ChatGPT ni mecanismos de captura por el trabajo visual.

## Entrega y reproducción

El ZIP de proyecto contiene el código fuente completo (sin `.git`, `node_modules` ni binarios generados), este informe y una carpeta `evidencia` con capturas, logs locales y mediciones JSON. Ejecutar `npm ci`, `npm run verify` y `npm start` en un entorno compatible con Electron. `npm run dist:win` genera el ZIP ejecutable; el ya compilado está disponible en el artefacto enlazado arriba.

Vista UI: `node dev/serve.mjs 3300 --browser`. No sustituye la aplicación Electron.

La evidencia incluye `blue-qa.cjs`, el harness de Chromium usado para el recorrido y mediciones. Sus dependencias son opcionales y externas al navegador (`playwright-core`, `@sparticuz/chromium`). Requiere el baseline servido en puerto 3400 y la versión nueva en 3300. `NEXO_QA_MODULES` indica la carpeta que contiene el `package.json` de esas dependencias; `NEXO_QA_OUT` el directorio de resultados. Según el sistema, Chromium puede necesitar bibliotecas nativas. No son dependencias del producto.

Las capturas muestran datos vacíos reales de la vista UI; no conversaciones ni indicadores inventados. El antes/después compara la composición de inicio y el panel Memoria. Hay capturas adicionales de actividad, historial, permisos, ajustes y tamaños adaptables. La referencia tiene brillos más intensos; se conservaron disposición y jerarquía con un tratamiento moderado para no introducir efectos costosos ni texto engañoso.

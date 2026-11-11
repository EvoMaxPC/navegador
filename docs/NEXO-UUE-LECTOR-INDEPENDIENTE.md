# Canal DOM independiente de Comprensión · 0.1.33

Este canal se conserva en la reconstrucción del módulo. Su consumidor ya **no**
es el antiguo User Understanding Engine: es `ConversationOptimizer`.
[Arquitectura vigente](NEXO-COMPRENSION-OPTIMIZACION.md).

- `src/preload/bridge.cjs` inicia `build/understanding-reader.cjs` antes del lector
  EVO/Repetición, en el mundo aislado de la webview y sin consultar sus interruptores.
- `src/preload/understandingReader.js` tiene observador, cola de 500 ms y ACK propios.
  Reutiliza el adaptador DOM de EVO, no su instancia, transcripción ni motor.
- `src/core/understandingConversation.js` obtiene texto literal, rol explícito,
  identidad de mensaje, orden, cobertura y recortes.
- `nexo:understanding:conversation` es exclusivo del lector aislado. Main exige
  guest propio, mainFrame, HTTPS, host exacto ChatGPT, mismo origen/ruta y chat no
  temporal. Valida todos los campos y presupuestos antes de aceptar contenido.
- Los canales de Repetición y EVO **no alimentan** el optimizador. No hay fallback
  hacia el motor retirado ni doble alimentación del contexto desde esas rutas.
- Comprensión trabaja aunque Mediación y EVO Memory estén apagadas. Los motores
  de EVO Memory no se modificaron. Repetición conserva su vista RAM y contadores.
- La shell confiable puede pedir relectura mediante `nexo:understanding-read`.
  `postMessage` de la página no obtiene esta API ni acceso a sus snapshots.

Se capturan hasta 2000 mensajes recientes, 200000 caracteres por mensaje y
2000000 caracteres por snapshot. Si falta presupuesto se prioriza lo reciente
conservando el orden. El payload declara cantidad detectada/enviada/omitida,
`clipped`, `streaming` y `remote_history_complete:false`. La compresión no acepta
una ventana recortada como si fuera definitiva o completa.

MutationObserver sobre Document, rAF/fallback, sondeo, navegación, visibilidad,
foco y pageshow detectan actualizaciones. Un rechazo o fallo de IPC permite
reintentar; pagehide vacía pendientes, pageshow restaura un único observador y
disconnect cancela definitivamente. No se leen composer, cookies ni formularios.

Los IDs nativos permiten fusionar mensajes y sus actualizaciones en el nuevo
motor sin descartar mensajes ausentes de una ventana posterior. Si el adaptador
sólo tiene IDs posicionales y su contenido cambia, o el orden solapado resulta
incompatible, el nuevo motor marca incertidumbre y no comprime ese contexto.

No se hace scroll automático ni se consultan APIs privadas. Un mensaje remoto
que ChatGPT no haya cargado no puede capturarse. Estas garantías están probadas
con fixtures/VM/Electron stub; falta validar el DOM actual con una cuenta real.

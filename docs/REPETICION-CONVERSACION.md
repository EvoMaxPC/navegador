# Repetición de conversación — Nexo 0.1.26

## Uso

1. Abrir una conversación normal de ChatGPT en Nexo, nueva o antigua.
2. Abrir el panel EVO y elegir el icono de dos hojas, **Repetición de conversación**, debajo de Actividad.
3. El panel muestra **Vos** y **ChatGPT** en el orden del documento, sin tener que enviar un mensaje nuevo. Las respuestas parciales se actualizan en el mismo mensaje, sin añadir una copia por fragmento.
4. Los cambios del documento se agrupan aproximadamente cada 500 ms. Al cambiar de pestaña o conversación, se cambia la fuente; nunca se muestra intencionalmente el chat de otra pestaña.
5. Si se está leyendo arriba, las actualizaciones no fuerzan el scroll al final. El texto se puede seleccionar/copiar normalmente; no se modifica el portapapeles automáticamente.

## Qué significa «literal»

El panel inserta mediante `textContent` el texto obtenido del contenido de los mensajes en el DOM. No lo resume, no lo traduce, no lo reescribe, no elimina espacios iniciales/finales ni lo pasa por el tokenizador. Conserva los saltos de línea y el Unicode que devuelve el lector. No interpreta HTML, scripts ni Markdown de la conversación como código ejecutable.

Es una repetición **textual**, no una captura gráfica: el ancho y los saltos visuales de ajuste pueden diferir. No promete reconstruir el Markdown original del servidor, imágenes, archivos adjuntos, razonamiento oculto ni mensajes que el sitio no haya cargado. La exactitud se refiere a la cadena leída del DOM, no a una comparación con bytes SSE o con el consumo real de OpenAI. Cambios futuros de selectores/estructura de ChatGPT pueden requerir adaptar el lector.

## Chats antiguos y límites explícitos

- Un historial ya cargado se lee al abrirlo, sin depender de un fetch nuevo o de que CDP conserve su cuerpo.
- Si ChatGPT carga el historial por partes, desplazarse por la conversación para que aparezcan los mensajes que faltan. Nexo no accede a historiales privados mediante APIs alternativas ni promete leer lo que no existe en el DOM.
- Se muestran hasta los últimos 200 contenedores de mensajes cargados; límite por mensaje de 200.000 caracteres y por snapshot de 1.000.000 de caracteres. Si hay recorte/omisión por estos límites, el panel muestra explícitamente **«no es la conversación completa»**.
- Estos límites son independientes de los límites de EVO MEMORY: la vista no hereda el recorte de 10.000 caracteres de la transcripción histórica de memoria.
- Se mantiene la exclusión de chats temporales. No lee composer, contraseñas, cookies, formularios ni otros sitios.

## Arquitectura y privacidad

Se reutiliza `watchChatGptConversation`: **un solo MutationObserver**, ahora sobre `Document` y en el preload aislado. Publica por separado el snapshot de memoria existente y la vista literal. Se conserva el respaldo de sondeo incorporado por el cambio concurrente `93a56e3` (1,2 s, sin releer el DOM de pestañas ocultas desde ese respaldo), además de los eventos de navegación. No existe un lector paralelo en el mundo principal. Memoria conserva su contrato y sus límites anteriores.

Flujo: DOM compartido → `build/chatgpt-reader.cjs` en preload aislado → `nexo:repetition:snapshot` → caché volátil por webContentsId/URL → evento a la shell → render por cuadro.

- La repetición funciona aunque mediación y EVO MEMORY estén apagadas. En ese modo el fetch pasa al original sin inspección/reescritura del cuerpo: sólo se lee el DOM para esta vista.
- La ruta de repetición **no cuenta turnos/respuestas/tokens, no destila y no escribe nuevos archivos**. EVO MEMORY, si está habilitada, mantiene por separado su comportamiento previo.
- El texto de esta copia sólo vive en memoria mientras está abierta la pestaña. La caché se elimina al navegar/cerrar; al reabrir Nexo se vuelve a leer el documento cargado. La política previa de persistencia de EVO MEMORY no cambia.
- El receptor sólo acepta snapshots del main frame de un webview ChatGPT HTTPS y exige coincidencia de URL real. Valida roles, estructura y límites antes de guardarlos en RAM.
- Sólo la shell conocida puede consultar `nexo:repetition:get`; una web no puede leer la repetición de otra pestaña. El puente no habilita canales IPC arbitrarios.
- El contenido no se envía a servicios externos ni se añade al JSONL de diagnóstico. La shell no usa `innerHTML` para pintar estos mensajes.

## Validación

- Suite completa: **667 pruebas, 666 aprobadas, una omitida, cero fallos**.
- Tests del lector: espacios, saltos, Unicode, chats ya abiertos, cambios parciales, cambio SPA/chat vacío, exclusión de temporales, mensajes mayores de 10k y límites explícitos.
- Tests de IPC: memoria/mediación apagadas, aislamiento por pestaña, cambio de URL, limpieza al destruir, rechazo de páginas ajenas, subframes y lectores no privilegiados; la repetición no mueve contadores ni memorias.
- Test del circuito de producción: DOM simulado → bundle generado → preload real → IPC del principal → consulta desde shell, incluyendo respuesta de más de 18k, actualización sin duplicación y fetch de paso directo con memoria/mediación apagadas.
- Tests del renderer: sólo texto, no ejecución HTML, actualización del mismo nodo sin duplicados, vaciado, aviso de límites y respeto del scroll del usuario.
- Chromium headless con fixture local y MutationObserver real: panel a 1440×1000 y 760×900, ambos roles exactos, conservación de espacios/saltos/Unicode, actualización automática, ausencia de HTML ejecutable, chat vacío y memoria apagada. Sin errores JS ni infracciones detectadas por axe WCAG 2 A/AA en ese recorrido. No es certificación de accesibilidad ni una sesión real de ChatGPT.
- Benchmark existente ejecutado sin cambiar presupuestos; bundle de inyección aproximadamente **58,5 kB** sumando el bundle principal y el nuevo bundle del lector (no se oculta el coste trasladado al preload; baseline previo: 51,3 kB). Sin dependencias nuevas de producción.

Pendiente: confirmar los selectores, lectura completa del contenido cargado, cambios de conversación y generación en una sesión propia de ChatGPT dentro de Electron/Windows. Los tests y fixtures no equivalen a esa comprobación.

## Integración concurrente

Se conservaron e integraron los commits remotos `2bb1696`, `4ec73d2` y `71c6512`, que muestran un espejo temporal de captura dentro de la propia pestaña. Ese espejo de diagnóstico no sustituye este panel lateral: no muestra por sí mismo ambos roles ni todo el historial cargado. Su Shadow DOM cerrado no se recorre al leer los mensajes. Se completó el mock de Document con `addEventListener` para probar también ese arranque sin alterar la lógica de producción del espejo.

También se integraron `131920a` y `ae9fbbd`, con lectura DPU del último assistant posterior al último usuario renderizado, aunque el prompt proporcionado difiera. Se conservan los controles existentes de generación vigente y frescura del observador de espera; esto no demuestra por sí mismo que un turno pertenezca a una petición de red concreta.

## Adaptador EVO — 0.1.25

`src/core/chatgptAdapter.js` centraliza las cuatro estrategias, en orden: `[data-message-author-role]`, `[data-turn]`, `[data-testid^="conversation-turn"]`, `article`. Conversación, DPU y detección de streaming reutilizan este módulo. Se eliminan candidatos anidados y no se inventan roles por alternancia: se usan atributos de rol, descendientes explícitos o las estructuras conocidas de burbuja/Markdown. Contenedores ambiguos se omiten.

El texto visible se conserva con `innerText`; los bloques de código siguen dentro del mensaje, sin duplicarse. El helper de código permite leer lenguaje y código por separado cuando se necesite. IDs existentes de mensaje/turno se priorizan, con posición DOM como alternativa estable durante una generación (sin hash del texto cambiante). No se añadieron funciones para insertar texto ni leer el composer.

El estado de generación reconoce Stop/Detener/Parar, descarta botones deshabilitados y etiquetas de dictado/voz/micrófono. El diagnóstico desplegable del panel muestra estrategia, número de mensajes visibles y estado; `window.__nexo.conversationReader()` añade los conteos de candidatos sin contenido, IDs ni rutas. La estrategia que cruza IPC se valida contra una lista permitida.

Validación adicional: cuatro estrategias con ambos roles, literalidad, DPU, prioridad de selectores, anidamiento, rechazo de roles ambiguos, IDs, código, botones y metadatos sin contenido. Chromium con DOM/MutationObserver reales: estrategias alternativas en la fixture del panel, texto exacto, sin duplicados ni errores JS; cero infracciones axe detectadas en el recorrido. Captura: `/home/user/nexo-repeticion-adaptador.png`. No se probó una cuenta real de ChatGPT ni el ejecutable Windows de esta versión.

Se integraron además los cambios concurrentes hasta `e9334eb` y sus seis pruebas del lector histórico/IDs. Se mantuvo el adaptador compartido (sin duplicar estrategias ni asignar roles a ciegas por paridad), con reconocimiento de estructuras anidadas también para `data-turn`. Suite completa posterior a esta integración: 667 pruebas, 666 aprobadas, una omitida y cero fallos.

## Corrección del panel vacío — 0.1.26

La captura del usuario mostraba texto de GPT con el panel vacío. Una imagen no permite determinar si falló la selección, el arranque o el transporte; no se afirma una causa única de esa sesión.

Se reprodujeron dos fallos contra el código del ejecutable entregado (`84c3564`):

- `publishLive` marcaba un snapshot como enviado antes de confirmar IPC. Tras un rechazo y sin cambios del DOM, una nueva lectura no lo reenviaba (una publicación en vez de dos).
- `pagehide` activaba `stopped` de forma irreversible: `pageshow` de una página restaurada no recuperaba la lectura.

Ambos casos pasan en 0.1.26. También se corrigió observar sólo el `body` inicial, lo que perdía mutaciones tras sustituirlo.

La corrección no se limita a añadir selectores: el lector compartido se ejecuta desde `src/preload/chatgptReader.js`, empaquetado como CommonJS, en el mundo aislado. La copia llega por `ipcRenderer.invoke` directamente al principal, sin `postMessage` del sitio y aunque la inyección de mediación falle. El bridge de la página ya no acepta eventos de snapshot de conversación. Las confirmaciones/reintentos de memoria de los cambios concurrentes se mantienen mediante las promesas del IPC directo. No se añadieron dependencias de producción ni escrituras en el composer.

El principal solicita una relectura al estar listo el DOM, tras navegación SPA y al consultar una caché vacía desde la shell autorizada. Una relectura explícita permite repoblar la caché aunque el texto no haya cambiado. El diagnóstico diferencia «no se recibió snapshot» de «lector activo sin mensajes reconocidos».

### Evidencia

- `npm run verify`: **667 pruebas; 666 aprobadas, una omitida, cero fallos**.
- Nuevas regresiones: `test/chatgpt-reader-lifecycle.test.js`; también prueba directa de IPC aislado con memoria/mediación apagadas y confirmación de memoria.
- Chromium con mundos separados mediante CDP: preload de producción, inyección principal bloqueada intencionalmente, ambos roles recibidos por IPC simulado, sustitución de body y eventos pagehide/pageshow. No cuenta de ChatGPT.
- `scripts/probes/repetition-electron.cjs`: aplicación y shell de producción, webview HTTPS servido localmente mediante interceptación de protocolo (sin excepciones TLS), preload real, IPC real y panel real. Comprobó texto literal, memoria/mediación apagadas, actualización sin duplicados, APIs del mundo principal alteradas, reemplazo de body y eventos pagehide/pageshow sintéticos. Estos últimos no equivalen a una navegación BFCache completa.
- Windows CI **42755430646**, commit **9813fc4**: verificación, integración Electron, benchmark, empaquetado y prueba de arranque **correctos**.
- ZIP 0.1.26: https://github.com/EvoMaxPC/navegador/actions/runs/42755430646/artifacts/13735686481 . Incluye la corrección; no es el ZIP anterior 0.1.25.

Pendiente todavía: validación en una sesión real de ChatGPT del usuario. No se afirma haber accedido a su cuenta, su DOM real o su conversación a partir de la imagen.

# Repetición de conversación — Nexo 0.1.24

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

Se reutiliza `watchChatGptConversation`: **un solo MutationObserver**, sin un segundo observador ni polling por intervalo. Publica por separado el snapshot de memoria existente y la vista literal. Memoria conserva su contrato y sus límites anteriores.

Flujo: DOM → bundle → preload aislado → `nexo:repetition:snapshot` → caché volátil por webContentsId/URL → evento a la shell → render por cuadro.

- La repetición funciona aunque mediación y EVO MEMORY estén apagadas. En ese modo el fetch pasa al original sin inspección/reescritura del cuerpo: sólo se lee el DOM para esta vista.
- La ruta de repetición **no cuenta turnos/respuestas/tokens, no destila y no escribe nuevos archivos**. EVO MEMORY, si está habilitada, mantiene por separado su comportamiento previo.
- El texto de esta copia sólo vive en memoria mientras está abierta la pestaña. La caché se elimina al navegar/cerrar; al reabrir Nexo se vuelve a leer el documento cargado. La política previa de persistencia de EVO MEMORY no cambia.
- El receptor sólo acepta snapshots del main frame de un webview ChatGPT HTTPS y exige coincidencia de URL real. Valida roles, estructura y límites antes de guardarlos en RAM.
- Sólo la shell conocida puede consultar `nexo:repetition:get`; una web no puede leer la repetición de otra pestaña. El puente no habilita canales IPC arbitrarios.
- El contenido no se envía a servicios externos ni se añade al JSONL de diagnóstico. La shell no usa `innerHTML` para pintar estos mensajes.

## Validación

- Suite completa: **640 pruebas, 639 aprobadas, una omitida, cero fallos**.
- Tests del lector: espacios, saltos, Unicode, chats ya abiertos, cambios parciales, cambio SPA/chat vacío, exclusión de temporales, mensajes mayores de 10k y límites explícitos.
- Tests de IPC: memoria/mediación apagadas, aislamiento por pestaña, cambio de URL, limpieza al destruir, rechazo de páginas ajenas, subframes y lectores no privilegiados; la repetición no mueve contadores ni memorias.
- Test del circuito de producción: DOM simulado → bundle generado → preload real → IPC del principal → consulta desde shell, incluyendo respuesta de más de 18k, actualización sin duplicación y fetch de paso directo con memoria/mediación apagadas.
- Tests del renderer: sólo texto, no ejecución HTML, actualización del mismo nodo sin duplicados, vaciado, aviso de límites y respeto del scroll del usuario.
- Chromium headless con fixture local y MutationObserver real: panel a 1440×1000 y 760×900, ambos roles exactos, conservación de espacios/saltos/Unicode, actualización automática, ausencia de HTML ejecutable, chat vacío y memoria apagada. Sin errores JS ni infracciones detectadas por axe WCAG 2 A/AA en ese recorrido. No es certificación de accesibilidad ni una sesión real de ChatGPT.
- Benchmark existente ejecutado sin cambiar presupuestos; bundle de inyección aproximadamente **53,8 kB** en el estado integrado (baseline previo: 51,3 kB; el total incluye también el espejo de diagnóstico remoto). Sin dependencias nuevas de producción.

Pendiente: confirmar los selectores, lectura completa del contenido cargado, cambios de conversación y generación en una sesión propia de ChatGPT dentro de Electron/Windows. Los tests y fixtures no equivalen a esa comprobación.

## Integración concurrente

Se conservaron e integraron los commits remotos `2bb1696`, `4ec73d2` y `71c6512`, que muestran un espejo temporal de captura dentro de la propia pestaña. Ese espejo de diagnóstico no sustituye este panel lateral: no muestra por sí mismo ambos roles ni todo el historial cargado. Su Shadow DOM cerrado no se recorre al leer los mensajes. Se completó el mock de Document con `addEventListener` para probar también ese arranque sin alterar la lógica de producción del espejo.

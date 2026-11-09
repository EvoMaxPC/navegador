# Tokens de salida GPT — auditoría y corrección 0.1.14

**Estado: corrección implementada y validada con grabaciones externas y pruebas automatizadas. No cerrada según el criterio de conversación real del usuario.**

## 1. Diagnóstico previo a los cambios

Se auditó el árbol limpio basado en `ae8d1b0`. El diagnóstico se comunicó antes de modificar código. No se partió de que la tokenización estuviera rota.

### Fallos comprobados

1. **Tokens calculados pero no notificados a la interfaz.** `Engine.#absorbTokens()` recuperaba el texto de una respuesta ya contada y sumaba sus tokens. Devolvía `duplicate: true` para no sumar otra respuesta. `CdpObserver.#deliver()` comunicaba esa marca, y el callback `onEvent` de `src/main/main.js` retornaba antes de `broadcast('nexo:stats-changed', engine.stats())`.
   - Reproducción previa, con Electron simulado y proceso principal real: `outputTokens` interno **0 → 15**, **0 avisos nuevos**, último aviso a la shell **0**.
   - Después: **0 → 15**, **1 aviso nuevo**, aviso a la shell **15**.
2. **Formato de captura no reconocido.** `looksLikeStream()` aceptaba NDJSON, pero `createStreamFilter()` sólo usaba `parseSSE()`. CDP separaba los JSON por líneas, pero el adaptador tampoco entendía los eventos actuales `type: "content"`, `markdown`, `mode`, `revision`. La grabación externa `logged-out-reply.ndjson` producía texto vacío.
3. **SSE compacto y multiplexado interpretado incorrectamente.** El adaptador no seguía las raíces `v.message`, las operaciones heredadas ni los contextos `c`. Un mismo texto puede viajar como fragmento oculto y mensaje fusionado visible. La extracción genérica agregaba además valores de control: la grabación `normal-reply.sse` daba `REDACTED! ✅ I’m here and ready to help.finished_successfully` en vez de `Test successful! ✅ I’m here and ready to help.`. Los parches agrupados también debían reescribir `v.<índice>.v`, no reemplazar el array completo `v`.
4. **Tokenizador sin recuperación específica de salida.** Una excepción de BPE se propagaba al procesamiento de la captura. Se reprodujo induciendo una excepción, no observando un fallo espontáneo del paquete.
5. **Finalización y parciales.** El filtro sólo emitía `onEnd` al hacer `flush`: un aborto no notificaba el texto ya recibido. Además, la deduplicación por ID retornaba antes de ajustar un texto que había crecido; las diferencias BPE se limitaban a positivas, aunque una extensión puede reducir tokens (`functio`: 3; `function`: 1).

Estas son causas reproducidas. **No hay una captura de la sesión Windows del usuario que permita atribuirle exactamente uno de esos caminos.**

## 2. Recorrido reconstruido

1. **Detección:** el perfil ChatGPT de `src/core/sites.js` reconoce peticiones de conversación, excluye preparación y contempla el canal de actualizaciones sin cuenta. `planRequest()` de `src/inject/index.js` localiza el prompt. El proceso principal observa además `webRequest` y CDP correlaciona por `requestId` y pestaña.
2. **Fetch:** `window.fetch` se envuelve en el mundo principal. La petición se envía una sola vez mediante `nativeFetch`; `wrapResponse()` procesa su cuerpo. No existe un reemplazo de `XMLHttpRequest` en esta rama: las respuestas XHR y las de workers dependen del respaldo CDP (`XHR`, `Fetch` y tipos alternativos reconocidos como `Other`).
3. **Streaming:** `createStreamFilter()` decodifica bytes de forma incremental. SSE se separa en eventos completos mediante `parseSSE()`. NDJSON usa líneas completas; si llega como `text/plain`, se identifica su formato. El wire NDJSON se conserva, sin convertirlo a SSE ni modificar sus bytes Unicode.
4. **Extracción:** `createAdapter('chatgpt')` mantiene contextos por canal `c`, rol, mensaje y parte; procesa raíces, parches y continuaciones, y reconstruye el snapshot. Excluye usuario, sistema, herramientas, razonamiento y copias marcadas como ocultas/fragmentos. Para NDJSON reconstruye `markdown` con `replace`/`append` y deduplica revisiones.
5. **Cierre:** los controles terminales permiten liberar texto retenido; el cierre normal del transporte emite `onEnd` una sola vez. Un rechazo/cancelación de `pipeTo` invoca `finishInterrupted()` para anunciar el contenido parcial sin ocultar el error de lectura al cliente.
6. **Puente:** `onEnd` transmite `text`, modelo y estado mediante `window.postMessage` → `src/preload/bridge.cjs` → `ipcRenderer.invoke('nexo:stream-end', payload)`. El metadato estimado del mundo de la página no decide el contador de salida.
7. **CDP:** `src/main/cdp.js` observa respuestas y al `loadingFinished` pide `Network.getResponseBody`, decodifica base64 si corresponde y procesa SSE/NDJSON/JSON con `CdpCapture` y el mismo adaptador. La lectura SSE utiliza ahora eventos completos, incluidos `data:` multilínea. Cuando el cuerpo no está disponible, deja el diagnóstico existente; no inventa texto ni tokens.
8. **Tokens y Engine:** `countOutputTokens()` utiliza el BPE local existente de `countTokensForProvider()`/`src/core/gptTokens.cjs` y el modelo del mensaje/solicitud. Conserva `cl100k_base` para las familias clásicas reconocidas y `o200k_base` como selección existente para GPT moderno/modelo no identificado. Sólo ante excepción o recuento inválido estima sobre el texto real y registra `output-tokenizer-fallback`. Un cuerpo sin texto aporta cero.
9. **Contadores:** `#countResponse()` y `onCdpCapture()` incorporan salida una sola vez. `#absorbTokens()` agrega tokens a una respuesta ya contada sin texto. `#mergeResponse()` corrige el total final de los parciales, también cuando el BPE disminuye. No se agregaron contadores ni cambios a los incrementos de mensajes, entrada, respuestas, turnos o intervenciones.
10. **Interfaz:** el principal emite `nexo:stats-changed`, incluso cuando CDP aporta tokens sin una respuesta nueva. `src/preload/shell.cjs` permite ese canal. El listener existente de `src/ui/shell/app.js` ejecuta `refreshStats()` → `nexo.getStats()` → `stats.outputTokens` → `#statOutTokens.textContent`, formateado en `es-AR`. No se cambió ese circuito ni se rediseñó la interfaz; sólo se actualizó versión y nota explicativa.

No se agregó MutationObserver ni otro capturador DOM: la evidencia mostró fallos reparables en los mecanismos existentes. El DOM de esta rama se usaba para gestos de envío y continuación, no para capturar respuestas.

## 3. Evidencia externa, no fixtures fabricados para NEXO

Se incorporaron seis grabaciones anonimizadas del proyecto `Adr1enR1chard/ecologits-extension`, fijadas al commit `05502ec6943cc55a87a2884bd6927eb85be5c995`: normal, Thinking largo, regeneración, SSE abortado, NDJSON sin cuenta normal y detenido. El catálogo de origen identifica los seis como grabados mediante `howToRecord`; su README documenta la grabación y anonimización conservando estructura.

Ver `test/fixtures/chatgpt-recorded/README.md`, enlaces de procedencia y licencia MPL-2.0 incluida. Los streams se copiaron sin modificaciones. No se copiaron implementaciones del proyecto externo.

La respuesta Thinking se contrasta con una proyección independiente de las operaciones del canal fusionado visible del fixture, no sólo comparando dos instancias de nuestro adaptador. También se reconstruye el wire SSE entregado al cliente para comprobar que no se obtuvo un contador correcto a costa de romper la respuesta.

## 4. Cambios

- `src/core/streamAdapters.js`: protocolo real de ChatGPT y reconstrucción por canal/mensaje/revisión.
- `src/core/streamFilter.js`: NDJSON/texto y finalización parcial sobre el filtro existente.
- `src/core/cdp.js`: snapshots del adaptador y exclusión de controles de la extracción genérica.
- `src/inject/index.js`: selección del formato y notificación de abortos/modelo recibido.
- `src/main/cdp.js`: SSE por eventos completos y conservación del modelo del cuerpo.
- `src/main/tokens.js`: recuperación y diagnóstico sólo para el conteo de salida; la función usada por la entrada no cambia.
- `src/main/engine.js`: tokenización de salida protegida, ajuste de parciales y conservación del modelo; sin nuevos incrementos de otros contadores.
- `src/main/main.js`: actualización automática tras captura deduplicada y metadato de salida coherente con BPE.
- `src/ui/shell/index.html`: sólo versión 0.1.14 y aclaración del método; sin rediseño.
- `package.json`, `package-lock.json`: versión 0.1.14, sin nuevas dependencias.
- `test/chatgpt-output-circuit.test.js`, grabaciones y `test/cdp-transporte.test.js`: pruebas; el test de motor roto ahora usa una forma de mensaje reconocida, no un evento inventado de otro dialecto.
- Documentación de esta entrega.

## 5. Validación alcanzada

- `npm run verify`: **480 pruebas, 479 aprobadas, 1 omitida, 0 fallos**.
- Bundle compilado: **39.9 kB**, **14.6 kB gzip**, 8 módulos. Se mantienen los límites de rendimiento existentes.
- **16/16 pruebas nuevas**: respuestas corta/larga, Markdown y saltos, fragmentación de un byte incluyendo emoji, SSE/NDJSON, fin normal y aborto real del stream de replay, vacío, varias respuestas consecutivas, CDP `Other`, recuperación tardía, deduplicación en ambos órdenes, revisiones repetidas, mismo ID parcial/completo, selección BPE clásica, excepción/cero de BPE y ajuste decreciente.
- El circuito de replay ejecuta el bundle de inyección, el preload real, los handlers del principal, el tokenizador real y las funciones reales de actualización de la shell sobre elementos mínimos. **Electron y esos elementos son simulados: no es una prueba visual ni una conversación en vivo.**
- La prueba omitida requiere `NEXO_ELECTRON_ZIP_DIR` para la cadena local con un ZIP externo de Electron. La compilación y el arranque Windows se comprueban por separado mediante CI.

## 6. Lo que falta para cerrar la tarea

Este sandbox no tiene un navegador Electron ejecutable/display ni acceso de salida permitido a ChatGPT. No se efectuó una conversación real en ChatGPT desde NEXO empaquetado. La compilación y la prueba de humo de Windows tampoco sustituyen ese ensayo.

Falta ejecutar la compilación entregada en Windows, hacer una pregunta real, esperar el fin del streaming y comprobar que `tokens de salida` se actualiza sin cambiar de panel. Repetir con respuesta larga y con Stop. Si falla, se necesita una captura SSE/NDJSON o HAR **sanitizada**, con estructura, MIME, tipo de recurso y diagnósticos de NEXO, sin cookies, cabeceras de autorización ni credenciales. No se debe concluir que ChatGPT volvió a cambiar el protocolo sin esa evidencia.

También siguen siendo límites explícitos los casos donde ni la inyección recibe texto ni CDP conserva el cuerpo (por ejemplo un aborto sólo observado desde CDP), y el límite previo de 200 000 caracteres del payload inyectado. No se eliminó esa protección ni se inventan tokens para esos casos.

**No se declara cumplido el criterio de finalización en vivo.**

## 7. Entrega y compilación Windows

Código de la corrección: `a55ae4ce99ce27bcc10a8e0068b78dea42fc328d`, publicado en
`arena/4678aef7-navegador`.

[CI Windows 42659319061](https://github.com/EvoMaxPC/navegador/actions/runs/42659319061)
terminó **success**: instalación, verificación, benchmark, empaquetado y prueba de
humo del ejecutable. Esto verifica el arranque de la shell empaquetada; no abre
una conversación real con ChatGPT.

[Artefacto Windows Nexo-win32-x64](https://github.com/EvoMaxPC/navegador/actions/runs/42659319061/artifacts/13694225101):
158 141 104 bytes, digest del artefacto comunicado por GitHub
`sha256:290b92ce1fbbb897c9fe6fad14fe3a4c32f7c080f1d3d89a07f9d2f089ca43ce`.
El digest corresponde al contenedor del artefacto, no se presenta como hash del
ZIP interno. La descarga de logs desde el host externo de Actions está bloqueada
en este entorno; los resultados de cada paso y los metadatos del artefacto se
confirmaron mediante la API de GitHub. No se probó el ejecutable localmente.

# Captura CDP de streaming — Nexo 0.1.23

## Alcance y causa probable

Se adaptó el parche de streaming propuesto por el usuario a la rama con Nexo 0.1.22. No había un archivo `streaming-fix.patch` en el checkout; se trabajó sobre el diff pegado en la conversación.

El observador sólo recuperaba el cuerpo HTTP con `Network.getResponseBody` después de `loadingFinished`. Si Chromium no conservaba ese cuerpo, el parser no recibía texto, aunque otra vía hubiera contado la respuesta. Se reprodujo **ese caso** con el Electron simulado: cuerpo no disponible y bytes de respuesta entregados sólo por eventos CDP.

Esto confirma un hueco del código, no demuestra que sea la causa única del fallo en la sesión real del usuario. No se inició una conversación real de ChatGPT desde este entorno.

## Corrección

En `src/main/cdp.js`:

- Para streams SSE, NDJSON y texto plano de una petición de conversación autorizada, se solicita `Network.streamResourceContent` al recibir la respuesta.
- Se guardan los bytes base64 de `Network.dataReceived`, correlacionados por pestaña/requestId. `bufferedData` se antepone a los fragmentos posteriores.
- El acumulador se instala **antes** de enviar el comando: no pierde eventos recibidos mientras se activa.
- Si el cierre llega antes de la respuesta del comando, se espera su resolución con un máximo de un segundo. No se bloquea indefinidamente el cierre.
- Los bytes se decodifican juntos al finalizar: UTF-8 partido entre fragmentos se conserva.
- Si el streaming no está soportado, está vacío, tarda demasiado o se descarta por límites/formato, se mantiene `getResponseBody` como fallback. Un prefijo truncado por límites nunca se entrega como cuerpo completo.
- Límite de 2.000.000 bytes y 8.192 fragmentos por respuesta, ocho acumuladores activos por pestaña (hasta 16 MB de bytes acumulados; no incluye buffers temporales de decodificación, parser ni Chromium).
- Se liberan los acumulados al cancelar/fallar la carga, desprender el depurador, cerrar la pestaña o desautorizar contenido. Una activación tardía no resucita esos datos.
- Las respuestas que la capa ya terminó con texto mantienen su exclusión. El motor sigue deduplicando con sus mecanismos existentes.

No se modifica el parser de ChatGPT, la estimación de salida de una unidad por palabra, BPE de entrada, persistencia, contadores públicos ni clasificación de turnos. No se reintroduce un contador de turnos completos. El respaldo DPU basado en la capa de página existente no se reemplaza: este cambio aborda el transporte SSE/NDJSON, no todos los protocolos posibles.

## Pruebas

- Regresión **roja** con `src/main/cdp.js` de `37a48ff`: el test de integración no obtiene la respuesta al fallar `getResponseBody`.
- Misma regresión **verde** con el cambio: mensaje y respuesta únicos, estimación exacta de salida por palabras, texto en EVO MEMORY y snapshot final enviado a la UI. Un segundo cierre no duplica respuesta ni salida.
- `test/cdp-streaming.test.js`: 17 casos de transporte, incluyendo bufferedData, eventos antes de activar, cierre anticipado, Unicode, respuesta grabada externa, dos streams intercalados, ausencia de soporte/cuerpo, límite de bytes/fragmentos/concurrencia, privacidad, timeout, deduplicación con la capa y desconexión/fallo.
- Comprobación adicional con Chromium headless 153 real y un servidor HTTP local de SSE por fragmentos: el observador de producción recibió el texto completo con `streamResourceContent`, sin llamar a `getResponseBody` ni registrar errores. Sólo se sustituyó el hostname de clasificación de los eventos para apuntar al servidor local; no fue una sesión de ChatGPT ni de Electron.
- `npm run verify`: **620 pruebas, 619 aprobadas, 1 omitida, 0 fallos**. Es la suite de esta rama; las 481 pruebas del parche original no describen la versión actual.

Los replays y el Electron simulado no sustituyen una prueba de navegación real.

## Respaldo DOM mencionado por el usuario

En el checkout de esta rama no existen `src/main/domFallback.js`, `domCandidates` ni `onDomFallback`. No se agregaron ni se borraron esos elementos. No hay cambios a `src/main/engine.js` en este parche. La lectura DOM de conversaciones de ChatGPT ya presente en la capa de página se conserva.

## Comprobación en el equipo del usuario

1. Ejecutar la nueva compilación de Nexo, abrir una conversación normal de ChatGPT y enviar un mensaje; no usar chat temporal para verificar persistencia.
2. Esperar a que termine. Comprobar que se ve la respuesta y suben respuestas y salida estimada. El mensaje y la respuesta no deben duplicarse; una finalización normal no debe incrementar cancelados ni fallidos.
3. Abrir EVO MEMORY y comprobar el texto capturado; no basta con que suba el contador de respuestas. Para diagnóstico, revisar también el recibo de guardado de la captura correspondiente.
4. Revisar `Documentos/NEXO-CAPTURE-DIAGNOSTIC.jsonl`, que conserva la política de metadatos sin conversaciones. Si falla, compartir los avisos de captura y un extracto de ese diagnóstico, no contenido privado de la conversación.
5. Repetir con mediación apagada y EVO MEMORY habilitada para validar la observación pasiva, y detener una respuesta para comprobar que cancelados suma exactamente una vez.

Si el stream no se puede leer, se mantienen los avisos existentes de cuerpo ausente/vacío o texto no reconocido. El hecho de que pasen los tests o el empaquetado no permite afirmar que quedó resuelto en ChatGPT real.

## Revisión posterior: timeout con fragmentos disponibles

El segundo diff propuesto espera la activación con `Promise.race`, pero después del timeout concatena `streamChunks` aunque la activación no haya respondido. Si `bufferedData` sigue pendiente, puede entregar sólo la cola de SSE como si fuera el cuerpo íntegro y no intentar `getResponseBody`.

La implementación publicada exige `stream.enabled`, además de haber bytes. Vencido el plazo sin confirmación, descarta el acumulado y usa el fallback. Una respuesta tardía del comando no repuebla los buffers descartados. Su espera sigue siendo de un segundo; pasarla a 1,5 segundos no sustituye esa comprobación.

Se añadieron dos regresiones sin cambiar código de producción:

- Hay fragmentos válidos, pero la activación no responde a tiempo: se entrega únicamente el cuerpo completo del fallback; una activación posterior no suma otra captura.
- Si además falla el fallback, no se inventa una respuesta con los fragmentos disponibles; se emite `response-sin-cuerpo`.

Ambos casos fallaron al quitar temporalmente la condición de activación confirmada y pasan con el código publicado, que se restauró sin cambios. Suite ampliada: **622 pruebas, 621 aprobadas, una omitida, cero fallos**; el archivo de transporte tiene ahora 19 casos. Los resultados 620/619 anteriores corresponden a la publicación original de 0.1.23.

Por eso, un contador en cero aún no excluye esta parte del transporte: la activación puede fallar o exceder el plazo y el cuerpo de fallback tampoco estar disponible. Se necesita el diagnóstico de esa captura concreta, no inferir la causa únicamente del contador.

## Prueba de solapamiento con Chromium real (servidor local)

El solapamiento entre `bufferedData` y `dataReceived.data` no se había demostrado como defecto. No se añadió eliminación por prefijos/sufijos similares: podría borrar repeticiones legítimas de la respuesta.

Se agregó `dev/probe-streaming.cjs`, una prueba opt-in de transporte real:

1. Un servidor HTTP local entrega un cuerpo SSE sintético conocido, por fragmentos, con tildes, emoji y una repetición legítima.
2. Se retrasa la activación hasta observar al menos dos eventos reales sin `data`, forzando un `bufferedData` no vacío.
3. Se permite tráfico mientras Chromium procesa el comando y se retrasa 60 ms la devolución de su resultado al observador. Así hay eventos con datos antes de que el observador reciba la resolución de la promesa.
4. Se verifica **byte por byte el cuerpo bruto**, antes de pasar por el parser. Un parser de snapshots acumulados podría ocultar repeticiones del transporte; por eso no basta con comparar el texto final.
5. También se compara el texto entregado por el observador de producción contra el esperado y se exige una sola captura, sin recurrir a `getResponseBody`.

Resultado en Chromium **153.0.8010.0**: **10/10 casos** (cinco sin compresión y cinco con gzip), bytes y texto exactos, sin huecos ni solapamiento observados. El cuerpo esperado tiene 241 bytes; las capturas tuvieron 128 o 130 bytes de cabecera almacenada y el resto llegó por eventos con datos. Es una observación de esos escenarios, no una prueba universal de todas las versiones o condiciones.

El observador es el de producción, pero el hostname de los eventos se cambia explícitamente de localhost a `chatgpt.com` sólo para activar su clasificación. Los requestId, eventos, respuestas del comando y bytes provienen de Chromium real. **No se contacta ChatGPT ni se ejecuta Electron.** La persistencia y la sesión real del usuario siguen pendientes.

### Repetir la prueba

Con Node y un Chromium instalado, instalar sólo `playwright-core` en un directorio externo al repositorio y ejecutar:

```sh
npm install --prefix /ruta/de/herramientas --no-audit --no-fund playwright-core
NODE_PATH=/ruta/de/herramientas/node_modules \
CHROMIUM_EXECUTABLE=/ruta/al/ejecutable/chromium \
node dev/probe-streaming.cjs
```

En el sandbox se usó `@sparticuz/chromium` instalado aisladamente, con sus bibliotecas compartidas disponibles mediante `LD_LIBRARY_PATH`; el script también lo admite si no se indica ejecutable. Estas herramientas no se añadieron al package.json ni al lockfile del navegador. El probe usa `--no-sandbox` únicamente para este Chromium de prueba local; no cambia opciones de seguridad de Nexo. No se ejecuta en `npm run verify` ni se empaqueta: es una comprobación adicional opt-in.

Se agregó además una regresión determinista para eventos `dataReceived` sin `data` antes de la activación. El archivo de transporte contiene ahora **20 casos**. Suite completa tras esta revisión: **623 pruebas, 622 aprobadas, una omitida, cero fallos**.

### Qué no demuestra una comparación de tamaños

Los bytes base64 decodificados del transporte contienen SSE/JSON, no sólo el texto del asistente. El texto extraído, su representación Markdown y el texto visible del DOM pueden tener longitudes diferentes. Además, `encodedDataLength` mide otra etapa del transporte (con compresión y overhead), y bytes UTF-8 no son caracteres JavaScript/UTF-16. En la prueba, el cuerpo de 241 bytes dio `encodedDataLength` de 458 sin compresión y 514 con gzip/flush; no son longitudes comparables directamente.

Por tanto, comparar «caracteres leídos» del panel con el DOM es una señal orientativa, no una validación de integridad ni de ausencia de solapamiento. Tampoco se añadió un aviso automático basado en igualar esos tamaños. Para ChatGPT real se necesita correlacionar la captura concreta, el texto que extrajo el parser y su recibo de memoria, manteniendo fuera del diagnóstico persistido el contenido privado de la conversación.

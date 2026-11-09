# Arquitectura

Cuatro ideas ordenan todo el proyecto:

1. **El motor es isomorfo.** `src/core/` no importa nada de Electron, ni del DOM,
   ni de Node. Se ejecuta igual en el proceso principal, en la sala de pruebas del
   navegador y en los tests. Se compila una sola vez (esbuild) y se inyecta como
   IIFE en el mundo principal de cada página.
2. **Observar todo, mediar lo que se puede.** La mediación (reescribir la
   petición, filtrar el stream) vive en la página. La observación (frames de
   WebSocket, cuerpos JSON) vive en el proceso principal con el depurador CDP.
   Lo observado nunca se presenta como mediado.
3. **Dos mundos, un puente.** El preload corre aislado y es el único con
   privilegios. El código que engancha `fetch` corre en el mundo de la página; se
   comunican con `postMessage` y el preload traduce a IPC. La configuración del
   sitio llega por `sendSync('nexo:config-sync')` en el arranque del documento: el
   enganche tiene que estar puesto **antes** de que la página guarde su propia
   referencia a `window.fetch`, así que una espera asíncrona o un
   `DOMContentLoaded` llegan tarde.
4. **Nunca romper la petición del usuario.** Todo fallo del motor degrada a «dejar
   pasar el mensaje tal cual». No hay ninguna ruta en la que una excepción del
   análisis impida enviar o recibir.

---

## Componentes

### `src/core/analysis.js`

Detección de periodicidad y degeneración.

- `prefixFunction(s)` — KMP, base de la búsqueda de bordes.
- `zFunction(s)` — `z[i]` = longitud del prefijo común más largo entre `s` y `s[i:]`.
- `repeatingSuffix(str, opts)` — período mínimo de un sufijo repetido. Se aplica
  sobre la cadena **invertida**, porque «repetir al final» equivale a «empezar
  repitiendo» en el reverso, y eso es lo que mide la función Z.
- `findLagRepeat(text, opts)` — el detector que funciona en vivo: el final del
  texto es idéntico a lo que había `lag` caracteres atrás. Con `k = 44` caracteres
  ya hay evidencia suficiente; devuelve `start` y `cutAt` en coordenadas del texto.
- `tokenStutter`, `lineLoop`, `paragraphLoop`, `analyzeTail`, `detectTruncation`.

`analyzeTail` devuelve `{loop, severity, type, detail, signals}`. `detail.cutAt` es
el punto donde **arranca la repetición**, no donde arranca la unidad: la primera
escritura del bloque es legítima y se conserva.

### `src/core/streamSentinel.js`

Máquina de estados de un turno de recepción.

```
push(delta)
  ├─ raw += delta
  ├─ si no está cortado: #inspectIfDue()
  │    ├─ cada 24 caracteres: sonda (indexOf del final / tartamudeo)
  │    └─ si la sonda dispara o pasaron 512: análisis completo
  ├─ si hay bucle: stop, cutIndex = alignCut(cutAt)
  └─ emit = raw[entregado : límite]      (límite = raw − retención, o cutIndex)
```

**Por qué la retención se calcula y no se elige a mano.** Para cortar en el inicio
de una repetición, el inicio tiene que seguir dentro del búfer. La detección por
retardo necesita `k` caracteres de repetición; con dos copias de una unidad de 40
caracteres hacen falta ~80. De ahí:

```
retención ≥ unidad_mínima × repeticiones_mínimas + margen  (40 × 2 + 32 = 112)
```

Si bajás `minUnit` para detectar antes, la retención baja sola y la latencia visual
también. Si lo subís, ganás precisión y perdés inmediatez.

`#alignCut` retrocede hasta el último `\n\n` o fin de frase dentro de 400
caracteres. Cortar un párrafo entero es aceptable; cortar una palabra no.

### `src/core/streamAdapters.js`

Traduce el cable de cada proveedor a «tramos de texto» y de vuelta. Cada adaptador
expone tres operaciones:

- `read(json)` → `{ segments, terminal }`. Cada tramo dice dónde está el texto
  (`path`) y cuánto es nuevo (`newText`); `terminal` avisa si el evento cierra un
  bloque o el mensaje.
- `write(json, segments, values)` → escribe el texto reescrito **en el mismo
  sitio** del JSON. En el protocolo de parches de ChatGPT el texto viaja en `v` y
  la ruta `p` sólo dice dónde lo aplica el cliente: se reescribe `v`, nunca la
  ruta (era el error que convertía `parts` en un string).
- `pending({ text, delivered })` → arma el evento sintético con la forma del
  último evento de texto, para soltar lo retenido antes de un cierre.

Perfiles: `chatgpt` (parches `{p,o,v}` y el formato acumulado antiguo, con eco del
usuario y estados que no son texto), `claude` (`content_block_delta` y el
`completion` acumulado) y `generic` (el último recurso con `deltaPaths`).

### `src/core/streamFilter.js`

`TransformStream<Uint8Array, Uint8Array>` que envuelve el cuerpo de la respuesta.

- Parseo incremental de SSE (`parseSSE` guarda el resto sin cerrar y conserva el
  `raw` de cada evento: comentarios, `retry:` e `id:` se reenvían textualmente).
- El adaptador del sitio dice qué eventos traen texto; el centinela decide cuánto
  se entrega y `distribute()` reparte lo nuevo entre los tramos del evento, en
  orden, sin solapamientos.
- Al cortar: los eventos siguientes viajan con el texto vacío (el cliente necesita
  su cierre).
- Al cerrar: el texto retenido se devuelve con la forma del último evento de texto,
  **antes** del evento de cierre, y `[DONE]` siempre queda último.
- Un cuerpo que no parece SSE (`looksLikeStream`) pasa intacto.

### `src/core/cdp.js` y `src/main/cdp.js`

Los dos canales que el enganche de `fetch` no alcanza: **frames de WebSocket** y
**respuestas JSON completas**. `src/core/cdp.js` es la parte isomorfa —convierte
frames y cuerpos en texto, reutilizando `streamAdapters.js` y `extractDeltas()`—
y `src/main/cdp.js` es el transporte: adjunta `webContents.debugger`, escucha
`Network.*`, pide los cuerpos y entrega cada turno a `engine.onCdpCapture()`.

Reglas: sólo hosts con perfil, sólo texto (nada binario), los SSE se excluyen para
no contar dos veces lo que ya media la página, y cualquier fallo del depurador
deja la capa inerte sin tocar la navegación. Detalle: [`CDP.md`](CDP.md).

### `src/core/promptEngine.js`

Reglas puras + ensamblado explícito. El reporte incluye `blocks` (qué se inyectó y
por qué), `findings` (avisos al usuario), `context` (compactación) y `stats`
(tokens de entrada, salida e inyectados). La UI usa ese reporte para el panel: la
transparencia es parte del producto, no un extra.

### `src/core/compaction.js`

Compactación extractiva, sin modelo auxiliar: puntúa oraciones por señales
(decisiones, pendientes, restricciones, números, rutas de archivo, problemas
abiertos), deduplica por huella, agrupa por tipo y ordena cronológicamente. El plan
`planBudget` decide qué turnos se mantienen literales y cuáles se pliegan,
respetando siempre un mínimo de turnos recientes.

### `src/core/guard.js`

`ConversationGuard` mantiene por conversación: historial, huellas de bucles vistos y
libro de intervenciones. `ConversationTurn` envuelve al centinela y decide al cerrar:

- primer bucle con un patrón → **continuar** donde se cortó;
- segundo bucle con el mismo patrón → **reintentar con otra estructura** (primero un
  esquema, después desarrollar un solo punto);
- respuesta truncada → continuar;
- negativa o respuesta vacía → sugerencias de reformulación.

---

## Flujo completo de una petición

1. La página llama a `fetch(url, {body})`.
2. El hook comprueba `isChatRequest(site, url, method)`: ruta exacta (comparada por
   `pathname`, sin contar la consulta) y método. Si no es un envío de mensaje,
   `fetch` nativo y nada más — `/prepare`, listados y regeneraciones no se tocan.
3. `planRequest()` **sólo prepara**: lee el cuerpo (`Request.clone().text()` si
   hace falta), `locateUserText(body, site)` encuentra el mensaje del usuario y
   `patchUserText` reescribe ese campo y únicamente ese campo.
4. `bridge.request('prepare', {prompt})` → IPC → proceso principal → `promptEngine`.
5. **Un solo** `fetch` nativo con el cuerpo ya mediado. No hay reenvío: un fallo de
   red o un `AbortError` (el botón «Detener») llegan a la página tal cual y nunca
   se duplica el mensaje.
6. Si la respuesta es SSE, se envuelve con el filtro; si no, pasa intacta.
7. `onStop` → IPC → libro de intervenciones y marca en la pestaña.
8. `onEnd` → IPC → reparación, decisión de continuación, actualización del historial.
9. Si la continuación automática está habilitada, `submitContinuation` escribe el
   prompt en el cuadro de texto y pulsa enviar.

En paralelo, y sin tocar nada de lo anterior, el proceso principal observa por CDP
lo que no pasa por `fetch` (frames de WebSocket y cuerpos JSON). Ese camino
**no media**: analiza el texto con el mismo centinela, lo guarda en el historial y
en EVO MEMORY, y sólo emite un aviso cuando hay un bucle, un corte o una negativa,
siempre dicho como observación. Las huellas de lo ya contado se comparten entre
los dos caminos, así que un mismo turno no se registra dos veces.

---

## Contadores de conversación

Ocho métricas independientes, cada una con su hecho, expuestas por
`nexo:stats` y dibujadas en el panel de actividad:

| Métrica | Qué cuenta | De dónde sale |
| --- | --- | --- |
| `messages` | mensajes del usuario | evento `outgoing` de la capa, uno por envío reconocido |
| `responses` | respuestas de la IA | cierre de stream (`nexo:stream-end`) o captura CDP |
| `turns` | turnos completos | par mensaje↔respuesta, asociado por `messageId` |
| `inputTokens` | tokens del mensaje | `countTokensForProvider` sobre el texto localizado (BPE local para GPT) |
| `outputTokens` | tokens de la respuesta | `countOutputTokens` sobre el texto **real** leído (BPE local para GPT): lo entrega la capa al cerrar el stream o CDP al leer el cuerpo. Si la respuesta se contó por la red —sin texto— y el texto aparece después, sus tokens se suman a **esa** respuesta (no se cuenta otra). |
| `interventions` | actividad de la conversación | +1 al contar un mensaje y +1 al contar una respuesta |
| `mediatedInterventions` | intervenciones del motor | `prepare()` sólo cuando el texto cambió, más los cortes |
| `loopsSeen` | bucles observados | centinelas de cada guardián + observación CDP |
| `loopsCut` | bucles cortados | cierre de stream con `stopped: true` |

### De dónde sale cada hecho

La entrada (mensaje del usuario) se reconoce por **cuatro caminos independientes**,
y basta con uno:

1. **El vigilante de red del proceso principal** (`webRequest.onBeforeRequest`):
   lee el cuerpo que está por salir, sin ejecutar nada en la página ni depender del
   depurador. Es el camino más difícil de romper y el primero que se prueba.
2. **El gesto de enviar** en la página: clic en el botón de enviar o Enter en el
   cuadro, con texto escrito. No depende de cómo venga el cuerpo de la petición.
3. **La petición de la capa**: el cuerpo JSON que sale hacia el sitio, leído
   dentro de la página.
4. **La petición observada por CDP**: el mismo cuerpo, leído con
   `Network.requestWillBeSent`.

Un envío tiene un `messageId` y se cuenta **una sola vez**: el gesto y la
petición se enlazan por ese identificador, y si los caminos lo anuncian con
identificadores distintos, el motor los reconoce por la huella del texto
(`fingerprint` de la misma función que usa el resto del motor) y por la cercanía
en el tiempo. El identificador del mensaje que se contó primero queda como alias
de los demás, así la respuesta cierra **ese** turno aunque llegue con otro
identificador. Dos mensajes iguales seguidos desde la misma fuente son dos
mensajes.

La salida (respuesta) se captura por:

- el **stream SSE** que envuelve la capa de la página;
- el mismo **SSE leído por CDP** siempre que la capa **no haya cerrado ese
  stream**. Que la capa esté viva —que haya contado el envío— no prueba que vaya
  a capturar la contestación: si se calla, la respuesta no la contaría nadie.
  Lo que decide es un hecho, no una sospecha: si la capa informó el cierre de un
  stream en esa pestaña después de que saliera la petición, CDP no lo vuelve a
  leer; si no lo informó, lo lee y el motor descarta el duplicado por
  `messageId` y, en su defecto, por el texto;
- **CDP**, con los frames de WebSocket, los cuerpos JSON de una petición propia
  del sitio y el cuerpo completo del SSE, que el depurador entrega al terminar
  (salvo que la capa haya cerrado ese stream);
- **el cierre de la petición en la red**: si el POST de conversación termina con
  2xx y en esa pestaña sigue un mensaje esperando respuesta, el modelo contestó.
  Es el único camino que no necesita leer el cuerpo: no aporta texto ni tokens de
  salida, pero cuenta la respuesta y cierra el turno. Espera un margen corto para
  que la capa o CDP cuenten primero, con texto; si alguno lo hizo, el turno ya no
  está esperando y este camino no hace nada.

Sólo la respuesta a una petición **de conversación** puede ser una respuesta del
modelo: CDP exige que la URL sea la del endpoint de chat del sitio
(`isMediable`, la misma función que decide la mediación). Un `GET` del historial,
un JSON de cuentas o de listas no se cuentan, aunque vengan del mismo dominio y
sean un POST.

**La conversación se reconoce por su cuerpo, no sólo por su ruta.** La ruta del
endpoint de chat se compara por su forma —tiene que terminar en `/conversation`—
en vez de exigir la exacta: un cambio de versión en el sitio dejaba «0 de
conversación» con decenas de POST delante. Si ni la forma coincide, manda el
cuerpo: un POST al proveedor cuyo JSON trae el mensaje del usuario con el esquema
del sitio **es** la conversación, y desde ahí su respuesta se cuenta y se lee. La
ruta real queda anotada (`chat-ruta`) para no volver a suponerla. Las rutas de
preparación (`…/prepare`, `requestSkip`) llevan el mismo cuerpo y no se cuentan.

**Un cero no se queda sin causa.** Cada rama que puede perder una respuesta deja
un aviso en el registro, con el código que la identifica:

| Código | Qué pasó |
| --- | --- |
| `response-tipo` | La respuesta de la conversación llegó con un tipo que el depurador no observa. |
| `response-mime` | El MIME no es SSE ni JSON: el cuerpo no se interpreta. |
| `response-sin-cuerpo` | El búfer del depurador ya no tenía el cuerpo. |
| `response-vacio` | El depurador devolvió el cuerpo vacío en un stream. |
| `response-formato` | El cuerpo no tenía eventos `data:` con JSON (deja una muestra). |
| `response-base64` | El cuerpo vino codificado y se decodificó. |
| `response-sin-texto` | El stream se leyó, hubo eventos y ninguno trajo texto del asistente: deja la **forma** del primer evento para corregir el adaptador. |
| `response-capa` | El stream lo cerró la capa de la página: el depurador no lo relee. |
| `cdp-sin-depurador` | El depurador no se pudo adjuntar (o no existe en este Electron). |
| `incoming-network` | La respuesta se contó por el cierre de la red: sin texto todavía. Si el texto aparece después, sus tokens se suman a esa misma respuesta. |
| `chat-ruta` | El mensaje viaja por una ruta que el perfil no declara: se reconoció por el cuerpo y se cuenta igual. |
| `chat-unmatched` | POST al proveedor fuera de la ruta conocida y sin mensaje en el cuerpo. |
| `tokens-recuperados` | El texto de una respuesta ya contada sin texto aportó sus tokens: dice cuántos y de qué host, sin sumar otra respuesta. |

**Asociación.** El envío guarda su `messageId` en la petición observada. La
respuesta a esa petición viaja con el mismo identificador y cierra **ese** turno;
un socket, que no tiene URL de petición, se asocia al mensaje que está esperando
respuesta en esa pestaña, y sólo dentro de la ventana de respuesta. Un mensaje
viejo sin respuesta no se cierra con una respuesta ajena.

Una respuesta que llega en pedazos se acumula y se cuenta al cerrarse; mientras
crece no suma respuestas, sólo corrige los tokens de salida. El acumulador no
vuelve a sumar lo que ya aportó el adaptador del sitio: los protocolos
acumulados repiten el texto completo en cada evento, y sumarlo otra vez serían
tokens contados dos veces.

**Tokens sin texto no existen.** Los tokens de salida salen siempre de
`countOutputTokens` sobre el texto real; nunca de una cifra fija por respuesta. Si
ningún camino logra leer el cuerpo, la respuesta se cuenta igual (camino de red)
y los tokens quedan donde estaban. Cuando el texto aparece un instante después
—CDP termina de leer el cuerpo cuando la petición ya cerró—, el motor lo suma a
la respuesta que ya estaba contada, sin tocar el contador de respuestas.

**Cierre dudoso ≠ corte confirmado.** Que una respuesta parezca incompleta
(`detectTruncation`) es una heurística de texto; el registro lo dice así y no
afirma que la red la haya cortado. Un fallo de red (`net::ERR_FAILED`) se anota
como fallo de la petición, nunca como «respuesta recibida».

Reglas que sostienen la cuenta:

- **La captura no depende de la mediación.** La capa envuelve la respuesta de
  toda petición de conversación, haya o no texto que reescribir.
- **Un mensaje se cuenta al enviarse**, no al prepararse: `prepare()` no toca los
  contadores de mensajes ni de turnos.
- **La identidad no es el texto.** Cada envío lleva un `messageId` propio de la
  página; la respuesta lo devuelve y así se cierra el turno, incluso con varias
  pestañas abiertas. El texto sólo se usa como segunda barrera para descartar la
  misma respuesta vista por SSE y por CDP.
- **Los avisos del sistema no son intervenciones.** El registro los guarda con
  `kind: 'system'` y el contador de intervenciones los excluye.
- **Los tokens son una estimación** (`estimateTokens`: caracteres y alfabeto), no
  el conteo del tokenizador del proveedor. La interfaz lo dice con un asterisco.

El detalle de la corrección de los contadores —causa, criterio de identidad y
qué queda por validar— está en [`CONTADORES.md`](CONTADORES.md). Lo que la
pestaña Memoria guarda, qué significa cada número y qué se hace con un registro
cifrado está en [`MEMORIA.md`](MEMORIA.md).

### Cuando los contadores no suben: la línea de captura

Un cero puede venir de cuatro sitios distintos y desde el panel se veían igual.
Por eso el panel de actividad muestra, debajo de los ocho contadores, una línea
de estado que **no cuenta la conversación**: informa del arnés de captura.

```
Captura — red activa · 128 peticiones · 4 POST · 3 de conversación · 3 contadas
```

- `red activa` / `red sin registrar`: si el vigilante de red quedó enganchado en
  la partición de las pestañas. Si está registrado pero las peticiones no suben,
  el tráfico no pasa por ahí.
- `N POST`: peticiones POST vistas hacia un proveedor de IA.
- `N de conversación`: las que el perfil reconoce como envío de un mensaje.
- `N contadas`: las que además sumaron el mensaje.
- `CDP en N pestañas`: el depurador está adjunto a las pestañas del sitio.

Dos avisos del registro completan el diagnóstico, y los dos son hechos, no
sospechas:

- `chat-unmatched`: llegó un POST al proveedor que no coincide con la ruta de
  conversación del perfil. Lleva la ruta real, así el patrón se corrige con el
  dato y no a ciegas.
- `chat-disabled`: la petición de conversación llegó, pero el sitio está apagado
  en Ajustes; no se cuenta ni se media.

El gesto de enviar tampoco depende de un selector exacto: si el marcado del sitio
cambia y no aparece el cuadro que declara el perfil, se usa el que tiene el foco
y, en último término, el primer cuadro editable de la página. Un formulario que
se envía (`submit`) cuenta como gesto, igual que el botón.

---

## Costes

| Operación | Coste |
|---|---|
| Sonda por fragmento | `indexOf` sobre ≤ 6 000 caracteres |
| Análisis completo | función Z sobre ≤ 6 000 caracteres (solo cuando la sonda dispara) |
| Compactación | una pasada por turno plegado |
| Tokens inyectados | 40–90 (protocolo equilibrado) |

El peor caso realista —una respuesta de 20 000 caracteres que no se traba— ejecuta
~40 análisis completos de 6 000 caracteres. Es despreciable frente al tiempo de red.

---

## Extensiones previstas

- **Filtro no-streaming:** hoy las respuestas JSON completas pasan sin reescribir;
  el hook solo reporta. Añadir un pase de reparación sobre el cuerpo completo es
  directo (`responseEngine` ya existe).
- **Reparación en DOM:** tras el stream, corregir el nodo renderizado del último
  mensaje usando el adaptador del sitio.
- **Proveedor LLM opcional** para resúmenes de contexto de mayor calidad. La
  interfaz está pensada para enchufarlo (`compaction` acepta un `summarize`), pero
  por defecto no se usa: el producto tiene que funcionar sin conexión.
- **Panel de comparación:** guardar las dos versiones (crudo y entregado) para medir
  cuánto se recuperó por conversación.


### Distribución del tokenizador

Las utilidades puras de `src/core/text.js` no importan diccionarios BPE.
`src/core/gptTokens.cjs` carga la codificación bajo demanda y es compartido por
`src/main/tokens.js` y el preload. La página sólo aporta texto y metadatos ligeros:
el preload convierte el metadato del envío a BPE y elimina `tokenText` antes de
reenviarlo por IPC. El Engine calcula la salida sobre el texto recibido.
Así el bundle de captura conserva el límite de 60 kB sin quitar el conteo BPE.


### Tokens de salida 0.1.14

El mismo adaptador ChatGPT atiende SSE delta-encoded con canales `c`, raíces
`v.message` y parches heredados, y NDJSON `content/markdown` con `mode/revision`.
Los fragmentos ocultos del mensaje fusionado no se cuentan otra vez. Las rutas
`v.<índice>.v` de un patch se reescriben sin destruir su array de operaciones.
El filtro conserva el wire NDJSON y anuncia una captura parcial si el origen
falla o se cancela. La recuperación BPE de **salida** sólo usa estimación sobre
texto real si hay excepción o un resultado inválido, con diagnóstico visible
`output-tokenizer-fallback`; el cálculo de entrada sigue separado y sin cambios.

Una captura CDP puede ser duplicada como **respuesta** pero aportar nuevos tokens.
En ese caso el principal también emite `nexo:stats-changed`; el listener existente
de la shell obtiene las estadísticas y actualiza `statOutTokens` sin intervención
manual. Ver `OUTPUT-TOKENS-AUDITORIA.md` para evidencia y límites de validación.

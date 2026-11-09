# Arquitectura

Tres ideas ordenan todo el proyecto:

1. **El motor es isomorfo.** `src/core/` no importa nada de Electron, ni del DOM,
   ni de Node. Se ejecuta igual en el proceso principal, en la sala de pruebas del
   navegador y en los tests. Se compila una sola vez (esbuild) y se inyecta como
   IIFE en el mundo principal de cada página.
2. **Dos mundos, un puente.** El preload corre aislado y es el único con
   privilegios. El código que engancha `fetch` corre en el mundo de la página; se
   comunican con `postMessage` y el preload traduce a IPC.
3. **Nunca romper la petición del usuario.** Todo fallo del motor degrada a «dejar
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

### `src/core/streamFilter.js`

`TransformStream<Uint8Array, Uint8Array>` que envuelve el cuerpo de la respuesta.

- Parseo incremental de SSE (`parseSSE` guarda el resto sin cerrar).
- Extracción genérica de deltas (`extractDeltas`) con pistas por adaptador.
- Reescritura del texto dentro del mismo evento: se conserva el `id`, el `event` y
  el resto del JSON.
- Al cortar: los eventos siguientes viajan con el texto vacío (el cliente necesita
  su cierre).
- Al cerrar: el texto retenido se devuelve clonando el último evento de texto,
  **antes** de reenviar `[DONE]`.

Si el cuerpo no parece SSE (`looksLikeStream`), la respuesta pasa intacta y el
motor se limita a no intervenir.

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
2. El hook comprueba `isChatRequest(site, url)`; si no es un chat, `fetch` nativo.
3. `locateUserText(body, site)` encuentra el mensaje del usuario sin conocer el
   esquema exacto (mensajes estilo OpenAI, `prompt`, `f_req` de Gemini, último
   string de contenido como último recurso).
4. `bridge.request('prepare', {prompt})` → IPC → proceso principal → `promptEngine`.
5. `patchUserText(body, site, textoMediado)` reescribe el cuerpo. Solo ese campo.
6. `fetch` nativo de verdad. Si la respuesta es SSE, se envuelve con el filtro.
7. `onStop` → IPC → libro de intervenciones y marca en la pestaña.
8. `onEnd` → IPC → reparación, decisión de continuación, actualización del historial.
9. Si la continuación automática está habilitada, `submitContinuation` escribe el
   prompt en el cuadro de texto y pulsa enviar.

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

# Contadores de entrada/salida con la misma calculadora Tokenizador

## Corrección

La tarjeta anterior dependía de correlacionar envíos con eventos de red, obtener un modelo concreto del proveedor y recuperar el texto original. Si esas señales faltaban, no había un número útil aunque Memoria ya mostrara la conversación. Para las dos tarjetas de tokens se incorpora un acumulador independiente del motor de actividad, alimentado por **la misma copia literal del DOM que lee Memoria**.

Ruta de producción:

1. `watchChatGptConversation` / `readChatGptConversation({literal:true})` publica los mensajes y respuestas de ChatGPT por el canal aislado existente, también con EVO apagada.
2. Main valida el snapshot. Para alimentar el contador requiere el frame principal de un guest que pertenece a la shell. Conserva aparte esa última copia para no promover al contador una caché recibida sin esa comprobación.
3. `DomTokenTotals.observe` pasa **cada string literal** a `calculateTokenizer({text,model})`, la misma función usada por la pestaña Tokenizador. No hace trim, normalización, reemplazos ni conversiones de palabras/caracteres a tokens.
4. `stats.domTokens` se publica a la shell; `tokenCounterView` imprime esos acumulados en entrada/salida. El primer historial recibido ya actualiza las tarjetas, sin esperar una petición de red.
5. El respaldo directo que usa Memoria puede aportar el mismo texto mediante un IPC nuevo restringido a la shell dueña, al guest y a su URL actual. No crea un observador adicional ni se habilita la memoria para contar. Esta rama de respaldo depende de que Memoria efectúe su lectura; la lectura aislada ordinaria es independiente de Memoria/EVO.

Fórmula de cada aporte: `T = length(encode_Em(S_original))`. La suma es **por mensaje**, no la tokenización de concatenar textos. Vacío: 0. Biblioteca fijada: `gpt-tokenizer` 4.1.0.

## Referencia explícita, no modelo inventado

**Ajustes → Tokenizador de los contadores** permite elegir gpt-4o (inicial), gpt-5, gpt-4 o gpt-3.5-turbo. La descripción de Actividad muestra el modelo y encoding. Se trata de una **referencia seleccionada por el usuario**, no detección del modelo usado por ChatGPT. Cambiarla recalcula los mensajes acumulados en RAM. Un modelo no verificado se rechaza; no se adivina un encoding.

Ejemplo literal: `"  Hola, mundo.  "` tiene 6 tokens con gpt-4o/o200k_base y 7 con gpt-4/cl100k_base. Dos entradas con ese texto y **IDs diferentes** suman 12 o 14 respectivamente. Las palabras y caracteres de la calculadora siguen siendo auxiliares, no la fórmula.

## Acumulación y límites

- RAM de la sesión, separada por `memory.projectId`. No escribe otra transcripción en disco ni cambia los recuerdos, el historial, los proveedores o los resultados de turno.
- Cada clave conversación + rol + ID aporta una vez. Releer un snapshot no suma otra copia. El mismo texto con otro ID sí suma. La respuesta parcial con el mismo ID **reemplaza** su aporte, incluso si su longitud baja.
- Las conversaciones con `/c/id` comparten identidad entre pestañas. La transición desde una conversación anónima sólo migra aportes si existe identidad de mensaje compartida. Un nuevo chat anónimo tras navegar recibe otra generación.
- Al cambiar de respaldo directo a lector aislado, si las estrategias cambian los IDs, se sustituye la contribución del documento para no sumar dos copias. Si el nuevo snapshot cubre menos mensajes que lo ya registrado se indica cobertura parcial. No se promete recuperar identidades inexistentes ni conservar una suma completa a través de cambios arbitrarios de estructura/IDs del sitio.
- Un snapshot vacío transitorio no elimina el acumulado ni borra el vínculo de migración pendiente.
- Límites: captura de hasta 200 turnos, 200000 unidades UTF-16 por turno y 1000000 por snapshot; acumulador de hasta 4000000 unidades UTF-16 / 10000 registros por proyecto. Un recorte/límite se muestra como `n + ?`, no como cobertura completa. El contador conserva el texto que recibió, no reconstruye lo que nunca estuvo disponible.
- Esperando DOM se imprime 0 con explicación; no se deduce que el consumo real sea cero. Reiniciar Nexo vacía estos acumulados. La memoria conversacional persistente no se borra.

## Separación de métricas y seguridad

La UI usa `domTokens.inputTokens/outputTokens`; `inputTokens`, `outputBpeTokens`, mensajes, respuestas y resultados del motor conservan su semántica anterior para compatibilidad. Abrir un historial suma texto a las tarjetas DOM, **no inventa envíos o respuestas de red**. Otros proveedores mantienen sus funciones; este lector DOM es específico de ChatGPT.

Los tokens son exactos para el string capturado y la referencia elegida; **no son factura**, no incluyen instrucciones/contexto ocultos, adjuntos ni estructura interna del proveedor. Una fixture no es una cuenta autenticada. La página controla su DOM; estas comprobaciones IPC no autentican la procedencia de ese contenido. La auditoría global del puente MAIN/DPU, ráfagas y correlación sigue abierta: esta corrección no constituye aprobación de seguridad.

## Pruebas reproducibles

- `node --test test/dom-token-totals.test.js`: 197 pruebas, incluidas 184 filas de comparación con OpenAI tiktoken (entrada y salida), identidad, acumulación, parciales, modelos, proyectos, migración, snapshots vacíos, navegación y los handlers reales de main con Electron simulado.
- `scripts/verify-bpe-official.py`: comparación independiente con OpenAI tiktoken 0.12.0 del núcleo, preload, libro de salida y calculadora; 184 comparaciones, 0 discrepancias en la ejecución local de esta corrección.
- `npm run verify`: build de inyección + suite completa. El resultado de la ejecución se adjunta al informe de entrega, no se infiere de las pruebas focalizadas.
- `scripts/probes/repetition-electron.cjs`: fixture HTTPS local en Electron real que comprueba primera entrada/salida aun con EVO apagada, suma de segunda entrada, salida histórica + parcial, dos mensajes idénticos con IDs diferentes y recálculo al cambiar referencia, además de Memoria y navegación. El resultado Windows debe consultarse en CI para el commit entregado; no equivale a una prueba con cuenta real.

Los informes anteriores conservan resultados históricos: la presentación de tarjetas dependiente del modelo detectado descrita en ellos queda sustituida por esta referencia explícita sobre DOM.

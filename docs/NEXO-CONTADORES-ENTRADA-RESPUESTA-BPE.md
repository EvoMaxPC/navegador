# Entrada y respuesta visibles con tokenizador — Nexo 0.1.33

## Cambios

- Actividad: «Tokens de entrada de usuario» y «Tokens de respuesta IA». Los contadores de mensajes/respuestas siguen siendo cantidades, no tokens.
- Salida visible: BPE del texto original con el modelo identificado y su encoding verificado. Se usa el mismo núcleo que la entrada: `T = length(encode_Em(S_original))`. No se usa una equivalencia de palabras/caracteres para el valor BPE.
- El texto literal del lector aislado, compartido con la vista de conversación de EVO Memory, actualiza el aporte del mismo turno. No se suma una copia por cada parcial ni se agrega una respuesta al actualizar sus tokens. Abrir un historial no crea actividad nueva.
- Cuando una entrada de red/CDP sólo declara `auto`, el contador puede completarla cuando llega el modelo concreto de SU respuesta. Para ello conserva temporalmente el original en el registro del contador (máximo 200000 caracteres), sin escribir esa copia en el log ni en la memoria conversacional, y la elimina al resolver su medición. Si el original no está disponible no lo reconstruye a partir de texto normalizado o renderizado.
- El zoom de interfaz pasa de la cabecera a **Ajustes → Apariencia**. Conserva controles, persistencia y zoom de sitio/atajos. No se repone el zoom flotante inferior ni el espejo de captura.

## Separación de métricas

`outputBpeTokens` es el total exacto que muestra la tarjeta de tokens de respuesta. `unknownOutputMessages`, `bpeOutputMessages`, `estimatedOutputMessages` y `estimatedOutputTokens` explican su cobertura. `outputTokens` permanece como métrica interna heredada para compatibilidad; **no es el valor que muestra esa tarjeta**. No se mezclan las estimaciones de otros proveedores con los totales BPE.

Sin modelo/texto verificable se muestra «—», no un cero que aparente una medición. Si hay aportes medidos y pendientes se muestra «n + ?». El detalle explica ambas categorías. No se añade compatibilidad de modelos ni se adivina un encoding para `auto`, `gpt-6` u otros nombres desconocidos.

Los resultados cancelado/fallido/realizado siguen requiriendo señales del turno. Recibir texto no prueba por sí solo una cancelación, un fallo ni un final confirmado. Un cero puede ser correcto si ese resultado no se observó.

## Validación local

- Script de referencia ampliado: tokenización del núcleo, entrada del preload y libro de salida visible contra **OpenAI tiktoken 0.12.0**: **184 comparaciones, 0 discrepancias**. Incluye el número, encoding e IDs, sobre textos con espacios de borde, tabs, CRLF, Unicode, emojis y texto largo. Runtime `gpt-tokenizer` sigue fijado en 4.1.0.
- 196 pruebas nuevas: 184 filas de referencia más escenarios de entrada auto/modelo tardío, progreso acumulado, DOM frente a Markdown de red, correcciones descendentes, lectura histórica, recuperación de texto, respuestas idénticas de envíos diferentes, modelo desconocido, estimaciones separadas, zoom en Ajustes, parcial interrumpido y cierre duplicado fuera de las últimas seis respuestas.
- Suite completa: **1269 pruebas, 1268 correctas, 0 fallidas y 1 omitida**. Duración local: 129238.419439 ms. La omitida requiere `NEXO_ELECTRON_ZIP_DIR` para la cadena de empaquetado.
- Las pruebas VM de presentación importan la función real nueva y verifican la tarjeta BPE, conservando por separado las regresiones de la estimación interna anterior.
- La integración Windows existente se amplía para comprobar el BPE de entrada en preload, el texto parcial literal en Memoria y el número impreso en Actividad antes y después del cierre. También comprueba que el zoom sólo esté en Ajustes. El resultado de esa ejecución debe consultarse en el flujo del commit compilado; las pruebas locales no se presentan como ejecución de Windows.

Ejemplo reproducible: string `"  Hola, mundo.  "`, `gpt-5`, `o200k_base`: **6 tokens**; el mismo string con `gpt-4`, `cl100k_base`: **7 tokens**. No se hace `trim` ni normalización para medir.

## Límites que no se ocultan

No se puede garantizar «todos los contadores sí o sí» ante texto/modelo no expuestos, una sesión no observada o cambios futuros del sitio. Esta revisión hace verificable la medición y explícita la ausencia de datos; no inventa cifras para evitar ceros.

No se midió facturación ni contexto oculto. No hubo prueba con una cuenta real de ChatGPT en el entorno local. La captura DOM no autentica la procedencia del proveedor. Los bloqueantes previos de la auditoría del puente IPC y correlación de gestos siguen pendientes; esta revisión no los da por cerrados ni constituye aprobación de seguridad.

# Pestaña Tokenizador

## Uso

1. Abrir **Tokenizador** en las pestañas del panel derecho de Nexo.
2. Elegir un modelo con encoding verificado (predeterminado explícito: `gpt-4o`).
3. Escribir o pegar el texto: se calcula automáticamente tras una pausa breve, o al pulsar **Contar tokens**.
4. Leer el resultado numérico y el encoding. **Copiar resultado** copia el número, modelo, palabras y caracteres. **Limpiar** vacía el texto y muestra 0. Palabras y caracteres son datos auxiliares, no la fórmula de tokens.

La fórmula es `T = length(encode_Em(S_original))`: número de IDs que produce el encoding del modelo aplicado al string original. No se hace trim, normalización Unicode ni equivalencia de palabras/caracteres. Ejemplo: `"  Hola, mundo.  "` da **6** con `gpt-4o`/`o200k_base` y **7** con `gpt-4`/`cl100k_base`.

Nexo utiliza su dependencia local `gpt-tokenizer` 4.1.0, contrastada con OpenAI **tiktoken 0.12.0**. No instala Python ni llama a una API para contar. No afirma ejecutar la biblioteca Python dentro de Electron.

## Alcance y privacidad

- Se mide sólo el texto introducido con el modelo seleccionado. No incluye formato/overhead de mensajes, contexto oculto, archivos, imágenes ni la respuesta futura. Es un número de tokens del texto, no una factura ni una predicción del consumo total de una conversación.
- La operación no guarda el texto en archivos, logs o EVO Memory, no lo envía a OpenAI y no modifica los contadores de Actividad. El núcleo mantiene su caché temporal local acotada ya existente.
- Sólo se ofrecen modelos de la tabla verificada. Un nombre desconocido no recibe un encoding inventado.
- Límite: **200000 unidades UTF-16**, validado tanto en la interfaz como en el servicio. No se recorta un texto grande silenciosamente.
- Cambiar texto/modelo invalida el resultado anterior. Si el usuario edita mientras espera una operación, su resultado tardío no se imprime sobre el nuevo texto. Errores y servicio no disponible se muestran sin fabricar cifras.
- La vista web de diseño no simula tokenización: la calculadora funciona en Electron.

## Integración con cambios concurrentes

Se incorporó sin force push la historia remota hasta `d09963d`, que agregaba una herramienta Tiktoken. Se unifica en una sola pestaña **Tokenizador**, conservando conteo automático, palabras/caracteres y copiar resultado, además del botón explícito y las validaciones. La API previa `nexo.tiktoken.count` sigue disponible por compatibilidad y restringida a la shell; la interfaz unificada usa el nuevo contrato con número y encoding.

## Implementación

- `src/main/tokenizerCalculator.js`: servicio sin efectos persistentes, usa el núcleo BPE ya verificado.
- IPC `nexo:tokenizer:models` y `nexo:tokenizer:count`: exclusivamente shell registrada, frame principal y URL interna exacta. Webviews, subframes e impostores son rechazados. No se abre una nueva ruta de postMessage desde sitios externos.
- `src/ui/shell/tokenizerPanel.js`: modelo, texto, envío explícito, resultado, errores, limpieza y descarte de resultados obsoletos.
- Pestaña/panel integrados en la navegación accesible ya existente. No se altera el lector de conversaciones, el contador automático ni el almacenamiento de EVO.

## Validación ejecutada

- Referencia independiente: **184 comparaciones, 0 discrepancias**, verificando núcleo, preload, libro de respuesta visible y calculadora manual contra tiktoken 0.12.0 (IDs, cantidades y encoding; incluye espacios, tabs, CRLF, Unicode, emojis y texto largo).
- Pruebas nuevas de calculadora, UI e IPC: **193 correctas**. Incluyen tabla completa de referencia, entrada vacía, modelos/entradas inválidas, límite, texto sin cambios, cambio de encoding, resultado tardío, errores/reintento y rechazo de fuentes no autorizadas. Contadores/ajustes permanecen iguales tras calcular.
- Suite completa local: **1462 pruebas; 1461 correctas, 0 fallidas, 1 omitida**; duración 129132.251722 ms. La omisión requiere un paquete externo de Electron para probar el asar de una distribución.
- `npm run build:inject` y `git diff --check`: correctos.
- El probe de Electron real se amplía para abrir la pestaña, contar 6 con gpt-4o y 7 con gpt-4, conservar espacios, limpiar a cero y confirmar que la actividad no cambió. El resultado Windows corresponde al flujo del commit compilado y se entrega por separado; no se infiere de las pruebas Linux.

Esta pestaña nueva no cierra la auditoría previa del puente de captura MAIN world ni los demás bloqueantes de correlación pendientes. Sus canales IPC sí están restringidos a la shell; eso no equivale a una aprobación de seguridad del navegador completo.

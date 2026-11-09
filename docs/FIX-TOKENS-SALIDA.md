> **Informe histórico de la entrega anterior.** El estado actual integra los cambios
> remotos BPE y la corrección de compilación. Las cifras, el uso de estimación y
> la nota de no integración de este informe corresponden al snapshot anterior.
> Ver `COMPILACION-FIX.md` para la implementación y verificación actuales.

# Fix de tokens de salida GPT — código 0.1.13

## Alcance y estado

Este ZIP contiene el proyecto fuente completo y el bundle de inyección generado. No contiene un ejecutable Windows nuevo, `node_modules`, perfiles de usuario ni `.git`.

El arreglo está verificado mediante pruebas automatizadas; **no se verificó una conversación real de ChatGPT en Windows**. No se presenta la compilación como prueba de funcionamiento en producción. Los tokens son la estimación local de `estimateTokens(text)`, no una lectura del uso oficial de la API.

## Causas reproducidas en código y pruebas

1. El cierre de red podía contar la respuesta sin conocer su cuerpo. Cuando CDP obtenía el texto más tarde, la deduplicación impedía aportar los tokens que faltaban.
2. CDP dejaba de leer el cuerpo si la inyección había cerrado el streaming, incluso cuando ese cierre no traía texto.
3. El lector de cuerpos de streaming sólo reconocía eventos SSE `data:` con JSON; descartaba JSON por líneas y respuestas de conversación con MIME `text/plain`.
4. En ChatGPT, un evento acumulativo repetido podía volver a aportar por el extractor genérico el texto que ya había agregado el adaptador.

Estos caminos se reprodujeron con fixtures y Electron simulado. Sin una captura de la sesión real del usuario no se puede afirmar cuál de ellos explica por sí solo todos los casos observados en Windows.

## Solución

- El Engine conserva temporalmente la referencia a una respuesta ya contada sin texto. Si después llega texto por CDP o por inyección, suma `estimateTokens(text)` a esa misma respuesta, una sola vez. No incrementa respuestas, mensajes, entrada, actividad ni turnos en esa recuperación.
- La atribución se invalida al enviar una pregunta nueva, al vencer la ventana existente o al cerrar la pestaña. No se creó un segundo contador.
- CDP sólo omite la lectura de un stream cuando la inyección lo cerró **con texto**. Acepta SSE, JSON por líneas y texto plano de una petición de conversación reconocida. Los eventos de control SSE no se interpretan como texto generado.
- El acumulador ChatGPT evita volver a agregar el texto que el adaptador ya aportó. Los mecanismos existentes del Engine deduplican las capturas y ajustan los fragmentos acumulativos.
- Si ningún mecanismo recupera texto, la respuesta se cuenta como antes y no se inventan tokens.

## Archivos

Cambios funcionales:
- `src/main/engine.js`: recuperación diferida de tokens y deduplicación con los mecanismos existentes.
- `src/main/cdp.js`: respaldo tras un cierre sin texto y lectura tolerante del cuerpo.
- `src/core/cdp.js`: evitar texto duplicado en el respaldo genérico de ChatGPT.
- `src/main/main.js`: únicamente la descripción del diagnóstico `incoming-network`; sin cambios en envío ni contadores de entrada.

Pruebas y documentación:
- `test/tokens-salida.test.js`: 13 pruebas de integración del proceso principal con Electron simulado.
- `docs/ARQUITECTURA.md`, este informe y `README.md`: comportamiento y resultados actualizados.
- `package.json`, `package-lock.json`: sólo versión de código 0.1.13, sin nuevas dependencias.

Auditados sin modificación: `src/inject/index.js` y `src/preload/bridge.cjs`. La inyección ya transmite el texto completo, caracteres y `estimateTokens(text)`; el bridge ya reenvía el payload al proceso principal.

No se modificaron la interfaz ni EVO MEMORY. Las operaciones existentes que incrementan respuestas, entrada y mensajes permanecen intactas. La recuperación de texto no se considera una respuesta adicional.

## Verificación ejecutada

- `node --test test/tokens-salida.test.js`: primera ejecución ampliada, 12/12 aprobadas. Se añadió después el caso de eventos de control sin texto y se ejecutó toda la suite mediante `npm run verify`.
- `npm run verify` final: **453 pruebas, 452 aprobadas, 1 omitida, 0 fallos**. Incluye las **13/13 pruebas** específicas de tokens de salida. Bundle de inyección compilado correctamente: 37.1 kB, 13.4 kB gzip.
- Casos específicos: respuesta normal; CDP/SSE; CDP `Other`; NDJSON; deduplicación inyección→CDP y CDP→inyección; texto acumulativo; respuesta sin texto; texto tardío tras cierre de red; independencia de entrada y mensajes; cierre de inyección vacío con respaldo CDP; MIME plano/JSON; eventos SSE de control sin tokens ficticios.
- La prueba omitida es la cadena completa de empaquetado con un ZIP externo de Electron (`NEXO_ELECTRON_ZIP_DIR` no configurado).
- `npm run dist:win`: intentado. El bundle y los iconos se generaron, pero el empaquetado se detuvo al descargar Electron: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `unable to verify the first certificate`. No se desactivó la validación TLS. **No hay compilación Windows nueva validada ni prueba de humo del ejecutable de esta versión.**

## Validación real pendiente

En Windows, compilar desde este proyecto con `npm ci` y `npm run dist:win`, con acceso válido a la descarga de Electron. Para desarrollo: `npm start`.

1. Anotar respuestas y tokens de entrada/salida antes de una conversación nueva en ChatGPT.
2. Enviar una pregunta, esperar el fin del streaming y verificar que la respuesta aumenta una sola vez y que los tokens de salida aumentan a partir del texto recibido.
3. Repetir con una respuesta larga y varias respuestas consecutivas. Los fragmentos no deben sumar varias respuestas ni duplicar tokens.
4. Si la red cuenta primero y CDP recupera después, el registro muestra `tokens-recuperados`: aumentan sólo los tokens de la respuesta ya contada.
5. Si vuelve a quedar en cero, conservar los diagnósticos de CDP/formato/cuerpo. No atribuir el caso a una ruta o protocolo sin evidencia de esa sesión.

## Coexistencia con cambios remotos

Durante la entrega se detectaron commits remotos simultáneos que reemplazan el estimador por otro tokenizador y modifican tokens de entrada. No se integraron ni se sobrescribieron: este ZIP corresponde al árbol local verificado, basado en `074899f`, y mantiene el alcance solicitado. No se publicó una release ni se hizo push de este snapshot sobre los cambios remotos.

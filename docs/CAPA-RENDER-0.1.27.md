# Capa de lectura renderizada — Nexo 0.1.27

## Resultado

El navegador observa el DOM compartido de ChatGPT desde el preload aislado, usando el lector EVO y **un único MutationObserver**. Una ráfaga de mutaciones se agrupa en el siguiente `requestAnimationFrame`, en lugar del retraso fijo de 500 ms de la versión anterior. No se altera el compositor, el TLS, el contenido enviado, ni los bytes de la respuesta del proveedor para realizar esta copia.

El mismo snapshot literal alimenta:

1. **Repetición de conversación**, en RAM.
2. **Memoria → Conversación de esta pestaña**, vista literal en vivo con ambos roles, sin esperar al cierre.
3. La transcripción local de Memoria, si el usuario habilitó ese guardado.
4. La estimación existente de salida por palabras para la respuesta del envío observado, sin contabilizar la apertura de un historial como actividad nueva.

La transferencia entre procesos y el pintado de la shell son asíncronos: no se promete sincronización física en el mismo píxel/cuadro del compositor. La ruta visible trabaja por cuadro, sin esperar a terminar la respuesta. Sin rAF/documento visible queda el fallback existente.

## Memoria: vista inmediata y disco agrupado

- `src/preload/conversationSaveQueue.js` agrupa las revisiones del mismo documento durante 500 ms y conserva la última. No se serializa todo el archivo de memoria 60 veces por segundo.
- Se conserva la confirmación de persistencia del IPC; un rechazo no se confirma como guardado.
- Al cambiar de documento se vacía el lote anterior, y `pagehide` solicita vaciar la cola. Esto no garantiza terminar una escritura si el proceso se mata abruptamente; puede perderse el último lote no confirmado.
- Al apagar Memoria se cancela el lote pendiente. La copia visible en RAM puede seguir funcionando y se etiqueta como tal.
- Los ajustes ahora llegan también a los preloads de webviews ya abiertos. Antes sólo se actualizaba la shell: la nueva prueba en Windows detectó que activar Memoria sin recargar dejaba el lector con el ajuste anterior. Se corrigió mediante `refreshGuestSettings`.
- El guardado toma la misma cadena literal, sin quitar espacios extremos antes de archivarla. Se mantienen los límites explícitos de transcripción: 10.000 caracteres por mensaje, 250.000 por conversación, 200 mensajes y 50 conversaciones. La vista en RAM conserva sus límites propios (200.000 por mensaje y 1.000.000 por snapshot). Los recortes se indican; no se afirma guardar contenido ilimitado.
- No se leen chats temporales ni contenido no cargado en el DOM, ni se copian conversaciones a logs de diagnóstico.

## Salida IA: palabras, no facturación de OpenAI

`Engine.onRenderedConversation` reutiliza `streamProgress`, la identidad canónica del envío y `recentTexts`; no introduce un contador paralelo.

- El primer snapshot es una base: abrir un historial no suma palabras ni respuestas.
- Los cambios de la respuesta posterior a un envío observado producen una estimación acumulada, no la suma independiente de cada fragmento.
- «Ho» → «Hola» sigue siendo una palabra; «Hola mundo» pasa a dos.
- Si DOM y SSE/CDP ven el mismo envío, no se concatenan dos copias. El texto visible identificado como tal tiene prioridad para esa estimación, aunque el Markdown de red difiera.
- El cierre retira el provisional y reconcilia la misma respuesta. Si la red cierra antes del último render, el DOM puede corregir el número sin añadir otra respuesta.
- Los alias del mismo envío se resuelven antes de aplicar el progreso. Dos envíos distintos con respuestas iguales siguen siendo dos respuestas.
- La salida sigue siendo una unidad estimada por palabra. La entrada BPE y la clasificación existente de cancelados/fallidos/realizados no cambian; no se añade un contador de completos.
- Snapshots recortados, otros documentos o sin envío observado no se convierten artificialmente en respuestas nuevas. No incluye razonamiento oculto, imágenes o texto que el sitio no renderiza/carga.

## Validación

- `npm run verify`: **681 pruebas, 680 aprobadas, una omitida, cero fallos**.
- `test/rendered-conversation.test.js`: progreso incremental, DOM/SSE/CDP intercalados, red anterior/posterior al render, correcciones descendentes, alias, cancelación sin reclasificar, respuestas iguales en envíos distintos, historial sin actividad, ráfagas por cuadro, cola de disco y cancelación/vaciado.
- `test/repetition-main.test.js`: además de aislamiento/privacidad, activar/desactivar Memoria actualiza preloads existentes, sin enviar ajustes a páginas sin perfil.
- Chromium con interfaz de producción y fixture local: ambos roles en Memoria, revisiones literales sin duplicados, sin interpretar HTML ni errores JS. Captura local `/home/user/nexo-memoria-en-vivo.png`; no es una conversación de una cuenta real.
- `scripts/probes/repetition-electron.cjs`, en Electron real/Windows: shell y webview reales, DOM servido localmente bajo HTTPS mediante interceptación de protocolo, IPC y almacenamiento reales. Se habilitó Memoria sin recargar, se mostraron tres parciales en el panel, se comprobó **1 → 2 → 3 palabras con cero respuestas cerradas**, y luego tres palabras/una respuesta al cerrar. Se verificó el texto literal final consultando la transcripción y leyendo el archivo JSON de memoria. También se preservan las pruebas de aislamiento, sustitución del body y eventos de restauración.
- CI **42757679272**, commit **a0cf1fd**: verificación, integración Electron, benchmark, empaquetado y arranque del ejecutable correctos.
- Benchmark local: **59,5 kB sumando ambos bundles**, sin dependencias nuevas ni relajación de límites.

## Descarga

[Windows x64 — Nexo 0.1.27](https://github.com/EvoMaxPC/navegador/actions/runs/42757679272/artifacts/13735439632)

Cerrar Nexo completamente, extraer en una carpeta nueva y ejecutar `nexo.exe`. Habilitar Memoria para persistir la transcripción. GitHub puede exigir iniciar sesión para bajar el artefacto.

Pendiente: validación con la cuenta y el DOM real de ChatGPT del usuario. La prueba local/CI no se presenta como acceso a esa sesión.

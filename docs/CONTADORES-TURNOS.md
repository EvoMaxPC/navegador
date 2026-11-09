# Contadores de resultado de ChatGPT — NEXO 0.1.18

## Implementación

El panel conserva su estilo y sus métricas de mensajes, respuestas, tokens y
actividad. Se reemplazó el antiguo total de turnos por tres contadores de resultado
exclusivos, todos inicializados en **0** al crear Engine:

| Campo en `nexo:stats` | Etiqueta | Cuándo cuenta |
| --- | --- | --- |
| `turnsCancelled` | turnos cancelados | Stop real del usuario o cancelación explícita del proveedor |
| `turnsFailed` | turnos fallidos | error de generación o fallo de la petición de conversación |
| `turnsPerformed` | turnos realizados | interrupción sin confirmar el resultado |

Un `AbortError` o `net::ERR_ABORTED` **no prueba** por sí solo una cancelación del
usuario: también puede proceder de navegación, recarga o del propio sitio.
El listener de clic existente reconoce Stop en ChatGPT mediante los botones
`data-testid="stop-button"` y `data-testid="stop-generating-button"`, con
`event.isTrusted`. No bloquea ni modifica el gesto. Los fallos de peticiones
ajenas a la conversación (historial, cuenta, telemetría) no suman turnos fallidos.

La clasificación comparte la identidad de envío, alias y `seenResponses` del
motor existente. No hay otra captura de respuesta, otro observador DOM, otro
motor de contadores ni temporizadores nuevos. El helper `core/turnOutcome.js`
sólo interpreta señales. Inyección/preload/IPC, `stream-end`, CDP y webRequest
siguen siendo los mecanismos de transporte y captura.

Una respuesta aporta **exactamente un resultado**. SSE, NDJSON, CDP, cierre de
red y avisos repetidos no vuelven a sumarlo. Los envíos consecutivos, incluso con
texto idéntico, y las pestañas diferentes conservan sus propias identidades.
Regenerar o continuar reserva otra identidad en `awaiting`, sin sumar un mensaje
del usuario ni tokens de entrada; dos regeneraciones iguales son dos turnos.
La correlación también cubre envíos que Chromium atribuye a un worker (`-1`).

Si la red termina sin cuerpo, no se afirma que el modelo completó normalmente:
se registra desconocido. Si llega una confirmación tardía, se **mueve** ese mismo
turno: se resta uno a desconocidos y se suma uno al resultado confirmado. No
quedan dos contadores incrementados para el mismo turno. Una confirmación ya
registrada no se degrada con avisos posteriores de menor certeza.

Una navegación completa, cierre o caída de renderizador con un turno pendiente
registra desconocido. Los cambios de URL dentro de una SPA (por ejemplo, la
asignación de una URL nueva al chat) no se tratan como interrupciones.

Cada cambio comunica `nexo:stats-changed` a la shell. Las cuatro celdas se
actualizan por la suscripción existente, sin recargar la página.

## Contadores retirados

Se retiraron `loopsSeen`, `loopsCut`, el alias `loops` y la métrica CDP de bucles,
con sus acumulaciones, agregación y elementos de interfaz. También se retiró el
contador de bucles cortados de la sala de pruebas/demo y las métricas agregadas
de `guard.stats()`.

Se mantienen la detección de repeticiones, el centinela, los diagnósticos y la
memoria interna de patrones del guardián: esta última decide si continuar o
regenerar ante una repetición, no es uno de los contadores públicos eliminados.
No se borró memoria ni historial del usuario.

## Tokens y funciones conservadas

No se modificaron `src/main/tokens.js`, `src/core/gptTokens.cjs`, el tokenizador,
la estimación de contingencia ni las fórmulas de suma/ajuste de entrada/salida.
La clasificación de un resultado no suma tokens ni actividad. Los tokens del
texto parcial siguen entrando por el cierre de captura existente. Los tests
previos de tokens se mantienen, con la única actualización de las aserciones
que dependían del antiguo total de turnos.

## Pruebas

- **20 pruebas nuevas de Engine/clasificación:** cero inicial, cuatro resultados,
  errores y abortos, exclusividad, repetición SSE/CDP, confirmación tardía,
  tokens intactos, múltiples pestañas, IDs alternativos y worker sin pestaña.
- **16 pruebas adicionales de circuito:** bundle de inyección, preload real,
  handlers reales, BPE y funciones de shell reales sobre DOM mínimo simulado.
  Cubren SSE/NDJSON normales, Stop con y sin gesto confiable, AbortError,
  error de generación con HTTP 200, rechazo de fetch, HTTP 500, error SSE sin
  EOF/DONE, cancelación CDP y navegación/cierre.
- Pruebas existentes adaptadas a la semántica nueva: una red sin confirmación
  ya no se etiqueta como turno completo. Las verificaciones de tokens,
  mensajes, respuestas y demás funciones se conservan.
- `npm run verify`: **529 pruebas, 528 aprobadas, 1 omitida, 0 fallos**.
  La omitida requiere un ZIP externo de Electron para la cadena local.
- Bundle: **45.2 kB**, **16.2 kB gzip**, 10 módulos; sin nuevas dependencias ni
  relajación de límites de rendimiento.

Estas son pruebas automatizadas, incluidas grabaciones externas de ChatGPT.
**No se verificó una sesión propia en vivo de ChatGPT en Windows desde este
sandbox.** El paquete Windows y su arranque pueden comprobarse en CI, pero eso
no sustituye una conversación real. Si ChatGPT cambia los identificadores del
botón Stop, sin señal explícita del proveedor la interrupción quedará como
"desconocida", no se inventará una cancelación confirmada.


## Integración de cambios concurrentes

Durante la publicación se detectaron cuatro commits remotos nuevos en esta
misma rama: `f333bc7`, `f00ebe8`, `6259b86` y `7a65760`, para capturar ChatGPT
anónimo mediante DPU/HTML y lectura final de DOM. Se integraron por merge normal,
sin force push ni eliminación de esa captura. Se resolvió el solapamiento de
`wrapResponse` conservando los metadatos DPU y la identidad del turno.

La ruta DPU ahora conserva también el estado Stop, emite completo sólo al obtener
la respuesta visible y registra desconocido si no puede confirmarla, sin
inventar texto ni tokens. Se agregaron **3 pruebas de integración DPU** con DOM y
transporte sintéticos (normal, Stop/cierre y respuesta no verificable), además
de las **6 pruebas DPU recibidas del remoto**. No constituyen validación en vivo.


## Ajuste 0.1.17: cancelación y nombre del cuarto contador

El cuarto campo público se renombró a `turnsPerformed`, con etiqueta
**turnos realizados** e ID `statTurnsPerformed`, en motor, IPC de estadísticas,
shell y pruebas. Es el cambio de nombre solicitado; no se ha convertido en
un total que duplique los otros tres resultados. La clasificación interna
`unknown` se conserva para no cambiar las reglas de resultado ni los tokens.

La detección del gesto Stop reutiliza ahora `site.stopButton` del perfil de
ChatGPT, incluyendo los dos test IDs existentes y los aria-label Stop, Detener
y Cancelar, sin distinguir mayúsculas. Antes, cuatro pruebas con aria-label no
sumaban cancelaciones; después del cambio pasan. Se prueban cinco variantes de
botón, clic en el icono hijo, clic repetido y posterior aborto/CDP: **exactamente
+1 en turnos cancelados** y aviso inmediato a la shell. También se verifica la
cancelación confirmada después de una llegada de red sin resultado definitivo:
se mueve el mismo turno a cancelados y no se contabiliza dos veces.

No se cambió la tokenización, la captura de texto ni la lógica de suma de tokens.


## Ajuste 0.1.18: eliminación de turnos completos

Se eliminó el campo del constructor de Engine, de `nexo:stats`, del enlace de
la shell y del HTML del panel. No queda una acumulación oculta ni se traslada su
valor a otro contador. Permanecen **turnos cancelados, fallidos y realizados**.

La finalización normal sigue existiendo como señal privada de captura y
deduplicación, sin contador asociado. La respuesta y sus tokens se registran
igual que antes. Las pruebas comprueban que el contador retirado no se expone,
que no se creen propiedades `null`/`undefined` por sumar a una métrica ausente y
que repetir un cierre no duplique respuestas ni tokens.

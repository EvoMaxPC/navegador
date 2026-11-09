# Contadores de resultado de ChatGPT — NEXO 0.1.16

## Implementación

El panel conserva su estilo y sus métricas de mensajes, respuestas, tokens y
actividad. Se reemplazó el antiguo total de turnos por cuatro resultados
exclusivos, todos inicializados en **0** al crear Engine:

| Campo en `nexo:stats` | Etiqueta | Cuándo cuenta |
| --- | --- | --- |
| `turnsCompleted` | turnos completos | finalización normal de la respuesta |
| `turnsCancelled` | turnos cancelados | Stop real del usuario o cancelación explícita del proveedor |
| `turnsFailed` | turnos fallidos | error de generación o fallo de la petición de conversación |
| `turnsUnknown` | turnos desconocidos | interrupción sin confirmar el resultado |

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

- **18 pruebas nuevas de Engine/clasificación:** cero inicial, cuatro resultados,
  errores y abortos, exclusividad, repetición SSE/CDP, confirmación tardía,
  tokens intactos, múltiples pestañas, IDs alternativos y worker sin pestaña.
- **11 pruebas adicionales de circuito:** bundle de inyección, preload real,
  handlers reales, BPE y funciones de shell reales sobre DOM mínimo simulado.
  Cubren SSE/NDJSON normales, Stop con y sin gesto confiable, AbortError,
  error de generación con HTTP 200, rechazo de fetch, HTTP 500, error SSE sin
  EOF/DONE, cancelación CDP y navegación/cierre.
- Pruebas existentes adaptadas a la semántica nueva: una red sin confirmación
  ya no se etiqueta como turno completo. Las verificaciones de tokens,
  mensajes, respuestas y demás funciones se conservan.
- `npm run verify`: **512 pruebas, 511 aprobadas, 1 omitida, 0 fallos**.
  La omitida requiere un ZIP externo de Electron para la cadena local.
- Bundle: **41.8 kB**, **15.1 kB gzip**, 9 módulos; sin nuevas dependencias ni
  relajación de límites de rendimiento.

Estas son pruebas automatizadas, incluidas grabaciones externas de ChatGPT.
**No se verificó una sesión propia en vivo de ChatGPT en Windows desde este
sandbox.** El paquete Windows y su arranque pueden comprobarse en CI, pero eso
no sustituye una conversación real. Si ChatGPT cambia los identificadores del
botón Stop, sin señal explícita del proveedor la interrupción quedará como
"desconocida", no se inventará una cancelación confirmada.

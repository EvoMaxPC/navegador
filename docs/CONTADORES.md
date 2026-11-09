# Los dos contadores: causa, corrección y qué falta validar

Informe de la corrección de los contadores de **mensajes** y **respuestas**.
Todo lo que dice «comprobado» está cubierto por una prueba que se ejecuta contra
el proceso principal real (`src/main/main.js`) con un Electron falso, y que
**falla** sin la corrección.

## 1. Qué estaba mal

### 1.1 Una respuesta se identificaba por su texto

La deduplicación entre canales (capa de la página, CDP, cierre de stream) decidía
que dos capturas eran «la misma respuesta» **porque el texto era igual**. Ese
criterio no sabe nada de turnos, así que fundía respuestas legítimas:

- `onCdpCapture` guardaba la huella `h:<host>|<hash>` durante **dos minutos** y
  descartaba cualquier texto igual. Cinco respuestas «Listo.» a cinco preguntas
  distintas contaban **una**.
- `#mergeResponse` comparaba sólo texto (igual, prefijo o crecida). Un cierre de
  stream posterior con el mismo texto no se contaba, aunque fuera otro turno.

Medido con la prueba `3b` antes de la corrección: **5 intercambios → 1 respuesta**.
Es una pérdida silenciosa: no hay error, no hay aviso, sólo un número que no sube.

### 1.2 «La capa está viva» se confundía con «la capa capturó la respuesta»

En v0.1.4 la capa se marcaba viva al **contar un envío**. A partir de ahí, CDP
dejaba de pedir el cuerpo de los `text/event-stream`. Si la capa contaba el envío
y después no cerraba el stream (su envoltorio del `fetch` no corre, el sitio
cambió de transporte, la pestaña se restauró sin ella), **la respuesta no la
contaba nadie**: 0 respuestas, sin rastro de por qué.

Es el cambio que explica el síntoma «dejó de contar respuestas» respecto de
versiones anteriores: la condición para que CDP leyera el stream pasó a depender
de un hecho que no implica nada sobre la respuesta.

## 2. La corrección

**Un solo criterio, con el turno como referencia.** Una respuesta es nueva si hay
un turno esperando y lo visto no pertenece a ese turno. El texto sirve para no
contar dos veces el mismo hecho, nunca para fundir dos hechos distintos.

| Sitio | Antes | Ahora |
|---|---|---|
| `#seenAlready` (huellas entre canales) | texto igual en 2 min ⇒ duplicado | duplicado sólo si no hay turno nuevo esperando, o si la marca es del mismo turno (por `messageId`, o por ser posterior al envío) |
| `#mergeResponse` | texto igual/prefijo ⇒ duplicado | igual, pero condicionado al turno pendiente |
| `onCdpCapture` | fusionaba sin mirar el turno | resuelve el turno **antes** de fusionar |
| CDP y `text/event-stream` | no leía el cuerpo si la capa estaba viva | lee el cuerpo salvo que la capa haya **cerrado ese stream** después de que saliera la petición |

Nada de temporizadores nuevos: la ventana de respuesta que ya existía
(`VENTANA_RESPUESTA_MS`) sigue siendo el único límite, y ahora no puede eliminar
una respuesta legítima porque la decisión final la toma el turno.

## 3. Archivos modificados

- `src/main/engine.js` — deduplicación por turno en `#seenAlready`, `#markSeen` y
  `#mergeResponse`; `layerEnded` / `layerEndedAfter` para decidir el stream.
- `src/main/cdp.js` — instante de salida de cada petición y lectura del SSE
  cuando la capa no cerró ese stream.
- `src/main/main.js` — estado de captura visible, avisos `chat-unmatched` y
  `chat-disabled`, y `nexo:stats` con el bloque `capture`.
- `src/inject/index.js` — el gesto de enviar no depende de un selector exacto.
- `src/ui/shell/*` — una línea con el estado de la captura (no rediseño).
- `test/contadores-correccion.test.js` — las once pruebas de aceptación.
- `test/cdp-main.test.js`, `test/cdp-transporte.test.js`, `test/contadores-cdp.test.js`
  — reescritas las que exigían el contrato viejo, cada una con su pareja.

## 4. Pruebas de aceptación

| # | Criterio | Resultado |
|---|---|---|
| 1 | un mensaje enviado suma +1 | OK |
| 2 | una respuesta completa suma +1 | OK |
| 3 | cinco intercambios ⇒ 5 y 5 | OK |
| 3b | cinco respuestas con el mismo texto ⇒ 5 | OK (fallaba: daba 1) |
| 4 | el streaming no suma por fragmento | OK |
| 5 | la misma respuesta por dos mecanismos ⇒ 1 | OK |
| 6 | un error HTTP no suma respuestas | OK |
| 7 | una respuesta sin terminar no está contada hasta que termina | OK |
| 8 | cada respuesta se asocia a su mensaje | OK |
| 9 | la interfaz se entera en el acto (`nexo:stats-changed`) | OK |
| 10 | cambiar de conversación o de pestaña no pierde ni duplica | OK |

Suite completa: **411 pasan, 1 omitida, 0 fallan**; `npm run verify` OK.

## 5. Qué NO está validado

- **Prueba real en ChatGPT.** No tengo Windows ni sesión de ChatGPT en este
  entorno: no puedo enviar mensajes reales. Lo que está comprobado es el
  cableado (IPC, `webRequest`, CDP) contra el Electron falso, no el sitio real.
- **Persistencia entre reinicios.** Los contadores son de la sesión: cambiar de
  conversación o de pestaña no los toca (prueba 10), pero cerrar la aplicación
  los reinicia. No se agregó disco porque no estaba previsto y no se pidió.
- **Cómo se comporta con la cuenta real del sitio.** Si las respuestas entran por
  `incoming-cdp` en vez de por la capa, la línea «Captura —» del panel lo dice, y
  también si el endpoint cambió (`chat-unmatched`) o si el sitio está apagado en
  Ajustes (`chat-disabled`).

# Observación CDP (sólo lectura)

El enganche de `fetch` cubre las peticiones y los streams SSE que salen de la
página. Quedaban dos canales fuera: los **frames de WebSocket** y las
**respuestas JSON completas**, que no pasan por un stream y por eso el filtro no
las veía.

Esta capa los observa con el depurador de Electron (`webContents.debugger`, el
protocolo Chrome DevTools) y conecta lo capturado con los motores que ya
existían. **Observa, no media**: cuando CDP ve una respuesta, el sitio ya la
mostró. Nada de lo que se registra acá se reescribe.

---

## 1. Dónde se engancha

| Pieza | Archivo | Qué hace |
|---|---|---|
| Lectura del protocolo | `src/core/cdp.js` | Convierte frames y cuerpos JSON en texto de conversación, reutilizando los adaptadores de `streamAdapters.js` |
| Transporte | `src/main/cdp.js` | Adjunta el depurador por pestaña, escucha `Network.*` y pide los cuerpos |
| Cableado | `src/main/main.js` | `did-attach-webview` → `cdp.sync(contents)`; `did-start-navigation` → adjuntar o soltar; `destroyed` → soltar |
| Motor | `src/main/engine.js` | `onCdpCapture()`: análisis, deduplicación, historial, EVO MEMORY y libro |
| Guard | `src/core/guard.js` | `observeTurn()` (historial + memoria) y `note()` (libro de intervenciones) |

El depurador se adjunta **sólo** a las pestañas cuyo host tiene perfil en
`sites.js` (ChatGPT, Claude y los que se agreguen). En cualquier otro sitio no se
toca nada.

---

## 2. Qué se observa y qué se media

| Canal | ¿Se observa? | ¿Se media? | Por qué |
|---|---|---|---|
| Petición `fetch` del mensaje | sí | **sí** | Se reescribe el cuerpo antes de enviarlo (`promptEngine`) |
| Respuesta SSE | sí | **sí** | `TransformStream` que reescribe los eventos antes del DOM |
| Frame de WebSocket | **sí** | no | Llega ya entregado a la página; CDP no puede reescribirlo |
| Respuesta JSON sin SSE | **sí** | no | Igual: cuando se puede leer, ya se mostró |

La regla de convivencia es explícita: **los cuerpos `text/event-stream` no se
procesan por CDP**. De esos se ocupa la capa de la página, y contarlos también
acá duplicaría el turno. La lista completa de exclusiones:

- `mimeType` que no sea JSON (`application/json`, `text/json`, `*+json`),
- cualquier stream (`event-stream`, `ndjson`, `jsonl`),
- tipos de recurso distintos de `XHR`/`Fetch`, estados fuera de 2xx,
- cuerpos en base64, sin cuerpo en el búfer o de más de 2 MB,
- frames binarios y JSON incompletos.

---

## 3. Cadena completa de una captura

```
Network.webSocketFrameReceived / Network.loadingFinished (+ getResponseBody)
        │
        ▼
CdpCapture            ← adaptador del sitio (chatgpt, claude) o extracción genérica
   texto + prompt + control de cierre + número de turno
        │
        ▼
engine.onCdpCapture()  ← deduplicación por huella (misma pestaña, 2 minutos)
        │
        ├─ StreamSentinel   → ¿bucle? ¿truncada?  (el mismo detector del stream en vivo)
        ├─ guard.observeTurn → historial + EVO MEMORY (el turno real, tal cual se mostró)
        ├─ responseEngine    → negativa o respuesta vacía (sólo se informa)
        └─ guard.note + logbook → libro de intervenciones → panel de la interfaz
```

Detalles que importan:

- **Un turno se cierra** con la señal del propio protocolo
  (`message_stop`, `finished_successfully`, `finish_reason`) o cuando se cierra
  el socket. Los turnos siguientes del mismo socket se numeran (`seq`).
- **La conversación se identifica** con `sitio#pestaña#socket` (WebSocket) o
  `sitio#pestaña#petición` (JSON). El guard sigue siendo por pestaña, como antes.
- **El texto no se duplica**: los protocolos acumulados (el frame repite todo lo
  anterior) se recortan por ruta; los deltas se suman tal cual.
- **El eco del usuario no se cuenta como respuesta**: se reconoce el rol y se
  ignora.
- **El prompt** se toma de los frames salientes sólo cuando es inequívoco
  (`messages[]` con rol `user`, `prompt`, o un frame marcado como del usuario).
  Una heurística laxa ensuciaría el historial y EVO MEMORY.

---

## 4. Qué se registra cuando hay un problema

Un bucle detectado en algo que **ya se mostró** no se puede cortar. Por eso el
evento lo dice con todas las letras:

```
Bucle observado por CDP en claude (no se pudo cortar)
  Se repitió ×4 un bloque de 128 caracteres tras 640 caracteres.
  Llegó por WebSocket, así que el texto ya estaba en el sitio:
  se registra como observación, sin intervención.
```

Campos de la entrada: `meta.via = 'cdp'`, `meta.observed = true`,
`meta.source` (`websocket`/`json`), `meta.conversationId`, `meta.seq`,
`meta.frames` y `savedChars = 0` (no se ahorró nada porque no se pudo cortar).

Los códigos posibles son `cdp-<tipo de bucle>`, `cdp-<motivo de corte>`,
`cdp-refusal` y `cdp-empty`. **No se emite ninguna entrada cuando la captura es
normal**: el contador sube y el turno queda en el historial, nada más.

---

## 5. Deduplicación

Tres capas, de afuera hacia adentro:

1. **El protocolo**: los SSE no entran a CDP.
2. **El observador**: un frame repetido o un cuerpo pedido dos veces produce una
   sola captura (`CdpCapture` se vacía al entregar).
3. **El motor**: huellas `sitio|prompt|texto` y `host|texto` por pestaña, con
   ventana de dos minutos. Las escriben **los dos caminos**, así que un mismo
   turno que llegue por HTTP/SSE y por CDP se cuenta una sola vez. Cuando se
   descarta, sube `cdp.duplicates` y no se escribe nada en el libro.

---

## 6. Cuando CDP no está disponible

| Situación | Qué pasa |
|---|---|
| Electron sin `webContents.debugger` | No se adjunta nada; se cuenta en `failed` |
| Ya hay un depurador adjunto (DevTools abierto) | Igual: `attach()` lanza, se captura y se sigue |
| `Network.getResponseBody` falla (cuerpo fuera del búfer) | Se registra en consola y se descarta la captura |
| El motor lanza una excepción al recibir | Se registra y la observación continúa |
| `NEXO_CDP=0` | La capa no se crea: el navegador es el de antes |

En todos los casos la navegación, el historial, las sesiones y la mediación
HTTP/SSE siguen funcionando igual. La capa CDP no participa del envío ni de la
recepción: sólo mira lo que ya pasó.

---

## 7. Límites que siguen abiertos

- **No media WebSocket ni JSON.** Reescribir un frame exigiría interceptar el
  socket en el proceso de red; no se hizo y no se afirma lo contrario.
- **El prompt de un WebSocket** se registra sólo si el frame lo trae de forma
  explícita. En protocolos binarios o comprimidos no se captura nada.
- **Un socket vivo no se cierra solo**: si el sitio no manda señal de cierre y
  nunca cierra el socket, el turno se entrega recién al soltar la pestaña (o al
  navegar). Es el precio de no inventar un temporizador que corte respuestas
  largas legítimas.
- **Sólo hosts con perfil.** Un proveedor nuevo necesita su entrada en
  `src/core/sites.js` (host, rutas, adaptador) antes de que CDP lo mire.
- **El bucle observado no se puede deshacer**: queda como aviso en el libro y en
  el historial, para que la continuación o el próximo turno salgan mejor.

---

## 8. Fallos del proveedor y de la carga

Un sitio que contesta «No se pudo conectar» o una pestaña que queda en blanco no
dejaban rastro: la capa observaba sólo lo que salía bien. Ahora hay cuatro
códigos en el registro de actividad, con el dato mínimo para explicar el
síntoma —URL, código y tipo de recurso— y **sin leer contenido**:

| Código | Origen | Qué dice |
| --- | --- | --- |
| `http-error` | `Network.responseReceived` | 4xx/5xx en un XHR/Fetch de un host con perfil: `meta.status`, `meta.resourceType`, `meta.url` recortada |
| `net-failed` | `Network.loadingFailed` | La petición no llegó: `meta.errorText`, `meta.blockedReason` |
| `load-failed` | `did-fail-load` de la pestaña | La navegación no llegó: `meta.errorCode`, `meta.errorDescription`, `meta.url` |
| `page-error` | capa inyectada (`nexo:event` tipo `error`) | El adaptador o el enganche falló: `meta.stage`, `meta.message` |

Reglas que los gobiernan:

- **La mediación apagada no observa.** `contentAllowed(host)` decide al adjuntar
  y al leer un cuerpo: un sitio que el usuario apagó en Ajustes no recibe
  depurador.
- **`canceled` no es un fallo.** Chromium informa `loadingFailed` con
  `canceled: true` cuando el propio sitio aborta una petición; anotarlo sería
  ruido. El código `-3` de `did-fail-load` («cancelada») se ignora por lo mismo.
- **Deduplicación.** CDP recuerda `kind|status|url` durante 60 s y el registro
  general agrupa por `code|title` durante 30 s: una petición que se reintenta en
  bucle produce una entrada, no cien.
- **Los SSE no se cuentan dos veces.** El stream de chat ya lo media la página;
  acá sólo interesan las respuestas JSON y los fallos.
- **Si la capa inyectada falla, el stream sigue.** El filtro reenvía el evento
  tal cual llegó y avisa una sola vez (`page-error`): un `throw` dentro del
  `TransformStream` cerraría el cuerpo y la página vería la petición rota.

### Vigilante de red (no depende de la mediación)

Mientras CDP necesita el depurador —y por lo tanto un sitio habilitado—, el
vigilante de la sesión escucha siempre: `webRequest.onCompleted` y
`onErrorOccurred` son **notificaciones**, no interceptores, así que no pueden
modificar ni retener una petición y no cambian lo que el sitio ve. Anota los
mismos `http-error` y `net-failed` de la tabla, sólo para hosts con perfil y sólo
para XHR/Fetch, con `meta.path` para distinguir endpoints. `net::ERR_ABORTED` y
los 2xx/3xx se ignoran.

Es el camino que sirve cuando la mediación está apagada: la página carga, el
sitio contesta «No se pudo conectar» y el registro dice exactamente qué endpoint
respondió qué código.

`NEXO_CDP=0` apaga la observación por depurador y `NEXO_NETWATCH=0` el vigilante
de red; ninguno de los dos toca la mediación.

### Huella del cliente

Al arrancar queda una entrada `user-agent` (severidad `info`) con el texto
efectivo: es la forma de comprobar que la compilación que corre ya no lleva las
marcas de Electron.

Chromium en Electron se presenta con `Electron/x` y el nombre de la aplicación
en el `User-Agent`. Los proveedores con protección anti-bot (ChatGPT y Claude
entre ellos) leen esa marca: la portada carga desde caché, pero las llamadas a
la API devuelven 403 o el desafío de la portada no se resuelve y la pestaña queda
en blanco. Al arrancar, `normalizeUserAgent()` quita esos dos tokens de
`app.userAgentFallback` y `configureSession()` fija el mismo texto en
`persist:nexo`, para que las pestañas no se delaten por su cuenta. El resto de la
huella (pistas de cliente, WebGL, idioma) sigue siendo la de Chromium: no se
falsifica nada más.

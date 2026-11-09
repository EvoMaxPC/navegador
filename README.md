# Nexo

**Un navegador basado en Chromium que se sienta entre vos y los chatbots.**

Nexo no es un cliente de IA más: es un navegador real (Electron/Chromium) que carga
ChatGPT, Claude, Gemini o Perplexity tal como son, pero **media la conversación en
los dos sentidos**:

- **Antes de enviar** reescribe tu mensaje: elimina repeticiones, detecta
  instrucciones contradictorias, resuelve referencias sueltas («hazlo», «eso»),
  compacta el historial largo y añade un protocolo anti-bucle.
- **Mientras llega la respuesta** analiza el stream en vivo, detecta cuándo el
  modelo se traba repitiéndose y **corta antes de que el bucle aparezca en
  pantalla**.
- **Después** repara la respuesta (markdown roto, bloques de código sin cerrar,
  tokens internos filtrados) y ofrece continuar exactamente donde se cortó.

Todo el análisis es **local y determinista**: sin modelos auxiliares ni nube. El conteo GPT usa el tokenizador BPE local
`gpt-tokenizer`, incluido en la distribución.

**Corrección de tokens de salida 0.1.15:** soporte de SSE multiplexado y NDJSON
registrados de ChatGPT, recuperación de BPE y actualización automática del contador
al terminar la respuesta, sin esperar el cierre de la conexión HTTP.
[Auditoría, pruebas y validación en vivo pendiente](docs/OUTPUT-TOKENS-AUDITORIA.md).

**Contadores 0.1.18:** turnos cancelados, fallidos y realizados,
con deduplicación y actualización automática. Se retiraron las métricas de bucles
sin quitar la protección contra repeticiones.
[Implementación, archivos y pruebas](docs/CONTADORES-TURNOS.md).

**[Descargar la compilación corregida 0.1.13 para Windows](https://github.com/EvoMaxPC/navegador/actions/runs/42651499665/artifacts/13689642278)**
— artefacto `Nexo-win32-x64` de GitHub Actions (requiere iniciar sesión; retención de 30 días).
Extraé el ZIP interno `Nexo-0.1.13-win32-x64.zip` y ejecutá `nexo.exe`.
Sin firmar: Windows muestra SmartScreen la primera vez. Detalles
en [`docs/EMPAQUETADO.md`](docs/EMPAQUETADO.md).

---

## Estado

- **Navegador (etapa 2, completa):** pestañas, historial, marcadores, descargas,
  restauración de sesión, buscar en página, zoom por sitio, permisos por sitio y
  borrado de datos. Verificado con pruebas automáticas y con un checklist manual
  en [`docs/NAVEGADOR.md`](docs/NAVEGADOR.md).
- **Mediación (etapa 0, completa):** motor saliente, centinela, filtro SSE,
  reparación, antibucles y EVO MEMORY.
- **Aplicación de Windows (compila y arranca):** `npm run dist:win` genera
  `nexo.exe` con icono y metadatos, dentro de un ZIP listo para repartir; el
  ejecutable empaquetado se autodiagnostica con `npm run smoke`. GitHub Actions
  compila en Windows real y deja el ZIP como artefacto. Ver
  [`docs/EMPAQUETADO.md`](docs/EMPAQUETADO.md).
- **Interceptación de red por CDP (etapa 4):** aprobada, todavía no implementada.

- **Rendimiento (medido, no prometido):** las sugerencias de la barra de
  direcciones bajaron de 9,3 ms a 0,25 ms por tecla, el análisis del stream a la
  mitad y el código inyectado en cada página de 47 kB a 25,6 kB. Cómo se mide y
  qué se cambió: [`docs/RENDIMIENTO.md`](docs/RENDIMIENTO.md).

Auditoría completa del código, con lo que se rompía y lo que se corrigió:
[`docs/AUDITORIA.md`](docs/AUDITORIA.md).

## Probarlo en 30 segundos

```bash
git clone <este-repo> && cd navegador
npm install

# 1. Sala de pruebas: el motor real, en tu navegador, contra un modelo simulado
npm run demo            # → http://localhost:3000/demo/

# 2. El navegador
npm start
```

En Windows, `dist\Nexo-win32-x64\nexo.exe` después de `npm run dist:win`.

La sala de pruebas muestra el antes y el después en paralelo: a la izquierda el
texto que generó el modelo (con su bucle infinito), a la derecha lo que Nexo
entregó. El modelo está simulado; la mediación es la de verdad — es el mismo
código que corre dentro del navegador.

```bash
npm test                # 529 pruebas, con dependencias instaladas
npm run bench           # rendimiento medido: tabla antes/después
npm run verify          # pruebas + bundle + checklist manual
npm run dist:win        # aplicación de Windows + ZIP (ver docs/EMPAQUETADO.md)
```

---

## Cómo funciona

```
                       ┌──────────────────────── pestaña de IA ────────────────────────┐
  tu mensaje  ────────►│  cuadro de texto del sitio                                     │
                       │        │                                                       │
                       │        ▼                                                       │
                       │  fetch() ──► [1] MOTOR SALIENTE ──► petición reescrita ───────┼──► modelo
                       │                                                                 │
                       │  DOM ◄── [3] REPARACIÓN ◄── [2] CENTINELA DE STREAM ◄── SSE ───┼◄── modelo
                       └─────────────────────────────────────────────────────────────────┘
                                     ▲                    ▲
                                     │      proceso principal: estado por pestaña,
                                     │      memoria de bucles, libro de intervenciones
                                     └────────── interfaz: pestañas, panel, ajustes
```

### 1. Motor saliente (`src/core/promptEngine.js`)

Seis reglas puras, en orden, antes de que el texto salga:

| Regla | Qué arregla |
|---|---|
| Limpieza | espacios, caracteres invisibles, líneas duplicadas |
| Higiene de pegado | bloques gigantes mal delimitados que el modelo confunde con instrucciones |
| Contradicciones | «sé breve» + «explica en detalle», «en español» + «in English»… |
| Ambigüedad | «hazlo» sin antecedente: añade una línea para que el modelo confirme antes de responder |
| Presupuesto de contexto | pliega turnos viejos en una tarjeta de memoria con decisiones, restricciones y pendientes |
| Protocolo | bloque breve anti-repetición / anti-invención / de aclaración |

El resultado siempre es visible en el panel: ves exactamente qué se envía y por qué.

### 2. Centinela de stream (`src/core/streamSentinel.js`)

El corazón del invento. Tres decisiones hacen que el corte sea limpio en lugar de
una tirita tardía:

**Búfer de retención.** Nunca se pinta el final del texto al instante: se retienen
los últimos ~112 caracteres. Cuando la repetición se detecta, todavía está en el
búfer y se descarta entera. El presupuesto se calcula solo:
`retención ≥ unidad_mínima × repeticiones_mínimas + margen`.

**Sonda barata primero.** Una repetición implica que el final del texto ya apareció
antes. Se comprueba con `indexOf` (una búsqueda de subcadena) y solo si coincide se
ejecuta el análisis completo. El coste por token queda despreciable incluso en
respuestas de 20 000 caracteres.

**Detección por retardo.** El final del texto se compara con lo que había *k*
caracteres atrás. No hace falta esperar a que se complete una segunda copia del
bloque: con 44 caracteres repetidos ya se sabe que el modelo volvió al mismo
estado, y se conoce el punto exacto del corte. El análisis secundario mide el
período mínimo del sufijo con la función Z sobre la cadena invertida.

Se detectan cinco familias de fallo: bloque repetido, frase repetida con otra
puntuación, tartamudeo de una palabra, líneas/listas que se reescriben y
degeneración de vocabulario (diversidad léxica por debajo del umbral).

El corte se alinea a un límite natural (párrafo o frase), porque cortar a mitad de
palabra es peor que cortar un poco antes.

### 3. Filtro SSE (`src/core/streamFilter.js`)

Los chatbots no pintan texto: reciben eventos. Nexo reescribe el evento, no el DOM.
Cuando el centinela corta, los eventos siguientes se siguen enviando **con el texto
vacío**, para que el cliente reciba su cierre y no quede colgado. El texto retenido
se devuelve clonando el último evento de texto, y siempre **antes** de `[DONE]`.

### 4. Reparación (`src/core/responseEngine.js`)

Al cerrar el turno: tokens de plantilla filtrados (`<|im_end|>`, `[INST]`), bloques
de código sin cerrar, negritas desbalanceadas, párrafos finales duplicados, prefijos
«Assistant:», negativas del modelo (con sugerencia para reformular) y detección de
respuesta cortada.

## 5. EVO MEMORY: memoria entre conversaciones

Los cuatro pasos anteriores arreglan **una** conversación. EVO MEMORY arregla lo
que pasa **entre** ellas: cada turno se destila en unidades pequeñas —objetivos,
decisiones, restricciones, pendientes, problemas, datos con ancla—, se guardan en
tu máquina y se recuperan cuando el mensaje que estás escribiendo las necesita.

```
tu mensaje → recuperación (BM25 + TF-IDF + anclas + intención + MMR)
           → compilador por capas con presupuesto de tokens
           → bloque [EVO · memoria del proyecto] → modelo
```

- **Contexto compilado, no historial pegado.** Cada capa tiene un tope y lo que
  sobra se redistribuye; los últimos turnos viajan literales.
- **La memoria no crece sola.** Deduplicación por Jaccard, sucesión cuando dos
  memorias se contradicen y límite duro con protección de lo fijado.
- **Continuidad portable.** El paquete de continuidad se exporta en markdown y se
  pega en cualquier IA; reimportarlo no duplica nada.
- **Medido, no prometido.** El panel *Memoria* muestra tokens usados, presupuesto
  y porcentaje ahorrado frente a pegar el historial completo.

Detalle, fórmulas y límites honestos: [`docs/EVO-MEMORY.md`](docs/EVO-MEMORY.md).

---

## 6. Observación CDP: los canales que el enganche no ve

Hay dos canales que no pasan por `fetch` ni por un stream: los **frames de
WebSocket** y las **respuestas JSON completas**. El depurador de Electron (CDP)
los observa desde el proceso principal, los lee con los mismos adaptadores del
sitio y los entrega al motor: el centinela analiza el texto, el turno entra en el
historial y en EVO MEMORY, `responseEngine` avisa si hubo negativa, y el libro de
intervenciones lo cuenta.

**Observar no es mediar.** Ese texto ya llegó al sitio, así que no se corta ni se
reescribe: un bucle detectado allí se registra como «observado, no se pudo
cortar», con `savedChars: 0`. Los SSE quedan fuera de CDP a propósito: de esos ya
se ocupa la página, y mirarlos también contaría el turno dos veces.

Si el depurador no está disponible, la capa queda inerte y el navegador se
comporta igual que antes. Detalle y límites: [`docs/CDP.md`](docs/CDP.md).

---

## Cómo se engancha a cada sitio

| Capa | Dónde vive | Depende de | ¿Media? |
|---|---|---|---|
| Petición | `fetch` del mundo principal | patrón de URL del sitio | sí |
| Respuesta SSE | `TransformStream` sobre el cuerpo | formato SSE | sí |
| Continuación | adaptador DOM | selectores del cuadro de texto | sí |
| WebSocket | depurador CDP (proceso principal) | frames JSON del sitio | no, sólo observa |
| JSON sin SSE | depurador CDP (proceso principal) | cuerpo JSON del sitio | no, sólo observa |

El enganche de red es la base: sobrevive a los rediseños del sitio. El adaptador DOM
solo se usa para la continuación automática y es lo primero que se rompe cuando un
sitio cambia. Ver [`docs/SITIOS.md`](docs/SITIOS.md) para la tabla de adaptadores y
cómo añadir uno.

---

## Qué hace bien y qué no

**Hace bien**

- Detectar y cortar repeticiones reales con muy pocos falsos positivos.
- No romper la interfaz del sitio: los eventos de control viajan intactos.
- Funcionar sin conexión y sin servicios externos.
- Mantener el contexto útil cuando la ventana se llena.
- Recordar lo que ya decidiste, la próxima vez que abras un chat —en cualquier
  modelo—, sin arrastrar la conversación entera.

**No hace (todavía)**

- No regenera la respuesta por vos: propone la continuación y, si lo habilitás, la
  envía escribiendo en el cuadro de texto (frágil ante rediseños).
- No corrige hechos ni inventos: detecta negativas y baja diversidad, no verifica
  información.
- Los adaptadores por sitio son heurísticos. Si un sitio cambia su esquema de
  petición, el motor deja pasar el mensaje sin tocar (nunca rompe la petición).
- No está probado contra todos los sitios: `docs/SITIOS.md` marca el estado de cada
  uno.
- Lo que llega por WebSocket o como JSON completo **no se puede corregir**: CDP lo
  observa y lo registra, pero cuando lo ve ya está en pantalla. Ver
  [`docs/CDP.md`](docs/CDP.md).
- La memoria no agranda el modelo ni esquiva los límites del proveedor: aprovecha
  mejor el presupuesto que ya tenés. La recuperación semántica es TF-IDF más 21
  grupos conceptuales curados, no un modelo denso: un sinónimo fuera de esos
  grupos no se puentea. Ver [`docs/EVO-MEMORY.md`](docs/EVO-MEMORY.md).

---

## Estructura

```
src/nav/         historial, marcadores, descargas, sesión, permisos, zoom, atajos
src/memory/      EVO MEMORY: destilado, índice, recuperación, contexto, paquete
src/core/        motor isomorfo, sin dependencias (Node y navegador)
  analysis.js      periodicidad, tartamudeo, truncamiento
  streamSentinel.js búfer + sonda + corte
  streamFilter.js  reescritura de SSE
  cdp.js           lectura de frames WebSocket y cuerpos JSON (observación)
  promptEngine.js  intervención saliente
  responseEngine.js reparación entrante
  compaction.js    tarjeta de memoria
  guard.js         orquestador por conversación
src/inject/      capa inyectada en el mundo principal de la página
src/preload/     puentes (pestañas y shell)
src/main/        proceso principal: ventana, pestañas, ajustes, motor y capa CDP
src/ui/shell/    interfaz del navegador
src/ui/start/    página de pestaña nueva
demo/            sala de pruebas (mismo motor, modelo simulado)
scripts/         verificación, icono, empaquetado para Windows y prueba de humo
test/            529 pruebas con node:test (incluye un Electron falso para el arranque)
docs/            arquitectura, navegador, adaptadores, privacidad, memoria, empaquetado y auditoría
.github/         flujo que compila la aplicación de Windows
```

## Privacidad

Nada sale de tu máquina. El perfil se guarda en el directorio de usuario de la
aplicación y podés borrarlo desde *Ajustes → Restablecer*. Ver
[`docs/PRIVACIDAD.md`](docs/PRIVACIDAD.md).

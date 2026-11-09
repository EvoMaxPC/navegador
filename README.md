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

Todo el análisis es **local y determinista**: sin modelos auxiliares, sin nube, sin
dependencias en tiempo de ejecución.

---

## Probarlo en 30 segundos

```bash
git clone <este-repo> && cd navegador
npm install

# 1. Sala de pruebas: el motor real, en tu navegador, contra un modelo simulado
npm run demo            # → http://localhost:3000/demo/

# 2. El navegador
npm start
```

La sala de pruebas muestra el antes y el después en paralelo: a la izquierda el
texto que generó el modelo (con su bucle infinito), a la derecha lo que Nexo
entregó. El modelo está simulado; la mediación es la de verdad — es el mismo
código que corre dentro del navegador.

```bash
npm test                # 89 pruebas, sin dependencias
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

---

## Cómo se engancha a cada sitio

| Capa | Dónde vive | Depende de |
|---|---|---|
| Petición | `fetch` del mundo principal | patrón de URL del sitio |
| Respuesta | `TransformStream` sobre el cuerpo | formato SSE |
| Continuación | adaptador DOM | selectores del cuadro de texto |

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

**No hace (todavía)**

- No regenera la respuesta por vos: propone la continuación y, si lo habilitás, la
  envía escribiendo en el cuadro de texto (frágil ante rediseños).
- No corrige hechos ni inventos: detecta negativas y baja diversidad, no verifica
  información.
- Los adaptadores por sitio son heurísticos. Si un sitio cambia su esquema de
  petición, el motor deja pasar el mensaje sin tocar (nunca rompe la petición).
- No está probado contra todos los sitios: `docs/SITIOS.md` marca el estado de cada
  uno.

---

## Estructura

```
src/core/        motor isomorfo, sin dependencias (Node y navegador)
  analysis.js      periodicidad, tartamudeo, truncamiento
  streamSentinel.js búfer + sonda + corte
  streamFilter.js  reescritura de SSE
  promptEngine.js  intervención saliente
  responseEngine.js reparación entrante
  compaction.js    tarjeta de memoria
  guard.js         orquestador por conversación
src/inject/      capa inyectada en el mundo principal de la página
src/preload/     puentes (pestañas y shell)
src/main/        proceso principal: ventana, pestañas, ajustes, motor
src/ui/shell/    interfaz del navegador
demo/            sala de pruebas (mismo motor, modelo simulado)
test/            89 pruebas con node:test
docs/            arquitectura, adaptadores y privacidad
```

## Privacidad

Nada sale de tu máquina. El perfil se guarda en el directorio de usuario de la
aplicación y podés borrarlo desde *Ajustes → Restablecer*. Ver
[`docs/PRIVACIDAD.md`](docs/PRIVACIDAD.md).

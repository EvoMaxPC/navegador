# NEXO Comprensión — desarrollo en siete etapas

## Acuerdo de alcance

Los 72 requisitos describen un objetivo amplio, no capacidades ya demostradas.
Se avanza por etapas sobre el UUE existente, sin reconstruir NEXO ni introducir
un agente ejecutor. La entrega actual incorpora **las siete etapas**, sobre
0.1.33, con alcance local acotado. El desarrollo por etapas se cierra; no se
proclaman los 72 requisitos satisfechos sin límites ni los gates manuales aprobados.
[Cierre y revisión transversal](NEXO-COMPRENSION-REVISION-FINAL.md).

No hay modelo semántico nuevo, envíos externos, nuevos permisos ni dependencia
nueva. Las reglas actuales siguen siendo locales y conservadoras. Comprender no
significa ejecutar, aprobar una propuesta ni verificar que ChatGPT hizo algo.

## Siete bloques y trazabilidad completa

Cada número aparece una vez como responsabilidad principal; hay dependencias
entre bloques. Las funciones previas de UUE se reutilizan.

| Etapa | Responsabilidad | Requisitos | Estado de esta entrega |
|---|---|---|---|
| 1 | Observación incremental, roles y actualización automática | 1–6, 49, 54, 58, 68 | Base implementada; límites semánticos debajo |
| 2 | Objetivo principal, múltiples objetivos, cambios y ciclo de vida | 7–12 | Implementada con gramática acotada y revisión explícita; detalle debajo |
| 3 | Reglas, restricciones, preferencias, decisiones y vigencia | 13–18, 37–41, 43–44, 50–51, 53, 67, 72 | Ampliada con gramática acotada, revisión de conflictos y edición de vigencia; detalle debajo |
| 4 | Tareas, subtareas, dependencias, prioridades y siguiente paso | 19–24, 34, 36 | Base estructurada implementada; gramática acotada, sin plan ni ejecución automáticos |
| 5 | Proyectos, referencias, selección de contexto y antecedentes | 25–30, 47, 55–57, 59, 71 | Base local ampliada: etiquetas, referencias e inspección/selección explícitas; límites debajo |
| 6 | Progreso, errores, bloqueos, propuestas y evidencia de resultados | 31–33, 35, 45–46, 69–70 | Base explícita de registros, propuestas y evidencia aportada; sin verificación factual |
| 7 | Inspector completo, explicación, corrección e inferencias confirmables | 42, 48, 52, 60–66 | Inspector paginado y revisión explícita con historia; explicación determinista, no semántica universal |

Cada etapa deberá cerrar con casos positivos/negativos, conservación de reglas,
independencia de EVO, pruebas de regresión y límites explícitos. No usar el número
de campos o tests como medida de comprensión semántica ni de utilidad real.

## Etapa 1 implementada — entrega anterior

### Qué cambió

1. **Planificador observacional puro** en `src/core/conversationObservation.js`.
   Recibe los roles/IDs del lector existente. Selecciona usuarios nuevos en orden,
   compara identidades/versiones y conserva una ventana observacional limitada.
   No clasifica órdenes del asistente ni determina qué tareas se ejecutaron.
2. **Servicio UUE existente**, no otro motor: `observeConversation` procesa todos
   los usuarios nuevos seleccionados, no sólo el último de cada snapshot. El
   primer snapshot de un contexto realmente vacío inicializa los usuarios visibles
   en orden; un contexto previo sin metadatos nuevos sólo considera el último
   usuario, para no reactivar reglas históricas retiradas durante una actualización.
3. **Respuestas de ChatGPT observadas** con rol explícito, estado DOM y extracto.
   Se muestran como datos no verificados. No entran en objetivos, instrucciones,
   restricciones, decisiones ni avances del usuario.
4. **Actualización automática del panel**, agrupada a 250 ms y diferida mientras
   hay una lectura/edición en curso. El código conserva borradores por contexto,
   selección/foco de textarea y scroll al renovar la vista. Esos detalles visuales
   siguen pendientes de prueba en Electron real.
5. **Protección de datos existentes**: las mutaciones de reglas preservan el nuevo
   registro observacional. Borrar el contexto elimina también su ventana y mantiene
   la exclusión de reingestión. Fallo de disco informa error y permite reintentar;
   no marca como confirmado un registro observacional que no pudo guardar.

### Registro y límites deliberados

No se copia una segunda transcripción completa ni se reemplaza EVO MEMORY.
Se guarda, junto al contexto UUE existente, un campo opcional `conversation`,
versionado independientemente con `version: 1`:

```text
revision, cursor, ledger[], messages[], warnings[]
messages: id, role, digest, chars, preview, preview_clipped,
          status, certainty, authority, observed_at
```

- Máximo 24 mensajes recientes. Usuarios: sólo metadatos, no copia del texto en
  `preview`; el texto original se entrega al UUE actual para su clasificación.
- Asistente: extracto de hasta 4.000 caracteres, recorte declarado y autoridad
  `conversation-data-only`, certeza `observed-not-verified`.
- `complete` significa texto estable observado en el DOM, **no tarea completada**.
  `streaming` se presenta desde RAM; no se persiste cada fragmento del asistente.
  La respuesta estable sí se guarda, con su recorte si corresponde.
- Hasta 256 identidades de usuario en el cursor observacional. La deduplicación
  normativa anterior conserva su propio registro de hashes de hasta 2.048 entradas.
- Hasta 50 ventanas vivas en RAM; los límites de archivo/contextos UUE anteriores
  siguen vigentes. La rotación de esta ventana no elimina reglas activas.
- El nuevo campo es aditivo: archivos 0.1.33 sin `conversation` siguen cargando.
  No se cambia `schema_version` de la representación normativa. El campo nuevo
  se valida al leer/escribir; datos observacionales corruptos bloquean escritura
  en lugar de convertirse en instrucciones o sobrescribirse silenciosamente.
- Si se pierde el ancla de continuidad en una ventana parcial se informa. Sólo
  puede considerarse el último usuario desconocido; no se reconstruye el segmento
  ausente ni se presume que todo el historial pertenece a la tarea actual.
- Las señales de recorte o terminación como `...` son avisos heurísticos. No
  completan datos ni convierten una frase incompleta en intención confirmada.

El lector, los dos canales existentes, la cola de 500 ms y las validaciones de
main no se sustituyen. Main únicamente pasa el indicador `streaming` al consumidor
UUE para distinguir la observación parcial de la estable. No se modifican CDP,
contadores, tokenizador, guard, clasificadores UUE, EVO ni su archivo.

### Qué no cubre todavía esta etapa

- Interpretar semánticamente todas las propuestas, respuestas incompletas,
  malentendidos o pendientes implícitos del asistente.
- Resolver referencias libres usando todo el historial, ni declarar que se
  comprende una conversación completa por conservar una ventana de observación.
- Nuevos objetivos múltiples, descomposición general, dependencias, próximo paso
  acordado, validación factual de resultados o aceptación automática de propuestas.
- Recuperar un mensaje que el lector no vio, que fue eliminado o quedó fuera de
  su ventana. No se leen roles nuevos del DOM ni elementos auxiliares de interfaz.

Por tanto, 1–4, 49, 54, 58 y 68 tienen implementación observacional comprobada con
los límites anteriores; 5 y 6 sólo tienen base parcial (recorte/señales y orden
contextual). **No se declaran los 72 requisitos completados.**

## Validación ejecutada de la etapa 1

| Ejecución | Total | Aprobadas | Fallidas | Omitidas |
|---|---:|---:|---:|---:|
| Focalizadas: observación + UUE + independencia + contrato shell | 62 | 62 | 0 | 0 |
| `npm test` | 802 | 801 | 0 | 1 |

La suite completa duró 102.759,29857 ms. La omitida es el empaquetado Windows real
que requiere `NEXO_ELECTRON_ZIP_DIR`. `npm run build:inject` fue correcto:
53,7 kB / 19,3 kB gzip, 11 módulos. No hubo ejecución de instalador real.

Se añadieron 14 pruebas en `test/understanding-observation.test.js`:
- usuarios en orden y asistente sin autoridad normativa;
- varios mensajes nuevos entre snapshots, deduplicación y reinicio;
- stream en RAM y respuesta estable persistida, sin progreso inventado;
- límites de ventana/extracto y no duplicación del texto de usuario;
- recorte y posterior versión completa; señal heurística de mensaje incompleto;
- historial hacia atrás y compatibilidad con archivos previos;
- pérdida de ancla advertida; exclusión tras borrado;
- preservación del registro al editar reglas y aislamiento entre contextos;
- corrupción de datos y fallo de disco con reintento;
- agrupación del refresco, edición ocupada, eventos durante lectura y panel inactivo.

Las pruebas de servicio usan archivos reales. Las integraciones con main/lector
usan Electron stub y DOM de fixture. El planificador de refresco se prueba con
reloj controlado: **no es una prueba de renderizado visual del panel**.

No se ejecutó Electron real, cuenta ChatGPT real ni inspección de accesibilidad,
foco/cursor o scroll reales. Tampoco se midió rendimiento ni reducción de errores
con usuarios. Antes de ampliar el siguiente bloque conviene verificar manualmente:
EVO apagada → varios mensajes → respuestas en generación/estables → panel abierto
que se renueva → borrador en edición → cambio de conversación → reinicio → borrado.

## Archivos de la etapa 1

Nuevos:
- `src/core/conversationObservation.js`
- `src/ui/shell/understandingRefresh.js`
- `test/understanding-observation.test.js`
- `docs/NEXO-COMPRENSION-ETAPAS.md`

Modificados:
- `src/main/userUnderstanding.js`: integración y registro opcional por contexto.
- `src/main/main.js`: paso del indicador de generación desde los consumidores.
- `src/ui/shell/understandingPanel.js`: observaciones y actualización automática.
- `scripts/packaging-config.mjs`: assets nuevos requeridos por el paquete.
- `README.md`, `docs/NEXO-CAPA1-0.1.33.md`, `docs/NEXO-CAPA1-VALIDACION.md`:
  enlaces y registro del alcance posterior, sin invalidar evidencia histórica.

La entrega de etapa 1 se publicó como `64b8432`. Su alcance y resultados anteriores
se conservan como evidencia histórica; el bloque siguiente amplía únicamente los
objetivos, no la ejecución autónoma.


## Etapa 2 implementada — objetivos y ciclo de vida

### Alcance de los requisitos 7–12

- **Principal explícito, libre y literal:** permanece el editor de hasta 200.000
  caracteres y las declaraciones reconocidas ES/EN. Una tarea, aclaración,
  preferencia o pregunta secundaria no reemplaza ese objetivo. Una declaración
  distinta sin señal inequívoca abre una propuesta de cambio; un «sí» genérico no
  la acepta. El editor y «Cambio de objetivo: …» son cambios explícitos.
- **Historia y cambios legítimos:** se conservan el objetivo anterior, su origen,
  estado y fechas; el registro de eventos añade los cierres, reaperturas,
  incorporación de independientes y confirmación/rechazo de inferencias.
- **Varios objetivos separados:** catálogo de objetivos independientes. No cambian
  el principal, no heredan sus instrucciones y no activan otro proyecto ni
  ejecutan un plan. No se pretende haber implementado ámbitos de reglas por
  objetivo: las reglas existentes siguen perteneciendo a la conversación/contexto.
  Para trabajar realmente en otro proyecto hay que usar otro contexto/conversación;
  selección y continuidad ampliadas corresponden al bloque de proyectos.
- **Implícitos revisables:** ciertos deseos de crear/construir/desarrollar, etc.,
  sin principal activo, se guardan como candidatos inferidos, no como objetivos.
  El panel permite rechazarlos o confirmar uno como principal/independiente.
  La inferencia original conserva su certeza; el objetivo resultante registra la
  confirmación. No se puede sustituir un principal activo desde un candidato.
- **Ciclo de vida:** estados activos, completados y cancelados separados. Cerrar
  el principal retira su proyección activa y la tarea asociada; las restricciones
  y demás reglas se conservan. Reabrir exige declaración/control explícito y
  conserva identidad. Una continuación genérica no reactiva un objetivo cerrado.
- **Declaración no es prueba:** completar guarda `kind: user-declaration`,
  `verified: false`, origen y fecha. No añade progreso probado, no analiza archivos
  ni valida resultados. El asistente observado nunca cierra objetivos ni confirma
  interpretaciones. `complete` del DOM continúa significando sólo texto estable.

### Uso desde conversación y panel

Ejemplos de la gramática conservadora (no son instrucciones de ejecución):

```text
Mi objetivo: mejorar la accesibilidad de NEXO
Cambio de objetivo: documentar su arquitectura
Objetivo independiente: preparar una aplicación educativa
Objetivos independientes:
- Diseñar un editor
- Documentar una API
Objetivo principal completado
Cancelo el objetivo principal
Retomar el objetivo principal
Objetivo «Documentar una API» completado
Retomar objetivo «Documentar una API»
Quiero construir una aplicación educativa
```

El último ejemplo crea una interpretación pendiente sólo si no hay principal
activo; no confirma un objetivo. Una lista exige de uno a diez renglones con guion
(o asterisco). Un formato dudoso pide aclaración en vez de unir varios objetivos.
Las referencias entre comillas se resuelven por texto normalizado exacto; si son
ambiguas o desconocidas no se elige un objetivo por intuición.

En **Comprensión**: editor del principal → declarar completado/cancelar/reabrir;
sección de independientes → conservar uno separado y controlar su estado;
interpretaciones → confirmar concretamente o rechazar; historial → revisar eventos.
Las tarjetas muestran literal, certeza, estado, procedencia y fecha. El estado
cancelado no equivale a completado y ambos muestran su naturaleza declarativa.

### Persistencia, seguridad y límites

Se amplía el estado UUE `schema_version: 1` con tres arrays **opcionales al leer**:
`independent_goals`, `goal_candidates` y `goal_events`. Los archivos anteriores
sin esos campos siguen cargando; se inicializan cuando se necesitan. No hay otro
archivo/transcripción ni cambio en EVO. Las estructuras nuevas, cierres,
confirmaciones, estados, origen y eventos se validan al leer/escribir; corrupción
bloquea escritura sin sobrescribir el archivo.

Límites por contexto: 20 independientes (incluidos cerrados/sustituidos), 30
candidatos (incluidos resueltos), 200 eventos y 50 objetivos principales históricos.
Se conservan los límites previos de texto/contexto/archivo. Al llenarse un catálogo
se rechaza la transacción con error visible: no se podan silenciosamente objetivos
activos, candidatos ni historia para admitir otro cambio. Tampoco se guarda media
lista si rebasa un límite. Un fallo de escritura no confirma el cierre en RAM;
puede reintentarse con la misma revisión.

Las tres operaciones nuevas (`goal-independent`, `goal-transition`,
`goal-candidate`) pasan por el mismo IPC de edición, revisión optimista y
validaciones shell/mainFrame/guest. No se exponen APIs privilegiadas al sitio.
No se cambian el lector, los canales, la cola de 500 ms, el ACK, los prompts,
Engine, guard, CDP, tokenización, contadores ni la dependencia opcional de EVO.

### Validación ejecutada

| Ejecución | Total | Aprobadas | Fallidas | Omitidas |
|---|---:|---:|---:|---:|
| Focalizadas: UUE, observación, IPC, independencia, shell, objetivos y panel | 90 | 90 | 0 | 0 |
| `npm test` | 830 | 829 | 0 | 1 |

La suite completa duró 104.306,10077 ms. La omitida sigue siendo el empaquetado
Windows real que requiere `NEXO_ELECTRON_ZIP_DIR`. Build de inyección correcto:
53,7 kB / 19,3 kB gzip, 11 módulos. La versión se conserva en 0.1.33.

Se añaden **28 pruebas**:
- 25 en `test/understanding-goals.test.js`: literal extenso, cambios, historia,
  independientes, cierres/reapertura, referencias ambiguas, negaciones/citas,
  inferencias, confirmación y rechazo, límites atómicos, compatibilidad,
  corrupción, reinicio, aislamiento, borrado y fallo de persistencia/reintento.
- 2 en `test/user-understanding-main.test.js`: operaciones nuevas en el flujo IPC
  real con Electron stub, rechazo de página/subframe y asistente sin autoridad
  para cerrar objetivos.
- 1 en `test/understanding-goals-panel.test.js`: controles de UI conectados al core
  mediante el puente de fixture; confirmación, guardado, cierre/cancelación,
  reapertura, borrador conservado y cambio de pestaña sin edición accidental.

**Límites de la evidencia:** DOM de fixture y Electron stub no equivalen a una
sesión real. No se ejecutaron Electron/Windows ni una cuenta ChatGPT real, ni se
validaron visualmente foco, scroll, estilos o accesibilidad. No hay mediciones de
calidad semántica o rendimiento. La gramática ES/EN no comprende todos los deseos,
negaciones, citas o referencias posibles; ante lenguaje no reconocido hay que
corregir/editar en el panel. No hay descomposición automática general ni selección
semántica entre proyectos ni evidencia externa de finalización.

Gate manual pendiente: EVO apagada → objetivo extenso → tarea y pregunta secundaria
→ objetivo independiente → declaración de cierre → reapertura → deseo inferido
sin principal activo y revisión de candidato → cambio de conversación → reinicio
→ borrar contexto y comprobar exclusión. Revisar también texto literal escapado,
foco/borrador, scroll y controles dentro del tema BLACK & ELECTRIC BLUE existente.

### Archivos de la etapa 2

Nuevos: `src/core/userGoals.js`, `test/understanding-goals.test.js` y
`test/understanding-goals-panel.test.js`.
Modificados: core y servicio UUE, panel Comprensión, manifest de empaquetado,
tests IPC y documentación. No se añade dependencia de producción ni de pruebas.
La entrega de etapa 2 se publicó como `2ab790e`. Su siguiente bloque, reglas,
restricciones, preferencias, decisiones y vigencia, se desarrolla debajo.
No se declaran completados los 72 requisitos.


## Etapa 3 implementada — reglas, preferencias, decisiones y vigencia

### Qué amplía este bloque

Se reutilizan las categorías y prioridades UUE existentes: restricciones
obligatorias → instrucciones → decisiones declaradas → preferencias orientativas.
El objetivo explícito y las políticas de sistema conservan su precedencia. Se
mantienen separados los subobjetivos, contexto y avances; no hay ejecutor ni
modificación de prompts a partir de estas reglas.

- **Categoría y prioridad visibles:** las reglas nuevas guardan `category`, además
  de texto, estado, origen de usuario, certeza, alcance y fechas. El panel muestra
  esta información, sin presentar una preferencia como obligación ni una decisión
  como ejecución comprobada.
- **Comparación conservadora:** además de acciones/objetivos textuales comparables
  de la base UUE, se reconocen algunas dimensiones de idioma, longitud y formato
  de respuesta. Un conflicto entre reglas no se resuelve por intuición. Una nueva
  indicación dudosa abre la propuesta concreta y conserva las anteriores. Una
  actualización inequívoca del mismo nivel y vigencia puede sustituirla con
  historia; no salta una regla superior ni sustituye automáticamente una regla
  duradera por otra temporal.
- **Preferencias orientativas:** sólo compiten con preferencias; no retiran
  restricciones, instrucciones ni decisiones. Los cruces reconocidos con reglas
  superiores producen avisos calculados, sin activar una excepción. El índice por
  dimensión se calcula localmente; se muestran hasta 100 cruces con aviso de
  recorte, sin podar reglas. No se compara semánticamente todo el lenguaje.
- **Corrección transaccional:** `rule-update` permite editar texto, categoría y/o
  vigencia de una regla activa por ID y revisión. Corrige un borde anterior: una
  corrección incompatible con otra regla **ya no retira primero la original**.
  Ambas permanecen hasta confirmar la sustitución concreta; rechazar la propuesta
  no las modifica. Al confirmar se revalidan las referencias y los conflictos
  actuales; una propuesta obsoleta no puede retirar reglas nuevas por accidente.
- **Retiro e historia:** se puede retirar una regla por control del panel o texto
  exacto inequívoco. La historia conserva categoría anterior, literal y origen
  originales, más tipo, actor y fecha del cambio. Continuar una conversación no
  reactiva reglas retiradas. No se borra historia para hacer espacio.
- **Propuestas ≠ decisiones:** las sugerencias reconocidas del usuario quedan en
  una lista pendiente, con origen y certeza inferida respecto de una decisión.
  Confirmar/rechazar exige seleccionar esa propuesta concreta; «sí»/«dale» no
  confirman la lista. Una declaración explícita de decisión que coincide con una
  propuesta pendiente la vincula a la decisión resultante. Si la confirmación
  entra en conflicto con una obligación, primero se exige revisar ese conflicto;
  no se activa la decisión ni se pierde la propuesta original. El estado resuelto
  conserva `verified: false`. Confirmar jamás autoriza una herramienta.
- **Asistente sin autoridad:** sus sugerencias y afirmaciones siguen siendo sólo
  datos de la ventana observacional. No crean reglas, propuestas normativas del
  usuario, decisiones ni pruebas de progreso. También se filtran bloques de código,
  citas, ejemplos y secciones reconocidas «El asistente dijo: …» en mensajes propios.

### Vigencia y ejemplos de uso

Se mantienen dos alcances compatibles con la persistencia existente:

- `project`: **este contexto UUE**, hasta actualización/retiro explícitos; no es
  una regla global para todas las conversaciones ni un ámbito por objetivo.
- `session`: esta sesión de NEXO, expira al reiniciar. Las reglas se archivan como
  obsoletas con `change.kind: session-expired`. Si la historia ya está llena,
  permanecen obsoletas en su categoría y fuera de la proyección activa; no se
  descartan para permitir arrancar. Las propuestas temporales pendientes y sus
  conflictos también caducan. Las duraderas se conservan con EVO apagada.

Ejemplos reconocidos desde la conversación:

```text
Restricción: No borres información
Instrucción: Usa español
Prefiero respuestas cortas
Decisión confirmada: Mantener Electron
Propuesta: Documentar una API local
Solo por esta sesión: No ejecutes código
Preferencia temporal: respuestas cortas
Instrucción permanente: Usa español
De ahora en más prefiero respuestas detalladas
Reemplaza «Usa español» por «Usa inglés»
Retira la restricción «No borres información»
```

La etiqueta o envoltura de alcance se interpreta; se conserva el valor de la regla
sin resumirlo. El origen apunta al mensaje observado. El editor conserva textos
libres/extensos aunque no estén en la gramática. En el panel cada regla vigente
incluye **Editar texto, categoría o vigencia**, y las propuestas tienen controles
separados para confirmar o rechazar.

«Sólo esta vez», condiciones y ciertos alcances no modelados —por ejemplo «hasta
terminar la tarea»— piden aclaración. No se reinterpretan como permanentes ni como
toda la sesión. No hay todavía alcance automático por turno, fecha o finalización
de tarea. Cambiar explícitamente una regla duradera a temporal la sustituye; al
expirar **no se restaura automáticamente una versión histórica**. Las excepciones
con restauración, si se amplían, necesitan otro modelo explícito, no heurísticas.

### Compatibilidad y protección de datos

`decision_candidates` es opcional en archivos antiguos, con máximo de 30 registros
por contexto, incluidos aceptados/rechazados/obsoletos. Las categorías anteriores
siguen limitadas a 200 entradas y la historia a 400. Al llenarse, se rechaza la
transacción; no hay poda silenciosa ni corrección parcial. `category` y `change`
son metadatos aditivos validados; no se cambia `schema_version: 1` ni los archivos
EVO. Corrupción bloquea escritura sin sobrescribir. Fallos de disco no confirman
ediciones/decisiones en RAM y permiten reintentar.

`rule-update` y `decision-candidate` pasan por el IPC de edición existente, con
revisión optimista, shell confiable, mainFrame y propiedad del guest. No hay API
privilegiada nueva en la página ni lectura adicional. Se conservan lector, cola de
500 ms, ACK, CDP, guard, preparación/envío, tokenización y contadores anteriores.
Se mantiene la versión 0.1.33 y no se añade dependencia de producción ni pruebas.

### Validación ejecutada y límites

| Ejecución | Total | Aprobadas | Fallidas | Omitidas |
|---|---:|---:|---:|---:|
| Focalizadas: UUE, observación, IPC, independencia, shell, objetivos, reglas y paneles | 118 | 118 | 0 | 0 |
| `npm test` | 859 | 858 | 0 | 1 |

La suite completa duró 101.544,728808 ms. La omitida sigue siendo el empaquetado
Windows real con `NEXO_ELECTRON_ZIP_DIR`. Build de inyección correcto:
53,7 kB / 19,3 kB gzip, 11 módulos.

Se añaden **28 pruebas de comportamiento**: 25 en
`test/understanding-rules.test.js`, una de callbacks del panel en
`test/understanding-rules-panel.test.js` y dos de flujo IPC/main en
`test/user-understanding-main.test.js`. Cubren categorías, prioridad, preferencias,
conflictos, correcciones sin pérdida, propuestas obsoletas, retiro, alcances,
condiciones/citas, reinicio, EVO apagada, aislamiento, compatibilidad, corrupción,
límites y fallos de disco con reintento. Se extrae el DOM mínimo de fixture a
`test/harness/dom-fixture.mjs` para reutilizarlo con los objetivos sin duplicarlo;
el runner completo cuenta además ese archivo de infraestructura, sin aserciones
propias, como una entrada aprobada.

No se ejecutaron Electron real, Windows real ni una cuenta ChatGPT real. DOM de
fixture y Electron stub verifican callbacks y contratos, **no la apariencia,
foco/scroll, accesibilidad ni interacción real de la shell**. Tampoco hay mediciones
de rendimiento o calidad semántica. Las claves de conflicto son acotadas: ausencia
de aviso no prueba compatibilidad, ni esta implementación satisface cualquier
redacción de los requisitos. La comprensión sigue siendo local ES/EN, sin LLM.

Gate manual pendiente: EVO apagada → objetivo → restricción e instrucción →
preferencia incompatible → edición que entra en conflicto → rechazar/confirmar
cambio concreto → sugerencia y confirmación → regla/propuesta temporal → reinicio
→ revisión de historia → cambio de conversación y borrado. Revisar borradores,
selección de categoría/vigencia, literal escapado y tema BLACK & ELECTRIC BLUE.

### Archivos y siguiente bloque

Nuevos: `src/core/userRules.js`, `test/understanding-rules.test.js`,
`test/understanding-rules-panel.test.js` y `test/harness/dom-fixture.mjs`.
Modificados: core/servicio UUE, panel, manifest de empaquetado, tests main y de
objetivos del panel, README y documentación. La etapa 3 se publicó como `7965b17`.
Su siguiente bloque se desarrolla debajo. Los gates manuales siguen pendientes;
**no se declaran completados los 72 requisitos**.


## Etapa 4 implementada — tareas, relaciones y siguiente paso

### Alcance del bloque

Los requisitos 19–24, 34 y 36 tienen ahora una base explícita de seguimiento dentro
del **mismo UUE**, no un segundo expediente, motor ejecutor o transcripción. Las
solicitudes normales siguen actualizando la última tarea inferida de la base
(`current_task`); no se convierten automáticamente en una lista de trabajo.
El panel distingue esa última solicitud interpretada del seguimiento explícito.

- **Tareas pendientes y foco:** las declaraciones reconocidas y los controles del
  panel añaden tareas con texto literal, origen, certeza, fechas y estado pendiente.
  «Tarea actual: …» selecciona además un foco explícito. Una nueva tarea no borra
  las anteriores ni sustituye el objetivo, las reglas o los subobjetivos.
- **Subtareas:** relación por ID o referencia textual única al padre; no se inventa
  una descomposición. No son los subobjetivos del UUE. Completar una hija no
  completa a su padre; para declarar completado al padre deben estar satisfechas
  todas sus subtareas. Una subtarea cancelada no cuenta como completada.
- **Dependencias:** enlaces explícitos, con referencias existentes, sin duplicados
  ni ciclos. Se validan conjuntamente con la jerarquía: una hija que depende de su
  padre crea un ciclo porque completar al padre requiere a la hija. Un requisito
  pendiente/cancelado/bloqueado impide declarar iniciada o completada su dependiente.
- **Prioridad y orden separados:** alta, normal, baja o sin prioridad acordada.
  `task_priority` no altera la jerarquía de instrucciones y restricciones (`priority`).
  Se puede subir/bajar en la lista con una permutación completa validada; no se
  deduce de ello una secuencia de ejecución ni un plan aprobado.
- **Resultado esperado:** campo opcional, libre y editable, separado de los avances.
  Un resultado esperado no es evidencia de que se haya obtenido.
- **Estados declarados:** pendiente, en curso, bloqueada, completada y cancelada.
  Bloquear exige motivo. Cambiar ese motivo se registra; retirar el bloqueo o
  reabrir una tarea exige acción explícita, sin reanudarla automáticamente.
  Los cambios de estado guardan `kind: user-declaration`, `verified: false`, origen
  y fecha. Nunca añaden progreso probado ni seleccionan una herramienta.
- **Próximo paso acordado:** puntero elegido por el usuario a una tarea abierta,
  incluso si está bloqueada, con origen y fecha. Se informa si hay impedimentos.
  Al completar/cancelar ese paso se conserva el acuerdo con su estado: no se elige
  automáticamente otro, ni se inventa un «siguiente paso» al decir «continuá».
- **Historia transaccional:** creación, edición, relaciones, prioridad, estado,
  foco, próximo paso y orden quedan registrados. Editar conserva ID y origen
  iniciales, y añade actor/fecha/valores anteriores y nuevos en el evento.

### Elegibilidad estructural, no autorización ni evidencia

`task_tracking` proyecta las tareas, el foco, el próximo paso y los impedimentos
estructurales declarados. Se comprueban dependencias completadas y sus requisitos
transitivos; reabrir un requisito puede impedir pasos posteriores sin reescribir
los estados pasados que declaró el usuario. Los cierres pasados se conservan como
historia, **no se convierten en hechos verificados**. El panel avisa cuando un padre
con cierre declarado tiene subtareas que ya no están satisfechas.

Una tarea puede vincularse explícitamente a un objetivo activo. No se inventa esa
relación a partir de una petición genérica. Cerrar/sustituir el objetivo conserva
las tareas y sus vínculos, pero bloquea la elegibilidad para iniciarlas/completarlas.
El mismo control se aplica a los objetivos de sus ancestros y a padres cerrados o
bloqueados. No se permite mezclar objetivos incompatibles entre hija y ancestros.
Las dependencias son las declaradas: no se infieren requisitos adicionales de un
texto, una prioridad, el orden de lista o el progreso observado del asistente.

«Sin impedimentos estructurales declarados» **no significa** permiso de ejecución:
no evalúa la verdad de un resultado ni garantiza que se cumplieron restricciones,
permisos o condiciones del mundo real. El asistente observado no crea ni completa
estas tareas, no bloquea trabajo por su cuenta ni acuerda el próximo paso del usuario.

### Uso desde conversación y panel

Gramática conservadora ES/EN: una directiva completa por mensaje, o una lista de
uno a diez renglones con guion/asterisco. Ejemplos:

```text
Tarea: Revisar el lector
Tarea actual: Auditar IPC
Tareas:
- Revisar permisos
- Documentar cambios
Subtarea de «Auditar IPC»: Revisar validación de frames
La tarea «Documentar cambios» depende de «Revisar permisos»
Prioridad de tarea «Auditar IPC»: alta
Resultado esperado de tarea «Auditar IPC»: Informe de canales y permisos
Tarea «Revisar permisos» en curso
Tarea «Revisar permisos» completada
Tarea «Auditar IPC» bloqueada: falta autorización
Tarea «Auditar IPC» pendiente
Próximo paso: tarea «Documentar cambios»
Enfocar tarea «Auditar IPC»
Limpiar próximo paso
```

Las referencias por texto se normalizan de forma acotada y deben ser únicas. Si no
hay una referencia clara, un formato válido o una transición consistente, se pide
aclaración sin modificar parcialmente el grafo. Los límites de capacidad rechazan
la transacción sin consumir una media lista ni podar pendientes. Una repetición
literal no duplica la misma tarea con igual padre/objetivo, ni reactiva una cerrada.

En **Comprensión → Tareas, subtareas y próximo paso** se puede agregar, editar
texto/resultado esperado, elegir padre y objetivo, seleccionar dependencias
(múltiple), prioridad, foco y próximo paso, declarar estados y mover el orden.
Las relaciones se eligen por ID; los ciclos y referencias inválidas se rechazan.
El historial permite revisar los cambios. Los borradores de texto y relaciones
se conservan al refrescar; al guardar se limpian juntos para que metadatos viejos
no reviertan una edición posterior. Un cambio de pestaña no aplica una edición
pendiente al nuevo contexto.

### Persistencia, límites y seguridad

Campos opcionales al leer archivos antiguos, sin cambiar `schema_version: 1`:
`tasks`, `task_events`, `focused_task_id` y `next_step`. No se migra automáticamente
la última tarea inferida ni los subobjetivos a tareas confirmadas. Se conserva el
archivo UUE existente, sus escrituras atómicas, exclusión tras borrado y EVO opcional.

Por contexto: hasta 100 tareas (incluidas cerradas), 10 dependencias por tarea,
200 eventos y 10 tareas por lista de conversación. Texto, resultado esperado y
motivo de bloqueo: hasta 200.000 caracteres, sujetos al límite global previo de
2 millones por contexto y 8 MB por archivo. No hay poda silenciosa; al alcanzar
capacidad hay que resolver la organización de forma explícita, por ejemplo usando
otro contexto. No existe borrado individual de tareas que deje referencias rotas.

Se valida esquema, origen, estados/declaraciones, referencias, ciclos y cambios
históricos. Corrupción bloquea escritura sin sobrescribir. Un fallo de disco no
confirma tareas o cierres en RAM y permite reintentar con la misma revisión.
Las tareas persisten al reiniciar; no se reinterpretan como trabajo en ejecución
real ni heredan instrucciones de otro contexto.

Las seis operaciones (`task-add`, `task-update`, `task-transition`, `task-focus`,
`task-next`, `task-order`) pasan por la edición IPC existente: shell confiable,
mainFrame, guest propio y revisión optimista. No hay canal, API privilegiada web,
permiso, dependencia de producción o llamada a un modelo nuevos. El lector, cola
de 500 ms, ACK, EVO, CDP, guard, preparación/envío, tokenización y contadores se
conservan. Versión mantenida: 0.1.33.

### Validación ejecutada

| Ejecución | Total | Aprobadas | Fallidas | Omitidas |
|---|---:|---:|---:|---:|
| Focalizadas: UUE, observación, main/IPC, independencia, shell, objetivos, reglas, tareas y paneles | 146 | 146 | 0 | 0 |
| `npm test` | 887 | 886 | 0 | 1 |

La suite completa duró 102.218,288979 ms. La omitida sigue siendo el empaquetado
Windows real con `NEXO_ELECTRON_ZIP_DIR`. Build de inyección correcto:
53,7 kB / 19,3 kB gzip, 11 módulos.

Se añaden **28 pruebas de comportamiento**: 25 en
`test/understanding-tasks.test.js`, una de callbacks del panel en
`test/understanding-tasks-panel.test.js` y dos de flujo IPC/main en
`test/user-understanding-main.test.js`. Cubren literal, aislamiento de objetivo y
reglas, listas, subtareas, dependencias/ciclos mixtos, estado declarativo,
reapertura, bloqueos, elegibilidad transitiva, orden/prioridad, resultado esperado,
foco/paso, citas/negaciones, repetición, capacidades, compatibilidad, reinicio,
EVO apagada, borrado, corrupción, fallo de disco, revisiones y remitentes no
privilegiados. La fixture DOM compartida se amplía para selección múltiple.

**Límites de la evidencia:** no se ejecutaron Electron real, Windows real ni una
cuenta ChatGPT real. Los tests de panel usan DOM mínimo/puente de fixture y main
usa Electron stub. No prueban renderizado, accesibilidad, scroll/foco ni selectores
múltiples en Chromium real. No hay mediciones de rendimiento o calidad semántica.
No existe descomposición semántica universal, planificador automático, estimación
de esfuerzo, fechas límite, ni verificación externa de resultados. Las frases
fuera de la gramática se corrigen con el panel; no se declara cumplida cualquier
redacción posible de los requisitos por tener un grafo de tareas.

Gate manual pendiente: EVO apagada → objetivo/reglas → dos tareas y una subtarea
→ dependencia → intento de inicio bloqueado → declaración de finalización del
requisito → inicio explícito → próximo paso → bloqueo con motivo → reapertura
→ cambio de orden/prioridad → cierre del objetivo → cambio de conversación →
reinicio → borrado. Revisar borradores, selección múltiple, historial, texto
escapado y tema BLACK & ELECTRIC BLUE existente.

### Archivos y entrega

Nuevos: `src/core/userTasks.js`, `src/ui/shell/understandingTasks.js`,
`test/understanding-tasks.test.js` y `test/understanding-tasks-panel.test.js`.
Modificados: core/servicio UUE, panel, manifest de empaquetado, fixture DOM,
tests main, README y documentación. La etapa 4 se publicó como `880ab58`. Su
siguiente bloque se desarrolla debajo. Los gates manuales siguen pendientes;
**no se declaran completados los 72 requisitos**.

El ZIP de esta entrega es de **fuentes**, no un ejecutable Windows ya validado.
Para probar desde fuentes, ubicarse en la raíz que contiene `package.json` y `src`,
no en `dist/Nexo-win32-x64`. El ZIP no incluye `.git`: los comandos Git requieren
un clon del repositorio. En PowerShell pegar sólo los comandos, no el prefijo
`PS C:\…>` ni los mensajes de salida/error de otra ejecución. Ver el README para
instalación y arranque; no se ejecutaron esos pasos en el equipo del usuario.


## Etapa 5 implementada — proyectos, referencias y selección de contexto

### Modelo local y alcance real

Este bloque amplía el UUE existente, sin crear otro expediente ni depender de
EVO para comprender la conversación actual. Su base cubre etiquetas de proyecto,
referencias actuales nombradas, antecedentes de contextos guardados y selección
explícita para continuar. No es un gestor global de proyectos ni un sistema de
resolución semántica universal.

- **Etiqueta de proyecto por contexto:** nombre libre de hasta 200 caracteres y
  descripción de hasta 10.000, con origen, fechas e historia. Se conserva literal,
  no se deduce del sitio, un archivo, un objetivo o una respuesta del asistente.
  Renombrar/quitar etiqueta no borra objetivos, tareas o reglas. Una etiqueta igual
  en dos conversaciones **no las fusiona ni comparte sus instrucciones**.
- **Cambio de proyecto ambiguo:** una declaración distinta con «Proyecto: …»
  cuando ya existe etiqueta pide aclaración. Renombrar explícitamente sólo cambia
  la etiqueta; para separar otro trabajo hay que usar otra conversación/contexto.
  No se migra un proyecto por similitud de palabras ni por una inferencia.
- **Referencias actuales nombradas:** alias locales para archivo, documento,
  componente o nota, dentro de `relevant_context`. Son datos declarados por el
  usuario; no leen archivos, validan rutas ni ejecutan comandos. Se puede elegir
  una referencia por ID/alias único y retirarla con historia. Un alias activo no
  se sustituye silenciosamente con otro contenido. Retirarlo limpia su selección.
- **Inspección sin activar:** listar contextos muestra etiqueta, objetivo breve,
  URL, revisión y fecha. Inspeccionar permite ver resumen/entradas del origen,
  estado y certeza, sin cambiar el contexto activo ni copiar sus reglas.
  Sólo incluye datos UUE del usuario: no usa respuestas del asistente como fuente
  de objetivos, decisiones o antecedentes confirmados.
- **Antecedentes vinculados, no importados:** una referencia a otro contexto o a
  una entrada concreta primero queda pendiente. Confirmar vincula sólo ese
  puntero, con `authority: reference-data-only` y `verified: false`. No incorpora
  el objetivo, tareas ni reglas ajenas al estado actual. «Sí» genérico no vincula.
  Rechazar/retirar conserva historia pero deja de recuperar el contenido asociado.
- **Origen con revisión y huella:** se registra ID de contexto, revisión, SHA-256
  de su estado UUE y destino exacto. Si el origen cambia, caduca o se elimina,
  no se muestra un texto actual como si fuera la versión vinculada. Se informa
  indisponibilidad/cambio. Renovar requiere inspeccionar la versión actual,
  vuelve a pendiente y exige confirmar de nuevo. No hay renovación automática.

La huella detecta cambios, **no prueba la verdad del origen ni cifra los datos**.
Es conservadora sobre el estado completo: un cambio no relacionado con la entrada
puede volver obsoleta una referencia, incluso al caducar una regla temporal sin
incrementar la revisión. No se guarda un texto histórico duplicado para reconstruir
una versión eliminada. La etiqueta descriptiva del puntero se conserva desde su
propuesta; el preview siempre indica revisión, contenido y estado del origen disponible.

### Continuar en un contexto no es vincular un antecedente

El panel separa dos acciones:

1. **Inspeccionar/proponer antecedente:** lectura y vínculo sin cambiar contexto.
2. **Continuar en este contexto:** confirmación explícita, contexto/revisión
   actuales y revisión/huella del origen. Los próximos mensajes actualizan ese
   contexto elegido; no se mezclan automáticamente los dos estados. Se muestran
   la URL visible, el contexto activo y la URL de origen. Se puede volver al
   contexto natural con otro control explícito.

La selección manual vive en RAM hasta cambiar de URL, cerrar la pestaña o reiniciar.
Las etiquetas, reglas, tareas y referencias sí persisten en sus contextos guardados.
Al volver/reiniciar se usa el contexto natural de la conversación, no una elección
oculta guardada. No se promete sincronización global ni continuidad entre perfiles
que no comparten el archivo UUE.

**Límite protegido de relectura:** al cambiar selección se establece una línea base
con el primer snapshot visible: sus usuarios históricos no se interpretan en el
contexto elegido. Luego sólo se procesan nuevos turnos según el lector/ledger
existentes. La ventana observacional se conserva por documento físico, separada
del contexto normativo elegido; no sobrescribe la conversación observada del origen.
Esto también impide reimportar en el destino, tras reiniciar, los mensajes del
período vinculado. Si el documento físico estaba borrado, no se vuelve a crear
su fila persistida por esta observación.

Si el último usuario está recortado, la línea base espera su versión completa.
Un mensaje visto sólo por DOM antes de completar esa línea base puede quedar
fuera de interpretación, deliberadamente: no se inventa si era histórico o nuevo.
Los originales recibidos por preparación siguen su camino existente. La selección
no altera el lector ni la cola de 500 ms. No se afirma captura perfecta de mensajes
que nunca llegaron a esos mecanismos.

Las raíces reconocidas `/g/<id>` y `/g/<id>/project` ahora son temporales por
pestaña/sesión, como la raíz previa: no se comparte una conversación sin ID por
estar en la portada de un proyecto. Sólo migran a una conversación de su misma
ruta de proyecto/origen. No se fusionan rutas distintas como `/c/id` y
`/g/proyecto/c/id` por suponer equivalencias semánticas. Los contextos antiguos
ambiguos siguen en la lista para selección explícita, no se sobrescriben.

### Uso y procedencia

Ejemplos de gramática ES/EN acotada:

```text
Proyecto: NEXO accesibilidad
Renombrar proyecto: NEXO documentación
Referencia actual «lector»: src/preload/chatgptReader.js
Usar referencia «lector»
```

El editor permite descripción y tipos de referencia adicionales. Elegir un alias
identifica un dato, no autoriza utilizarlo en una herramienta ni insertar su texto
en un prompt. No se resuelven «ese archivo», «lo anterior» o «el mismo proyecto»
por intuición cuando falta una referencia única. Las continuaciones ambiguas
conservan el contexto o piden aclaración con los controles existentes; no buscan
un proyecto ajeno automáticamente.

En **Comprensión → Proyecto, contexto y referencias**: etiqueta/descripcion,
referencias actuales, antecedentes pendientes/vinculados, lista de contextos,
inspección y continuación explícita. Los previews son extractos de hasta 1.000
caracteres, con recorte declarado; las entradas se paginan de 20 en 20. No hay
una segunda transcripción ni recuperación oculta de archivos o sitios externos.
La UI conserva borradores y descarta acciones si cambió la pestaña/contexto.
Las ediciones de la shell incluyen ahora la identidad esperada del contexto,
además de revisión, para no aplicar una edición a otra URL con igual revisión.

### EVO sigue siendo opcional y separado

La búsqueda EVO previa sigue siendo manual y aporta sólo referencias no verificadas,
no información actual confirmada. Ahora los candidatos nuevos guardan huella del
texto EVO, sin copiar ese texto al archivo UUE: sustituir un elemento con el mismo
ID invalida preview/confirmación de esa versión. También se verifica su proyecto
EVO. Referencias antiguas sin huella siguen siendo compatibles y se marcan sin
versión fijada; no se inventa retrospectivamente su huella original.

Con EVO apagada no se llama a `list`/`recall` ni se muestran sus textos; siguen
funcionando etiquetas, alias, inspección local, vínculos y lectura/comprensión
actual. Con EVO encendida sólo se consulta su lista si hay referencias activas o
preguntas de referencia abiertas, no para toda lectura del panel.

### Persistencia, seguridad y límites

Aditivos opcionales al leer archivos anteriores: `project`, `project_history`,
`context_references`, `context_events`, `selected_reference_id`, metadato `entity`
en entradas actuales y huella `digest` en referencias EVO nuevas. Se mantiene
`schema_version: 1`, el archivo UUE, sus límites de 50 contextos/8 MB y 2 millones
de caracteres por contexto. No se modifica el archivo EVO ni se añade dependencia.

Hasta 50 versiones anteriores de etiqueta, 30 antecedentes (incluidos retirados)
y 200 eventos de vínculos. Los alias reutilizan los límites de 200 entradas de
contexto y 400 históricas. Capacidad llena rechaza transacciones sin poda silenciosa.
Las estructuras, roles, punteros, eventos y huellas se validan. Corrupción bloquea
escritura sin sobrescribir; fallo de disco no confirma cambios en RAM y permite
reintentar. El borrado conserva tombstones: no reintroduce origen ni destinos.

Se reutilizan `edit`, `contexts` (lista/inspección) y `bind`, sin canal/preload nuevo.
La inspección sólo está disponible para shell confiable; con guest indicado se
valida propiedad de la pestaña. Mutación y selección mantienen mainFrame, guest
propio y control optimista de contexto/revisiones. Fuente observada no da autoridad.
Las huellas de orígenes se calculan una vez por origen en cada lectura del panel,
sin un índice global que pueda quedar desactualizado. No hay mediciones nuevas de
CPU/RAM ni afirmaciones de eficiencia cuantificada. No se cambian permisos,
preparación/envío, CDP, guard, tokenización ni contadores. Versión: 0.1.33.

### Validación ejecutada y pendientes

| Ejecución | Total | Aprobadas | Fallidas | Omitidas |
|---|---:|---:|---:|---:|
| Focalizadas: UUE, observación, main/IPC, independencia, shell, objetivos, reglas, tareas, proyectos y paneles | 175 | 175 | 0 | 0 |
| `npm test` | 916 | 915 | 0 | 1 |

La suite completa duró 103.277,685645 ms. La omitida sigue siendo el empaquetado
Windows real con `NEXO_ELECTRON_ZIP_DIR`. Build correcto de inyección:
53,7 kB / 19,3 kB gzip, 11 módulos.

Se añaden **29 pruebas de comportamiento**: 26 en
`test/understanding-projects.test.js`, una del panel en
`test/understanding-projects-panel.test.js` y dos de flujo IPC/main en
`test/user-understanding-main.test.js`. Cubren etiquetas/historia, alias,
inspección/paginación/recorte, vínculos no normativos, cambio/borrado de origen,
renovación, EVO apagada y texto EVO reemplazado, reinicio, aislamiento, selección y
retorno, línea base, ventanas separadas, raíces de proyecto, identidad/revisiones,
compatibilidad, capacidades, corrupción, disco/reintento y remitentes no autorizados.

No se probaron Electron real, Windows real ni una cuenta ChatGPT real. DOM mínimo,
puente de fixture y Electron stub no prueban renderizado, accesibilidad, foco/scroll,
selectores ni navegación real de proveedores. No hay clasificación semántica
universal, lectura de archivos, importación automática de reglas, verificación
factual ni ejecución. La implementación acotada no declara satisfechas todas las
redacciones posibles de los requisitos, ni los 72 completos.

Gate manual pendiente: EVO apagada → dos conversaciones/proyectos distintos →
igual etiqueta sin mezcla → alias actual y retiro → inspección sin activar →
antecedente pendiente/confirmado → cambio/borrado del origen → renovación explícita
→ continuar en otro contexto y revisar línea base → nuevos mensajes → volver al
natural → reinicio → borrado. Comprobar URLs/origen, borradores, tema BLACK &
ELECTRIC BLUE y que no se recupera contenido de vínculos rechazados/retirados.

### Archivos y siguiente bloque

Nuevos: `src/core/userProjects.js`, `src/ui/shell/understandingContexts.js`,
`test/understanding-projects.test.js` y `test/understanding-projects-panel.test.js`.
Modificados: core/servicio UUE, panel, manifest de empaquetado, tests main, README
y documentación. La etapa 5 se publicó como `50e3160`. Su siguiente bloque se
desarrolla debajo. Los gates manuales siguen pendientes; no hay ejecución autónoma.


## Etapa 6 implementada — progreso, problemas y evidencia

### Alcance explícito, sin fabricar comprobaciones

Los requisitos 31–33, 35, 45–46 y 69–70 se amplían con un registro local de avances,
resultados, errores, bloqueos y propuestas dentro del mismo UUE. No se añade un
agente, verificador de herramientas, lectura de archivos, diagnóstico semántico
general ni una transcripción adicional. Comprender/registrar no significa ejecutar,
certificar, aprobar acciones sensibles ni cambiar permisos.

Hay cinco tipos de entrada:

- **Avance declarado:** texto literal del usuario, sin convertirlo en porcentaje.
- **Resultado declarado:** desenlace seleccionado explícitamente como desconocido,
  éxito informado, parcial informado o fallo informado. El texto «todo pasó» no
  selecciona éxito automáticamente. Un resultado nuevo por gramática y cualquier
  afirmación capturada del asistente empiezan con desenlace **desconocido**.
- **Error informado:** un problema descrito, no una causa técnica demostrada.
- **Bloqueo informado:** un impedimento descrito; no se presupone dependencia,
  autorización pendiente ni indisponibilidad de herramientas que no se declararon.
- **Propuesta de trabajo:** pendiente hasta evaluación explícita por el usuario.
  Aceptar aquí es registrar esa evaluación, **no una decisión normativa, regla,
  tarea nueva, aprobación ejecutora ni permiso para el futuro**. Para una decisión
  o tarea se mantienen sus controles separados de las etapas anteriores.

La entrada puede vincularse a una tarea y/o un objetivo locales por ID exacto. Por
defecto no hay vínculo; no se usa el foco, la última solicitud, similitud de texto,
la etiqueta de proyecto ni el orden del DOM para inventarlo. Se permiten vínculos
a elementos cerrados para registrar lo que ocurrió; no se los reabre ni completa.

Texto, tipo, fuente y asociaciones son inmutables en cada entrada. Corregir requiere
retirar con motivo y registrar otra, conservando la original. Errores/bloqueos
pueden resolverse y reabrirse con motivo; propuestas pueden aceptarse/rechazarse
una vez y retirarse después. El retiro es terminal: no se reactiva una entrada.
Cada creación/transición tiene identidad, autoría y fecha; se valida la cadena de
estados contra el estado actual y no se podan eventos.

### Evidencia aportada no equivale a evidencia independiente

Se puede asociar a una entrada un **relato del usuario** o un **extracto de artefacto
aportado por el usuario**, con texto literal y ubicación opcional. Son dos clases
de aporte, no dos niveles de verdad. Una ruta/URL es sólo texto: no se crea un
enlace ejecutable, no se abre, no se lee, no se descarga y no se envía a otro sistema.
Ningún aporte se presenta como salida observada de un comando que NEXO no ejecutó.

Todos los registros conservan `verified: false` y `authority: tracking-data-only`;
los aportes, `verified: false` y `authority: evidence-data-only`. Que haya un log
pegado, un hash de versión o una confirmación humana **no cambia esos atributos**.
La captura correcta de una afirmación no demuestra que su contenido sea verdadero.

Retirar una evidencia requiere motivo, conserva el texto en historia y la excluye
de la vista efectiva. Retirar su entrada excluye también sus aportes de esa vista,
sin borrar la historia. No se pueden añadir aportes a entradas retiradas. Para
eliminar el contenido del expediente sigue disponible el borrado explícito del
contexto con tombstone; «retirar» no pretende ser un borrado físico.

En el panel se ven el resultado esperado de la tarea vinculada y lo informado,
**sin decidir automáticamente si coinciden**. La comparación queda pendiente de
revisión humana. Resultado favorable + aporte no resuelve errores abiertos, no
satisface dependencias ni completa tareas/objetivos. Del mismo modo, cerrar una
tarea no crea un resultado o una evidencia. Los bloques previos siguen intactos.

### Asistente observado: fuente separada y captura manual versionada

La lectura automática existente ya mantiene una ventana de 24 mensajes, con roles,
estados y previews del asistente de hasta 4.000 caracteres. Este bloque la reutiliza;
no añade otro lector, transcript, temporizador ni análisis semántico de respuestas.
Una respuesta completa, un stream terminado o texto que dice «hecho» sigue siendo
**información observada del asistente, no progreso comprobado**.

En «Registrar un extracto observado del asistente explícitamente» el usuario puede
clasificar manualmente un extracto como **propuesta** o **afirmación de resultado**.
La operación está reservada a la shell; main obtiene el texto y el rol de la ventana
observacional del documento físico. No confía en un texto/rol remitido en la solicitud.
Exige ID de mensaje, digest SHA-256 y revisión observacional actuales, además de
contexto/revisión UUE. Rechaza versiones modificadas aunque no haya cambiado la
revisión UUE, streams, mensajes recortados por el lector, versiones ausentes y
orígenes borrados. Un mensaje largo completo cuyo preview está recortado a 4.000
sí permite capturar su extracto: nunca se lo presenta como respuesta completa.

Se conserva sólo el primer extracto de hasta **1.000 caracteres**, identificado
como tal, con URL/contexto físico de origen, ID/huella del mensaje completo, fecha
de observación y revisión. `source.role` sigue siendo `assistant`, con certeza
`observed-not-verified`; `origin` identifica al usuario que lo registró por la shell.
Las declaraciones directas del usuario mantienen fuente `user` y certeza `explicit`.
No se atribuyen palabras del asistente al usuario que eligió registrarlas.

La captura **fija un extracto histórico**, no un puntero dinámico: regenerar la
respuesta no reemplaza el registro. El mismo mensaje/huella/tipo no se vuelve a
capturar en ese contexto, incluso si se retiró. Una versión distinta requiere otra
captura explícita. Que ese texto sea una propuesta o una afirmación lo decide aquí
el usuario, no un clasificador que deduzca acciones a partir de «listo».

Si se está continuando explícitamente en otro contexto, la captura se registra en
el contexto elegido y conserva la URL/identidad física de la pestaña de donde salió.
No importa la conversación guardada del contexto elegido ni busca mensajes en otros
contextos. El extracto explícitamente conservado permanece en el destino aun si
sale de la ventana observacional o se borra otro contexto de origen: no se recupera
ni reintroduce su contenido. Para retirarlo/borrarlo se usan los controles del destino.
Esta copia acotada elegida por el usuario se diferencia de los antecedentes por
puntero de la etapa 5, que sí se vuelven indisponibles cuando cambia el origen.

### Panel, gramática y continuidad compatibles

Nueva sección **Progreso, problemas y evidencia** en Comprensión, con los mismos
componentes y estilo existentes: registro literal, tarea/objetivo explícitos,
desenlace, evaluación/resolución con motivo, aportes y su retiro, autoría, fuentes
y eventos. Usa `textContent`, no HTML del mensaje ni ejecución de URLs. Conserva
borradores; controles bloqueados durante peticiones. Las ediciones llevan identidad
del contexto y revisión; cambiar de pestaña o de URL no aplica acciones anteriores
a otro trabajo con igual revisión. No se agrega un canal ni API privilegiada web.

Gramática ES/EN acotada, sólo declaraciones completas de una línea:

```text
Avance registrado: revisé las comprobaciones de IPC
Resultado: se informa que la prueba terminó
Error observado: el panel no actualiza
Problema pendiente: falta revisar la accesibilidad
Bloqueo: no tengo acceso a la cuenta
Propuesta de trabajo: revisar primero los tests
```

También `Recorded progress:`, `Result:`, `Observed error:`, `Blocker:` y
`Work proposal:`. No se interpretan como estos registros nuevos los bloques de
código, citas completas, texto con backticks, preguntas o párrafos multirenglón.
El formulario sí permite texto libre literal multirenglón. No hay resolución
automática de «ya está», «eso falló», «el mismo problema» o mensajes sin un marcador
inequívoco; la observación no convierte esas expresiones en hechos.

Se preserva el contrato de **`Avance:` / `Progreso:`** y los registros simples
anteriores en `progress`, visibles en «Avances y problemas declarados». No se los
migra, vincula, duplica como registros nuevos ni inventa evidencia retrospectiva.
El panel indica cuántos existen. Para seguimiento enriquecido se registra una
entrada nueva explícitamente, por formulario o con «Avance registrado:». Una línea
«Problema pendiente:» ahora se reconoce en el registro de errores, sin modificar
los contextos simples históricos que usaron esa frase.

La proyección efectiva separa entradas no retiradas, aportes activos, problemas
abiertos, propuestas pendientes, resultados y resultados sin aporte activo. También
muestra **conteos de estados declarados** de tareas, no porcentajes ni métricas de
trabajo real. Una tarea pendiente con bloqueo informado aquí no se bloquea en el
grafo: es otro dato que exige cambiar su estado explícitamente en Tareas. Esto evita
que una afirmación del asistente o un relato ambiguo silenciosamente impida/autorice
el siguiente paso. La elegibilidad previa sigue siendo sólo estructural.

Inspeccionar otros contextos incluye entradas de seguimiento **del usuario** no
retiradas, paginadas y con origen/estado/certeza; pueden proponerse como antecedente
versionado, sin importarlas al registro actual. No expone capturas del asistente
como declaraciones del usuario ni entradas retiradas. El cambio/retiro de una
entrada invalida los punteros anteriores como en la etapa 5.

### Persistencia, seguridad y límites

Campos aditivos `work_records`, `work_evidence`, `work_events`, opcionales al leer
archivos anteriores, con `schema_version: 1` y versión de app **0.1.33** conservadas.
Se usa el archivo UUE propio, también con EVO apagada. No hay llamadas nuevas a
EVO ni dependencia, permisos, envíos o integración de herramientas nueva.

Hasta 100 registros, 150 aportes de evidencia y 300 eventos, incluidos los retirados.
Texto de registro/aporte/motivo hasta 10.000 caracteres, ubicación hasta 2.048.
Exceso o capacidad llena rechaza sin recortar ni podar. Siguen vigentes los límites
anteriores por contexto/archivo: pueden alcanzarse antes que estos máximos.
Cambios transaccionales: se valida el estado completo antes de publicarlo/guardarlo;
fallo de disco conserva RAM/archivo previos y permite reintentar. Datos incompatibles,
autorías falsas, referencias rotas, verificación inventada o historia inconsistente
bloquean escritura sin sobrescribir el expediente. Sin recuperación desde tombstones.

Se reutiliza `nexo:understanding:edit`, ampliando su allowlist; `work-capture` se
resuelve dentro de main con la observación existente. Se conserva shell mainFrame,
propiedad de guest, revisión y contexto esperado. Un guest o subframe no puede
registrar evidencia, aceptar propuestas ni capturar respuestas con privilegios.
No se cambian cola de 500 ms, ACK, permisos, aislamiento, CDP, mediación, envío,
contadores, tokenización ni archivo EVO. No se afirman mediciones nuevas de CPU/RAM.

### Validación y límites de la evidencia de desarrollo

| Ejecución | Total | Aprobadas | Fallidas | Omitidas |
|---|---:|---:|---:|---:|
| Focalizadas: UUE, observación, main/IPC, independencia, shell y seis bloques/paneles | 210 | 210 | 0 | 0 |
| `npm test` | 951 | 950 | 0 | 1 |

La suite completa duró 103.465,839027 ms. La omitida sigue siendo el empaquetado
Windows real que requiere `NEXO_ELECTRON_ZIP_DIR`. Build correcto de inyección:
53,7 kB / 19,3 kB gzip, 11 módulos. No es evidencia de ejecución de cada registro
que pudiera declarar un usuario dentro del panel.

Se añaden **35 pruebas de comportamiento**: 31 core/servicio en
`test/understanding-progress.test.js`, 2 DOM/puente en
`test/understanding-progress-panel.test.js` y 2 de main/IPC en
`test/user-understanding-main.test.js`. Cubren literalidad, gramática/compatibilidad,
asociaciones por ID, no autorización, no cierre implícito, estados y motivos,
aportes/retirada, proyección sin métricas inventadas, capacidad sin poda, transacciones,
corrupción en archivo real, disco/reintento, reinicio EVO apagada, borrado/tombstone,
captura versionada, recortes/stream, duplicados, fuentes separadas, cambio de URL,
selección explícita e inspección de antecedentes no normativos.

No se ejecutaron Electron real, Windows real ni una cuenta ChatGPT real. DOM mínimo,
servicio real y Electron stub prueban contratos, no renderizado, accesibilidad,
foco/scroll ni comportamiento real de los selectores del proveedor. No hay una
prueba factual de resultados externos, un parser de logs que los certifique,
diagnóstico causal automático ni recuperación/ejecución autónoma. No se declaran
satisfechas todas las redacciones posibles de los requisitos por tener este registro.

Gate manual: EVO apagada → tarea con resultado esperado → registrar error/bloqueo →
resultado parcial sin cerrar tarea → aportar log/ruta sin abrir → retirar aporte →
resolver/reabrir problema con motivo → propuesta y «sí» genérico sin aceptar →
aceptación explícita sin permiso → observar stream del asistente → captura estable
con autoría correcta → regeneración sin sobreescribir → selección de otro contexto,
retorno/reinicio → borrado. Revisar BLACK & ELECTRIC BLUE, foco, borradores y URLs.

### Archivos y siguiente bloque

Nuevos: `src/core/userProgress.js`, `src/ui/shell/understandingProgress.js`,
`test/understanding-progress.test.js`, `test/understanding-progress-panel.test.js`.
Modificados: core/servicio UUE, selección de entradas inspeccionables, panel, manifest
de empaquetado, tests main, README y documentación. La etapa 6 se publicó como
`804404f`. Su siguiente bloque se desarrolla debajo. Los gates manuales siguen
pendientes; no se habilita ejecución autónoma.


## Etapa 7 implementada — inspector, explicación y revisión humana

### Qué consolida

Los requisitos 42, 48, 52 y 60–66 tienen ahora un inspector transversal y controles
explícitos de revisión sobre el UUE existente. No se añade un motor semántico, un
agente, otra memoria ni un historial completo de conversación. Los controles
previos de objetivos, reglas, tareas, proyectos y evidencia siguen siendo sus
editores especializados, no se eluden desde un editor JSON universal.

El inspector permite filtrar por **categoría, certeza y estado**, y paginar de
20 en 20 sin mutar el contexto. Muestra identidad, texto/extracto de hasta 1.000
caracteres con recorte y longitud declarados, prioridad cuando existe, alcance,
estado, certeza, procedencia, fechas y orientación sobre cómo corregir cada tipo.
El original completo sigue en su categoría/editor; el índice no lo reemplaza.

Incluye políticas fijas, objetivos/inferencias, última solicitud e intención,
restricciones/instrucciones/decisiones/preferencias, subobjetivos/contexto/progreso
simples, tareas, etiqueta de proyecto, antecedentes, registros/aportes de evidencia,
aclaraciones, historia/eventos de los bloques previos, revisiones nuevas,
foco/próximo paso, incertidumbre y metadatos observacionales. Los eventos son
históricos, no reglas reactivadas. Las respuestas observadas sólo aportan rol/ID,
estado y tamaño al índice: no se duplica su preview o una transcripción nueva.
Una captura manual de la etapa 6 sí muestra su extracto con fuente `assistant`
y el usuario registrador por separado.

Las explicaciones son **deterministas según categoría y campos guardados**:
por qué una preferencia no es restricción, una inferencia no es objetivo confirmado,
un antecedente no es instrucción, una tarea completada es declaración y no prueba,
etc. No se fabrica el razonamiento que produjo una clasificación histórica ni se
expone una supuesta traza semántica no registrada. No se asignan porcentajes de
confianza, certeza factual ni métricas de comprensión. Inspeccionar no altera
reglas, objetivos, preguntas, mensajes vistos o contadores.

### Revisión de última solicitud

La `current_task` previa representa la última solicitud interpretada, no una tarea
del grafo ni un permiso. Su relación inicial con el objetivo puede ser inferida.
En «Revisar última solicitud interpretada» el usuario puede:

- **Confirmar la interpretación** pendiente con una relación explícita a un
  objetivo activo por ID o a ninguno. No se elige automáticamente el objetivo,
  foco de tarea o próximo paso. Se conserva la fuente original y se añade
  confirmación humana con `verified: false`.
- **Corregir texto y relación:** texto libre literal, original archivado como
  sustituido y versión nueva confirmada con origen del usuario corrector.
- **Rechazar la interpretación:** original archivado como rechazado, sin adivinar
  otra solicitud ni cancelar el objetivo, tareas o restricciones.

Se exige ID vigente, contexto/revisión, acción válida y motivo de hasta 10.000
caracteres. «Sí» genérico no confirma ni crea tareas. No se puede vincular a un
objetivo cerrado/ausente ni volver a confirmar una solicitud ya confirmada.
Confirmar no la convierte en objetivo principal, tarea ejecutora o instrucción.
La incertidumbre de relación de esa solicitud deja de presentarse como pendiente;
las dudas/preguntas ajenas permanecen.

**Conservación revisada:** una solicitud confirmada ya no se pierde si llega otra
solicitud interpretada, cambia el objetivo principal o se cierra. Se archiva antes
de sustituirla/limpiarla. Historia llena rechaza la transacción, sin poda silenciosa.
Las inferencias transitorias no revisadas conservan el comportamiento previo; no
se genera una copia histórica de cada mensaje de conversación.

### Anotación de intención, sin reejecutar ni deshacer el pasado

Se conserva la clasificación original en `last_interaction` y se permite anotar
una intención/relación humana mediante selectores acotados y motivo. La anotación
vive en `interaction_review`, con fuente/fecha originales y autoría de la revisión.
El panel y la vista efectiva separan original y revisión; no se escribe encima de
la interpretación ni se inventa que la original fue una confirmación del usuario.

Una anotación «era una pregunta» **no borra una restricción que el mensaje ya había
registrado**; su retiro/corrección sigue requiriendo el editor específico. «Era una
aprobación» no acepta propuestas, objetivos o permisos pendientes. No se reenvía,
reinterpreta o reejecuta el mensaje. El nuevo mensaje registrado reinicia la
anotación actual y conserva el evento de revisión con origen/motivo en historia.
Las solicitudes independientes que no actualizan el estado siguen aisladas.

Intenciones de revisión: solicitud, pregunta, aclaración, corrección, continuación,
independiente, aprobación, rechazo o desconocida. Relaciones: trabajo actual,
independiente, referencia sin resolver o desconocida. Son anotaciones del usuario,
no una nueva gramática para ejecutar cambios de otras categorías.

### Corrección de datos simples y editores especializados

Los datos activos de `subgoals`, `relevant_context` simples y `progress` se pueden
corregir desde la página del inspector con texto literal y motivo. La operación es
atómica: archiva el original, crea el corregido confirmado en **la misma categoría
y alcance**, y registra el vínculo anterior/nuevo. Rechaza IDs obsoletos, texto
sin cambio, entradas duplicadas y categorías no permitidas. No fusiona historias.

Referencias nombradas/EVO no se reemplazan desde ese control: se retiran y se
registran otras explícitamente, para no sustituir el origen bajo el mismo alias/ID.
Restricciones/preferencias/decisiones usan el editor con conflictos de la etapa 3;
objetivos y tareas, sus editores previos; los registros y evidencias inmutables de
la etapa 6 se corrigen mediante retiro y entrada nueva. El índice ofrece indicación
del control correspondiente, no un bypass de sus reglas. Las políticas fijas no
son editables y las capturas del asistente no se convierten en fuentes del usuario.

### Persistencia y seguridad

Campos nuevos opcionales al leer archivos anteriores: `review_events` e
`interaction_review`. Se conserva `schema_version: 1`, app **0.1.33**, archivo UUE,
EVO independiente y sus límites anteriores. Hasta 100 eventos de revisión, con
motivo, acción, IDs anterior/nuevo, fuente original, autor de revisión, fecha y
etiquetas de cambio —no una copia del transcript—. Capacidad llena rechaza sin
podar. Los originales corregidos usan la historia existente, hasta 400 entradas.

Se validan acciones, motivos, identidades, rol de usuario, referencias históricas,
relación de la anotación con el mensaje original y su evento, y `verified: false`.
El nuevo control sobre `last_interaction` admite también la certeza histórica
`uncertain` de aprobaciones/rechazos ambiguos, manteniendo compatibilidad. Corrupción
bloquea escritura sin sobrescribir; error de disco conserva RAM/archivo previos y
permite reintentar. Borrar el contexto borra sus revisiones y mantiene tombstone.

El índice se deriva al leer; no se guarda otro archivo ni un índice global que pueda
quedar obsoleto. Se amplía `read` para filtros y comprobación opcional de contexto/
revisión. Las mutaciones nuevas reutilizan `edit` con su allowlist. **Sin canal o API
privilegiada web nueva**. La shell conserva mainFrame y guest propietario; los
lectores siguen recibiendo datos, no autoridad. No se cambian permisos, mediación,
envío, CDP, tokenización, contadores, cola de 500 ms, ACK ni almacenamiento EVO.

### Revisión transversal y correcciones adicionales

Durante el cierre se revisaron las interacciones de los siete bloques y se corrigió:

1. **Callbacks de vistas descartadas:** botones/formularios no toman la identidad o
   revisión de una nueva vista después de un refresh/cambio de contexto. Cada
   callback queda ligado a la vista que lo creó; si fue descartada, sólo renueva.
2. **Navegación en la misma pestaña durante una petición:** se usa una generación
   de navegación para descartar respuestas viejas y leer la nueva. Un evento
   `changed()` durante una lectura/edición ya no pierde esa renovación. Sin pestaña,
   se limpia la vista anterior, no se dejan acciones sobre datos de otro trabajo.
3. **Recuperación y borrado con identidad esperada:** el panel envía contexto además
   de revisión; main rechaza una identidad anterior incluso si la otra URL tiene la
   misma revisión. El borrado nativo revalida también la propiedad del guest tras
   esperar al diálogo, además de shell, conversación y revisión.
4. **Conservación de solicitudes confirmadas:** archivo antes de sustituir/limpiar,
   con rechazo transaccional si la historia está llena, como se explica arriba.

Los puntos anteriores son correcciones concretas comprobadas, no una afirmación de
que no pueda existir ningún otro fallo. La revisión no equivale a una auditoría
completa de Chromium/Electron o de todos los proveedores. Ver
[revisión final transversal](NEXO-COMPRENSION-REVISION-FINAL.md).

### Validación final ejecutada

| Ejecución | Total | Aprobadas | Fallidas | Omitidas |
|---|---:|---:|---:|---:|
| Focalizadas: UUE, observación, main/IPC, independencia, shell y siete bloques/paneles | 242 | 242 | 0 | 0 |
| `npm test` | 983 | 982 | 0 | 1 |

Suite completa: 103.793,03331 ms. La omitida es el empaquetado Windows real que
requiere `NEXO_ELECTRON_ZIP_DIR`. Build de inyección correcto: 53,7 kB / 19,3 kB gzip,
11 módulos. Los registros de validación se entregan junto a las fuentes.

Se añaden **32 pruebas de comportamiento**: 26 core/servicio/IPC aislado en
`test/understanding-inspector.test.js`, 4 DOM/puente en
`test/understanding-inspector-panel.test.js` y 2 main/IPC con Electron stub en
`test/user-understanding-main.test.js`. Cubren índice puro, jerarquía, filtros,
paginación/recorte, tipos de los bloques previos, fuentes, revisión de solicitudes,
relaciones por ID, anotación sin reejecutar, corrección literal con historia,
no duplicación/sustitución de referencias, capacidades, compatibilidad/corrupción,
disco/reintento, reinicio, EVO apagada, borrado/tombstone, callbacks descartados,
navegación diferida, propiedad del guest y remitentes no autorizados.

Una de las pruebas recorre **los siete bloques juntos**: observación de varios
usuarios/asistente → objetivo y restricción → preferencias/tareas → etiqueta →
solicitud confirmada → antecedente de otro contexto sin importar reglas → captura
de propuesta del asistente/aceptación sin permisos → resultado parcial y aporte
no verificados → revisión de intención → reinicio → selección explícita con línea
base → mensaje nuevo en el contexto elegido → retorno sin mezcla → borrado sin
reimportación. No sustituye una sesión real de cuenta/proveedor.

### Cierre de las siete etapas y límites pendientes

Se finaliza el desarrollo por etapas dentro del alcance descrito; no se anuncia un
octavo bloque ni se activa un job automático. Las siete bases locales están
integradas y probadas. **Esto no certifica los 72 requisitos como comprensión
semántica general ni declara aprobados los gates manuales.** Persisten la gramática
acotada ES/EN, ventana observacional limitada, referencias ambiguas no resueltas,
contradicciones no universales y ausencia de verificación factual/ejecución.

Pendientes externos: Electron/Windows real, cuenta ChatGPT real, navegación/roles
reales del proveedor, foco/scroll, accesibilidad, renderizado BLACK & ELECTRIC BLUE
y empaquetado Windows real. Son límites declarados, no pruebas simuladas como reales.
El checklist de cierre está en la revisión final; el ZIP es **fuente**, no un .exe
validado. Se conserva el compromiso de commit/push normal y comprobación del remoto.

Nuevos: `src/core/userReview.js`, `src/core/understandingInspector.js`,
`src/ui/shell/understandingInspector.js`, tests de inspector/core/panel y documento
de revisión final. Modificados: core/servicio/panel UUE, manifest, tests main y docs.

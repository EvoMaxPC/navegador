# NEXO Comprensión — desarrollo en siete etapas

## Acuerdo de alcance

Los 72 requisitos describen un objetivo amplio, no capacidades ya demostradas.
Se avanza por etapas sobre el UUE existente, sin reconstruir NEXO ni introducir
un agente ejecutor. La entrega actual incorpora **las etapas 1, 2 y 3**, sobre
0.1.33. Las cuatro siguientes siguen planificadas; no se declara el panel completo.

No hay modelo semántico nuevo, envíos externos, nuevos permisos ni dependencia
nueva. Las reglas actuales siguen siendo locales y conservadoras. Comprender no
significa ejecutar, aprobar una propuesta ni verificar que ChatGPT hizo algo.

## Siete bloques y trazabilidad completa

Cada número aparece una vez como responsabilidad principal; hay dependencias
entre bloques. Las funciones parciales existentes de UUE se reutilizarán.

| Etapa | Responsabilidad | Requisitos | Estado de esta entrega |
|---|---|---|---|
| 1 | Observación incremental, roles y actualización automática | 1–6, 49, 54, 58, 68 | Base implementada; límites semánticos debajo |
| 2 | Objetivo principal, múltiples objetivos, cambios y ciclo de vida | 7–12 | Implementada con gramática acotada y revisión explícita; detalle debajo |
| 3 | Reglas, restricciones, preferencias, decisiones y vigencia | 13–18, 37–41, 43–44, 50–51, 53, 67, 72 | Ampliada con gramática acotada, revisión de conflictos y edición de vigencia; detalle debajo |
| 4 | Tareas, subtareas, dependencias, prioridades y siguiente paso | 19–24, 34, 36 | Pendiente; no inventar plan ni ejecutar tareas |
| 5 | Proyectos, referencias, selección de contexto y antecedentes | 25–30, 47, 55–57, 59, 71 | Parcial previo; EVO opcional y referencias revisables |
| 6 | Progreso, errores, bloqueos, propuestas y evidencia de resultados | 31–33, 35, 45–46, 69–70 | Pendiente de interpretación ampliada; observar no verifica |
| 7 | Inspector completo, explicación, corrección e inferencias confirmables | 42, 48, 52, 60–66 | Controles parciales previos; consolidar tras las bases |

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
objetivos del panel, README y documentación. Se cierra con commit y push a la
rama de trabajo. El siguiente bloque es el **4: tareas, subtareas, dependencias,
prioridades y siguiente paso**. Los bloques restantes y los gates manuales siguen
pendientes; **no se declaran completados los 72 requisitos**.

# NEXO Comprensión — desarrollo en siete etapas

## Acuerdo de alcance

Los 72 requisitos describen un objetivo amplio, no capacidades ya demostradas.
Se avanza por etapas sobre el UUE existente, sin reconstruir NEXO ni introducir
un agente ejecutor. La entrega actual incorpora **las etapas 1 y 2**, sobre
0.1.33. Las cinco siguientes siguen planificadas; no se declara el panel completo.

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
| 3 | Reglas, restricciones, preferencias, decisiones y vigencia | 13–18, 37–41, 43–44, 50–51, 53, 67, 72 | Parcial previo; falta ampliar y validar sistemáticamente |
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
La entrega se cierra con commit y push sobre la rama de trabajo. **El próximo
bloque es el 3: reglas, restricciones, preferencias, decisiones y vigencia.**
No se declaran completados los 72 requisitos.

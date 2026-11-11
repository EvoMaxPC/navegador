> **Documento histórico del módulo retirado.** No describe el funcionamiento actual.
> El reemplazo está documentado en [Comprensión: optimización conversacional](NEXO-COMPRENSION-OPTIMIZACION.md).
> Los archivos de datos históricos del usuario no se han borrado ni migrado.

# NEXO AI 0.1.33 — Capa 1: User Understanding Engine

> Desarrollo posterior: [Comprensión en siete etapas](NEXO-COMPRENSION-ETAPAS.md).
> La etapa 1 amplía la recepción incremental y observación del asistente, con
> renovación automática del panel. La etapa 2 añade objetivos independientes,
> inferencias confirmables y cierre/reapertura explícitos sin verificar ejecución;
> la etapa 3 amplía reglas, propuestas de decisión y corrección/vigencia con historia.
> La etapa 4 añade seguimiento explícito de tareas, dependencias y próximo paso,
> sin planificación/ejecución automática ni verificación de resultados.
> La etapa 5 amplía etiquetas/referencias, inspección y selección explícita de
> contexto, sin importar reglas ni convertir antecedentes en hechos confirmados.
> La etapa 6 añade seguimiento de resultados/problemas, propuestas y evidencia
> aportada sin verificación factual ni autoridad para ejecutar.
> La etapa 7 consolida inspector, explicaciones deterministas y revisión humana
> con historia. [Cierre y revisión transversal](NEXO-COMPRENSION-REVISION-FINAL.md).
> Las descripciones de iteraciones anteriores
> de este documento deben leerse como evidencia histórica, no como límite actual.

## Alcance y estado real

Implementación local, independiente y reutilizable, integrada al flujo de preparación de mensajes y al consumidor del lector de conversaciones ChatGPT existente. No es un nuevo expediente ni una copia de EVO MEMORY. No incorpora LLM, agente, ejecución, elección de herramientas, evaluación/corrección de respuestas ni segunda capa de mediación. No cambia prompts a partir del nuevo estado: entrega una representación estructurada y aclaraciones para revisión humana y para futuros consumidores.

La comprensión automática es **determinista y conservadora, con reglas ES/EN**, no comprensión semántica general. La edición explícita permite conservar objetivos libres/extensos y categorizar cualquier instrucción fuera del vocabulario reconocido. Que los escenarios pasen no demuestra comprensión universal, mejora cuantificada de experiencia ni resolución de cualquier contradicción.

## Arquitectura

1. `src/core/userUnderstanding.js`: contrato versionado, función pura `updateUnderstanding(state, operation, metadata, now)`, interpretación `interpretMessage`, proyección de contexto vigente `effectiveUnderstanding`, validación y políticas invariantes. Exportado también por `src/core/index.js`. Sin Electron, disco, red o dependencia nueva.
2. `src/main/userUnderstanding.js`: servicio persistente, identidad de contextos, procedencia, revisión optimista, deduplicación, expiración temporal, referencias a EVO y seis IPC limitados a la shell. Reutiliza **`fileStorage` de `src/main/memory.js`**, con el mismo mecanismo temporal + rename; no reemplaza ni migra los archivos EVO.
3. `src/main/main.js`: instancia el servicio junto al EVO existente; observa texto original después de `Engine.prepare`; observa el último turno de usuario desde la vista literal validada y antes de la captura EVO, sin depender de su resultado; valida frame principal, tipo de webContents y propiedad del guest. Libera referencias por pestaña al destruirla. No se modifica el lector, el transporte CDP, el contador ni el guard.
4. `src/ui/shell/understandingPanel.js`: inspector/control de comprensión integrado al rail, menú y buscador de comandos. Reutiliza BLACK & ELECTRIC BLUE y las superficies existentes. Objetivo, reglas, procedencia, certeza, vigencia, historia, incertidumbre, preguntas concretas, consulta explícita a EVO, selección de contexto y eliminación.
5. Puente `src/preload/shell.cjs`: API de comprensión sólo para la shell; no se agrega API privilegiada al preload web. La preview avisa que el estado requiere Electron, sin simular persistencia.

### Contrato estructurado

```text
schema_version, context_id, revision
user_goal, current_task
subgoals[], active_instructions[], explicit_constraints[]
preferences[], relevant_context[], confirmed_decisions[]
pending_questions[], progress[], uncertainty[]
goal_history[], instruction_history[], seen_messages[]
last_interaction, last_context_update
```

Los elementos conservados tienen ID, texto, origen/canal/identidad de mensaje/URL, estado, certeza, alcance, prioridad y fechas. Las preguntas tienen propuesta concreta o faltante, IDs de conflicto, procedencia, fecha y resolución. La incertidumbre referencia la tarea o pregunta que la origina. `explicit` significa declaración literal observada o ingresada; **no significa hecho factual verificado**. `confirmed` indica una aceptación específica en el panel; tampoco verifica la verdad de una memoria. `inferred` identifica la tarea/relación estimada por reglas locales.

Jerarquía expuesta: políticas del sistema/seguridad → objetivo explícito → restricciones explícitas → instrucciones vigentes → decisiones declaradas → preferencias → inferencias. Las políticas no son editables desde el panel. Las preferencias no entran en el mecanismo que sustituye reglas superiores. Esta jerarquía organiza la interpretación y las actualizaciones de esta capa; no constituye un sistema de autorización del navegador ni garantiza que el proveedor de IA respete las reglas.

### Objetivo, tarea y actualización

- El editor de objetivo conserva exactamente el texto ingresado, incluidos espacios y saltos. No lo resume ni lo limita a los 2.000 caracteres del expediente anterior.
- En mensajes reconoce encabezados como `Mi objetivo principal: …`, `Mi objetivo es …`, `Cambio de objetivo: …` o `Cambiá mi objetivo a …`. Conserva el cuerpo literal de la declaración, no una reformulación; el encabezado/separador no forma parte del objetivo.
- Una nueva declaración de objetivo cuando ya existe otro no lo sustituye sin más: genera una propuesta. Un cambio inequívoco o el editor explícito sí actualiza y conserva historia. Las propuestas viejas de objetivo se invalidan ante una actualización explícita posterior.
- Una aclaración reconocida conserva contexto explícito o clasifica la regla que contiene; no resuelve referencias inciertas por suposición. Añadir una preferencia, restricción o regla incidental tampoco sustituye la tarea en curso.
- Una tarea intermedia no reemplaza el objetivo. El texto de la última tarea se conserva como inferido; al reiniciar se indica como último conocido. `continuemos`, `retomemos`, `siguiente paso` y otras referencias reconocidas reutilizan esa tarea sin inventar pasos, resultados o avance.
- `Subobjetivo:`, `Instrucción:`, `Restricción:`, `Preferencia:`, `Decisión confirmada:`, `Avance:`, `Problema pendiente:` y `Referencia:` admiten declaraciones revisables. También se reconocen familias acotadas de imperativos y prohibiciones. El panel permite categorizar cualquier texto que las reglas no reconozcan.
- `Reemplaza «Usa español» por «Usa inglés»` exige una única coincidencia de la instrucción anterior; la sustituye con historia. Una referencia no identificable pide aclaración. Una actualización inequívoca de idioma al mismo nivel puede reemplazar la anterior; no elimina restricciones superiores.
- `Pregunta independiente: …` o `Solicitud independiente: …` se interpretan sin modificar el contexto activo. No se afirma detección automática general de cambio de tema. Conversaciones distintas quedan separadas por identidad; compartir un proyecto requiere selección explícita de contexto.
- Un `sí`, `dale`, rechazo o aprobación observado no acepta automáticamente una propuesta local: puede responder a otro modelo. No autoriza acciones sensibles. Una aclaración necesita texto o la confirmación de una pregunta concreta.

### Contradicciones, ambigüedades y selección

El comparador detecta acciones opuestas de modificación/ejecución/borrado sobre un mismo objeto normalizado y selecciones de idioma incompatibles. Ejemplo probado: `No modifiques la funcionalidad` frente a `Modifica la funcionalidad`. Conserva la restricción vigente y formula una pregunta con ambas indicaciones. La aceptación explícita de esa pregunta puede sustituir las reglas concretas referenciadas; el rechazo no las cambia.

Faltantes materiales reconocidos: no hay objetivo, no hay tarea para retomar, no hay configuración confirmada que reutilizar o no se identifica qué corregir. Los detalles menores no generan una pregunta por defecto. Preguntas relacionadas sólo reciben una relación tentativa, nunca una confirmación inventada.

Se excluyen bloques de código, líneas de cita y secciones explícitas de ejemplos del extractor de reglas. No se guarda una transcripción nueva: se conservan el objetivo, categorías reconocidas, última tarea, historia de cambios, preguntas y hashes de identidad. La proyección `effectiveUnderstanding` filtra elementos obsoletos y presenta únicamente contexto vigente/revisable. No existe todavía selección semántica general ni presupuesto de inyección de esta capa.

## Integración real, deduplicación y continuidad

- `nexo:prepare` puede no terminar en un envío. Se registra con origen **prepare**, nunca como envío confirmado; no se incrementan contadores por comprender. UUE observa independientemente de EVO y también cuando la preparación retorna `disabled` por mediación apagada, conservando la exclusión de rutas de autenticación y la validación del guest/frame.
- La captura ChatGPT mantiene sus validaciones, contenido y persistencia anteriores. UUE consume la vista literal en vivo ya validada, disponible aun con EVO apagada, y también el snapshot de persistencia antes de comprobar el interruptor o resultado EVO. Ambos caminos usan la deduplicación existente de UUE, sin lecturas DOM, publicaciones IPC ni capturas EVO nuevas. El consumidor toma **sólo el último turno con rol user**, con identidad estable; no interpreta respuestas del assistant como órdenes y omite turnos recortados. No recorre toda una conversación histórica para activar reglas antiguas fuera de vigencia.
- El servicio correlaciona hashes del original y del texto realmente preparado para que la relectura de un prompt mediado no interprete bloques añadidos por NEXO como instrucciones nuevas. Reconocida la equivalencia, sólo confirma la identidad del snapshot en el registro de deduplicación. Si hay bloques NEXO/EVO y no existe un original inequívoco asociado, omite la interpretación y lo informa: no intenta reconstruir un objetivo inventado quitando texto a ciegas.
- Un snapshot ya conocido no se aplica repetidamente, incluso después de reiniciar, dentro de la ventana persistida de identidades. No se modifican el mecanismo de lectura, las estrategias DOM, el transporte CDP ni la deduplicación de contadores existente.
- Identidad: proyecto EVO al arrancar + origen/ruta de la conversación. Se omiten query y hash. Raíces sin identidad tienen contexto temporal por pestaña/sesión; se pueden recuperar explícitamente mediante el selector. Sólo se migra una raíz a una primera ruta conversacional identificable **del mismo origen**, sin sobrescribir un contexto existente o eliminado. No se arrastra el objetivo a otra web o a ajustes.
- El mismo contexto guardado se recupera por URL identificable entre sesiones. Para continuar en otra conversación se elige un contexto existente; la vinculación explícita dura hasta cambiar de documento/ruta o cerrar esa pestaña. No se cambia silenciosamente el `projectId` global de EVO.

## EVO MEMORY sin duplicación

`recall` y `list` son las interfaces existentes. La disponibilidad de EVO se consulta mediante `memoryEnabled`; el parámetro anterior `enabled` se conserva como alias compatible exclusivamente para antecedentes, no para detener UUE. La observación y persistencia UUE permanecen activas. Con EVO desactivada no se llama a `list` ni `recall` desde UUE, no se muestran textos de referencias y no se aceptan vínculos a memorias; las referencias propias se conservan sin reimportarlas y pueden volver a consultarse al reactivar EVO. La búsqueda local se solicita explícitamente, devuelve hasta seis candidatos de objetivo/restricción/tarea/decisión/preferencia y crea preguntas de vinculación; **no activa instrucciones a partir de memorias destiladas**.

Se guardan IDs/proyecto/tipo de referencia, no una copia de sus textos. El panel consulta la disponibilidad/texto actuales de EVO para mostrarlos como antecedentes **no verificados**. Confirmar un vínculo sólo agrega una referencia contextual. Si la memoria se olvida o desaparece, la propuesta no puede aceptarse y el contenido no se restaura desde UUE. El borrado de comprensión no borra EVO; sus controles de borrado siguen separados.

## Persistencia, privacidad y control

Archivo local por proyecto: `userData/nexo-understanding-<hash-proyecto>.json`. Escritura síncrona temporal + rename con el adaptador ya utilizado por EVO. Se confirma el cambio de estado sólo tras escritura exitosa; un fallo conserva el estado previo y se informa. Archivo corrupto, demasiado grande o incompatible bloquea lectura/escritura sin sobrescribirlo. No hay recuperación automática, cifrado adicional, fsync, bloqueo entre procesos ni borrado seguro.

Alcance `project`: activo hasta actualización o retirada explícita. Alcance `session`: expira al reiniciar y queda obsoleto en historia; si ésta está llena se conserva obsoleto en su categoría, nunca activo ni perdido, sin volver ilegible el archivo. La última tarea se retiene como referencia inferida. Preferencias no detectadas explícitamente no se generan por adivinación.

Límites explícitos, no resúmenes silenciosos:
- 200.000 caracteres por texto; 2 millones por contexto serializado; 8 MB UTF-8 por archivo.
- 50 contextos guardados; 200 entradas por categoría; 50 objetivos anteriores; 400 entradas de historia de reglas; 100 preguntas conservadas.
- 2.048 identidades recientes por contexto (FIFO de hashes, no reglas). Fuera de esa ventana una lectura muy antigua podría reinterpretarse. Al alcanzar límites de reglas/historia/preguntas se rechaza la actualización y se informa; no se podan reglas activas para hacer espacio. Puede ser necesario eliminar un contexto de forma explícita.

Los seis IPC (`read`, `edit`, `recall`, `contexts`, `bind`, `clear`) exigen URL exacta de shell, frame principal, ventana registrada y guest propietario. La revisión evita escrituras obsoletas. Borrado con diálogo nativo y nueva comprobación de pertenencia/documento/revisión. El borrado deja una marca de exclusión y detiene reimportación automática de ese contexto hasta una edición explícita. No es borrado seguro del disco ni elimina exportaciones/copias.

El evento de actualización transmite únicamente ID/revisión/indicador de pregunta, no el texto privado. El panel usa nodos/textContent, no HTML suministrado por mensajes. Borradores locales a la ventana, separados por contexto; no se envían al sitio. No hay nuevos envíos externos ni llamadas ocultas a modelos.

La autoridad del texto observado sigue siendo **observed-user-text**; el servicio no prueba criptográficamente que un humano lo escribió ni protege contra la propia página del proveedor comprometida. Los cambios hechos en el panel tienen procedencia distinta **user-confirmed-input**. Comprender/confirmar una referencia no autoriza acciones del sistema.

## Validación reproducible

Los resultados finales y el manifiesto están en `NEXO-CAPA1-VALIDACION.md` y `NEXO-CAPA1-ARCHIVOS.txt`.

Nueve escenarios ejecutables en `test/user-understanding.test.js`:

| Escenario | Comprobación |
|---|---|
| 1. Objetivo extenso | Texto de más de 2.000 caracteres, saltos y espacios exactos; no lo sustituye una tarea. |
| 2. Restricciones persistentes | Modificación, ejecución y borrado se mantienen; preferencia no las sustituye. |
| 3. Tarea intermedia | Objetivo conserva identidad; subobjetivo separado y tarea inferida referenciada. |
| 4. Corrección | Sustitución literal única, vigencia nueva e historia anterior. |
| 5. Retomar | Archivo real y nuevo servicio: objetivo, tarea y restricciones sobreviven; sin progreso inventado. |
| 6. Solicitud independiente | Sin cambios al estado; conversaciones aisladas; vinculación explícita comprobada. |
| 7. Contradicción | Pregunta específica; conserva regla hasta aceptar el cambio concreto; «sí» genérico no basta. |
| 8. Cambio de objetivo | Cambio inequívoco conserva historia; nueva declaración dudosa pregunta; recuperación del original. |
| 9. Confirmado vs inferido | Tarea incierta separada de decisión explícita; referencia EVO pendiente/confirmada no se vuelve regla. |

Además: revisión obsoleta, límites sin truncamiento, expiración temporal, fallo disco/corrupción, citas/código, deduplicación persistente, eliminación sin reintroducción, aislamiento de navegación, prompts mediados, memoria olvidada, main/IPC real contra Electron stub y contratos de UI/empaquetado.

## Límites y prueba manual pendiente

No se verificó visualmente Electron, cuenta real, navegación real, reinicio de aplicación real ni instalador Windows de esta versión. El build de inyección y los tests Node/stub no sustituyen esas comprobaciones. No se midieron reducción de errores, falsos positivos con usuarios, latencia real o carga de disco. No hay cron/job de revisiones.

Cuando un proveedor distingue conversaciones sólo por query/hash o mantiene la misma URL al iniciar otra, la identidad automática de esta capa no puede separarlas con garantía: usar otra pestaña o elegir/editar el contexto explícitamente. El cambio dinámico de proyecto EVO no se incorpora aquí; se utiliza el proyecto de la instancia al arrancar.

No detecta todas las instrucciones implícitas, objetivos sin declaración identificable, referencias libres, sarcasmo, negaciones compuestas, contradicciones por sinónimos ni cambios temáticos arbitrarios. Una frase no reconocida puede permanecer como última tarea inferida; debe revisarse/categorizarse en el panel. No integra un modelo semántico externo ni lo simula.

Las preguntas se notifican en el acceso Comprensión y se muestran al abrir el inspector; no bloquean ni cancelan el envío al proveedor. Esta capa ofrece control y representación, **no mediación completa ni garantía de cumplimiento**. El estado aún no se inyecta en prompts ni reemplaza el contexto EVO existente. No empezar una capa posterior hasta validar este alcance real y los gates manuales.

Gate manual recomendado: abrir Comprensión en Electron → fijar un objetivo extenso → enviar una restricción → comprobar origen y literal → generar contradicción y revisar pregunta → rechazar/confirmar propuesta concreta → cambiar de conversación y comprobar aislamiento → elegir contexto previo → reiniciar y revisar continuidad/vigencias → consultar y olvidar referencia EVO → borrar contexto y verificar que el lector no lo recrea. Revisar además que conteos, captura y comportamiento anterior continúan intactos.


## Corrección localizada posterior — independencia de EVO (misma versión 0.1.33)

La implementación inicial condicionaba UUE al interruptor y a `result.ok` de EVO.
La primera corrección eliminó ese acoplamiento desde main y mantuvo el lector sin
cambios, usando la vista en vivo como entrada UUE con EVO apagada. El ajuste
posterior solicitado modifica únicamente el lector existente y el recibo IPC:

- `watchChatGptConversation` usa `isEnabled: () => true`. Conserva `publishLive`,
  observadores y navegación; **no existe un segundo lector**.
- Cambiar ajustes a memoria desactivada ya no cancela la cola de snapshots UUE.
  La cola existente agrupa durante 500 ms; desconectar sigue cancelándola.
- Main valida el emisor/documento y observa con UUE antes de cualquier condición
  de captura EVO. Un subframe o fuente no autorizada no confirma observación.
- Con EVO apagada, un snapshot recibido/procesado o reconocido como duplicado
  retorna `{ ok: true, observed: true, memoryDisabled: true }` sin capturar EVO.
  El duplicado confirma entrega pero no agrega revisión ni registro.
- Sin usuario válido, con recorte, rechazo de fuente u otro fallo UUE se devuelve
  `ok: false`, `observed: false` y un motivo (`skipped`, y `error` si corresponde).
  Así el lector conserva su mecanismo de reintento ante entrega no confirmada.
- Con EVO activa, su resultado/captura conservan el comportamiento anterior;
  se agrega `observed` y, si aplica, `observationSkipped` para distinguir la
  recepción UUE de la captura EVO. Una falla EVO no borra el estado UUE.

No cambian nombres ni se duplican canales IPC. Este ajuste de confirmación es
intencional: sustituye la respuesta negativa que antes se daba con EVO apagada.
La clasificación de UUE, esquema, persistencia, interfaz, preload general,
Engine/guard, CDP, tokens y contadores no se modifican. La configuración EVO se
consulta sólo para sus capturas y antecedentes: nunca se activa internamente.

La persistencia UUE sigue usando su propio archivo y el adaptador ya existente,
sin migración ni cambios de persistencia general. Se conservan también sus
salvaguardas: sólo fuentes admitidas, recortes omitidos, aislamiento y exclusión
tras borrado explícito. Independencia de EVO no implica levantar esos controles.
Resultados nuevos, archivos y límites en [validación](NEXO-CAPA1-VALIDACION.md#corrección-de-independencia-uueevo--auditoría-local-posterior).


### Validación posterior del lector y confirmación IPC

Se ejecutaron en orden la prueba específica de independencia (8/8), `npm test`
(788 totales: 787 aprobadas, 0 fallidas, 1 omitida) y `npm run build:inject`
(correcto). La prueba usa el lector real, espera la cola real de 500 ms y los
sondeos posteriores, verifica estado y archivo UUE, ACK positivo, reintento de un
ACK negativo, cero capturas/recuperaciones EVO, contador sin cambios y revisión
sin duplicados. EVO permanece desactivada durante esas comprobaciones.
No equivale a prueba visual de Electron real: véase el informe de validación.

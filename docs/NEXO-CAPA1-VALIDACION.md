# Capa 1 — Validación de NEXO 0.1.33

Rama de trabajo: `arena/4678aef7-navegador`. La validación de implementación se realizó localmente antes de su publicación, sin ejecutar CI. El commit y push posteriores fueron autorizados expresamente por el usuario; su SHA queda registrado en Git. No se inició la segunda capa.

## Problema e hipótesis

Problema: la continuidad no debería convertir una tarea intermedia, preferencia, referencia destilada o interpretación incierta en un objetivo/regla nueva. Hipótesis acotada: un estado explícito y revisable puede conservar la intención en los nueve escenarios definidos y hacer visibles sus faltantes sin modificar el flujo de lectura/envío existente. Las pruebas comprueban ese comportamiento programado; no miden todavía si reduce esfuerzo o errores en uso real.

## Ejecución inicial de 0.1.33 (antes de la corrección de independencia)

| Comprobación | Resultado | Alcance |
|---|---|---|
| `node --test --test-reporter=tap` | **778 pruebas: 777 correctas, 0 fallidas, 1 omitida, 0 canceladas** | Suite Node completa sobre la fuente final; incluye modelos, EVO, capturas, contadores, contratos, menús, empaquetado estático y main con Electron stub. 98.648,478846 ms. |
| Nuevas pruebas UUE | **29/29 correctas** | 25 en `test/user-understanding.test.js` y 4 en `test/user-understanding-main.test.js`, incluidas en el total anterior. No son sesiones de Chromium. |
| Nueve escenarios solicitados | **9/9 correctos** | Fixtures explícitos descritos abajo; no un porcentaje de precisión semántica general. |
| `npm run build:inject` | Correcto | Generación de `inject.js`: 53,7 kB / 19,3 kB gzip, 11 módulos. No es build de instalador ni prueba real de inyección en un proveedor. |
| `node --check` | **148 archivos correctos** | Archivos JS/MJS/CJS de src, scripts, dev y test. |
| `git diff --check` | Correcto | Sin errores de whitespace del diff. |
| ZIP | Fuente y evidencias | Integridad, contenidos y SHA-256 comprobados al generar el archivo. No incluye dependencias instaladas ni ejecutable Windows. |

La prueba omitida es **`empaquetar.mjs produce un .exe con su asar`**, que requiere `NEXO_ELECTRON_ZIP_DIR`. No se declara que se haya generado o ejecutado ese instalador.

Registros de ejecución conservados fuera del repositorio y añadidos a `validacion/` del ZIP:
- `pruebas-completas.tap`.
- `build-inject.log`.
- `chequeos.txt`.

## Escenarios de aceptación

1. **Objetivo extenso literal:** más de 2.000 caracteres, saltos, signos y espacios exactos por editor; tarea posterior conserva el objetivo. Sin resumen automático.
2. **Restricciones persistentes:** no modificar funcionalidad, no ejecutar código y no borrar información siguen presentes tras instrucciones/preferencias/tareas. Preferencia no sustituye reglas superiores.
3. **Tarea intermedia:** subobjetivo separado y tarea inferida vinculada al objetivo original; no lo reemplaza.
4. **Corrección:** coincidencia única de una instrucción literal y sustitución explícita con historia. Actualización inequívoca del mismo nivel no deja ambas instrucciones contradictorias activas.
5. **Retomar:** escritura a disco, nueva instancia del servicio, `continuemos`: objetivo/tarea/restricción se recuperan, tarea se identifica como última conocida y no aparece progreso inventado.
6. **Solicitud independiente:** estado profundo sin cambios; otra conversación no hereda el objetivo. La selección explícita de un contexto permite continuar sin cambio global de proyecto EVO.
7. **Contradicción:** oposición reconocida sobre el mismo objeto conserva la restricción y pregunta exactamente qué sustituir. Un «sí» genérico no aplica el cambio; confirmación específica sí, con historia y nueva certeza.
8. **Cambio de objetivo:** declaración no inequívoca produce propuesta; cambio inequívoco conserva el original en historia; es posible retomarlo. Propuestas antiguas no pueden aplicarse después de un nuevo objetivo explícito.
9. **Confirmado distinto de inferido:** tarea/relación incierta separada de decisión explícita y referencia EVO; confirmar una referencia no la convierte en regla ni verdad verificada.

## Integración adicional comprobada

- Handlers reales de producción: `nexo:prepare` → observación UUE → archivo local → inspector IPC, con guest adjunto y frame correcto. Preparar no incrementa mensajes enviados.
- Captura existente: usuario/assistant se guardan en EVO como antes; sólo el último usuario alimenta UUE. El texto del assistant no cambia el objetivo.
- Correlación de texto original y preparado: snapshot mediado no activa instrucciones añadidas por NEXO/EVO. Sin original inequívoco, omisión informada en vez de reconstrucción supuesta.
- Deduplicación de snapshot estable también tras nueva instancia, dentro del registro de identidades.
- Eliminación explícita deja exclusión; la lectura posterior no recrea el contexto. Edición explícita permite reactivarlo.
- No migrar una raíz a otro origen o a ajustes; sólo a ruta conversacional identificable del mismo origen y sin sobrescribir un contexto existente/eliminado.
- Antecedentes mediante EVO real, sólo IDs en UUE; una memoria olvidada no se copia ni reactiva al confirmar.
- Restricciones de IPC: shell exacta, frame principal, propietario del guest, categorías/operaciones permitidas y revisión. Borrado exige confirmación nativa.
- Corrupción bloquea sobreescritura; fallo de almacenamiento no confirma estado en RAM. Expiración temporal aun con historia llena conserva entradas obsoletas e inactivas, sin tornar ilegible el archivo.
- Límite de reglas rechaza la actualización sin podar reglas activas ni truncar texto.
- Citas, código y ejemplos no se convierten en instrucciones; una aclaración o preferencia incidental no sustituye la tarea actual.

## Hallazgos y correcciones durante esta entrega

- El comparador inicial no unificaba `modifiques` y `modifica`; se corrigió la familia verbal y se verificó con el escenario de contradicción.
- Una fixture inicial de EVO usaba `text` en vez de la interfaz real `content`; se corrigió la prueba, sin alterar EVO para hacerla pasar.
- El auditor estático de IPC no conocía el registrador prefijado nuevo; ahora inspecciona su allowlist y los assets del panel además del contrato existente.
- Se endurecieron, antes de la ejecución final, los límites de migración de contexto, el tratamiento del prompt mediado, las propuestas antiguas de objetivo y la expiración cuando la historia está llena. Todos quedaron cubiertos por nuevas pruebas.

No hubo fallos en la ejecución final. Esto no permite afirmar ausencia general de fallos, ni tasas de falsos positivos/negativos sobre lenguaje natural. No hay un corpus independiente ni medición con usuarios para esas métricas.

## Conservación y límites

No se modificaron `src/main/cdp.js`, `src/main/memory.js`, `src/memory/*`, `src/inject/*`, `src/preload/bridge.cjs` ni `src/core/guard.js`. El punto de consumo nuevo está en main, después de la captura existente; no es un mecanismo nuevo de lectura de ChatGPT.

El estado estructurado se usa en la observación real y en el panel de control/aclaración. **Todavía no es un nuevo contexto que el guard envíe al modelo**. No se incorpora mediación posterior, evaluación de calidad, recuperación, ejecución ni llamada a un modelo. Las aclaraciones no bloquean el envío al proveedor.

La interpretación es por reglas y vocabulario limitado, no semántica general. Límites de texto/almacenamiento, identidad por ruta, preguntas acumuladas, origen observado frente a edición humana y persistencia sin cifrado adicional se detallan en [arquitectura y uso](NEXO-CAPA1-0.1.33.md).

## Pendientes que no se dan por aprobados

- Electron real, cuenta/proveedor real y recorrido visual del nuevo inspector.
- Reinicio real de la app con varias pestañas/proyectos y condiciones de disco reales.
- Teclado/foco/accesibilidad visual y operación manual de todos los controles.
- Instalador Windows/asar real y CI de esta versión.
- Medir latencia, coste de escrituras, falsos positivos, errores omitidos, reducción de esfuerzo y utilidad real en tareas equivalentes.

Aplicar el gate manual de la arquitectura antes de declarar cerrada la validación funcional o comenzar la siguiente capa. Las pruebas y la cantidad de campos no sustituyen esa evidencia.


## Corrección de independencia UUE/EVO — auditoría local posterior

Registro histórico de la primera corrección, luego publicada como `e3bdcb0`.
El ajuste de lector/confirmación IPC descrito al final sustituye su comportamiento
de envío exclusivamente en vivo y de respuesta negativa con EVO apagada.

**Base:** commit `efa6937c2bf3a75088b76535a88322cf9a5a81f9`, rama
`arena/4678aef7-navegador`. Se conserva **0.1.33**. Esta corrección se entrega
**sin commit ni push**, por instrucción del usuario. La publicación mencionada al
principio de este documento corresponde a la implementación anterior, no a esta
corrección. No se incorpora Capa 2 ni funcionalidad adicional.

### Cambios mínimos

- `src/main/main.js`: configura la disponibilidad de antecedentes mediante
  `memoryEnabled`, sin desactivar observación UUE. Consume la vista literal ya
  validada (que el lector sigue emitiendo con EVO apagada). Observa snapshots
  antes del interruptor/captura EVO, nunca condicionado a `result.ok`. La
  preparación se observa también con mediación apagada, excluyendo autenticación.
- `src/main/userUnderstanding.js`: elimina el bloqueo de observación por EVO;
  `observationEnabled` indica true con los mismos controles de fuentes/borrado.
  Bloquea `list`, `recall` y aceptación de referencias EVO cuando está apagada.
  Conserva la firma anterior `enabled` como alias de disponibilidad de antecedentes
  y añade `memoryEnabled` para expresar inequívocamente esa responsabilidad.
- `test/user-understanding.test.js`: corrige la expectativa anterior de pausa e
  incorpora dos pruebas de disponibilidad/ausencia de EVO y reapertura del archivo.
- `test/user-understanding-independence.test.js` (nuevo): seis pruebas de main,
  consumidor del lector real contra DOM de fixture, configuración y fallos EVO.
- Documentación: este archivo, `NEXO-CAPA1-0.1.33.md` y `NEXO-CAPA1-ARCHIVOS.txt`.

No cambian el esquema ni el archivo de persistencia UUE. No se modifican el lector
ChatGPT, preload, panel Comprensión, contratos/nombres IPC, Engine, guard, CDP,
contadores, `src/main/memory.js` ni `src/memory/*`. Sólo se añade el consumidor UUE
en main; no hay lecturas, publicaciones ni capturas EVO duplicadas. Las fuentes
repetidas se deduplican por identidad/contenido usando el código UUE existente.

### Resultados de esta corrección (fuente final)

| Ejecución | Ejecutadas | Aprobadas | Fallidas | Omitidas | Canceladas |
|---|---:|---:|---:|---:|---:|
| Específicas UUE (tres archivos) | **37** | **37** | **0** | **0** | **0** |
| Suite completa Node | **786** | **785** | **0** | **1** | **0** |

Las 37 específicas incluyen **8 pruebas nuevas** de independencia (2 de servicio,
6 de integración) y la expectativa corregida; no son 37 capacidades nuevas.
Comandos ejecutados:

```sh
node --test --test-reporter=tap test/user-understanding.test.js test/user-understanding-main.test.js test/user-understanding-independence.test.js
node --test --test-reporter=tap
npm run build:inject
```

Duración registrada de suite completa: **98.137,668669 ms**. La única prueba omitida
sigue siendo `empaquetar.mjs produce un .exe con su asar`, por requerir
`NEXO_ELECTRON_ZIP_DIR`. Build de inyección correcto. Chequeos `node --check` de
**149 archivos** correctos, `git diff --check` correcto y versión paquete/lockfile
0.1.33 verificada sin modificarlos.

### Escenarios A/B/C y bordes

- **A, EVO activada:** objetivos/decisiones UUE observados y persistidos; la captura
  EVO ocurre una sola vez y aporta antecedentes mediante las interfaces anteriores.
- **B, EVO apagada:** el lector sin modificaciones emite sólo el flujo en vivo;
  main alimenta UUE y persiste objetivo/restricción. No se llama a captura EVO.
  Preparación con EVO y mediación apagadas conserva objetivo/instrucción, pero no
  ingiere autenticación. No cambian los contadores ni las memorias existentes.
  Spies de servicio comprueban cero llamadas a `list`/`recall` con EVO apagada;
  las referencias quedan no disponibles y sin texto, y no pueden aceptarse.
  También se prueba UUE sin instancia EVO y reapertura de su archivo, conservando
  objetivo, instrucciones, restricciones, preferencia, decisión y progreso.
- **C, alternancia:** desactivar/reactivar no cambia ni pierde el estado UUE;
  las referencias se ocultan y reaparecen sólo al habilitar EVO; la captura EVO
  vuelve a funcionar y un turno ya observado no se aplica dos veces.
- **Fallos EVO:** `captureConversation` devuelve `ok:false` o lanza una excepción;
  UUE ya conserva el objetivo en disco. Se mantiene el resultado/error anterior de
  captura y no se reintenta ni duplica la operación.

Registros añadidos al ZIP en `validacion-correccion/`:
`pruebas-especificas.tap`, `pruebas-completas.tap`, `build-inject.log`, `chequeos.txt`.
La comprobación de integridad del ZIP y el SHA-256 se realizan al empaquetar.

### Alcance y pendientes

Estas pruebas ejecutan código de servicio, handlers de main, lector existente y
persistencia real de archivos, pero usan **Electron stub y DOM de fixture**.
**No se probó Electron real, cuenta/proveedor real, interfaz visual ni instalador
Windows real**. No se midió rendimiento ni se afirma comprensión semántica general.
Los límites previos de interpretación, identidad, seguridad y persistencia siguen
vigentes. La corrección se entrega para auditoría; no autoriza avanzar a otra capa.


## Ajuste final — lector siempre activo y confirmación IPC de UUE

**Base:** `e3bdcb0`, rama `arena/4678aef7-navegador`, versión **0.1.33**.
El usuario solicita ahora modificar el lector existente y confirmar la recepción
UUE por la cola; no se incorpora ninguna otra funcionalidad. El commit final de
este ajuste se identifica en Git y en el informe de entrega.

### Verificación previa y cambios

La inspección confirmó `isEnabled: () => settings.memory?.enabled !== false` y
la cancelación de cola al desactivar memoria en `src/preload/chatgptReader.js`.
También confirmó que main observaba UUE antes de EVO, pero respondía negativamente
con EVO apagada, sin tener en cuenta el resultado de esa observación.

Archivos modificados:
1. `src/preload/chatgptReader.js`: `isEnabled: () => true`; no cancela la cola al
   apagar EVO. Mantiene publicación en vivo, mismo watcher, cola, observadores y
   navegación. La desconexión conserva su cancelación.
2. `src/main/main.js`: guarda el resultado de `observeConversation`; con EVO
   apagada confirma sólo recepción/procesamiento UUE o duplicado conocido mediante
   `{ ok: true, observed: true, memoryDisabled: true }`. Los rechazos indican
   `observed: false` y motivo. La captura EVO queda después de ese retorno.
   Con EVO activa conserva su resultado y agrega el indicador `observed`.
3. `test/user-understanding-independence.test.js`: amplía la prueba del lector
   existente y agrega casos de recibo, fuente inválida, ausencia de usuario válido,
   recorte y reintento real de la cola ante ACK negativo.
4. `docs/NEXO-CAPA1-0.1.33.md`: actualiza el funcionamiento del lector y ACK.
5. `docs/NEXO-CAPA1-ARCHIVOS.txt`: manifiesto de este ajuste.
6. Este documento: método, resultados y alcance de validación.

No hay cambios de clasificación, interfaz, servicio/persistencia UUE, esquema,
cola de agrupación, preload general, CDP, tokens ni contadores. No se activa EVO
internamente ni se crea otro lector/canal. Se conservan las comprobaciones de URL,
fuente y frame: un subframe no se acepta como documento principal de UUE.

### Ejecuciones reales, en el orden solicitado

| Comando | Total | Aprobadas | Fallidas | Omitidas | Canceladas |
|---|---:|---:|---:|---:|---:|
| `node --test --test-reporter=tap test/user-understanding-independence.test.js` | **8** | **8** | **0** | **0** | **0** |
| `npm test` | **788** | **787** | **0** | **1** | **0** |

- Específica: **4.260,107058 ms**; temporizadores reales, no un avance ficticio de
  reloj. Se esperan 550 ms por lote de 500 ms, otro sondeo para comprobar que no
  hay reenvíos tras el ACK y un ciclo real de reintento ante ACK negativo.
- Suite completa: **104.124,532483 ms**. La única omitida continúa siendo
  `empaquetar.mjs produce un .exe con su asar`, que requiere
  `NEXO_ELECTRON_ZIP_DIR`.
- Después de la suite: `npm run build:inject` **correcto**, 53,7 kB / 19,3 kB gzip,
  11 módulos. Sin regresiones detectadas en estas ejecuciones.

### Aceptación automatizada

Durante la prueba de independencia se mantienen `enabled: false` y
`memory.enabled: false`, y se comprueba el ajuste antes y después de esperar los
lotes/sondeo. No se reactiva EVO hasta la limpieza final de la prueba.

1. El mismo lector DOM publica inmediatamente por el canal en vivo y, tras la
   espera real, por el canal de snapshots existente.
2. Main responde positivamente con `observed: true` y `memoryDisabled: true`.
3. El objetivo y la restricción aparecen en el estado consultado por el panel
   Comprensión; la revisión aumenta una sola vez por turno y el archivo UUE
   coincide exactamente con ese estado.
4. Métodos EVO de captura y recuperación están interceptados para fallar si se
   llaman durante esa prueba; no se llaman. Tampoco cambian las memorias previas.
5. No cambian mensajes, respuestas, tokens de entrada/salida ni resultados de
   turnos por esta observación.
6. Los dos canales, un envío repetido y el sondeo no duplican revisión/registros.
7. Un ACK negativo provoca reintento por la cola real; el siguiente recibo positivo
   confirma entrega sin duplicar UUE. Un usuario ausente/recortado, URL distinta,
   frame ajeno, frame ausente o shell no reciben una confirmación UUE falsa.
8. Las pruebas previas con EVO activa, alternancia y fallo de captura EVO siguen
   aprobadas dentro de la específica y de la suite completa.

Registros en el ZIP: `validacion-observacion/prueba-independencia.tap`,
`validacion-observacion/npm-test.tap`, `validacion-observacion/build-inject.log`
y `validacion-observacion/chequeos.txt`.

### Lo que no se probó

No se ejecutó Electron real ni se envió un mensaje desde una cuenta ChatGPT real.
Se usaron el lector y handlers de producción con DOM de fixture, Electron stub y
archivos reales. La actualización visual del panel, foco, navegación real y el
instalador Windows quedan pendientes de prueba manual. No se afirma rendimiento,
precisión semántica general ni validación de otra capa. No se modificó la UI para
esta entrega; la prueba verifica el estado y la persistencia que ella consulta.


## Comprensión por etapas — primera entrega posterior

Véase [plan, arquitectura y validación de etapa 1](NEXO-COMPRENSION-ETAPAS.md).
Se añadieron observación incremental de usuarios, extractos del asistente sin
autoridad normativa y renovación automática agrupada del inspector, sin modificar
la clasificación actual ni incorporar un modelo semántico. EVO sigue siendo
opcional. El nuevo registro observacional es aditivo y validado, sin reemplazar
la representación normativa ni los archivos EVO.

Resultados ejecutados: **62/62 focalizadas**; `npm test`: **802 totales, 801
aprobadas, 0 fallidas y 1 omitida** (empaquetado Windows real). Build de inyección
correcto. Las 14 pruebas nuevas se enumeran en el documento de etapas. No hubo
validación visual en Electron real ni prueba con cuenta ChatGPT real. No se
declaran satisfechos los 72 requisitos: sólo la primera base observacional, con
las limitaciones semánticas y de ventana allí detalladas.


## Comprensión por etapas — segundo bloque posterior

La [etapa 2 de objetivos y ciclo de vida](NEXO-COMPRENSION-ETAPAS.md#etapa-2-implementada--objetivos-y-ciclo-de-vida)
añade independientes, candidatos inferidos revisables, cierres/reapertura,
historia y controles del panel sin ejecución ni dependencia de EVO. El registro
aditivo es compatible con archivos previos. No borra ni reemplaza la evidencia
histórica de arriba.

Resultados de esta iteración: **90/90 focalizadas**; suite completa **830 totales,
829 aprobadas, 0 fallidas y 1 omitida** (empaquetado Windows real). Build de
inyección correcto. 28 pruebas nuevas; el test del panel usa DOM mínimo de fixture
y el flujo main usa Electron stub. No se probó Electron real ni una cuenta real.
Restan los bloques 3–7 y los gates manuales documentados; no son 72 requisitos
completados.


## Comprensión por etapas — tercer bloque posterior

La [etapa 3 de reglas, preferencias, decisiones y vigencia](NEXO-COMPRENSION-ETAPAS.md#etapa-3-implementada--reglas-preferencias-decisiones-y-vigencia)
conserva categorías/prioridades, añade propuestas revisables y edición explícita
de reglas con historia. Corrige el retiro prematuro de una regla cuando su
reemplazo entra en conflicto. La confirmación revalida referencias actuales;
preferencias no retiran obligaciones y decisiones no prueban ejecución.

Resultados de esta iteración: **118/118 focalizadas**, suite completa **859 totales,
858 aprobadas, 0 fallidas y 1 omitida** (empaquetado Windows real). Build de
inyección correcto. Se añaden 28 pruebas de comportamiento y se comparte el DOM
mínimo de fixture, contado también por el runner completo. No se probó Electron
real, Windows real ni una cuenta ChatGPT. La gramática y los alcances son limitados;
ver el documento de etapas para compatibilidad, límites y gates manuales. Restan
los bloques 4–7, sin proclamar completados los 72 requisitos.


## Comprensión por etapas — cuarto bloque posterior

La [etapa 4 de tareas, relaciones y siguiente paso](NEXO-COMPRENSION-ETAPAS.md#etapa-4-implementada--tareas-relaciones-y-siguiente-paso)
añade seguimiento explícito dentro del UUE: tareas/subtareas, dependencias sin
ciclos, prioridad y orden, resultado esperado, estados declarados, foco y próximo
paso acordado. No inventa planes ni verifica ejecución; una finalización del
asistente no cambia el estado declarado por el usuario.

Resultados: **146/146 focalizadas**; suite completa **887 totales, 886 aprobadas,
0 fallidas y 1 omitida** (empaquetado Windows real). Build correcto. 28 pruebas
nuevas de comportamiento; DOM mínimo/puente de fixture y Electron stub, sin prueba
visual en Electron/Windows real ni cuenta ChatGPT. Compatibilidad, límites,
corrupción, fallo de disco, reinicio, EVO apagada, aislamiento y seguridad IPC
están detallados en el documento de etapas. Restan los bloques 5–7 y los gates
manuales; no se proclaman completados los 72 requisitos.


## Comprensión por etapas — quinto bloque posterior

La [etapa 5 de proyectos, referencias y selección de contexto](NEXO-COMPRENSION-ETAPAS.md#etapa-5-implementada--proyectos-referencias-y-selección-de-contexto)
añade etiquetas locales, alias actuales, inspección y vínculos de antecedentes
sin autoridad normativa. Elegir otro contexto es explícito, reversible y temporal;
la línea base evita reimportar sus mensajes históricos. Cambios/borrados del origen
invalidan la versión vinculada; renovar exige revisar y confirmar de nuevo.

Resultados: **175/175 focalizadas**, suite completa **916 totales, 915 aprobadas,
0 fallidas y 1 omitida** (empaquetado Windows real). Build correcto. 29 pruebas
nuevas de comportamiento, con servicio/archivos, DOM mínimo y Electron stub; sin
prueba visual en Electron/Windows ni cuenta real. La gramática, versiones y selección
tienen los límites y gates manuales del documento de etapas. Restan los bloques
6–7: no se declaran completados los 72 requisitos ni se añade ejecución autónoma.


## Comprensión por etapas — sexto bloque posterior

La [etapa 6 de progreso, problemas y evidencia](NEXO-COMPRENSION-ETAPAS.md#etapa-6-implementada--progreso-problemas-y-evidencia)
añade registros explícitos, asociación opcional por ID a tareas/objetivos, resolución
y reapertura de problemas con motivos e historia, propuestas evaluables y evidencia
aportada. Los resultados son declaraciones, no comprobaciones. La captura manual de
un extracto del asistente usa la observación existente, conserva su autoría y fija
su versión; no se acepta como instrucción, decisión ni prueba de ejecución.

Resultados: **210/210 focalizadas**; suite completa **951 totales, 950 aprobadas,
0 fallidas y 1 omitida** (empaquetado Windows real). Build correcto. Se añaden 35
pruebas de comportamiento: 31 core/servicio, 2 de panel y 2 main/IPC. Se comprueban
capacidades sin poda, compatibilidad, corrupción, disco/reintento, reinicio,
tombstones, aislamiento, EVO apagada, versiones observadas, autoría y permisos.
Fixtures DOM/Electron stub no prueban Electron/Windows real ni una cuenta real.
Restan el bloque 7 y los gates manuales: no se declaran completados los 72 requisitos.


## Comprensión por etapas — séptimo bloque y revisión final

La [etapa 7 de inspector y revisión](NEXO-COMPRENSION-ETAPAS.md#etapa-7-implementada--inspector-explicación-y-revisión-humana)
consolida el índice paginado/filtrado, procedencia, certeza, estado y explicaciones
de alcance. Se puede confirmar/corregir/rechazar la última solicitud inferida,
anotar una corrección de intención y corregir datos simples conservando originales.
No ejecuta mensajes ni revierte otras categorías por una anotación de intención.

Resultados finales: **242/242 focalizadas**, suite completa **983 totales,
982 aprobadas, 0 fallidas y 1 omitida** (empaquetado Windows real). Build correcto.
32 pruebas nuevas: 26 core/servicio/IPC aislado —una de ellas recorre los siete
bloques—, 4 de panel y 2 main/IPC con Electron stub.

La [revisión final transversal](NEXO-COMPRENSION-REVISION-FINAL.md) detalla las
correcciones de callbacks obsoletos/navegación durante peticiones, conservación de
solicitudes confirmadas y revalidación de identidad/propiedad para recuperación y
borrado. Se conservan EVO opcional, roles, permisos, aislamiento y cola/ACK.
Cierra el desarrollo en siete etapas dentro del alcance local probado; **no es
validación en Electron/Windows/cuenta real ni certificación de los 72 requisitos
como comprensión semántica universal**. No hay ejecución autónoma.

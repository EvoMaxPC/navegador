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

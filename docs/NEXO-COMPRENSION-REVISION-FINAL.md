> **Documento histórico del módulo retirado.** No describe el funcionamiento actual.
> El reemplazo está documentado en [Comprensión: optimización conversacional](NEXO-COMPRENSION-OPTIMIZACION.md).
> Los archivos de datos históricos del usuario no se han borrado ni migrado.

# NEXO Comprensión 0.1.33 — cierre de siete etapas y revisión transversal

## Estado de la entrega

Desarrollo en siete etapas finalizado dentro del alcance local descrito en
[NEXO-COMPRENSION-ETAPAS.md](NEXO-COMPRENSION-ETAPAS.md). Se mantiene Electron,
versión 0.1.33, UUE existente, observación con EVO apagada y separación entre
comprender, proponer, confirmar y ejecutar. No se habilita ejecución autónoma.

**No se certifica comprensión semántica universal de los 72 requisitos ni se
sustituye validación en Electron/Windows/cuenta real con fixtures.** Las bases
implementadas y las limitaciones deben leerse juntas.

## Revisión funcional de las siete bases

| Bloque | Base integrada y revisada | Límite que permanece |
|---|---|---|
| 1. Observación | Roles explícitos, nuevos usuarios en orden, ledger/cursor, stream separado, actualización del panel | Ventana de 24; no recupera lo nunca observado ni interpreta universalmente respuestas/incompletos |
| 2. Objetivos | Objetivo literal, independientes, candidatos confirmables, cierre/reapertura con historia | Gramática ES/EN acotada; no sustituye el principal desde una inferencia |
| 3. Reglas | Restricciones/instrucciones/decisiones/preferencias separadas, conflictos reconocidos, alcance/vigencia/historia | Detección de contradicciones no universal; preferencia nunca es permiso |
| 4. Tareas | Subtareas/dependencias sin ciclos, prioridad/orden, foco/paso explícitos, estados declarados | No inventa plan ni verifica ejecución; elegibilidad sólo estructural |
| 5. Contextos | Etiquetas locales, alias, inspección, antecedentes con revisión/huella, selección explícita/línea base | No hay gestor global de proyectos ni fusión semántica; un nombre igual no comparte reglas |
| 6. Progreso | Registros y propuestas, problemas, evidencia aportada, captura explícita de extracto del asistente | Todo resultado/aporte sigue no verificado; no lee rutas/URLs ni cierra tareas automáticamente |
| 7. Inspector | Índice filtrado/paginado, origen/estado/certeza, explicaciones de alcance, revisión/corrección con historia | Explicaciones deterministas, no razonamiento retrospectivo ni anotaciones que reejecutan mensajes |

La tabla de etapas mantiene los 72 números distribuidos una vez como trazabilidad,
no como puntuación de semántica o prueba de utilidad real.

## Fallos concretos corregidos durante el cierre

1. **Acciones de UI descartada:** formularios/botones capturan la vista original y
   rechazan callbacks después de renderizar otra. No pueden heredar el contexto o
   revisión más nuevos para guardar un texto viejo en otro trabajo.
2. **Respuesta diferida después de navegar dentro del mismo guest:** generación de
   navegación, descarte de resultado viejo y renovación posterior. No se pierde el
   cambio de contexto porque el panel estuviera ocupado; sin pestaña se limpia la vista.
3. **Identidad en recuperación/borrado:** la UI incluye contexto esperado y main lo
   comprueba además de revisión. El borrado vuelve a resolver propiedad del guest
   tras el diálogo nativo; desvincularlo/cerrarlo impide eliminar datos.
4. **Solicitud confirmada perdida al sustituir/limpiar:** ahora se archiva antes de
   nueva solicitud interpretada, cambio o cierre del objetivo. Historia llena
   rechaza sin poda. Las inferencias transitorias no revisadas no producen un transcript.

Se reforzó también la validación de revisiones: rol, motivo, IDs anterior/nuevo,
fuente original, anotación ligada al mensaje original y su evento histórico.
La certeza `uncertain` previa sigue siendo válida para aprobaciones ambiguas.

No se afirma que se hayan encontrado o eliminado todos los fallos posibles del
navegador o que la suite demuestre ausencia de bugs.

## Invariantes comprobadas

- **EVO opcional:** comprensión y persistencia UUE siguen activas con EVO apagada;
  los escenarios nuevos usan memoria que falla si se consulta por error.
- **Roles/procedencia:** asistente observado no crea objetivos/reglas del usuario.
  Una captura manual conserva fuente `assistant` y usuario registrador separados.
- **Sin ejecución:** revisar intención, aceptar una propuesta, declarar resultado o
  aportar un log no concede permisos, envía mensajes ni completa tareas/objetivos.
- **Fuente frente a inferencia:** objetivo explícito no es sustituido por una
  interpretación; confirmar relación de solicitud exige ID activo o ninguno.
- **Persistencia:** cambios puros/transaccionales; disco fallido conserva RAM/archivo,
  reintento permitido; corrupción no se sobrescribe. Capacidad llena rechaza sin poda.
- **Historia/borrado:** versiones corregidas preservadas; retiro no es borrado físico.
  Borrado de contexto elimina sus revisiones y mantiene tombstone sin reimportación.
- **Contextos:** etiqueta/URL/selección distintas sin importación normativa; línea
  base de ventana histórica y observación por documento físico. Selección manual
  temporal; datos normativos persistentes separados.
- **Antecedentes:** cambio/borrado del origen invalida punteros versionados. La
  captura explícita de un extracto histórico es una copia acotada distinta y se
  retira/borra en su destino, sin recuperación automática de origen.
- **IPC:** shell exacta/mainFrame/guest propietario, allowlists, contexto/revisión;
  lectura de inspector sin privilegios nuevos para páginas web.
- **Integración:** lector, cola de 500 ms, ACK, mediación, CDP, permisos, aislamiento,
  tokenización, contadores y archivo EVO no se sustituyen. La suite de regresión
  conserva los casos previos, incluido el gate temporizado de observación/ACK.

## Pruebas ejecutadas

| Ejecución | Resultado |
|---|---|
| Focalizadas de UUE, observación, independencia, shell, main/IPC y siete bloques/paneles | **242/242 aprobadas** |
| Suite completa `npm test` | **983 totales, 982 aprobadas, 0 fallidas, 1 omitida** |
| Duración de la suite completa final | 103.793,03331 ms |
| `npm run build:inject` | Correcto: 53,7 kB, 19,3 kB gzip, 11 módulos |

La omitida requiere `NEXO_ELECTRON_ZIP_DIR` para empaquetado Windows real; no se
presenta como aprobada. La etapa final añade 32 pruebas: 26 core/servicio/IPC
aislado, 4 de DOM/puente y 2 de main/IPC con Electron stub.

Una prueba integral atraviesa los siete bloques y reinicio/bind/retorno/borrado,
comprobando que ni propuestas del asistente ni evidencia aportada cambian objetivo,
restricción, estado pendiente o permisos por sí solas. No son pruebas con una cuenta
real, ni con Chromium/Windows ejecutándose.

Los registros se incluyen en `validacion/etapa7-final/` dentro del ZIP de fuentes:
`pruebas-especificas.tap`, `npm-test.tap`, `build-inject.log` y `chequeos.txt`.
El último registra sintaxis, imports relativos, diff, versión, trazabilidad y enlaces.
No se guardan logs de conversaciones reales ni datos de cuenta.

## Gate manual externo pendiente

No ejecutado en este entorno:

- [ ] Instalar dependencias y abrir Electron real en Windows.
- [ ] EVO apagada: observar dos conversaciones con usuarios y asistentes reales.
- [ ] Objetivo literal + restricción + preferencia + cambio de objetivo con revisión.
- [ ] Tareas/dependencias/estados sin ejecuciones o cierres implícitos.
- [ ] Igual etiqueta en contextos distintos sin mezcla; alias y retiro visibles.
- [ ] Inspección/antecedente confirmado → cambio/borrado de origen → renovación explícita.
- [ ] Selección manual → línea base → mensaje nuevo → retorno → reinicio sin reimportar.
- [ ] Resultado parcial + problema abierto + log aportado sin abrir ruta/URL.
- [ ] Captura de asistente completo, regeneración e identidad de fuente preservada.
- [ ] Inspector: filtros/páginas/origen/certeza, revisión y corrección con motivo.
- [ ] Cambiar URL o cerrar pestaña mientras hay petición/diálogo, sin guardar en otro contexto.
- [ ] Borrado/reinicio sin reactivar reglas/revisiones retiradas ni antecedentes.
- [ ] Foco/selección de texto, scroll, teclado, accesibilidad y tema BLACK & ELECTRIC BLUE.
- [ ] Empaquetado Windows real y apertura del ejecutable resultante.

## Cierre

Se entrega fuente del proyecto completo, no un .exe Windows validado. La versión
sigue siendo 0.1.33. Los cambios se cierran con commit y push normal a la rama de
trabajo de la sesión, remoto comprobado y ZIP verificado contra sus fuentes Git.
No hay un octavo bloque pendiente de desarrollo autorizado ni un job automático;
los gates externos y límites semánticos anteriores siguen declarados.

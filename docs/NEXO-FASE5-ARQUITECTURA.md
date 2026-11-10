# NEXO · Fase 5 — arquitectura evolutiva y plan por capas

## Decisión de producto

**El centro de NEXO es la mediación entre el usuario y la IA**, con continuidad, calidad, contexto y control. El expediente de un objetivo es un soporte de esa continuidad, no el producto central ni un sustituto del motor. Permite retomar un trabajo con objetivo, criterios, fuentes, decisiones y pendientes. La adaptación comienza con preferencias declaradas, acotadas al expediente, no con inferencias sobre la personalidad.

Las prioridades y condiciones de revisión vigentes están en [Criterios rectores](NEXO-CRITERIOS-RECTORES.md). Prevalecen sobre el orden anterior de ideas funcionales: mediación → continuidad → calidad → contexto → adaptación → integración. Son responsabilidades sobre la arquitectura existente, no seis motores nuevos.

La primera capa se implementa en 0.1.32. No se inicia Knowledge semántico, Discovery ni Agent hasta cerrar la validación funcional de esta capa. No se reescribe EVO MEMORY, el lector de ChatGPT, CDP, la mediación o sus presupuestos.

## Alcance cerrado de la primera capa

Recorrido: abrir workspace → definir objetivo y criterios → asociar pestaña → seleccionar texto mediante menú nativo → revisar y confirmar cita → agregar tarea/decisión/nota → guardar dónde continuar → volver a consultar tras otro arranque.

Incluye revisiones de objetivo, referencias entre decisiones y citas, eliminación y exportación. La persistencia y la restauración del almacén se comprueban con archivos de prueba reales. La experiencia de cierre/arranque en Electron real todavía requiere validación manual.

No incluye descomposición automática, verificación factual, detección semántica de contradicciones, observación permanente de páginas, extracción masiva, comparación automática, modelo generativo, aprendizaje implícito ni agente autónomo. Los estados de tarea los declara el usuario.

## Componentes y responsabilidades

```text
Shell existente / workspace / registro Ctrl+K
  └─ src/ui/shell/workDossier.js + workDossier.css
       └─ shell preload: nexo.work (seis operaciones cerradas)
            └─ src/main/workDossier.js
                 ├─ autorización de shell y frame
                 ├─ resolución de guest a través de advancedBrowser
                 ├─ capacidades de selección nativa
                 └─ DossierStore: cola y almacenamiento local
                      └─ src/nav/workDossier.js
                           validación, mutaciones puras, exportación Markdown
```

- **Modelo:** no importa Electron, disco, memoria EVO o red. Produce un estado nuevo sin modificar el anterior. Valida contenido, límites, referencias, IDs, esquema y revisiones.
- **Servicio main:** único escritor de expedientes. Comprueba remitente, ventana, mainFrame y workspace configurado. Los recursos de pestaña se obtienen del webContents real del propietario. La selección procede del contexto nativo; no se admite una cita arbitraria enviada por renderer.
- **Almacén:** archivos independientes bajo `userData/work-dossiers/<workspaceId>.json`; temporal único y rename antes de confirmar. Una cola por instancia serializa lecturas y escrituras del proceso principal. Conflicto optimista por revisión. Los archivos corruptos/incompatibles no se reemplazan por un expediente vacío.
- **UI:** panel integrado con seis secciones: Continuar, Fuentes, Tareas, Decisiones, Notas y Control. Objetivo accesible en todas ellas. Usa texto DOM, no HTML de páginas. Borradores en RAM por workspace; no se confunden con datos guardados.
- **Navegación:** reutiliza el workspace y la sesión existentes. Abrir un recurso activa una pestaña ya presente con esa URL en ese workspace o crea una. No restaura automáticamente todos los recursos ni realiza peticiones de fondo.

## Modelo de datos v1

| Entidad | Campos y significado |
|---|---|
| Expediente | workspaceId, versión de esquema, revisión de escritura, fechas |
| Objetivo | texto, criterios explícitos, revisión semántica |
| Revisiones anteriores | objetivos y criterios previos; no se descartan silenciosamente |
| Continuación | próximo paso redactado por el usuario |
| Tarea | texto, estado manual pendiente/en curso/hecha |
| Recurso | URL HTTP(S), título y fecha obtenidos en main |
| Evidencia | cita literal seleccionada, fuente, fecha, método, truncado, anotación; siempre sin verificar |
| Decisión | declaración del usuario, citas opcionales, revisión del objetivo y señal de revisión pendiente |
| Nota | texto propio, no se clasifica como evidencia |
| Preferencias | citas desplegadas/contraídas y sección inicial del expediente |

Un cambio de objetivo o criterios marca las decisiones para revisión. Quitar una cita elimina su texto del expediente y retira el vínculo de las decisiones, marcándolas para revisión. No se determina que las decisiones sean incorrectas. Confirmar vigencia es una declaración del usuario, no una verificación externa.

Las tareas no se completan al visitar una página. No se muestra porcentaje de objetivo conseguido. No hay aprendizaje implícito ni preferencia global.

## Contrato IPC

Todos los canales `nexo:work:*` exigen shell exacta `nexo://app/src/ui/shell/index.html`, mainFrame y BrowserWindow real. El payload debe ser un objeto acotado y su workspace debe estar configurado.

| Canal | Operación |
|---|---|
| read | Leer expediente o devolver estado inicial si no existe archivo |
| mutate | Allowlist de cambios de objetivo, continuación, preferencias, tareas, notas, decisiones y eliminación de registro |
| attach | Asociar URL/título del guest autorizado; ignora una URL suministrada por renderer |
| capture | Consumir capacidad de selección nativa y guardar tras confirmación de la UI |
| clear | Confirmación nativa y reinicio del contenido con revisión monotónica |
| export | Formato JSON/Markdown y destino elegido por diálogo nativo, nunca por payload |

Eventos:
- `nexo:work-changed`: sólo workspace y revisión; no difunde contenido privado.
- `nexo:work-capture`: selección explícita enviada únicamente a la shell propietaria para revisión.

La acción de selección reutiliza el contexto nativo y sus controles actuales (30 segundos, URL, propietario y uso único). Después crea una capacidad independiente de confirmación de 120 segundos, un solo uso y vinculada a la shell. Se conserva una instantánea, no se vuelve a leer la página al confirmar. Nueva selección reemplaza el borrador anterior. No se genera captura de campos de contraseña.

## Privacidad y límites deliberados

- No hay solicitudes de red de la nueva capa. Abrir un recurso sí navega al sitio por acción explícita del usuario.
- No hay proveedor de IA, telemetría nueva, índice automático del historial ni permisos adicionales.
- Texto y URLs se guardan localmente sin cifrado adicional; la URL puede incluir parámetros privados y se muestra antes de conservar una cita.
- La confirmación de escritura significa que terminaron write/rename; no promete fsync ni supervivencia a toda pérdida de energía.
- El borrado vacía el archivo conservando la revisión para bloquear escrituras antiguas. No es borrado forense; no elimina exportaciones, backups del SO o textos en otras aplicaciones/ventanas.
- La cola cubre la instancia del servicio en el proceso principal, no editores externos ni procesos independientes escribiendo en el perfil.
- No se importan expedientes en esta capa. JSON exporta todos los datos; Markdown es una presentación con fuentes y advertencia de no verificación.
- Los borradores sólo viven en esta ventana y se pierden al cerrar. La UI permite descartarlos explícitamente y conservarlos durante recargas del expediente.
- No se cambia el sandbox del webview ni se amplían APIs de páginas; los límites heredados y su auditoría general siguen vigentes.

## Plan evolutivo con puertas de validación

### Capa 1 — Expediente persistente y adaptación declarativa (implementada)
Problema: se recuperan pestañas pero se pierde el trabajo.

Puerta: pruebas de modelo/disco/IPC, integración de registro y menú; recorrido manual real de guardar/cerrar/abrir; teclado, foco, varios workspaces, conflictos y disco. **La puerta funcional en Electron real sigue pendiente.** No iniciar la siguiente capa hasta cerrarla.

### Próxima capa — Contrato de interacción en la mediación existente (propuesta, no implementada)

Problema: objetivo, restricciones y criterios deben poder seguirse desde la solicitud hasta la evaluación del resultado, sin reescritura silenciosa ni contexto inventado.

Solución incremental: contrato con procedencia, alcance y revisión, conectado al circuito existente de preparación, memoria y observación. Primero diagnóstico explicable y criterios comprobables, sin nuevas regeneraciones automáticas por defecto. La recuperación posterior deberá ser autorizada, acotada y revalidada.

Puerta: intención literal preservada, restricciones esenciales retenidas, distinción entre fallo y sospecha, falsos positivos visibles, ninguna acción declarada completa sin evidencia y captura/persistencia EVO intactas. Aplicar la ficha de revisión de [Criterios rectores](NEXO-CRITERIOS-RECTORES.md).

### Evoluciones posteriores, no implementadas

- **Continuidad y contexto:** referencias explícitas a EVO, recuperación pertinente y revisión de autorizaciones, sin cambiar automáticamente projectId, mezclar proyectos o reintroducir datos borrados.
- **Calidad y recuperación:** diagnóstico con evidencia, causa conocida/desconocida, intentos limitados y comprobación posterior. No es garantía de veracidad ni comprensión general.
- **Adaptación:** preferencias con alcance y reversibilidad; patrones inferidos como propuestas revisables. No aprendizaje de permisos sensibles ni perfiles sensibles.
- **Integración:** comparación trazable, Discovery y agente acotado sólo cuando demuestren mejorar el trabajo y reducir errores. No avanzan por ser funciones nuevas.

Este orden sustituye el roadmap anterior que colocaba comparación y descubrimiento como siguientes entregas. El alcance implementado de 0.1.32 no cambia. Ninguna de estas evoluciones se declara iniciada o validada aquí.

## Criterio de profesionalidad de esta entrega

No se declara producto final ni agente inteligente terminado. Se entrega una primera sección vertical con modelo, persistencia, autorización, UI, integración, documentación y pruebas focalizadas; la validación Electron real debe preceder a ampliar el alcance.


## Actualización posterior — 0.1.33

El alcance anterior describe históricamente 0.1.32. Por autorización específica se
implementó la primera base de comprensión del usuario, no la mediación completa:
[arquitectura UUE, integración y límites](NEXO-CAPA1-0.1.33.md).
Incluye estado estructurado, observación real, revisión de incertidumbre y continuidad
con referencias explícitas a EVO, sin sustituir su persistencia ni modificar el lector.
El roadmap de arriba no debe leerse como que el nuevo módulo sigue siendo sólo una
propuesta. La evaluación de respuestas, recuperación, agentes y modelos semánticos
siguen sin implementarse. Los gates reales pendientes permanecen visibles en la
[validación de Capa 1](NEXO-CAPA1-VALIDACION.md).

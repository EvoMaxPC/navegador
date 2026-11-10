# NEXO Comprensión — desarrollo en siete etapas

## Acuerdo de alcance

Los 72 requisitos describen un objetivo amplio, no capacidades ya demostradas.
Se avanza por etapas sobre el UUE existente, sin reconstruir NEXO ni introducir
un agente ejecutor. Esta entrega implementa **sólo la etapa 1**, sobre 0.1.33.
Las seis siguientes quedan planificadas; no se declara el panel completo.

No hay modelo semántico nuevo, envíos externos, nuevos permisos ni dependencia
nueva. Las reglas actuales siguen siendo locales y conservadoras. Comprender no
significa ejecutar, aprobar una propuesta ni verificar que ChatGPT hizo algo.

## Siete bloques y trazabilidad completa

Cada número aparece una vez como responsabilidad principal; hay dependencias
entre bloques. Las funciones parciales existentes de UUE se reutilizarán.

| Etapa | Responsabilidad | Requisitos | Estado de esta entrega |
|---|---|---|---|
| 1 | Observación incremental, roles y actualización automática | 1–6, 49, 54, 58, 68 | Base implementada; límites semánticos debajo |
| 2 | Objetivo principal, múltiples objetivos, cambios y ciclo de vida | 7–12 | Siguiente etapa; reutilizar objetivo/historia actuales |
| 3 | Reglas, restricciones, preferencias, decisiones y vigencia | 13–18, 37–41, 43–44, 50–51, 53, 67, 72 | Parcial previo; falta ampliar y validar sistemáticamente |
| 4 | Tareas, subtareas, dependencias, prioridades y siguiente paso | 19–24, 34, 36 | Pendiente; no inventar plan ni ejecutar tareas |
| 5 | Proyectos, referencias, selección de contexto y antecedentes | 25–30, 47, 55–57, 59, 71 | Parcial previo; EVO opcional y referencias revisables |
| 6 | Progreso, errores, bloqueos, propuestas y evidencia de resultados | 31–33, 35, 45–46, 69–70 | Pendiente de interpretación ampliada; observar no verifica |
| 7 | Inspector completo, explicación, corrección e inferencias confirmables | 42, 48, 52, 60–66 | Controles parciales previos; consolidar tras las bases |

Cada etapa deberá cerrar con casos positivos/negativos, conservación de reglas,
independencia de EVO, pruebas de regresión y límites explícitos. No usar el número
de campos o tests como medida de comprensión semántica ni de utilidad real.

## Etapa 1 implementada

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

## Archivos de esta etapa

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

La entrega incluye un commit y push a la rama de trabajo; no se avanza a las
etapas 2–7 ni a ejecución autónoma en este cambio.

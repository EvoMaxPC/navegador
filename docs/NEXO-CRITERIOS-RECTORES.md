# NEXO — Criterios rectores de desarrollo y revisión

## Propósito

**Mediar entre el usuario y la inteligencia artificial para lograr interacciones más coherentes, eficientes, precisas y continuas.** La cantidad de funciones, paneles o modelos conectados no es una medida de éxito.

Este documento fija prioridades y condiciones de aceptación; **no declara implementadas** las capacidades propuestas. El expediente de objetivo de 0.1.32 es un soporte de continuidad y trazabilidad, no reemplaza el motor de mediación ni constituye por sí solo comprensión del usuario.

## Prioridades, en orden

1. **Mediación:** interpretar solicitudes, conservar la intención y coordinar la interacción con modelos y herramientas autorizados.
2. **Continuidad:** evitar pérdida de objetivos, instrucciones, restricciones, decisiones y avances mediante EVO MEMORY y referencias explícitas.
3. **Calidad:** detectar deficiencias observables, diagnosticar su causa e intentar una corrección acotada cuando sea seguro y esté autorizada.
4. **Contexto:** seleccionar información pertinente bajo presupuesto sin saturar ni eliminar restricciones esenciales.
5. **Adaptación:** mejorar la ayuda según la tarea y la interacción, con alcance visible, corrección y reversibilidad.
6. **Integración:** conectar navegador, modelos, herramientas y memoria para resolver problemas concretos, no para sumar integraciones.

Son responsabilidades de una misma arquitectura incremental, no una orden de crear seis motores independientes. Se reutilizan guard, preparación de prompts, observación, centinela, respuesta, memoria y compilación de contexto existentes.

## Cinco capacidades que debe orientar esta arquitectura

- **Comprensión del usuario:** distinguir objetivo explícito, instrucciones, restricciones, preferencias, contexto e interpretación provisional. Una inferencia nunca sustituye una instrucción. Si una ambigüedad afecta el resultado o la autorización, preguntar lo necesario en vez de asumir.
- **Mediación inteligente:** seleccionar una acción disponible y explicar qué contexto utiliza, qué cambiaría y qué requiere autorización. No afirmar coordinación de modelos sin un adaptador y una ejecución reales.
- **Detección y corrección:** separar evidencia de error, posible problema y limitación de observación. Corregir no es fabricar datos, cambiar el objetivo o afirmar que una tarea terminó.
- **Continuidad y memoria:** conservar procedencia, vigencia y alcance del contexto. Un dato capturado correctamente no es automáticamente verdadero. El borrado no debe provocar reintroducción de información mediante recuperación o resúmenes.
- **Experiencia adaptativa:** instrucciones explícitas primero; preferencias personales, de proyecto y de sesión diferenciadas. Inferencias de comportamiento como propuestas revisables, no reglas ocultas. No aprender permisos para futuras acciones sensibles por repetición de aceptaciones.

## Regla fundamental

**El motor no debe modificar silenciosamente el objetivo del usuario ni inventar información para corregir una respuesta.** Debe detectar el problema, determinar su causa cuando haya evidencia suficiente, intentar una solución permitida y comunicar las limitaciones restantes.

Si la causa no se puede determinar, se informa como desconocida o hipótesis. No se presenta una explicación plausible como diagnóstico probado.

## Ciclo de interacción propuesto

1. Identificar la solicitud literal y el objetivo vigente, con sus fuentes y revisión.
2. Separar requisitos obligatorios, preferencias, información disponible y faltantes.
3. Preparar un plan acotado y seleccionar contexto/herramientas existentes. Mostrar cambios relevantes y autorizaciones necesarias.
4. Ejecutar únicamente acciones permitidas; registrar evidencia de resultado, fallos y bloqueos sin volcar contenido privado en logs.
5. Evaluar la salida contra requisitos explícitos y señales observables.
6. Si hay un problema, clasificarlo y aplicar una recuperación limitada, o solicitar intervención. No reintentar indefinidamente ni repetir acciones con efectos externos.
7. Revalidar el resultado y entregar pendientes, incertidumbres y procedencia. Conservar lo necesario para continuar, respetando el alcance y los controles de memoria.

Este ciclo es un diseño de evolución. No implica que NEXO pueda interceptar toda respuesta antes de que el sitio la muestre: las capacidades dependen del canal, streaming y soporte del proveedor. La UI deberá distinguir resultado en curso, capturado, evaluado y evaluación no disponible.

## Qué se puede comprobar y qué no debe confundirse con certeza

| Caso | Evidencia posible | Conducta esperada |
|---|---|---|
| Fallo de herramienta | Error de API, timeout o resultado observable ausente | Informar fallo/bloqueo; no marcar completado por haber enviado una orden |
| Respuesta cortada | Fin de stream anómalo, estructura incompleta u otras señales | Señalar truncado confirmado o sospechado según la señal; continuación acotada, sin rellenar contenido inventado |
| Repetición | Coincidencias observadas por el centinela | Reutilizar controles existentes, sin doble contabilización ni ciclos de recuperación |
| Requisito no cumplido | Criterio verificable explícito y salida que lo incumple | Mostrar criterio y evidencia; no asumir incumplimiento sólo por falta de coincidencia léxica |
| Contradicción | Afirmaciones comparables, fuente, fecha y contexto | Mantener ambas evidencias; señalar discrepancia o pedir revisión, no decidir verdad por recencia |
| Pérdida de contexto | Restricción recuperada/aceptada que no llega al contexto preparado | Señalar pérdida trazable y restaurar contexto pertinente; no reconstruirlo con suposiciones |
| Intención ambigua | Interpretaciones plausibles incompatibles | Solicitar aclaración; no optimizar silenciosamente una meta inferida |

Las heurísticas actuales de NEXO no son comprensión semántica general ni verificación factual. Una evaluación semántica futura necesitará un modelo configurado, controles de privacidad y validación de sus propios errores. El evaluador tampoco se considera infalible.

## Límites no negociables

- Preservar lectura de ChatGPT, captura DOM, persistencia, deduplicación, contadores, presupuestos y mediación funcionales. No sustituir EVO MEMORY.
- Contenido de páginas y respuestas de modelos son datos no confiables: no autorizan herramientas, acceso a secretos o cambios de políticas.
- Validación y propiedad de recursos en main; no ampliar APIs privilegiadas del contenido web.
- Corregir texto no autoriza reenviar formularios, publicar, comprar, borrar datos ni cambiar cuentas. Una nueva acción sensible requiere su autorización correspondiente.
- Conservar la evidencia original y explicar transformaciones relevantes, sin reescribir la lectura literal ni sustituirla por una versión supuestamente mejor.
- No usar menos tokens, más reintentos o una respuesta más larga como prueba de mayor calidad.
- Mantener preferencias reversibles, alcance explícito y posibilidad de desactivar adaptación.

## Cómo revisar cada entrega

Cada entrega debe identificar un problema del usuario y una hipótesis de mejora comprobable. Antes de desarrollarla, definir casos, resultado esperado, evidencia y qué haría rechazar la mejora.

### Ficha de revisión

1. **Problema:** qué error o esfuerzo concreto se intenta reducir.
2. **Cambio:** qué comportamiento se modifica y qué partes existentes se reutilizan.
3. **Intención preservada:** objetivo literal, restricciones y diferencias de instrucciones/contexto antes/después.
4. **Resultado:** casos corregidos, no resueltos, regresiones y problemas nuevos.
5. **Detección:** errores detectados, errores no detectados y falsas alarmas; denominadores y método de clasificación visibles.
6. **Recuperación:** éxito sólo si una comprobación posterior confirma el resultado; informar reintentos agotados, límites y efectos secundarios.
7. **Continuidad/contexto:** restricciones esenciales retenidas, referencias vigentes y ausencia de mezcla de proyectos o resurrección de datos borrados.
8. **Control y privacidad:** cambios comprendidos por el usuario, autorizaciones, información utilizada y cualquier envío externo.
9. **Coste:** latencia, contexto y esfuerzo adicional cuando se midan; nunca métricas o ahorro inventados.
10. **Evidencia y estado:** inspección estática, prueba unitaria, doble de Electron, fixture o sesión real claramente diferenciados; pendiente de validación no equivale a aprobado.

Las comparaciones requieren tareas equivalentes, proveedor/modelo/configuración documentados y revisión con criterios explícitos. No atribuir una mejora al motor sólo por una variación estocástica de la respuesta. No publicar un porcentaje de calidad agregado sin definición y datos reproducibles. La conformidad del usuario puede ser evidencia de experiencia, no sustituye comprobación factual.

### Puertas de aceptación

- No introducir cambios silenciosos del objetivo ni pérdida de restricciones esenciales.
- No confirmar tareas sin evidencia de ejecución.
- No reintentar indefinidamente ni duplicar acciones con efectos externos.
- Mantener seguridad, controles de datos y regresiones cubiertas.
- Demostrar mejora en los casos acordados sin ocultar falsos positivos o fallos.
- Si falta validación real necesaria, mantener la entrega como pendiente y no acumular otra capa dependiente.

No se fija aquí una cadencia ni se instala una tarea de revisión automática. Las revisiones programadas deberán usar esta ficha cuando se acuerden su alcance y mecanismo. No hay un job nuevo ni monitorización activada por este documento.

## Próximo desarrollo prioritario propuesto

Tras cerrar la validación pendiente de 0.1.32, trabajar sobre un **contrato de interacción trazable** dentro del circuito de mediación existente: objetivo, restricciones, criterios y referencias de contexto, con procedencia, alcance y revisión.

La primera iteración debe observar y explicar requisitos/contexto y déficits comprobables, sin modificar por defecto los prompts ni disparar regeneraciones nuevas. Esto permite establecer una base antes de habilitar recuperación automática acotada. La selección semántica de modelos, Discovery y agentes generales quedan condicionados a evidencia de utilidad y seguridad; no son el siguiente paso por cantidad de funciones.


## Estado posterior — implementación autorizada de Capa 1 (0.1.33)

Por solicitud específica del usuario se implementó el [User Understanding Engine](NEXO-CAPA1-0.1.33.md):
representación local de objetivo/instrucciones/continuidad, interpretación conservadora,
procedencia, incertidumbre y control humano. Está conectado a preparación y al
consumidor del lector existente; no modifica los prompts a partir del nuevo estado
ni inicia recuperación automática o una segunda capa. No convierte el expediente
en el centro del producto ni reemplaza EVO.

Las pruebas automáticas y su alcance se detallan en [Validación Capa 1](NEXO-CAPA1-VALIDACION.md).
Esta autorización específica de desarrollo no acredita ni cancela las puertas manuales
pendientes de las entregas anteriores. La siguiente capa continúa bloqueada por la
validación real y las limitaciones documentadas; no se declara inteligencia semántica
general ni mejora de experiencia cuantificada por contar pruebas.

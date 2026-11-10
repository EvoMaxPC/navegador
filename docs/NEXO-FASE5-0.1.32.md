# Nexo 0.1.32 — Expediente de objetivo

## Qué se entrega

Primera capa implementada de Fase 5: un expediente persistente por workspace. No es la implementación de todas las ideas propuestas ni un agente autónomo. El objetivo es conservar el sentido del trabajo y permitir retomarlo con evidencias, decisiones y pendientes.

[Arquitectura, decisiones y plan por capas](NEXO-FASE5-ARQUITECTURA.md).

**Actualización de dirección:** el expediente es soporte de continuidad, no el núcleo de la innovación. El siguiente desarrollo se prioriza sobre mediación y calidad según [Criterios rectores](NEXO-CRITERIOS-RECTORES.md). Esta actualización documental no cambia las funciones ni los resultados de pruebas de 0.1.32.

## Cómo usarlo

1. Abrí el workspace correspondiente con las herramientas existentes de espacios de trabajo.
2. Abrí **Objetivo** en la barra lateral, el icono del panel o **Ctrl+K → Expediente del objetivo · continuar trabajo**. También está en el menú Nexo y en el catálogo para personalizar la barra rápida. No ocupa un atajo por defecto; se puede asignar mediante el registro central.
3. En **Continuar**, definí el objetivo y los criterios de éxito, uno por línea. Guardá explícitamente.
4. En **Fuentes**, usá **Asociar pestaña actual** para conservar la URL y título obtenidos por main. Asociar una pestaña no extrae su contenido.
5. Para una cita, seleccioná texto en una página HTTP(S), abrí el menú contextual y elegí **Conservar selección en expediente…**. Revisá fuente, destino y fragmento, agregá una anotación opcional y confirmá. La instantánea procede del evento nativo y no se modifica al guardar (salvo el límite explícito de 8000 caracteres, que se informa). No se captura desde campos de contraseña.
6. En **Tareas**, agregá comprobaciones pendientes y registrá manualmente pendiente/en curso/hecha. No son ejecuciones de un agente.
7. En **Decisiones**, escribí el motivo y, si corresponde, vinculá hasta 20 citas. Una decisión declarada no verifica sus fuentes.
8. En **Notas**, conservá interpretaciones propias separadas de las citas.
9. Guardá el próximo paso en **Continuar**. El expediente se carga al volver a abrir su panel; las pestañas siguen usando la restauración de sesión existente.
10. En **Control**, elegí citas desplegadas/contraídas y sección inicial al volver al workspace. Son preferencias explícitas de este expediente, no inferencias sobre vos.

## Revisiones y trazabilidad

- Cambiar objetivo o criterios conserva el anterior y marca decisiones para revisión.
- Confirmar que una decisión sigue vigente la vincula a la revisión actual; no la convierte en una conclusión verificada.
- Quitar una cita retira su texto y sus vínculos, y marca decisiones afectadas para revisión.
- Un recurso con citas no se puede quitar hasta eliminar sus citas.
- Todas las citas se muestran como **sin verificar**. Las notas y decisiones son declaraciones del usuario.
- No hay porcentajes ficticios de objetivo logrado ni detección automática de contradicciones.

## Guardado y borradores

Los cambios se confirman sólo después de escribir y renombrar el archivo en `userData/work-dossiers/<workspaceId>.json`. Un expediente sin archivo comienza vacío; uno corrupto o incompatible informa error y no se sobrescribe. La recuperación de un archivo dañado debe hacerse conservando una copia del archivo del perfil; no se implementa reparador automático.

Las escrituras se serializan en main y exigen la revisión vigente. Si otra vista guardó antes, se rechaza la escritura vieja. **Recargar sin perder borradores** permite actualizar la revisión; el usuario debe revisar su borrador antes de volver a guardar, no hay mezcla automática.

Los borradores se conservan en RAM por workspace durante esta ventana; **no sobreviven al cierre de NEXO** y no se exportan. Se identifican como sin guardar y pueden descartarse en Control.

Al eliminar se pide confirmación nativa. Se vacía el contenido y se conserva sólo el estado inicial/revisión monotónica para no aceptar escrituras viejas. No se eliminan EVO MEMORY, datos del sitio, archivos descargados o exportaciones previas. No es borrado seguro/forense.

## Exportación

- **JSON completo:** modelo del expediente con IDs, relaciones, revisiones y preferencias. En esta capa no hay importación desde JSON.
- **Markdown:** documento con objetivo, continuación, tareas, citas, fuentes, decisiones y notas. Incluye advertencia de no verificación.
- Ubicación mediante diálogo nativo. El renderer no elige rutas de escritura.
- Las exportaciones pueden contener información privada. Son copias independientes, no se borran al eliminar el expediente.

## Seguridad y privacidad

- Sin dependencias nuevas ni solicitudes de red propias de esta capa.
- Sin modelo generativo, indexación global de historial, lectura automática de todas las pestañas o aprendizaje implícito.
- IPC exclusivo para la shell exacta, su frame principal y una ventana conocida. Workspace y guest validados en main.
- URLs/títulos de recursos provienen del webContents real; no se aceptan fuentes inventadas por el renderer.
- La confirmación de cita usa token de un solo uso, propietario y caducidad de 120 segundos, posterior al contexto nativo existente. Repetir o inventar tokens no guarda datos.
- Contenido de fuentes mostrado como texto, no HTML ejecutable.
- Eventos de cambios sólo contienen workspace/revisión; el borrador de captura se entrega únicamente a su shell propietaria.
- Texto local sin cifrado adicional. Las URLs pueden contener parámetros privados; se muestran antes de confirmar la cita. Abrir una fuente sí realiza navegación externa por acción explícita.
- No se modificaron archivos de `src/memory`, `src/core`, `src/inject`, ni `src/main/{memory,engine,cdp}.js` en esta capa. La lectura de ChatGPT y el pipeline EVO no se sustituyen.
- No se integra todavía el expediente al proyecto global de EVO ni se cambia projectId al cambiar de workspace. La revisión de todos los IPC heredados es un trabajo separado.

## Límites

Máximo por expediente: 4 MB serializados; 200 tareas, 200 notas, 200 recursos, 200 citas, 100 decisiones; 50 revisiones anteriores de objetivo; 20 criterios de 300 caracteres; cita de hasta 8000 caracteres y anotación de 2000. Los límites rechazan el cambio; no podan información silenciosamente.

Los workspaces comparten perfil/cookies; no son sesiones privadas. Los recursos conservan referencias, no copias completas de páginas ni documentos locales. No se promete recuperar automáticamente el fragmento en una web que cambió. No se descargan fuentes al volver ni se comprueba su vigencia. Las tareas, notas y decisiones se pueden quitar y volver a crear; no hay editor de historial de cada registro.

Adaptación implementada: dos preferencias explícitas por expediente. No hay todavía personalización aprendida, ranking de sugerencias ni memoria conductual.

## Validación realizada en esta entrega

**186 pruebas focalizadas: 186 correctas, 0 fallos, 0 omitidas.** No es la suite completa del repositorio.

Comando ejecutado:

```sh
node --test --test-reporter=tap \
  test/work-dossier.test.js test/advanced-tools.test.js \
  test/shell-contract.test.js test/main-boot.test.js test/nav-stores.test.js \
  test/memory-engine.test.js test/memory-store.test.js \
  test/memory-rank.test.js test/memory-guard.test.js \
  test/chatgpt-conversation-reader.test.js \
  test/chatgpt-conversation-memory.test.js test/conversation-repetition.test.js
```

Cobertura relevante:
- Nuevo expediente: 27 casos de modelo, disco temporal real, límites, fuentes, revisiones, preferencias, borrado, exportación, fallos de rename y conservación de archivos corruptos.
- IPC probado con dobles: autorización de shell/frame, capacidades inventadas/reutilizadas/expiradas, separación de shells, contraseñas, destino nativo de exportación y guest ajeno.
- Arranque del main de producción con Electron simulado, incluido recorrido nuevo shell → objetivo → contexto nativo simulado → borrador → cita → archivo real de prueba.
- Contratos HTML/preload/main, stores de navegación, pruebas de memoria y lector de conversaciones existentes.
- `node --check` de módulos modificados y `git diff --check`.

El primer pase de compatibilidad detectó dos fallos: una expectativa de acelerador antigua en el test del menú y un error real al reemplazar `Comma` dentro de `Command`. Se corrigió la conversión para operar sobre la tecla completa y se actualizó el contrato del menú al modificador de plataforma. El pase final arriba indicado es posterior a esas correcciones.

**No se ejecutaron Electron real, UI en navegador, build, empaquetado ejecutable, benchmarks ni CI.** Los fixtures no son cuentas reales ni investigaciones reales. Las pruebas de memoria no certifican la experiencia completa con ChatGPT autenticado.

Registro TAP de la sesión: archivo acompañante `nexo-0.1.32/pruebas-focalizadas.tap` en las entregas del workspace (no contiene conversaciones reales).

## Puerta de validación pendiente

Antes de la próxima capa:

- [ ] Abrir Electron real y recorrer todos los accesos al expediente.
- [ ] Crear objetivo, conservar cita, agregar tarea/decisión/nota, cerrar y volver a abrir; comparar el archivo del perfil y la UI.
- [ ] Cambiar workspace durante lecturas/guardados; comprobar alcance, preferencias, borradores y selección de destino.
- [ ] Validar teclado, foco, Escape, menús, diálogos, reflujo y tamaños/DPI de escritorio.
- [ ] Comprobar conflictos entre vistas, errores de disco y archivo corrupto desde la UI.
- [ ] Exportar y eliminar mediante diálogos reales Windows/macOS/Linux.
- [ ] Regresión funcional de navegación, captura, permisos y EVO/ChatGPT con datos de prueba consentidos.

No se debe comenzar la siguiente innovación sin cerrar esta puerta.

## Estado de repositorio y entrega

Versión 0.1.32 sobre la rama `arena/4678aef7-navegador`. Cambios locales preservados junto con Fase 4, sin commit ni push, sin activación de CI. Proyecto fuente completo en ZIP, no ejecutable Windows nuevo. Lista de archivos en `NEXO-FASE5-ARCHIVOS.txt`.

# Archivos de la reconstrucción de Comprensión

Comparación con el estado publicado al iniciar este trabajo (7a3d20f).
Incluye el lector independiente que estaba sin publicar al recibir la solicitud
de reconstrucción. No se eliminaron archivos de datos de usuario.

## Eliminados (30)

- `src/core/conversationObservation.js`
- `src/core/understandingInspector.js`
- `src/core/userGoals.js`
- `src/core/userProgress.js`
- `src/core/userProjects.js`
- `src/core/userReview.js`
- `src/core/userRules.js`
- `src/core/userTasks.js`
- `src/core/userUnderstanding.js`
- `src/main/userUnderstanding.js`
- `src/ui/shell/understandingContexts.js`
- `src/ui/shell/understandingInspector.js`
- `src/ui/shell/understandingProgress.js`
- `src/ui/shell/understandingTasks.js`
- `test/understanding-goals-panel.test.js`
- `test/understanding-goals.test.js`
- `test/understanding-inspector-panel.test.js`
- `test/understanding-inspector.test.js`
- `test/understanding-observation.test.js`
- `test/understanding-progress-panel.test.js`
- `test/understanding-progress.test.js`
- `test/understanding-projects-panel.test.js`
- `test/understanding-projects.test.js`
- `test/understanding-rules-panel.test.js`
- `test/understanding-rules.test.js`
- `test/understanding-tasks-panel.test.js`
- `test/understanding-tasks.test.js`
- `test/user-understanding-independence.test.js`
- `test/user-understanding-main.test.js`
- `test/user-understanding.test.js`

## Creados (18)

- `docs/COMPRENSION-AHORRO-MEDIDO.json`
- `docs/COMPRENSION-ARCHIVOS.md`
- `docs/NEXO-COMPRENSION-OPTIMIZACION.md`
- `docs/NEXO-UUE-LECTOR-INDEPENDIENTE.md`
- `scripts/measure-conversation-optimization.mjs`
- `src/core/conversationOptimization.js`
- `src/core/conversationSemantics.js`
- `src/core/understandingConversation.js`
- `src/main/conversationOptimizer.js`
- `src/main/optimizationTokens.js`
- `src/main/optimizationWorker.js`
- `src/preload/understandingReader.js`
- `test/conversation-optimization-panel.test.js`
- `test/conversation-optimization.test.js`
- `test/conversation-optimizer-main.test.js`
- `test/conversation-optimizer-service.test.js`
- `test/fixtures/conversation-optimization-cases.json`
- `test/understanding-reader.test.js`

## Modificados (23)

- `README.md`
- `docs/NEXO-CAPA1-0.1.33.md`
- `docs/NEXO-CAPA1-VALIDACION.md`
- `docs/NEXO-COMPRENSION-ETAPAS.md`
- `docs/NEXO-COMPRENSION-REVISION-FINAL.md`
- `scripts/build-inject.mjs`
- `scripts/packaging-config.mjs`
- `src/core/chatgptConversation.js`
- `src/core/index.js`
- `src/main/main.js`
- `src/nav/shortcuts.js`
- `src/preload/bridge.cjs`
- `src/preload/chatgptReader.js`
- `src/preload/shell.cjs`
- `src/ui/shell/app.js`
- `src/ui/shell/index.html`
- `src/ui/shell/styles.css`
- `src/ui/shell/understandingPanel.js`
- `src/ui/shell/understandingRefresh.js`
- `src/ui/shell/workDossier.css`
- `test/harness/dom-fixture.mjs`
- `test/preload-tokens.test.js`
- `test/shell-contract.test.js`

## Dependencias y pruebas retiradas

Las fuentes eliminadas sólo pertenecían al Comprensión anterior. Se verificaron
sus imports/exports y se retiraron de `src/core/index.js`, main, preload y asar.
El adaptador, observador, cola de captura y tokenización compartidos se conservaron.
No se modificaron `src/memory/`, `src/main/engine.js` ni la lógica del expediente
independiente. Su CSS compartido sólo pierde selectores obsoletos de Comprensión.

Los archivos de prueba retirados verificaban funciones eliminadas (administración,
reglas, proyectos, tareas, objetivos, inspector y observación del UUE anterior).
Se reemplazaron por las pruebas `conversation-optimization*`,
`conversation-optimizer*` y `understanding-reader.test.js`, además de conservar
regresiones compartidas. Los resultados nuevos no representan cobertura equivalente
por simple comparación del número total de pruebas.

Los documentos anteriores señalados como históricos siguen disponibles; no son
imports ni motores cargados en ejecución. Los archivos de usuario históricos no
son parte del checkout y no se tocan.

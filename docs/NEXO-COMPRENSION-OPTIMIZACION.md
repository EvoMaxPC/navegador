# Comprensión reconstruida · optimización conversacional local · 0.1.33

## Estado de entrega y alcance honesto

Se **retiró** el motor anterior y se implementaron un motor nuevo, su worker,
medición local y una interfaz única. No hay objetivos/subobjetivos, tareas,
proyectos, preferencias, inferencias confirmables, formularios, seguimiento o
inspector de Comprensión funcionando detrás de la pantalla.

La optimización implementada es **conservadora y reversible**. Factoriza bloques
repetidos mediante diccionario y referencias, conserva sus ocurrencias con rol y
orden, y verifica la reconstrucción exacta antes de publicar ahorro. No es una
paráfrasis semántica general ni una promesa de comprender cualquier instrucción.
El análisis local de modalidades ES/EN es acotado y no permite decidir por sí solo
qué afirmación es verdadera o qué instrucción caducó. Si no hay reducción neta
verificable, el original se conserva.

Esto implementa el reemplazo arquitectónico y la compresión segura descrita abajo,
pero **no certifica todos los criterios semánticos abiertos de la solicitud**:
fusionar explicaciones distintas pero equivalentes, seleccionar relevancia y
resolver cualquier contradicción en lenguaje libre no están implementados como
capacidades generales. No se disfrazan de funciones terminadas.

## 1. Auditoría y retirada

Antes de eliminar archivos se revisaron referencias de `src`, `scripts` y `test`.
Los módulos `userUnderstanding`, `userGoals`, `userRules`, `userTasks`,
`userProjects`, `userProgress`, `userReview`, `conversationObservation` y el
inspector sólo alimentaban el antiguo Comprensión. Se retiraron sus fuentes,
exportaciones, UI, handlers y métodos del preload de shell. Sus pruebas específicas
se retiraron junto con esas funcionalidades y fueron reemplazadas por pruebas de
los nuevos contratos, no adaptadas para simular que el motor anterior sigue vivo.
La lista concreta está en [COMPRENSION-ARCHIVOS.md](COMPRENSION-ARCHIVOS.md).

Se conservaron adaptador/observador DOM, cola de captura, tokenizador instalado,
seguridad del guest y agrupación genérica de refrescos. No se modifican los
motores de `src/memory`, el motor de mediación, las reglas EVO o los contadores.
El expediente independiente «Objetivo» (`workDossier`) no pertenecía a Comprensión
y mantiene su lógica y funcionalidad sin cambios; en su CSS compartido sólo se
retiraron selectores sin uso del Comprensión anterior.

**Los archivos históricos `nexo-understanding-*.json` no se abren, migran, borran
ni sobrescriben.** El módulo nuevo no importa su persistencia ni mantiene ese
motor oculto. Las pruebas dejan un archivo histórico centinela con el nombre
hash real y comprueban sus bytes después del arranque y del uso del reemplazo.
La documentación de las siete etapas queda señalada como histórica.

## 2. Arquitectura actual

```
DOM ChatGPT → preload aislado / lector independiente → cola propia 500 ms
 → IPC nexo:understanding:conversation → validación main
 → ConversationOptimizer (fusión por identidad, dedup y control de estado)
 → worker_threads local → análisis acotado de relaciones y redundancia
 → representación con diccionario/referencias y cronología
 → reconstrucción literal + medición BPE neta
 → nexo:understanding:read → única pantalla Comprensión
```

Fuentes principales:

- `src/preload/understandingReader.js`: lector independiente, ACK/reintentos y ciclo
  de vida, usando el mismo método de acceso DOM que EVO.
- `src/core/understandingConversation.js`: extracción literal y contrato acotado.
- `src/core/conversationSemantics.js`: reconocimiento conservador de directivas,
  modificaciones explícitas, propuestas/hipótesis y declaraciones de resultados.
  Las etiquetas son efímeras e internas, no otro sistema de gestión.
- `src/core/conversationOptimization.js`: oportunidades, factorización, verificación
  reversible y selección por ahorro neto.
- `src/main/optimizationTokens.js`: BPE local con `gpt-tokenizer`, ya instalado.
- `src/main/optimizationWorker.js`: cálculo fuera del hilo principal de Electron.
- `src/main/conversationOptimizer.js`: coordinación, caché, worker e IPC de lectura.
- `src/ui/shell/understandingPanel.js`: estado, cuatro métricas y original/resultado.

No hay modelos auxiliares, descargas de pesos, llamadas a IA externa ni nuevas
dependencias npm. El worker tiene cola latest-only por webview, descarte de
resultados obsoletos y límite de ejecución de 20 segundos; un fallo nunca anuncia
optimización exitosa. Los cambios DOM equivalentes ya aceptados no se reprocesan.

La preparación de un prompt puede aportar una copia de sólo lectura al nuevo
motor; **no modifica la respuesta de `engine.prepare` ni el cuerpo que se envía**.
El modelo informado por metadatos de un envío es opcional y sólo selecciona el
conteo. El DOM no depende de ese canal ni de que haya mediación activa.

## 3. Reglas de seguridad y preservación

- USER y ASSISTANT se mantienen separados, incluidos en la representación final.
  Una propuesta del asistente nunca pasa a ser una decisión del usuario.
- Una afirmación de «probado» en el DOM se trata como declaración, no verificación
  externa. No se inventan resultados ni se añaden instrucciones nuevas.
- Las instrucciones antiguas, las correcciones y sus diferencias se conservan
  en orden; no se eliminan por antigüedad ni por similitud de palabras.
- Se preserva cada carácter de mensajes, identificadores, código, rutas, nombres,
  fechas, parámetros y valores. No sólo se compara un conjunto de palabras clave.
- El formato `nexo-literal-context-v1` usa referencias estructurales JSON, no
  sustituciones con delimitadores ambiguos. Cada `ref` apunta a un literal.
  La expansión no evalúa código y rechaza referencias inexistentes/heredadas.
- Se reconstruyen los mensajes y se comparan con el original canónico, incluidos
  ID, rol, orden y contenido. Si la comparación falla se descarta el candidato.
- Mensajes en generación no se comprimen como definitivos. Recortes, orden
  incierto o identidades posicionales cambiantes impiden optimizar el contexto.

La reconstrucción prueba integridad del formato; **no prueba** que un modelo de
lenguaje vaya a interpretar referencias con idéntica calidad en toda tarea.
Ese aspecto requiere evaluación real y permanece pendiente.

## 4. Activación y ahorro medido

Los contenidos breves no pasan al análisis relacional. Para los largos se buscan
repeticiones de mensajes, párrafos y unidades textuales. Se priorizan candidatos
acotados por ahorro estimado; cada inclusión verifica coste BPE de literal y
referencias. Finalmente se cuentan original y resultado completos, incluyendo
JSON, roles, diccionario, instrucciones de expansión y todas las referencias.
Sólo se ofrece resultado si el ahorro neto es positivo. Un texto largo sin una
transformación verificable permanece intacto: la longitud no basta para activar.

```
ahorro = tokens_originales - tokens_optimizados
porcentaje = 100 * ahorro / tokens_originales
```

Se usa `cl100k_base` para familias GPT antiguas reconocidas y `o200k_base` para
familias compatibles actuales reconocidas. Si el modelo no se conoce o no se
soporta, se muestra explícitamente **estimación para el destino**, aunque el conteo
BPE del texto con el encoding de referencia sea reproducible. Cadenas con tokens
especiales escritos por el usuario se tokenizan como texto normal.

Medición reproducible: `node scripts/measure-conversation-optimization.mjs`.
Corpus sintético representativo incluido en `test/fixtures/` y resultados completos
en [COMPRENSION-AHORRO-MEDIDO.json](COMPRENSION-AHORRO-MEDIDO.json).

| Caso (GPT-5 / o200k_base local) | Original | Optimizado | Ahorro | Reducción |
| --- | ---: | ---: | ---: | ---: |
| Prompt corto | 13 | 13 | 0 | 0% |
| Prompt largo repetitivo | 990 | 463 | 527 | 53.2323% |
| Información técnica repetida | 2050 | 462 | 1588 | 77.4634% |
| Contradicción y corrección | 832 | 431 | 401 | 48.1971% |
| Roles y propuestas | 1404 | 721 | 683 | 48.6467% |
| Conversación extensa (120 mensajes) | 8635 | 5732 | 2903 | 33.6190% |
| Texto largo sin redundancias | 1230 | 1230 | 0 | 0% |
| Equivalencia incierta | 129 | 129 | 0 | 0% |
| Generación incompleta | 1161 | 1161 | 0 | 0% |

Todas las filas optimizadas verifican reconstrucción completa. Son ahorros del
**texto generado**, no tokens realmente facturados ni una prueba de reducción del
historial que ChatGPT mantiene en sus servidores.

## 5. Contexto, memoria temporal y límites

El coordinador fusiona actualizaciones por rol/ID nativo y añade mensajes nuevos
respetando sus vecinos conocidos. Conserva los mensajes anteriores ausentes de
una ventana DOM posterior; no los poda sólo porque desaparecieron de la pantalla.
Si la identidad o el orden son ambiguos, conserva los datos y rechaza la compresión.

Los límites del lector son 2000 mensajes, 200000 caracteres por mensaje y 2000000
por snapshot. Main retiene hasta 8 webviews, 8000000 caracteres de texto en conjunto
y hasta 10000 mensajes por contexto. Un contexto que supera el presupuesto se
bloquea para optimización en lugar de podar silenciosamente sus mensajes previos;
la última ampliación puede no quedar retenida y se informa el límite. Otros
contextos temporales pueden expulsarse de RAM; volver a ellos exige relectura DOM.
No se presenta esto como continuidad ilimitada ni recuperación de todo historial.

Navegar a otro documento, cambiar la sesión efímera de un chat sin ID o cerrar la
webview libera su contexto temporal. Una lectura de shell sin caché solicita
automáticamente relectura DOM, sin esperar que cambie el texto.
Al reiniciar se reconstruye lo que ChatGPT vuelva a cargar. No se persiste una
segunda transcripción ni se usa EVO Memory como fuente. La caché tiene una
finalidad operativa, no sustituye al archivo histórico del usuario.

## 6. Interfaz y comunicaciones

Una sola pantalla muestra:

- Analizando / Sin necesidad de optimización / Optimización realizada /
  No se pudo optimizar con seguridad.
- Tokens originales, optimizados, ahorrados y porcentaje.
- Resultado cuando hay ahorro y original consultable para comparación.
- Alcance del conteo, procedencia y motivo cuando no se optimiza.

No hay formularios, categorías de administración, inspector o paneles secundarios.
Se conserva el estilo negro/azul existente. Todo se renderiza con `textContent`.
La lectura de shell exige su mainFrame, URL interna exacta y propiedad del guest.
No quedan handlers `edit`, `recall`, `contexts`, `bind` o `clear` del motor anterior.

El canal DOM exige guest propio, mainFrame, HTTPS/host exacto ChatGPT, mismo
origen/ruta y exclusión de chats temporales. Las llamadas `postMessage` de la
página no permiten invocarlo. Repetición y EVO tienen sus rutas propias y ya no
alimentan el nuevo motor por canales compartidos.

## 7. Validación y pendientes

Pruebas focalizadas: **57/57 correctas**. Cubren casos cortos/largos, información
técnica, contradicciones, ambos roles, 120 mensajes, corpus reproducible,
streaming, reintentos/ACK, fallos, resultados tardíos, navegación, presupuestos,
modelos/tokenizadores, aislamiento IPC, worker real y pantalla sin controles viejos.
La integración ejecuta lector real y handlers main de producción con Electron
stub: EVO on/off, ausencia de captura EVO por el nuevo canal, contadores intactos,
recuerdos disponibles al reactivar y archivo histórico sin modificación.

Suite completa final: **795 pruebas, 794 correctas, 0 fallos y 1 omitida**.
La prueba omitida necesita `NEXO_ELECTRON_ZIP_DIR` para empaquetado Windows/Electron.
El número de pruebas no es comparable directamente al del módulo anterior: se
retiraron sus pruebas funcionales al eliminar esas funciones. No se retiraron
regresiones ajenas para hacer pasar la suite.

`npm run build:inject` genera los tres bundles, incluido el lector independiente.
Chequeos adicionales: sintaxis, contrato shell/preload/main, imports antiguos
inexistentes y manifiesto de empaquetado. Logs fuera de Git en
`/home/user/deliveries/nexo-comprension-reconstruccion/`.

**Pendientes reales:**

1. Comprensión semántica general, fusión de paráfrasis, relevancia libre y resolución
   automática general de vigencias/contradicciones: no implementadas como capacidades
   universales. Se conserva original cuando no hay transformación reversible.
2. Validación visual, foco/accesibilidad, streaming y navegación con cuenta real de
   ChatGPT en Electron/Windows: no ejecutada aquí. Fixtures/VM/stub no la sustituyen.
3. Calidad de respuesta de un modelo al recibir el contexto con referencias:
   pendiente de evaluación real. Integridad literal no certifica calidad semántica.
4. Aplicación automática del contexto al historial remoto de ChatGPT: **no existe**.
   El resultado se entrega al panel por IPC, no reemplaza envíos ni elimina mensajes
   del servidor. No se declara ahorro facturado ya conseguido por sólo generarlo.
5. Contexto remoto ausente del DOM y continuidad ilimitada: no disponibles. Límites
   y estado parcial se muestran; no hay scroll automático ni APIs privadas.

## 8. Ejecutar el proyecto y verificar la entrega

El ZIP contiene fuentes, pruebas, documentación y bundles generados, sin `.git`,
`node_modules` ni perfiles/datos privados. Desde la carpeta que contiene
`package.json`: `npm ci`, `npm test`, `npm run build:inject`, `npm start`.
Para Windows: `npm run dist:win` en un entorno compatible. El ZIP es proyecto fuente,
no un ejecutable Windows probado. No se sube el ZIP al repositorio Git.

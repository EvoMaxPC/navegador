# EVO BROWSER — Propuesta técnica

**Etapa 1: investigación, arquitectura y plan. Sin implementación.**

> Estado: documento para aprobación. No se escribió código de producto en esta
> etapa, según el punto 14 del pedido. Lo que sí existe es el motor de mediación y
> EVO MEMORY ya construidos y medidos, que esta propuesta reutiliza en lugar de
> rehacer.

---

## 0. Resumen ejecutivo

| Decisión | Elección | Por qué |
| --- | --- | --- |
| Tecnología del navegador | **Electron + WebContentsView** | Es el único stack que da Chromium real *y* un protocolo de depuración (CDP) uniforme por pestaña, que es la base de la función 2. |
| Gestión de pestañas | Migrar de `<webview>` a **`WebContentsView`** por pestaña | `<webview>` es el camino viejo; `BrowserView` está deprecado desde Electron 30. `WebContentsView` permite adjuntar CDP por pestaña desde el proceso principal. |
| Interceptación | **Tres canales redundantes**: página (fetch), red (CDP) y API oficial | Cada canal falla donde el otro funciona. La mediación no puede depender de uno solo. |
| Reescritura de streaming | En **página** (canal A); CDP solo **observa** | CDP obliga a bufferizar el cuerpo completo para reescribir una respuesta: mata el streaming. Ya está resuelto y probado en el canal A. |
| Marco legal y de plataformas | Intervención **en el cliente del usuario**, con su propia sesión y sus propias credenciales | EVO no descifra TLS ajeno, no crea cuentas ni automatiza sesiones ajenas. Se documenta límite por plataforma. |
| Persistencia | JSON atómico por dominio (hoy) → SQLite cuando el volumen lo justifique | Evita un módulo nativo (`better-sqlite3` + rebuild) antes de necesitarlo. Umbral medido, no intuido. |
| Nombre del producto | **EVO BROWSER** visible; identificadores internos `evo` | Renombrar la superficie es barato; canales IPC y archivos se migran con alias, sin romper el perfil existente. |

**Lo que ya está hecho y no se rehace** (auditoría del repo, no promesa):

```
src/core     3.078 líneas · 13 archivos   protocolo, centinela, filtro SSE, reparación, guard
src/memory   2.092 líneas ·  9 archivos   EVO MEMORY completo (memoria, contexto, handoff)
src/inject     316 líneas ·  1 archivo    capa de página: hook de fetch + puente
src/main       710 líneas ·  5 archivos   ventana, pestañas, ajustes, IPC, memoria
src/ui/shell   500+ líneas                interfaz con pestañas, omnibox, panel lateral
test         1.639 líneas · 15 archivos   153 pruebas, 0 fallos
demo         1.342 líneas                 sala de pruebas con el motor real
```

Fichas de sitio ya existentes: `chatgpt`, `claude`, `gemini`, `copilot`,
`perplexity`, `deepseek`, `grok`, `mistral`, `local`, `generic`.

**Lo que falta para llamarlo navegador** (verificado por búsqueda en el código, no
por suposición): historial persistente, marcadores, descargas, restauración de
sesión, buscar en página, zoom en interfaz, perfiles e incógnito, menú
contextual, panel de permisos por sitio, gestor de cookies/almacenamiento y
atajos completos. Sin eso, el punto 2 del pedido no está cumplido.

---

## 1. El riesgo principal: dos productos y una sola arquitectura

El pedido tiene dos requisitos independientes y uno es mucho más visible que el
otro. La tentación evidente es construir el navegador (visible, divertido) y
dejar la mediación como un panel decorativo. El segundo riesgo es el opuesto:
construir un mediador excelente sobre un navegador que no navega.

La propuesta ataca los dos con una regla de diseño:

> **La navegación no depende nunca de la mediación.** Si EVO MEMORY está vacío, si
> el adaptador del sitio está roto o si el usuario apaga todo el motor, la pestaña
> sigue navegando exactamente igual. La mediación es un observador en el medio,
> no un intermediario obligatorio.

Eso se implementa como un invariante comprobable: cada llamada al motor está
envuelta en `try/catch` con camino alternativo (`passthrough`), y hay una prueba
de integración que apaga el motor, navega, envía un mensaje y verifica que el
sitio funcionó.

---

## 2. Tecnología del navegador

### 2.1 Criterios

1. Chromium actualizado: los sitios de IA usan características modernas y hacen
   detección de navegador.
2. Acceso a un protocolo de depuración por pestaña: sin eso no hay interceptación
   de red fiable.
3. Aislamiento por pestaña y por sitio: sesiones, cookies y almacenamiento
   separados.
4. Costo de mantenimiento asumible por un equipo chico.
5. Camino de actualización de seguridad sin reescribir nada.

### 2.2 Comparativa

| Opción | Chromium | CDP por pestaña | Costo real | Veredicto |
| --- | --- | --- | --- | --- |
| Fork de Chromium | Sí, propio | Sí | Equipo de decenas, builds de horas, parches semanales, firma y actualizaciones propias | **Descartado**: inviable y peligroso para la seguridad del usuario |
| CEF | Sí | Sí, vía CEF | Escribir el navegador entero en C++: pestañas, omnibox, descargas, perfiles, autofill, actualizador | **Descartado** para esta etapa: años-persona |
| Tauri 2 | **No**: usa el webview del SO (WebView2/WKWebView/WebKitGTK) | **No uniforme** | Bajo | **Descartado**: sin CDP uniforme no hay función 2; y el comportamiento difiere por sistema operativo |
| Servo / Ladybird | Propio | No | Alto | **Descartado**: no soportan los sitios de IA modernos |
| **Electron + WebContentsView** | **Sí (Chromium 15x)** | **Sí: `webContents.debugger`** | Medio | **Elegido** |

Fundamento: las comparativas de 2026 coinciden en que Tauri gana en tamaño y RAM
(3–10 MB de instalador, 40–80 MB en reposo) y Electron en consistencia de
renderizado y ecosistema (120–200 MB, 150–400 MB en reposo). Para un *navegador*
con mediación, el criterio decisivo no es el instalador: es tener **el mismo motor
en todas las plataformas y un protocolo de depuración por pestaña**. Eso solo lo
dan Chromium embebido + Electron.[^1][^2][^3]

**Lo que se acepta al elegir Electron** (honestidad de costos): instalador grande,
consumo base alto, y la obligación de actualizar Electron para recibir parches de
Chromium. Se compensa con `electron-updater` y una política de versión mínima
soportada.

### 2.3 Migración de pestañas

`<webview>` hoy funciona, pero arrastra problemas de foco, atajos, menú
contextual y ciclo de vida. `BrowserView` está deprecado desde Electron 30 y su
reemplazo es `WebContentsView`, que además permite que el proceso principal
administre cada vista —condición necesaria para adjuntar CDP por pestaña—.[^4][^5]

Plan: mantener `<webview>` como camino de compatibilidad durante la etapa 2 y
migrar a `WebContentsView` en la etapa 3, con la shell recibiendo eventos por IPC
en lugar de propiedades del elemento.

---

## 3. Arquitectura

### 3.1 Los nueve motores pedidos, mapeados a módulos reales

| # | Motor (pedido) | Módulo | Estado |
| --- | --- | --- | --- |
| 1 | Motor del navegador | `src/main/window.js`, `src/main/tabs.js`, `src/ui/shell/` | Parcial (faltan historial, marcadores, descargas, sesión) |
| 2 | Motor de interceptación | `src/inject/` (canal A) + `src/main/cdp.js` (canal B, nuevo) + `src/adapters/` (canal C, nuevo) | Canal A hecho; B y C a construir |
| 3 | Motor de mediación | `src/core/{promptEngine,responseEngine,analysis,protocol,compaction}.js` | Hecho y probado |
| 4 | EVO MEMORY | `src/memory/` | Hecho y probado |
| 5 | Optimización de contexto y tokens | `src/memory/context.js` + `src/core/compaction.js` | Hecho (medido) |
| 6 | Adaptadores de IA | `src/core/sites.js` → `src/adapters/{chatgpt,claude,...}.js` | Fichas heurísticas; faltan adaptadores con capacidades declaradas |
| 7 | Base de datos local | `src/main/store.js` + `src/main/memory.js` (JSON atómico) | Hecho para ajustes y memoria; falta historial/descargas/sesiones |
| 8 | Interfaz y panel | `src/ui/shell/` | Hecho; falta panel EVO ampliado |
| 9 | Seguridad y permisos | `src/main/main.js` (permisos, sesión, CSP) | Parcial |

No se crean motores nuevos que dupliquen estos. El punto 12 del pedido se cumple
por omisión: la lista de motores ya está y lo que falta es *completar*, no *sumar*.

### 3.2 Procesos y flujo

```
┌──────────────────────────────────────────────────────────────────────┐
│ PROCESO PRINCIPAL                                                     │
│  · ventana, pestañas (WebContentsView), menús, descargas, permisos    │
│  · EVO MEMORY (una por perfil)  · Store de ajustes                    │
│  · mediación: ConversationGuard por pestaña (core/*)                  │
│  · canal B: webContents.debugger → CDP (Network, Fetch)               │
└───────▲───────────────────────────────▲──────────────────────────────┘
        │ IPC (contextIsolation)        │ CDP events
┌───────┴────────────┐        ┌─────────┴───────────────┐
│ SHELL (renderer)   │        │ PESTAÑA (webContents)   │
│ chrome de navegador│        │  preload + mundo aislado│
│ panel EVO          │        │  canal A: fetch/XHR/SSE │
└────────────────────┘        └─────────────────────────┘
```

Regla de oro de IPC: **el renderer de la shell nunca recibe objetos de red ni
sesiones**; recibe eventos ya normalizados (`intervention`, `memory-changed`,
`tab-state`). Toda capacidad peligrosa (CDP, descargas, permisos) vive en el
proceso principal.

### 3.3 Canal A — página (lo que ya existe)

`src/inject/index.js` se empaqueta a `build/inject.js` (47,1 kB) y se evalúa en el
mundo principal:

- engancha `window.fetch` y `XMLHttpRequest` para **ejecutar la mediación de
  entrada** y para **reescribir el cuerpo de la respuesta SSE en vuelo**;
- retiene caracteres, detecta bucles, corta y devuelve los eventos de cierre;
- habla con el preload por un puente aislado.

Ventaja: es el único canal que puede **modificar el texto mientras llega sin
romper el streaming**. Límite real: no ve peticiones hechas desde *service
workers* ni *web workers*, y detecta fácilmente a un cliente que reemplaza
`fetch` si el sitio se lo propone.

### 3.4 Canal B — red (CDP)

`webContents.debugger.attach('1.3')` permite:

- `Network.*`: ver todas las peticiones, cabeceras y cuerpos (`getResponseBody`
  una vez terminada la respuesta), incluidas las de workers.
- `Fetch.enable` con `requestStage: 'Request'`: **modificar `postData` antes de
  que salga** — sirve para la mediación de entrada incluso cuando el sitio usa
  service workers.
- `Fetch.enable` con `requestStage: 'Response'` + `Fetch.getResponseBody`: leer
  la respuesta **completa**. `fulfillRequest` transporta un `body` entero
  (base64): reescribir una respuesta SSE por CDP **obliga a bufferizar**, lo que
  anula el streaming. Por eso el canal B **reescribe entradas y verifica salidas**,
  pero no interviene en vivo sobre la salida.
- `Fetch.takeResponseBodyAsStream` exige que la petición esté pausada en
  **HeadersReceived** y, según el protocolo, después de tomarla "la petición no
  puede continuarse tal cual: el cliente debe cancelarla o entregar el cuerpo".
  Es decir: ni siquiera la lectura pasiva por stream es gratis en fidelidad y
  latencia.

Conclusión operativa, con las palabras del propio protocolo: `getResponseBody`
"solo puede emitirse para una petición pausada en la etapa Response" y es
excluyente con la toma por stream.[^6][^7][^8]

### 3.5 Canal C — API oficial o local

Cuando el usuario usa Ollama, LM Studio, o pega su propia clave de proveedor, EVO
habla el protocolo directamente: mediación completa, sin DOM, sin fragilidad.

- **Ollama**: `POST /api/chat` con `stream: true` devuelve **NDJSON** (una línea
  JSON por fragmento, `message.content`, `done: true` al final), no SSE.[^9][^10]
- **APIs en la nube**: SSE estilo `data: {...}` con `delta.content` y `data:
  [DONE]`; el adaptador traduce a un evento interno común.

Preferencia explícita del pedido (punto 8): **API oficial antes que scraping de
interfaz**, mecanismos privados solo cuando no haya alternativa.

### 3.6 Regla de combinación

```
entrada  → canal C (si hay API)  >  canal B (Request.postData)  >  canal A (fetch)
salida   → canal A (interviene en vuelo)  +  canal B (verifica y completa)
dedupe   → hash de (sitio, conversación, rol, texto) — nunca dos copias
degradado→ si un canal cae, el otro sigue; si caen los dos, passthrough puro
```

Este diseño cumple el punto 3.C: reconstrucción del intercambio con orden,
identificación usuario/IA, sin duplicaciones, y detección de mensajes incompletos
por comparación entre canales.

---

## 4. Navegador funcional: matriz de cumplimiento

| Función (punto 2) | API de Electron | Estado hoy | Etapa |
| --- | --- | --- | --- |
| Motor Chromium | Electron | ✅ | — |
| Barra de direcciones y búsqueda | shell + omnibox | ✅ | — |
| Navegar cualquier URL | `webContents.loadURL` | ✅ | — |
| Pestañas múltiples | `WebContentsView` | ⚠️ `<webview>` | 3 |
| Historial | SQLite/JSON + `did-navigate` | ❌ | 2 |
| Marcadores | JSON + UI | ❌ | 2 |
| Descargas | `session.on('will-download')` | ❌ | 2 |
| Gestión de ventanas | `BaseWindow` + vistas | ⚠️ una ventana | 3 |
| Atrás / adelante / recargar | `navigationHistory` | ✅ | — |
| Cookies y sesiones | `session.fromPartition` | ⚠️ una partición | 3 |
| Almacenamiento web | por partición | ⚠️ | 3 |
| HTML/CSS/JS y apps modernas | Chromium | ✅ | — |
| Permisos por sitio | `setPermissionRequestHandler` + UI | ⚠️ sin UI | 2 |
| Privacidad y seguridad | CSP, sandbox, aislamiento | ⚠️ | 4 |
| Restauración de sesión | serialización de pestañas | ❌ | 2 |
| Atajos de teclado | `Menu` + `before-input-event` | ⚠️ parcial | 2 |
| Interfaz rápida y moderna | shell | ✅ | — |
| Navegación sin mediación | invariante | ✅ (por diseño) | prueba en 2 |

Criterio de "hecho" para esta tabla: **prueba real en la máquina del usuario**, no
captura de pantalla ni "compila".

---

## 5. Mediación inteligente

### 5.1 Entrada (mensaje del usuario)

Ya implementado en `promptEngine.js`: limpieza de repeticiones, detección de
instrucciones contradictorias, resolución de referencias sueltas, protocolo
anti-bucle y **contexto EVO MEMORY compilado** (`[EVO · …] [/EVO]`).

A agregar:

1. **Requisitos explícitos**: extraer del mensaje una lista de condiciones
   («sin tablas», «en español», «máximo 200 palabras») y recordarlas para
   verificar la respuesta.
2. **Contradicción con la memoria**: si el mensaje contradice una decisión
   registrada, avisar *antes* de enviar («esto contradice la decisión del 3/11;
   ¿la reemplazamos?»). Nunca corregir en silencio.
3. **Deduplicación de instrucciones**: si el mensaje repite reglas ya presentes en
   el contexto compilado, se quitan del mensaje (ahorra tokens sin perderlas).

### 5.2 Salida (respuesta de la IA)

Ya implementado: reparación de markdown, bloques sin cerrar, plantillas de
modelo, negativas, detección de truncamiento y centinela de bucles en vivo.

A agregar (etapa 5), con honestidad sobre qué es heurística y qué no:

| Verificación | Cómo | Confianza |
| --- | --- | --- |
| Contradicción con decisiones | comparación con `decision`/`constraint` de memoria | Alta si hay ancla numérica |
| Requisito olvidado | lista de requisitos extraída del mensaje vs. respuesta | Media-alta |
| Desvío del objetivo | similitud con el `goal` activo | Media |
| Repetición / circularidad | ya implementado + similitud entre turnos | Alta |
| Dato inventado | anclas de la respuesta que no aparecen en fuentes citadas ni en el historial | **Baja: se marca, no se afirma** |
| Corrección no verificada | el error anterior sigue presente en la respuesta nueva | Media |

Regla de producto: **EVO señala, el usuario decide**. El nivel de autonomía define
si además actúa.

### 5.3 Antibucles avanzado (punto 5)

| Mecanismo | Estado |
| --- | --- |
| Bucles de texto y listas reescritas | ✅ implementado y probado |
| Circularidad de razonamiento | A construir: similitud entre turnos + estancamiento de "estado" |
| Intento fallido repetido | A construir: registro `error → solución` en memoria |
| Último estado válido | A construir: checkpoint por turno con posibilidad de "volver acá" |
| Verificación de la corrección | A construir: re-test del fallo original contra la respuesta nueva |
| Estrategia alternativa | A construir: cuando hay 2 intentos fallidos del mismo tipo, cambiar de enfoque y decirlo |

---

## 6. Integración con EVO MEMORY

Lo que ya existe y rinde (medido, no estimado): 20 turnos → 12 memorias activas,
contexto compilado de 257 tokens contra 466 de línea base (**45 % menos**),
recuperación correcta por intención en 5 de 5 consultas de prueba.

Lo que falta para el punto 6:

| Capacidad pedida | Estado |
| --- | --- |
| Memoria persistente | ✅ archivo atómico por perfil |
| Objetivos permanentes | ✅ tipo `goal`, no se descarta |
| Restricciones estrictas | ✅ tipo `constraint`, protegida |
| Memoria de proyectos | ⚠️ un proyecto por perfil; falta selector y memoria por proyecto |
| Memoria de conversaciones | ⚠️ `conversationId` guardado, sin índice por conversación |
| Historial de decisiones | ✅ tipo `decision` con fecha y procedencia |
| Recuperación semántica | ✅ BM25 + TF-IDF + 21 grupos conceptuales |
| Continuidad entre sesiones | ✅ paquete de continuidad JSON/markdown |
| Registro de errores y soluciones | ⚠️ `issue` existe; falta vincular solución y verificación |
| Recuperación de tareas interrumpidas | ❌ a construir (detectar cierre de pestaña con `task` abierta) |
| Gestión inteligente del contexto | ✅ compilador por capas |

---

## 7. Optimización de tokens

Números reales del motor actual, para no prometer de más:

| Escenario | Historial completo | Contexto EVO | Ahorro |
| --- | --- | --- | --- |
| 12 turnos, presupuesto 900 | 278 tok | 236 tok | 15 % |
| 20 turnos, presupuesto 2500 | 466 tok | 257 tok | 45 % |

El ahorro **crece con el largo de la conversación** y es 0 % cuando el historial
entra completo y la memoria no aporta: el motor no inventa economía. Además
existe el contador inverso: si el contexto compilado costara más que el historial,
se informa `overheadTokens` y `savedPct = 0`.

Límite que se mantiene escrito en la interfaz: EVO **no amplía la ventana de
contexto del modelo**; amplía la capacidad efectiva de trabajo del usuario.

---

## 8. Datos locales

**Hoy**: archivos JSON con escritura atómica (`tmp` + `rename`), uno por dominio:
`nexo-profile.json` (ajustes y registro), `evo-memory-<proyecto>.json`.

**Propuesta**: mantener JSON hasta que el volumen lo justifique, con umbral
explícito (≈ 50 000 filas totales o historial de más de 90 días). Entonces migrar
a SQLite (`better-sqlite3` o `node:sqlite` si está estable en la versión de Node
de Electron), con estas tablas:

```
projects(id, name, created_at, settings_json)
items(id, project_id, kind, text, terms_json, importance, uses, created_at, superseded_by)
conversations(id, project_id, site, title, started_at, last_at)
messages(id, conversation_id, role, text, original_text, modified, reason, ts, hash)
interventions(id, message_id, level, rule, before, after, accepted, ts)
sites(host, adapter, capabilities_json, last_verified_at)
```

Justificación de no migrar ya: un módulo nativo agrega `electron-rebuild` y
complica el empaquetado multiplataforma sin beneficio real con los volúmenes
actuales.

---

## 9. Seguridad, privacidad y plataformas

### 9.1 Qué NO hace EVO (y no va a hacer)

- **No descifra TLS.** No hay proxy MITM, no hay CA propia instalada. Solo se ve
  lo que el navegador ya ve.
- **No captura credenciales.** Los campos de contraseña y de tarjeta quedan
  excluidos por regla y por prueba automatizada.
- **No usa sesiones ajenas.** Opera sobre la sesión del usuario, autenticada por
  el usuario.
- **No automatiza cuentas ni crea identidades.** Nada de granjas de cuentas.
- **No envía conversaciones a terceros.** Todo el procesamiento es local.

### 9.2 Modelo de amenazas

| Amenaza | Mitigación |
| --- | --- |
| Fuga de conversaciones por logs | redacción de secretos, retención configurable, borrado por sitio |
| Sitio malicioso que explota la inyección | preload aislado, sin `nodeIntegration`, validación de mensajes, allowlist de hosts |
| Extensión o contenido que falsifica eventos | los eventos del canal A se validan contra el canal B cuando está disponible |
| Acceso local no autorizado al perfil | cifrado opcional con `safeStorage` (clave del SO) |
| Cadena de suministro (Electron, dependencias) | versión mínima fija, auditoría, sin dependencias en `src/core` ni `src/memory` |

### 9.3 Plataformas

Documento por sitio con lo que realmente se verificó: transporte observado,
capacidades (`lectura`, `entrada`, `salida`, `streaming`), fecha de verificación y
método de degradación. Se publica en `docs/ADAPTADORES.md` con capturas de
referencia (fixtures) y una prueba que falla cuando la captura deja de coincidir.

Riesgo asumido y dicho en voz alta: **los adaptadores se rompen cuando el sitio
cambia**. Por eso el diseño es "capacidad detectada + passthrough" y no
"dependencia dura".

---

## 10. Rendimiento y recursos

Estimaciones a validar con medición real (no son mediciones):

| Escenario | RAM esperada | Nota |
| --- | --- | --- |
| Ventana sola, shell | 150–250 MB | base de Electron |
| 1 pestaña de chat | +80–150 MB | Chromium por proceso de sitio |
| 10 pestañas | 1,4–2,4 GB | depende de los sitios |
| Mediación activa | +15–40 MB | motor propio, sin dependencias |
| EVO MEMORY (6 000 memorias) | 20–40 MB | índice invertido en memoria |

Medición obligatoria en la etapa 2: `app.getAppMetrics()` y
`process.memoryUsage()` exportados al panel de diagnóstico, con una prueba de 30
minutos de navegación real (10 pestañas, 3 sitios de IA) y registro de picos.

CPU: el centinela analiza por fragmento con sonda barata; ya está medido en
`docs/ARQUITECTURA.md`. La carga pesada (TF-IDF, MMR) corre solo al compilar
contexto, una vez por mensaje.

---

## 11. Plan por etapas

Cada etapa termina con **pruebas reales** y una lista de aceptación. Ninguna se
declara terminada por compilar.

| Etapa | Alcance | Aceptación real |
| --- | --- | --- |
| **0. Base (hecho)** | Motor de mediación, EVO MEMORY, shell, sala de pruebas | 153 pruebas verdes; demo con motor real |
| **1. Esta entrega** | Investigación, arquitectura, plan | Este documento + decisiones aprobadas |
| **2. Navegador usable** | Historial, marcadores, descargas, restauración de sesión, atajos, buscar en página, zoom, panel de permisos | Navegar 20 sitios reales, reiniciar y recuperar las pestañas; descargar un archivo y verlo en el gestor; historial persistente tras reinicio |
| **3. Pestañas modernas** | `WebContentsView`, perfiles, incógnito, menú contextual, múltiples ventanas | Abrir 10 pestañas en 3 perfiles distintos, cerrar y restaurar; verificar aislamiento de cookies |
| **4. Canal B (CDP)** | Adjuntar depurador por pestaña, captura de tráfico, reescritura de `postData` | Prueba con un sitio de prueba local: la entrada se modifica antes de salir y la observación de salida coincide con el canal A |
| **5. Adaptadores reales** | Un adaptador por sitio con capacidades declaradas y fixtures | Enviar y recibir en ChatGPT, Claude y Gemini reales; medir % de captura correcta y documentar fallos |
| **6. Mediación de salida** | Requisitos, contradicciones con memoria, verificación de corrección, circularidad | Casos preparados: el motor detecta la contradicción y el requisito olvidado; falso positivo medido y documentado |
| **7. Autonomía y panel** | 4 niveles, historial de decisiones, monitor de conversaciones, economía de tokens | El usuario ve antes/después/motivo de cada intervención y puede revertirla |

Duración relativa (puntos de esfuerzo, no fechas): etapa 2 ≈ 30 %, etapa 3 ≈ 15 %,
etapa 4 ≈ 15 %, etapa 5 ≈ 20 %, etapa 6 ≈ 15 %, etapa 7 ≈ 5 %.

---

## 12. Riesgos

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| El sitio cambia su transporte y el adaptador muere | Alto | Detección de capacidad + passthrough + fixture que avisa |
| Service worker impide el canal A | Alto | Canal B para entrada; observación pasiva para salida |
| Electron consume demasiada RAM en equipos chicos | Medio | Límite de pestañas activas, descarga de pestañas inactivas, medirlo y publicarlo |
| Detección de que el navegador es "no estándar" | Medio | Perfil de agente sin marcas propias; probar en los 3 sitios principales |
| ToS de plataformas | Medio | Intervención local sobre sesión propia y no automatizada; cada adaptador se documenta con su límite |
| Sobrecarga de mediación en respuestas largas | Bajo | Análisis por fragmento con sonda; ya medido |
| Falsa sensación de "verificación de hechos" | Alto | Se marca como sospecha, nunca como veredicto; texto explícito en la interfaz |

---

## 13. Pruebas: cómo se demuestra que algo funciona

Diferenciar siempre dos tipos (punto 13):

**Pruebas automatizadas (lo que corre en CI o en consola)**
- unitarias del motor y de la memoria (153 hoy);
- integración guard ↔ memoria ↔ guard;
- contrato de adaptadores contra fixtures grabados (sin red);
- prueba de invariante: motor apagado ⇒ navegación y envío intactos.

**Pruebas reales (lo que se hace a mano, una vez por etapa, y se registra)**
- navegar y operar los 3 sitios principales en la máquina del usuario;
- capturar el tráfico con el canal B y compararlo con el canal A;
- reiniciar la aplicación y comprobar persistencia de historial, sesión y memoria;
- medir RAM/CPU con `app.getAppMetrics()` durante 30 minutos;
- verificar que nada se envía a la red fuera de los sitios visitados (registro de
  conexiones salientes de la aplicación).

Nota de transparencia sobre este entorno: aquí **no hay display ni binario de
Electron**, así que ninguna prueba real de navegación puede ejecutarse desde acá.
Todo lo que se afirme como "navegador funcionando" tendrá que verificarse en la
máquina del usuario, con un protocolo escrito. Lo que sí se puede hacer acá es
todo lo que ya se hizo: motor, memoria, pruebas automatizadas y análisis estático.

---

## 14. Lo que descarto explícitamente

- Reemplazar las interfaces de ChatGPT/Claude/Gemini por imitaciones propias.
- Fork de Chromium, CEF desde cero o motor propio.
- Proxy MITM con CA instalada para leer TLS.
- Almacenar contraseñas, tokens de sesión o datos de tarjetas.
- Afirmar "verificado" cuando el motor solo sospecha.
- Prometer que EVO agranda el contexto del modelo o lo vuelve más inteligente.

---

## 15. Decisiones que necesito antes de implementar

1. **Nombre.** ¿`EVO BROWSER` reemplaza a `Nexo` en la interfaz y en el repo
   (canales IPC `nexo:` → `evo:`, archivos, docs)? Recomiendo sí, con alias para
   no perder el perfil existente.
2. **Alcance de la etapa 2.** ¿Completo (historial + marcadores + descargas +
   sesión + permisos) o mínimo primero (historial + sesión) para llegar antes a
   los adaptadores reales?
3. **Canales de mediación.** ¿Autorizás el canal B (CDP) sobre las pestañas? Es
   potente y es lo que permite leer tráfico con fidelidad, pero implica un
   depurador adjunto por pestaña (impacto mínimo, visible en devtools).
4. **Orden.** ¿Navegador primero (etapas 2–3) y después adaptadores (4–5), o
   adaptadores con un navegador mínimo y completar el navegador después?
   Recomiendo navegador usable primero: sin eso, la mediación no tiene dónde
   vivir y el producto no se puede probar de verdad.
5. **Perfiles y multi-proyecto.** ¿Un perfil = un proyecto de memoria, o proyectos
   múltiples dentro de un perfil compartido?

---

## Fuentes consultadas

[^1]: Tauri vs Electron 2026 — tamaño, RAM, arranque: https://rustify.rs/articles/rust-tauri-vs-electron-2026
[^2]: Comparativa 2026 de frameworks de escritorio: https://techloghub.com/compare/tauri-vs-electron
[^3]: Guía 2026 Electron vs Tauri: https://tibicle.com/electron-vs-tauri-2026-desktop-framework-guide
[^4]: Electron — BrowserView deprecado, reemplazado por WebContentsView: https://www.electronjs.org/docs/latest/api/browser-view
[^5]: Electron — cambios incompatibles 30.0 (deprecación de BrowserView): https://www.electronjs.org/docs/latest/breaking-changes
[^6]: CDP Fetch domain (`requestPaused`, `getResponseBody`, `takeResponseBodyAsStream`, `fulfillRequest`): https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
[^7]: Electron debugger + `Fetch.enable` en etapa Response (discusión y ejemplo funcional): https://stackoverflow.com/questions/66101799/electron-browserwindow-cannot-get-response-when-debugger-is-attached
[^8]: Limitaciones de reescritura de respuestas en Chromium (solo Firefox lo hace de forma nativa): https://groups.google.com/a/chromium.org/g/chromium-extensions/c/6P96hB6m9dY
[^9]: Ollama `/api/chat` con NDJSON (`done: true`, `message.content`): https://lemonade-server.ai/docs/api/ollama/
[^10]: Ejemplo de streaming NDJSON de Ollama desde Node: https://flaviocopes.com/ollama-local-llm/

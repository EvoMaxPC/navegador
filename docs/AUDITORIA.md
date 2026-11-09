# Auditoría: qué se revisó, qué se rompía y qué queda

Pasada de auditoría sobre el código completo (núcleo, memoria, navegador, proceso
principal, preloads), con dos objetivos: que lo que ya estaba declarado funcione de
verdad y que el navegador se pueda **compilar como aplicación de Windows**.

Resultado: **248 pruebas, 247 pasan, 1 se saltea** (la cadena de empaquetado
completa, que sólo corre si hay un Electron local o en el flujo de Windows). El
`nexo.exe` empaquetado arranca y se autodiagnostica en verde.

---

## 1. Errores encontrados y corregidos

### Navegación y pestañas

| Qué pasaba | Por qué importa | Corrección |
|---|---|---|
| `navigate()` cargaba la URL dos veces cuando la pestaña era nueva | Cada pestaña nueva pedía la página duplicada: doble carga, doble entrada en historial del sitio | La carga queda en un solo camino, después de crear la pestaña |
| Guardar sesión al cerrar usaba `ipcRenderer.invoke` dentro de `beforeunload` | La respuesta nunca llega: la ventana ya se está cerrando, la sesión se perdía | `send` sin respuesta + `ipcMain.on('nexo:session:save-now')` |
| Los aceleradores del menú perdían contra la página enfocada | `Ctrl+T` dentro de un chat no hacía nada: el sitio se comía la tecla | `before-input-event` en cada pestaña → `commandFor()` → comando a la shell |
| El manejador de flechas duplicaba `classList.add` y un `toggle` | Comportamiento errático del foco al navegar con teclado | Limpieza del manejador |
| Guardar el perfil en cada navegación | Escritura en disco por clic; en uso real, disco y CPU de más | Guardado diferido (4 s desde el último cambio) |

### Proceso principal y seguridad

| Qué pasaba | Por qué importa | Corrección |
|---|---|---|
| `nexo:open-external` hacía `shell.openExternal(url)` con cualquier URL | Una página podía pedirle a Windows que abriera `file:`, `ms-msdt:` o `smb:` — ejecución de programas a pedido del sitio | Lista blanca `http`/`https`/`mailto`, sin usuario:clave, con tope de longitud (`src/main/validate.js`) |
| `nexo:event` reenviaba a la interfaz lo que mandara cualquier renderer | Una pestaña podía inventar «intervenciones» y ensuciar el panel | Sólo se acepta desde `webview`, con tipo conocido, payload objeto y acotado, y el `href` real del remitente |
| `nexo:permissions:set` aceptaba cualquier nombre de permiso | Reglas basura en el perfil y en la política | Se valida contra `PERMISSION_CATALOG` |
| `nexo:session:capture` guardaba cualquier volumen | Una pestaña comprometida podía inflar memoria y el archivo de perfil | Topes de 8 ventanas y 120 pestañas por ventana |
| El protocolo `nexo://` servía con `net.fetch('file://…')` y dejaba escapar excepciones | Sin `Content-Type` explícito los módulos ES no cargan; una URL mal codificada tiraba el manejador | Lectura con `fs` + `Content-Type` por extensión + `400/403/404` (funciona igual dentro del asar) |
| Una pestaña que se caía quedaba muerta | Falta de memoria o choque del renderizador = pestaña en blanco para siempre | Recarga automática una vez, con ventana de gracia para no entrar en bucle |

### Empaquetado

| Qué pasaba | Por qué importa | Corrección |
|---|---|---|
| No había forma de generar un ejecutable | El pedido incluía una aplicación de Windows real | `scripts/empaquetar.mjs` con `@electron/packager`, asar, icono y metadatos |
| `build/` está en `.gitignore` pero `build/inject.js` es imprescindible en ejecución | El `.exe` se genera igual y la mediación no existe hasta navegar | Lista de exclusiones y archivos obligatorios en `scripts/packaging-config.mjs`, verificada por pruebas |
| No había icono | Windows mostraba el logo genérico de Electron | `scripts/make-icon.mjs` dibuja el ICO (7 tamaños) y el PNG sin dependencias |
| No había forma de saber si el `.exe` funciona | «Empaquetado» no es «funciona» | Modo `--smoke`: la app se autodiagnostica y `scripts/humo.mjs` traduce el informe a código de salida |

### Sólo en Windows

Estos no se veían en Linux y aparecieron al compilar de verdad:

- `test/harness/loader.mjs` armaba `file:///D:/D:/…` (doble letra de unidad) con
  `pathToFileURL(new URL(...).pathname)`; los tests de arranque no cargaban.
- `test/shell-contract.test.js` razona sobre líneas: con CRLF del checkout daba
  30 métodos del puente como faltantes.
- `scripts/verificar.mjs` invocaba node con `shell: true`, que parte la ruta en
  argumentos cuando tiene espacios.
- El paso de la prueba de humo en PowerShell moría antes de leer nada: con
  `ErrorActionPreference=Stop` y PowerShell 7.4, el código de salida distinto de
  cero de un proceso nativo es error terminante. Se reemplazó por Node
  (`scripts/humo.mjs`).

---

## 2. Qué se probó y cómo

| Archivo | Pruebas | Qué cubre |
|---|---|---|
| `test/nav-stores.test.js` | 34 | URL, historial, marcadores, descargas, sesión, permisos, zoom, atajos, perfil |
| `test/shell-contract.test.js` | 9 | Contrato HTML ↔ interfaz ↔ preload ↔ principal: ids y canales huérfanos |
| `test/main-boot.test.js` | 14 | Arranque real del proceso principal contra un Electron falso |
| `test/packaging.test.js` | 10 | Exclusiones, ZIP, icono y cadena completa (opcional) |
| `test/smoke.test.js` | 13 | La prueba de humo distingue sano de roto |
| `test/humo.test.js` | 6 | Lanzador: pasó, falló, sin informe, inexistente, colgado |
| `test/ipc-guards.test.js` | 7 | Esquemas de URL externa, eventos, sesión, permisos |
| núcleo y memoria | 155 | Motor saliente, centinela, SSE, reparación, EVO MEMORY |

El arranque no se prueba con mocks de funciones sueltas: `test/harness/` implementa
`BrowserWindow`, `webContents`, sesiones, protocolo, descargas y menú, y
`test/main-boot.test.js` importa **el `src/main/main.js` de producción**. Si el
arranque, el IPC o la política de permisos se rompen, falla ahí.

Lo que estas pruebas **no** pueden demostrar: que Chromium pinte bien una página
real. Eso sigue necesitando una persona y un display — el checklist manual está en
[`NAVEGADOR.md`](NAVEGADOR.md) §3.

---

## 3. Lo que sigue sin estar

Nada de esto se arregla con un parche y conviene decirlo antes que prometerlo:

- **`<webview>` sigue en uso.** Migrar a `WebContentsView` es requisito del canal
  CDP por pestaña (etapa 4) y no se hizo acá.
- **Una sola ventana.** El formato de sesión ya es multi-ventana, la interfaz no.
- **Sin firma de código.** Windows muestra SmartScreen la primera vez.
- **Sin actualizaciones automáticas.** Se reparte un ZIP.
- **Sin perfiles ni incógnito.** Una sola partición (`persist:nexo`).
- **El ejecutable no se probó a mano.** Se probó su arranque automatizado en
  Windows (protocolo, preload, CSS, pestaña montada), no una sesión de navegación
  completa contra ChatGPT o Claude con una persona mirando.

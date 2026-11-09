# Compilar Nexo para Windows

Nexo se empaqueta como una aplicación de escritorio normal: una carpeta con
`nexo.exe` (el binario de Electron renombrado), sus bibliotecas, el icono en los
metadatos del ejecutable y el código de la aplicación dentro de `resources/app.asar`.

---

## 1. Lo más rápido: bajarlo ya compilado

Cada etiqueta `v*` compila en un runner de Windows y adjunta el ZIP a la release.

| Versión | Archivo | Tamaño | sha256 |
|---|---|---|---|
| [v0.1.11](https://github.com/EvoMaxPC/navegador/releases/tag/v0.1.11) | `Nexo-0.1.11-win32-x64.zip` | 149 MB | ver el adjunto en la release |
| [v0.1.3](https://github.com/EvoMaxPC/navegador/releases/tag/v0.1.3) | `Nexo-0.1.3-win32-x64.zip` | 149 MB | ver el adjunto en la release |
| [v0.1.2](https://github.com/EvoMaxPC/navegador/releases/tag/v0.1.2) | `Nexo-0.1.2-win32-x64.zip` | 149 MB | ver el adjunto en la release |
| [v0.1.1](https://github.com/EvoMaxPC/navegador/releases/tag/v0.1.1) | `Nexo-0.1.1-win32-x64.zip` | 149 MB | ver el adjunto en la release |
| [v0.1.0](https://github.com/EvoMaxPC/navegador/releases/tag/v0.1.0) | `Nexo-0.1.0-win32-x64.zip` | 161 MB | `44b303074b251c62b73d4d5229ff5a0871c15943690356812768f2741821f1eb` |

1. Bajá el ZIP y descomprimilo (queda la carpeta `Nexo-win32-x64`).
2. Ejecutá `Nexo-win32-x64\nexo.exe`. No hace falta instalar nada.
3. La primera vez Windows va a avisar que el editor es desconocido (no está
   firmado); «Más información → Ejecutar de todas formas».

Para comprobar la descarga en PowerShell:

```powershell
(Get-FileHash .\Nexo-0.1.0-win32-x64.zip -Algorithm SHA256).Hash.ToLower()
```

Además, cada push a `src/`, `scripts/`, `test/`, `package.json` o al propio flujo
compila y deja el ZIP como artefacto de ese run (**Actions → “Compilar para
Windows” → `Nexo-win32-x64`**, se guarda 30 días).

---

## 2. Compilarlo en tu máquina

```bash
npm install
npm run dist:win
```

Eso encadena tres pasos:

| Paso | Qué hace |
|---|---|
| `build:inject` | empaqueta la capa de mediación en `build/inject.js` (esbuild) |
| `make:icon` | dibuja `build/icon.ico` (7 tamaños) y `build/icon.png` |
| `empaquetar` | arma la aplicación con `@electron/packager` y el ZIP |

Resultado en `dist/`:

```
dist/Nexo-win32-x64/            ← carpeta ejecutable
  nexo.exe                      ← Electron con icono y metadatos de Nexo
  resources/app.asar            ← la aplicación (src/, demo/, build/inject.js)
  *.dll, *.pak, locales/, …     ← lo que trae Electron
dist/Nexo-0.1.0-win32-x64.zip   ← para repartir
```

Opciones:

```bash
npm run dist:win -- --arch=arm64            # otros procesadores
npm run dist:win -- --no-asar               # archivos sueltos en resources/app/
npm run dist:win -- --out=salida            # otro directorio
npm run dist:win -- --electron-zip-dir=DIR  # usar un electron-v45.2.3-win32-x64.zip ya bajado
npm run dist:win -- --no-zip                # sólo la carpeta
```

El empaquetado **no** necesita wine ni Windows: el icono y los metadatos se
escriben con `resedit`, que es JavaScript puro. Lo único que cambia es que, fuera
de Windows, no se puede *ejecutar* el resultado.

### Requisito de red

`npm install` baja el paquete `electron` (un lanzador de 200 kB), pero el binario
—unos 160 MB— se descarga aparte desde las releases de Electron la primera vez que
se empaqueta, y queda en la caché (`~/.cache/electron`, `%LOCALAPPDATA%\electron\Cache`).
Si esa descarga está bloqueada, las alternativas son:

1. Compilar desde GitHub Actions (sección 1).
2. Bajar `electron-v45.2.3-win32-x64.zip` desde
   `https://github.com/electron/electron/releases/tag/v45.2.3`, ponerlo en una
   carpeta y pasar `--electron-zip-dir=RUTA`.

El script lo dice con esas palabras si la descarga falla; no deja un paquete a
medio armar.

---

## 3. Comprobar que el ejecutable funciona

```bash
npm run smoke        # node scripts/humo.mjs
```

Lanza `dist/Nexo-win32-x64/nexo.exe --smoke`. En ese modo la aplicación abre la
ventana de verdad (sin mostrarla), se pregunta a sí misma qué ve y escribe un
informe:

```
✔ ventana creada
✔ esquema nexo · nexo:
✔ documento cargado · complete
✔ título de la ventana · Nexo
✔ hoja de estilos aplicada · rgb(7, 8, 12)
✔ barra de direcciones
✔ franja de pestañas
✔ preload expuesto
✔ puente completo · bookmarks, …, zoom
✔ webview montada · 1 webviews
```

Eso distingue «se empaquetó» de «arranca»: comprueba que el protocolo `nexo://`
sirve archivos desde dentro del asar, que el preload llegó, que el CSS se aplicó y
que la shell montó una pestaña.

El veredicto lo da el informe, no el código de salida: al cerrar, Electron fija el
código con el apagado de Chromium y puede no ser 0 aunque todo haya ido bien.

---

## 4. Qué entra en el paquete

La lista vive en `scripts/packaging-config.mjs`, en un solo lugar, y
`test/packaging.test.js` verifica que no se desincronice:

- **Entra:** `src/` (proceso principal, preloads, interfaz, núcleo, memoria),
  `demo/` (la sala de pruebas se abre desde la barra), `build/inject.js` y
  `package.json`.
- **No entra:** `test/`, `docs/`, `scripts/`, `dev/`, `.github/`, `node_modules/`
  (no hay dependencias de ejecución), el ZIP ni los registros.

La prueba del empaquetado falla si se agrega una exclusión que tumbe un archivo
necesario en ejecución —el error clásico es dejar afuera `build/inject.js`: el .exe
se genera igual y la mediación no existe hasta que abrís un chat.

---

## 5. Firma de código

El ZIP **no está firmado**. Windows va a mostrar el aviso de SmartScreen
(«Windows protegió tu PC») en la primera ejecución, porque el ejecutable no tiene
un certificado de firma. Firmarlo requiere un certificado de code signing; el
empaquetador lo soporta con la opción `windowsSign` de `@electron/packager`, pero
no hay ninguno en el repositorio y no se puede inventar.

Tampoco hay actualizaciones automáticas: es una distribución manual.

---

## 6. Si algo falla

| Síntoma | Causa probable |
|---|---|
| `No se pudo descargar Electron …` | Sin salida a las releases de GitHub. Ver «Requisito de red». |
| `falta build/inject.js` | Empaquetaste sin `build:inject`. Usá `npm run dist:win`, que lo hace. |
| El ZIP se genera pero `nexo.exe` no arranca | Mirá el informe de `npm run smoke`; si no hay ninguno, el fallo es del binario de Electron (versión o arquitectura). |
| Ventana en blanco al abrir | El asar no trae `src/ui/shell/index.html`. La prueba del empaquetado lo detecta antes de compilar. |
| Antivirus marca el .exe | Un binario sin firmar recién compilado; ver «Firma de código». |

---

## 7. Qué se probó y dónde

- **En el servidor de desarrollo (Linux, sin display ni binario de Electron):** la
  cadena de empaquetado completa, con una distribución de Electron simulada
  (archivo `electron-v45.2.3-win32-x64.zip` armado a mano). Se verificó que el
  arranque produzca `nexo.exe` con icono y versión en los recursos del PE, un asar
  con los 62 archivos correctos y un ZIP que lectores independientes abren sin
  errores. Esto prueba el empaquetador, **no** el binario real.
- **En GitHub Actions (Windows Server 2022, Electron 45.2.3 real):** instalación,
  `npm run verify` (429 pruebas), empaquetado, la prueba de humo sobre el `.exe`
  empaquetado y publicación del ZIP de 161 MB. Ese es el archivo de la sección 1:
  el que se descarga y se ejecuta.

Ver también [`NAVEGADOR.md`](NAVEGADOR.md) para el checklist manual del navegador y
[`AUDITORIA.md`](AUDITORIA.md) para lo que se revisó en esta pasada.

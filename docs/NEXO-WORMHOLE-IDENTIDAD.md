# NEXO AI — identidad Wormhole · 0.1.33

## Recursos oficiales y referencia

La identidad parte del **primer recurso adjunto por el usuario**,
`NEXO-Wormhole.png`. Se conserva byte por byte en
`src/ui/assets/identity/NEXO-Wormhole.png`.

SHA-256 del original:
`8290387c631e1d7a9f054f2ee3c7a82759405bfc9ca264469f2a03d47f384678`.

El último mensaje suministró PNG, no un archivo ICO. Por eso el
`NEXO-Wormhole.ico` incluido es un derivado multirresolución del mismo PNG, sin
redibujar ni sustituir el agujero de gusano. Contiene entradas PNG de 16, 24, 32,
48, 64, 128 y 256 px. El derivado de 256 px también permite generar la vista
previa del icono. La conversión inicial se hizo con Pillow y remuestreo Lanczos;
Pillow **no es una dependencia de ejecución o de instalación** del proyecto.
`npm run make:icon` copia los derivados versionados y el PNG original a `build/`.

La segunda imagen (`image-6.png`) se utilizó como referencia de composición,
iluminación, paleta y proporciones. **No está colocada como fondo ni empaquetada
como interfaz.** El fondo es un SVG local de nebulosas, estrellas y horizonte
planetario, con paneles, controles y texto reales. No hay una maqueta rasterizada.

## Aplicación de la identidad

- Wormhole en el botón del menú izquierdo, cabecera, inicio, pie izquierdo y marca
  del dock derecho. Se usa el mismo PNG oficial en todas esas superficies.
- `BrowserWindow.icon`: ICO oficial derivado en Windows y PNG oficial en Linux.
- `scripts/make-icon.mjs` ya no dibuja el antiguo icono genérico.
- El empaquetador usa el ICO derivado en `nexo.exe`; nombre de producto y descripción
  de Windows muestran NEXO AI y «Tu portal al Mundo de la IA».
- Se conserva el nombre técnico del paquete/ejecutable y la ruta del perfil para
  no cambiar dónde se guardan los datos del usuario.
- La ventana conserva sus controles nativos del sistema operativo. No se agregan
  falsos botones decorativos de minimizar/maximizar/cerrar.

## Menú izquierdo

El rail existente conserva sus opciones y sus controladores de navegación.
Se inicia **cerrado en cada arranque**, independientemente del modo derecho.
El botón Wormhole de cabecera siempre está visible y abre/cierra ese rail.
Usa `aria-expanded`, `aria-controls`, `inert` al cerrar y Escape con devolución de
foco al botón. La apertura no modifica los motores ni los destinos de navegación.

Se retiró la pestaña **Repetición de conversación**, su sección y los callbacks
que sólo pintaban esa sección. **No se elimina el transporte de snapshots ni el
componente `createRepetitionView`**, porque EVO Memory los utiliza para su lectura
literal y sus contadores. Se conserva explícitamente esa dependencia compartida.
Las opciones restantes de ambos menús mantienen sus paneles originales.

## Menú derecho

El panel existente ahora tiene dos presentaciones:

- **Automático** (predeterminado): barra compacta de iconos; al pasar el mouse o
  enfocar con teclado se expande. Al salir se contrae tras 250 ms, excepto si hay
  un control del panel enfocado para no interrumpir su edición.
- **Fijo**: permanece expandido. El botón Cerrar se desactiva explicando que se
  debe seleccionar Automático para contraerlo; no se cambia silenciosamente la
  preferencia guardada.

Ajuste: **Ajustes → Apariencia · menú derecho**. `rightMenuMode` se valida y guarda
junto con las preferencias existentes en `browser-tools.json`, mediante el IPC
confiable y el guardado atómico ya existente. Un fallo de guardado restaura el modo
previo y no aparenta éxito. El anclaje/flotación de EVO sigue funcionando de forma
independiente mediante su botón de pin existente.

Las etiquetas y el contenido se ocultan en el dock compacto. Al expandir, las
etiquetas recuperan dimensiones y posición normales, no sólo `display`: se retira
el recorte accesible de la presentación antigua. Sus nombres accesibles siguen
disponibles también en modo compacto.

## Zoom real de interfaz

Los dos grupos de controles (cabecera y esquina inferior derecha) actúan sobre el
**zoom de la interfaz NEXO**, con reducir, porcentaje, aumentar y restablecer.
Los pasos son 75%, 80%, 90%, 100%, 110%, 125% y 150%; restablecer vuelve a 100%.

`uiZoom` se valida y persiste en las preferencias de navegador. Después de guardar,
main ejecuta `setZoomFactor` sobre las ventanas cuya URL es la shell exacta de
NEXO, no sobre páginas externas ni ventanas de autenticación. Se restaura al cargar
la shell y permanece mientras se navega entre sitios o se reinicia la aplicación.
No se introdujo un puente IPC privilegiado para las páginas web.

**El zoom por sitio anterior no se elimina:** sigue en Sitios y en sus atajos,
con su persistencia por origen. El zoom de interfaz no sobrescribe ese valor ni
hace pasar un cambio de escala del sitio por un cambio de interfaz.

## Diseño, adaptación y movimiento

- Azul noche, cian, azul eléctrico y violeta; tipografía clara y capas de cristal
  oscuro con bordes luminosos y sombras contenidas.
- Hero con el Wormhole oficial, NEXO AI, «Tu portal al Mundo de la IA» y
  «Explorá · Aprendé · Descubrí».
- Se conservan buscador, accesos actuales, más aplicaciones y tarjetas informativas;
  no se agregan destinos o módulos ficticios. EVO LABS/PIXELVERSE y Extensiones
  continúan indicando que no están configurados/disponibles.
- Estrellas y nebulosas vectoriales locales, horizonte planetario y transparencias.
  No se añaden peticiones externas, fuentes remotas, canvas continuo ni timers
  de partículas. No se prometen cifras de CPU/RAM/GPU no medidas.
- Anillo orbital CSS en el botón, variación suave del brillo del hero, hover y
  transiciones cortas. `prefers-reduced-motion: reduce` desactiva animaciones y
  transiciones.
- En ancho reducido, los paneles se superponen sin ocultar sus opciones; las listas
  siguen siendo desplazables. El inicio se apila y conserva sus controles.

## Pruebas y límites de verificación

Pruebas focalizadas: **92 totales, 91 correctas, 0 fallos y 1 omitida**.
Incluyen identidad byte a byte, ICO/PNG y empaquetado, menús/teclado, persistencia,
validación de modos/zoom, aislamiento main/subframe/guest, contrato HTML/preload,
regresiones de zoom por sitio, EVO Memory y lector DOM/Comprensión.

Suite completa: **806 totales, 805 correctas, 0 fallos y 1 omitida**.
La omitida es el empaquetado ejecutable Windows/Electron, que requiere
`NEXO_ELECTRON_ZIP_DIR`. La primera ejecución completa encontró una prueba antigua
que exigía la pestaña Repetición: se actualizó su contrato para la retirada solicitada,
conservando las comprobaciones de las demás herramientas.

Además se ejecutaron **19 comprobaciones en Chromium headless real** sobre la
interfaz con el adaptador web de desarrollo: menús, etiquetas visibles, modo fijo,
persistencia de la vista previa, zoom, adaptación a 1568×882 y 940×680 y reducción
de movimiento. No hubo errores JS/HTTP. Se inspeccionaron capturas del inicio,
menú izquierdo abierto, menú fijo y ventana pequeña.

La vista web usa un adaptador explícito sin motores ni cuenta de ChatGPT. Su
persistencia de diseño es local a esa vista; **no prueba Electron por sí sola**.
Por separado, los tests de producción main con Electron stub verifican que
`setZoomFactor` se llama sobre shell, no guest, y que las preferencias se escriben
realmente en disco. Las pruebas del icono comprueban el recurso y el formato.

**Pendiente en Windows real:** ejecutar la distribución, comprobar icono de
ventana/barra de tareas (incluida caché de accesos anclados), controles nativos y
aceleración gráfica. No se declara esa validación como realizada. Tampoco se
realizó aquí una sesión real de ChatGPT; los motores y el lector se preservan y
sus regresiones pasan, pero fixture/stub no equivalen a esa sesión.

## Archivos y ejecución

Principales archivos nuevos: `wormhole.css`, `wormholeChrome.js`,
`wormhole-start.css`, recursos `src/ui/assets/identity/` y las pruebas
`wormhole-identity.test.js`/`wormhole-main.test.js`.

Se adaptan HTML de shell/inicio, presentación en `app.js`/`browserTools.js`,
preferencias de navegador, aplicación de zoom en main, script de iconos y
manifiesto de empaquetado. **Sin cambios en los motores de EVO Memory, lectura DOM,
Comprensión, captura, contadores o archivos históricos del usuario.**

Desde la carpeta con `package.json`:

```
npm ci
npm run make:icon
npm run build:inject
npm test
npm start
```

Para vista de diseño sin Electron: `node dev/serve.mjs 3400 --browser`.
Para empaquetar Windows en un entorno compatible: `npm run dist:win`.
El ZIP de entrega contiene proyecto fuente y bundles/iconos generados, no es un
instalador ni un ejecutable Windows validado. No contiene perfiles privados,
`node_modules` o `.git`.

Logs y capturas de esta validación:
`/home/user/deliveries/nexo-wormhole/`.

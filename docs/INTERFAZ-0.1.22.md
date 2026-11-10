# Nexo 0.1.22 — interfaz y arquitectura de shell

## Diseño implementado

- Chrome oscuro verde, superficie clara salvia y tipografía del sistema; sin fuentes, imágenes o librerías remotas para dibujar la interfaz.
- Nueva pestaña con búsqueda/navegación HTTP(S), accesos a IA y herramientas de trabajo. DuckDuckGo como búsqueda, igual que la resolución de la barra.
- Panel EVO con rail de ocho herramientas, encabezado contextual, cierre explícito, métricas jerarquizadas y explicación técnica plegable. No se quitaron memoria, permisos, historial, descargas ni diagnóstico.
- Selección de pestañas por flechas/Home/End; Supr cierra la pestaña enfocada, además de Ctrl+W. Rail vertical por flechas arriba/abajo/Home/End. Foco visible, estados ARIA, paneles etiquetados, movimiento reducido y disposición compacta.
- Estado de conexión diferencia página local, HTTPS y HTTP. HTTPS se describe como cifrado, no como garantía de fiabilidad.

## Menos trabajo de interfaz

`src/ui/shell/scheduler.js` guarda sólo la última tarea por clave hasta el siguiente cuadro. No añade procesos, intervalos ni framework.

- La shell usa el snapshot recibido en `nexo:stats-changed` en vez de solicitar `nexo:stats` en cada fragmento. El principal comparte un snapshot con el diagnóstico de captura para no dejarlo obsoleto.
- Las consultas explícitas de estadísticas concurrentes comparten una promesa. Una respuesta IPC antigua no pisa un estado push más reciente.
- Los paneles secundarios no se consultan todos al arrancar; se cargan al abrirse. Notificaciones de descargas/marcadores/memoria/perfil sólo refrescan su panel si está visible.
- Las transcripciones se piden al desplegar su sección, no en cada actualización normal de memoria.
- No se cambian el estimador de salida por palabras, BPE de entrada, mediación, persistencia, deduplicación ni clasificación de turnos.

### Medición y límites

En el mismo sandbox, baseline `bb24350` y cambios actuales:

| Microbenchmark existente | Antes | Después* |
| --- | ---: | ---: |
| Bundle de inyección | 51,3 kB | 51,3 kB |
| SSE, 9.000 caracteres | 3,04 ms | 3,03 ms |
| Memoria: recuperar 300 turnos | 5,86 ms | 5,66 ms |
| Arranque principal → primera ventana simulada | 55,5 ms | 57,6 ms |

*Una ejecución de referencia, no un estudio estadístico ni una medición de navegación real. La variación pequeña no demuestra una mejora ni regresión de velocidad. Ejecutar `npm run bench` para repetir; se mantienen los presupuestos existentes. Los JSON de esta sesión se guardaron fuera del repositorio para no versionar resultados dependientes del equipo.

La mejora estructural comprobada por `test/shell-architecture.test.js`: **1.000 eventos de estadísticas antes del siguiente cuadro → una tarea de render y cero consultas extra de estadísticas**. Se prueba también que las consultas concurrentes se comparten y que no sobrescriben eventos más recientes. Esto reduce trabajo de la shell; no implica que una web externa descargue más rápido ni mide RAM total del navegador.

## Seguridad aplicada

- Puente de páginas: `__nexo:call` sólo admite `prepare`; ya no interpola un canal IPC elegido por la página. Prueba real del preload en VM rechaza memoria, ajustes, borrado y apertura externa, además de mensajes de otros frames.
- Favicons: asignación mediante DOM, sin interpolar HTML; sólo HTTP(S) sin credenciales o raster base64 acotado. SVG/data activos, file y javascript se rechazan. Logs escapan también clase/tipo/etiqueta.
- Sandbox habilitado en el renderer de la shell, manteniendo aislamiento y Node deshabilitado. Navegación de la shell fuera de su documento y popups bloqueados.
- Protocolo `nexo://app` restringido a recursos públicos de renderer. Excluye main/preloads, archivos de perfil, metadatos de Git y package.json. Mantiene el control de traversal y MIME. El servidor de desarrollo aplica el mismo filtro de recursos.
- CSP explícita sin scripts inline, sin objetos, sin base externa y sin envíos de formulario en la shell. La nueva pestaña tiene su propia CSP.

No es una auditoría exhaustiva ni una garantía de invulnerabilidad. Los huéspedes conservan el preload no sandboxed requerido actualmente por su tokenizador/inyección; convertirlo exige otra migración y pruebas. Una siguiente fase debe centralizar comprobaciones de remitente/capacidad de todos los handlers IPC del principal y evaluar sustituir `webview` sin romper la captura. No se desactivan TLS ni los controles de seguridad de las páginas.

## Verificación

- `npm run verify`: **602 pruebas, 601 aprobadas, 1 omitida, 0 fallos**; suites del motor, preload, contrato de shell, captura, memoria, IPC y presupuestos de archivos. Tests nuevos para scheduler, estadísticas push, favicon, estado HTTPS, bridge y protocolo.
- Se corrigieron expectativas de una prueba pasiva que asumía contadores globales vacíos pese a compartir motor con pruebas anteriores: ahora comprueba el delta contra el estado anterior. El harness UI recibe el payload IPC real, no una notificación artificial sin datos.
- Prueba visual local con Playwright/Chromium headless: 1440×1000 y 760×900; ocho paneles, selección por flechas, cierre/reapertura del panel, nueva pestaña y ausencia de overflow horizontal. Sin errores JavaScript en ese recorrido.
- Axe (reglas WCAG 2 A/AA) no detectó infracciones en la shell de la vista de prueba tras corregir controles interactivos anidados en pestañas. No equivale a certificación WCAG ni a una prueba con lector de pantalla; no se auditó exhaustivamente cada estado o página externa.

## Vista web de desarrollo

```sh
node dev/serve.mjs 3200 --browser
# /browser/ : HTML/CSS/JS reales de la shell con adaptador sólo de desarrollo
# /demo/    : sala de pruebas histórica
```

`dev/preview.js` adapta webviews a iframes de la nueva pestaña y ofrece datos vacíos, marcados explícitamente como vista UI. No carga conversaciones, no accede al perfil Electron, no es un motor de navegación y no se empaqueta (`dev/` está excluido). No usarlo para certificar descargas, aislamiento entre huéspedes, captura real o persistencia.

Pendiente de aceptación manual: aplicación Electron en Windows con sitios reales, descargas/permisos, reabrir sesión, lector de pantalla y conversación propia de ChatGPT. Los replays, la vista web y CI no sustituyen esa prueba. Tampoco se ha hecho una comparación controlada con Chrome, Edge, Firefox u otros navegadores.

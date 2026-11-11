# Auditoría correctiva: persistencia del perfil — entrega parcial

**Estado: auditoría ABIERTA, rama no aprobada.** Esta revisión no corrige aún el puente MAIN world/IPC ni los casos pendientes de correlación. No debe presentarse como cierre de la auditoría de seguridad.

## Identificación

- Fuente: Nexo 0.1.33.
- Rama: `arena/4678aef7-navegador`.
- Base: `d0145f1c92f8006bbbe9c50db4a54909e46c47e2`.
- El commit de esta revisión figura en el manifiesto de la entrega, sin introducir una referencia circular en este documento.
- Respaldo previo: `respaldo-d0145f1.zip`, SHA-256 `9f2cd1bcd5150afcff273fca8cd79ce207fc6631494facb1f14aa59f15f53986`.

## Corrección realizada

Ámbito: `src/main/store.js`, archivo `nexo-profile.json` (ajustes y log). No se cambió el almacenamiento de EVO MEMORY, el lector de Comprensión, los proveedores ni los tokenizadores.

1. Sólo `ENOENT` se trata como primer arranque. `EACCES`, `EIO` y otros errores de lectura bloquean las escrituras del perfil durante esa instancia.
2. JSON corrupto o estructura incompatible: se copia el archivo original, byte por byte, a `nexo-profile.json.corrupt-<UUID>.bak`, con creación exclusiva. Se sincroniza el respaldo antes de permitir un guardado. Si falla su preservación, se bloquean las escrituras. El respaldo no se borra ni se reutiliza en reinicios posteriores.
3. Guardado en temporal único del mismo directorio: apertura exclusiva, escritura, `fsync`, cierre y `rename`. Nunca se trunca previamente el archivo destino. Los errores se propagan y los temporales se limpian en el camino de fallo normal.
4. Ajustes, restablecimiento y log se construyen como nuevo estado y sólo se publican en RAM después de completar el reemplazo. Si falla, se mantienen los datos anteriores.
5. `setSettings`, `resetSettings` y `clearLog` rechazan su IPC cuando no se confirma el guardado. La interfaz conserva los ajustes confirmados y avisa del fallo; los errores de ajustes también quedan visibles en una nota accesible del panel existente.
6. Las escrituras de log de fondo no derriban el navegador: el anfitrión recibe un aviso por una ruta que no vuelve a escribir en Store. Ese log no se presenta como persistido. Se expone el estado de recuperación/guardado sólo a la shell registrada y se informa al arrancar.

## Compatibilidad y documentación

- `package.json` y el paquete raíz de `package-lock.json`: Node **>=22.12.0**, coherente con packager y dependencias fijadas. Ejecutado aquí con Node 22.22.3.
- Se aclara que las dependencias de producción, incluido `gpt-tokenizer`, sí entran en el paquete; se excluyen las de desarrollo.
- Enlaces 0.1.13 y cifras de empaquetado antiguas se identifican como históricos, no como validación de 0.1.33. Se retiran las cifras fijas obsoletas de pruebas del README.
- No se añadió compatibilidad de modelos. `gpt-6` continúa desconocido; no se verificaron nuevas referencias oficiales en esta revisión.

## Evidencia ejecutada

### Roja

Se ejecutó `test/profile-store.test.js` sustituyendo temporalmente sólo Store por el archivo de la base `d0145f1`; después se restauró el código corregido:

- **19 pruebas: 1 correcta, 18 fallidas.** La correcta corresponde al manejo UI de rechazo ya corregido; la sustitución afectaba únicamente Store.
- Registro: `QA/persistencia-baseline.tap`.

### Verde

- Pruebas nuevas Store/UI + IPC real del proceso principal contra Electron falso: **20/20**, sin omisiones.
- Incluyen perfil con datos → corrupción → reinicio → cambio de ajuste → respaldo original intacto; estructuras inválidas; múltiples respaldos; errores de lectura; fallo al copiar respaldo; fallos de apertura, escritura, sincronización y reemplazo; rollback de todas las mutaciones; error de log de fondo; feedback UI.
- La prueba IPC provoca un fallo real de `rename` ocupando temporalmente el destino con un directorio; comprueba rechazo de ajustar/restablecer/limpiar log y conservación de RAM, más recuperación posterior al quitar el bloqueo.
- `npm run build:inject`: correcto.
- `npm test`, sobre el código final: **1067 pruebas, 1066 correctas, 0 fallidas, 1 omitida**, duración 125845.9143 ms.
- La omisión es el control de asar sobre un ejecutable distribuido; requiere `NEXO_ELECTRON_ZIP_DIR`.
- `git diff --check`: correcto.

## Límites y bloqueantes pendientes

- **Puente de confianza sin corregir:** `event.source === window` y una webview no autentican al código NEXO. La ruta de `prepare` también modifica estado. No se añadió un token accesible desde MAIN world ni se afirma seguridad por validar el sender. Es el siguiente bloqueante prioritario.
- **Correlación sin corregir en esta revisión:** DPU opaco antes de 2500 ms, ráfagas de tres o más gestos y dos envíos legítimos idénticos dentro de 800 ms. Las pruebas anteriores no constituyen aceptación de esos casos.
- DOM compartido no demuestra procedencia del proveedor. No se elevó a prueba autenticada ni se alteró la memoria conversacional para intentar tapar el problema.
- Este cambio cubre Store del perfil; no es una auditoría exhaustiva de todos los almacenes del navegador.
- El reemplazo atómico y `fsync` no son una prueba de resistencia a todos los cortes eléctricos, sistemas de archivos ni fallos de hardware. No se ejecutó una prueba de corte de energía ni se sincroniza explícitamente el directorio contenedor.
- No se recuperan mágicamente bytes que ya estaban destruidos: se conserva el original corrupto para recuperación/inspección. No se reemplaza ese respaldo por defaults.
- No hubo ejecución en Windows ni sesión real de ChatGPT. Las pruebas IPC usan el proceso principal de producción con Electron falso; la UI se prueba en VM, no con navegador visual.

**Conclusión:** persistencia corregida y probada en este alcance; auditoría completa todavía bloqueada. El ZIP es una entrega parcial de fuentes y evidencia, no un ejecutable Windows ni una aprobación de seguridad.

# Corrección de compilación — 0.1.13

## Causas comprobadas

El flujo Windows de la rama fallaba después de incorporar el conteo BPE:

- `gpt-tokenizer` pasó a ser una dependencia de ejecución, pero el empaquetador excluía todo `node_modules` y rechazaba cualquier `dependencies`.
- Los diccionarios BPE importados desde las utilidades compartidas entraban en el script inyectado: **3004.6 kB** frente al límite de **60 kB**; en el entorno local el parseo mediano era de unos 93 ms frente al máximo de 20 ms.
- Dos pruebas de contadores todavía exigían cifras fijas/heurísticas en vez de los tokens del texto con BPE.
- `verify` probaba antes de compilar y podía leer un bundle viejo.

Aparte, el sandbox no confiaba inicialmente en la CA de la red. Al usar el almacén de confianza del sistema, la descarga de los assets de Electron sigue bloqueada por la restricción de salida del entorno. Esto es independiente del código del empaquetador.

## Correcciones

- Permitir dependencias de producción y conservar `prune: true` para quitar las de desarrollo. Verificar que los módulos BPE y los nuevos helpers viajen dentro de `app.asar`.
- Mantener las utilidades de texto libres de los diccionarios. Compartir el BPE mediante `src/core/gptTokens.cjs`, cargado bajo demanda por el proceso principal y el preload.
- El preload calcula el metadato BPE de los envíos y elimina el texto auxiliar antes del IPC; el Engine sigue calculando la salida desde el texto recibido. Se conserva la selección de codificación por modelo y el comportamiento de otros proveedores.
- Mantener los límites originales de rendimiento: no se aumentaron para ocultar el problema.
- Actualizar las dos expectativas obsoletas y construir el bundle antes de probarlo.
- Diagnosticar errores TLS/red anidados en `fetch.cause`, ofreciendo CA de confianza, empaquetado offline o CI, sin desactivar TLS.
- Integrar los cambios remotos que ya usaban BPE con el arreglo local de recuperación de texto tardío; ese camino usa ahora el mismo tokenizador y el modelo del turno.

No se modificaron la interfaz ni EVO MEMORY, ni se agregaron contadores.

## Verificación local

- Dependencias instaladas desde el lockfile (`npm ci --ignore-scripts`; la descarga de Electron se valida por separado).
- `npm run verify`: **464 pruebas, 463 aprobadas, 1 omitida, 0 fallos**.
- Bundle: **37.5 kB**, **13.5 kB gzip**, 8 módulos; pasan los límites de tamaño y parseo originales.
- Pruebas nuevas del preload: BPE moderno/clásico, conservación de otros proveedores, compatibilidad de avisos antiguos, eliminación del texto auxiliar y bridge real con IPC simulado.
- Pruebas nuevas del diagnóstico: certificados, errores de red anidados, errores ajenos a la descarga y causas circulares.
- La prueba omitida requiere un ZIP externo de Electron mediante `NEXO_ELECTRON_ZIP_DIR`.
- Empaquetado local intentado con confianza TLS del sistema: bloqueado en la descarga del binario por la red del sandbox. No se desactivó TLS.

## Verificación Windows completada

El workflow [Compilar para Windows — run 42651499665](https://github.com/EvoMaxPC/navegador/actions/runs/42651499665)
terminó con **success** el 2026-11-09, sobre el commit `e40cc1601ae8d9ebfeac9328bbd1c313eb04e562`.

Pasaron instalación de dependencias, verificación automática, referencia de rendimiento,
`npm run dist:win`, prueba de humo del ejecutable y publicación del ZIP.

Artefacto: [Nexo-win32-x64](https://github.com/EvoMaxPC/navegador/actions/runs/42651499665/artifacts/13689642278),
158138785 bytes, no expirado al entregar; retención de 30 días según el workflow.
El ZIP de artefacto contiene `Nexo-0.1.13-win32-x64.zip`.

Esto confirma el empaquetado y arranque en Windows, no una conversación real en ChatGPT.
El problema local de acceso a los hosts de assets sigue siendo una limitación de red
que no se evita desactivando TLS.

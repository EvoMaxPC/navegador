# 0.1.33 — EVO global apagada: Memoria apagada, Comprensión activa

## Corrección solicitada

El interruptor global de Mediación (`settings.enabled`) ahora gobierna también la
disponibilidad efectiva de EVO Memory. La condición común es:

```js
settings.enabled !== false && settings.memory?.enabled !== false
```

Se aplica en main, motor y shell. **No se usa para apagar la observación UUE.**
Esto corrige la independencia anterior de Memoria respecto del interruptor global;
las explicaciones históricas de las etapas deben leerse con esta actualización.

- EVO global apagada: no se captura ni recuerda contenido en EVO Memory por DOM,
  CDP o guards existentes. Lista, conversaciones, búsqueda y exportación no devuelven
  recuerdos; estadísticas no consultan su contenido y ocultan su ruta de archivo.
- Comprensión sigue leyendo y persistiendo por el lector/cola existentes. El ACK
  puede devolver `observed: true, memoryDisabled: true` sin fingir una captura EVO.
- El panel Memoria sólo muestra el aviso de desactivación y de que Comprensión sigue
  activa. No muestra mensajes en RAM, historial ni recuerdos guardados. Se vacían
  su caché de presentación y paquete, no el archivo EVO. No se ocultan los paneles
  hermanos de Comprensión o Repetición.
- Las consultas pendientes del panel se invalidan al desactivar; no pueden volver
  a mostrar datos mediante una respuesta atrasada. Tampoco inicia lectura directa
  de respaldo desde Memoria mientras está apagada.
- Los guards existentes se desconectan de la memoria al apagar cualquiera de los
  dos gates. Pin, olvido individual, importación y recuperación/exportación no se
  ejecutan mientras está desactivada. El borrado explícito del proyecto conserva
  su API previa: apagar el interruptor no la invoca.

**Los recuerdos previos no se borran y la preferencia `memory.enabled` no se cambia
silenciosamente.** Al reactivar EVO global, Memoria vuelve a estar disponible sólo
si su propia preferencia estaba habilitada. La comprensión actual y su archivo no
se reinician ni se sustituyen por recuerdos antiguos.

El cambio corresponde al interruptor **global** de Mediación. Se conserva la
configuración previa por sitio: con EVO global encendida y memoria habilitada,
ChatGPT puede observarse sin intervenir sus mensajes aunque la mediación de ese
sitio esté apagada. No se cambian permisos, roles, aislamiento, cola de 500 ms,
reglas de contadores/tokenización ni lectores para resolver este pedido.

## Validación

- **72/72 focalizadas**, incluyendo independencia UUE/EVO, main/IPC, CDP, lector,
  contrato shell, panel Memoria y recibos de diagnóstico.
- Suite completa: **989 totales, 988 aprobadas, 0 fallidas, 1 omitida**.
- Duración completa: 104.247,027114 ms. La omitida requiere el paquete Electron
  Windows real (`NEXO_ELECTRON_ZIP_DIR`); no se presenta como aprobada.
- Build de inyección correcto: 53,7 kB / 19,3 kB gzip, 11 módulos.

Se agregan seis pruebas: gates y reconexión de guards, limpieza y consulta diferida
con las funciones de producción de la shell en VM, disponibilidad/aviso del panel,
y recorrido main/IPC con memoria inicialmente poblada. Este último apaga sólo EVO
**global** dejando `memory.enabled: true`, comprueba que EVO no captura ni expone
recuerdos mientras UUE observa/persiste, y reactiva para comprobar conservación.
El positivo de recibos de diagnóstico se ajusta a EVO global encendida/mediación
por sitio apagada, manteniendo comprobaciones de fallo de disco.

Las pruebas de shell usan fixtures/VM y main usa Electron stub; no se ejecutaron
Electron visual, Windows ni una cuenta ChatGPT real. Pendiente manual: apagar desde
Ajustes con Memoria abierta y con Comprensión abierta, comprobar vista vacía/aviso,
seguir conversando y verificar Comprensión, y reactivar sin pérdida de recuerdos.

Versión conservada: **0.1.33**. Se publica con commit y push normal sobre la rama de
trabajo; no se mezcla en `main` automáticamente.

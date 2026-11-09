# Privacidad

Nexo está construido sobre una regla: **el análisis de tus conversaciones no sale
de tu máquina**.

## Qué se procesa y dónde

| Dato | Dónde se procesa | Sale del equipo |
|---|---|---|
| Tu mensaje antes de enviarlo | proceso principal (motor saliente) | solo el texto final, hacia el sitio que ya ibas a usar |
| La respuesta que llega | pestaña, en el mundo de la página | no |
| Historial para compactar | memoria del proceso principal | no |
| Libro de intervenciones | memoria + archivo de perfil | no |

No hay telemetría, ni analítica, ni comprobación de actualizaciones, ni llamadas a
servicios de terceros.

## Qué se guarda en disco

Un único archivo en el directorio de usuario de la aplicación:

```
<userData>/nexo-profile.json
├── settings   → ajustes de mediación, sitios habilitados, presupuesto de contexto
└── log        → últimas 400 intervenciones (tipo, título, fragmento de 140 caracteres)
```

Del libro de intervenciones se guardan **fragmentos cortos**, no conversaciones
completas. Las respuestas y los mensajes viven en memoria mientras la pestaña está
abierta y se descartan al cerrarla.

Las cookies y sesiones de los sitios se guardan en el perfil `persist:nexo`, igual
que en cualquier navegador, para que no tengas que iniciar sesión cada vez.

## Qué NO se hace

- No se envía el texto a un modelo auxiliar para «resumir mejor» el contexto: la
  compactación es extractiva y local.
- No se sube nada a un servidor de sincronización.
- No se reescribe el DOM de los mensajes ya mostrados.
- No se leen otras pestañas ni el resto del historial del navegador.

## Borrar todo

- *Panel → Ajustes → Restablecer ajustes* devuelve la configuración a los valores
  por defecto.
- *Panel → Actividad → Limpiar* borra el libro de intervenciones.
- Para borrar todo (ajustes, libro y sesiones de los sitios): eliminá el directorio
  de usuario de Nexo.

Rutas típicas:

- macOS: `~/Library/Application Support/nexo-browser`
- Linux: `~/.config/nexo-browser`
- Windows: `%APPDATA%\nexo-browser`

## Riesgos que conviene tener presentes

- **Reescribir el cuerpo de la petición** cambia lo que el servidor recibe: es
  exactamente lo que el producto promete, pero implica que el proveedor del modelo
  no verá tu texto original. El panel muestra siempre el texto que se envía.
- **La inyección corre en el mundo de la página**, con los mismos permisos que el
  sitio. Un sitio malicioso podría intentar interferir; el código inyectado no
  expone datos a la página más allá del objeto de depuración `window.__nexo`, que no
  contiene tu historial.
- **Las sesiones iniciadas** son las tuyas: Nexo no las comparte entre perfiles ni
  las exporta.

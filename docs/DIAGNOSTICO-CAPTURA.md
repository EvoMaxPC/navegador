# Diagnóstico local de captura · Nexo 0.1.21

## Dónde está

Al iniciar NEXO se crea `NEXO-CAPTURE-DIAGNOSTIC.jsonl` dentro de la carpeta
Documentos que informa Electron para el usuario. No se manda a un servidor.
La ruta está disponible también en `nexo:stats` y `nexo:cdp:stats`.
Cada línea es un objeto JSON independiente. Las escrituras se serializan para
no mezclar líneas. A los 5 MiB se conserva una copia `.jsonl.1` y comienza un
archivo nuevo. Un error de escritura se avisa en consola; `nexo:cdp:stats`
devuelve `diagnosticError`, sin fingir que se generó un informe.

## Qué demuestra cada etapa

- `app-start`: arrancó el diagnóstico; no prueba que ChatGPT haya sido leído.
- `diagnostic` / `cdp-attached`: CDP se adjuntó a una pestaña; tampoco prueba por
  sí solo que la conversación haya sido capturada. Otros códigos indican por
  qué no se recuperó un cuerpo o no se reconoció texto.
- `request-detected`: se reconoció un envío por CDP o por la capa de página.
- `response-delivered`: se recuperó una respuesta y se entregó al motor, con su
  longitud en caracteres, origen y recibo de EVO MEMORY si existe.
- `conversation-read`: lectura independiente del historial visible del DOM.

`memory.saved` indica aceptación y guardado confirmado por el motor;
`memory.persisted` distingue confirmación de escritura en disco (`true`), fallo
(`false`) y ausencia de un almacén persistente en un motor de prueba (`null`).
Un recibo nulo significa que no se confirmó guardado para esa captura; nunca se
rellena con el resultado de otra respuesta. `action` puede ser created, merged,
superseded o ignored. Una respuesta repetida puede fusionarse sin crear otra.

El recibo viaja desde `Engine.onCdpCapture` hasta el evento del observador. Se
retiró la búsqueda anterior por `.slice(-30)` del log: el log se ordena del más
nuevo al más viejo, por lo que eso buscaba entre los registros antiguos. Además,
una búsqueda sin ID podía atribuir a una respuesta el guardado de otra.

## Privacidad

El escritor usa una lista cerrada de campos y valores. Incluye únicamente fecha,
etapa, proveedor/origen reconocido, longitud, indicadores booleanos, código
predefinido y estado numérico/booleano de memoria. No serializa prompts, respuestas,
metadatos arbitrarios, títulos, errores textuales, cookies ni credenciales.

No se guardan URLs, rutas de conversación ni IDs de mensajes crudos. `captureId`
es un HMAC truncado con clave aleatoria por arranque: permite correlacionar etapas
dentro de ese arranque, sin exponer el identificador original. No permite enlazar
sesiones distintas. El texto de la conversación continúa en el expediente local
de EVO MEMORY, separado del informe de diagnóstico.

## Observación pasiva

Se preservaron los cambios concurrentes de la rama: la política `contentAllowed`
permite observar ChatGPT si está habilitada la mediación **o** EVO MEMORY. Apagar
la mediación no equivale a apagar una memoria que el usuario dejó habilitada.
Otros proveedores siguen la política previa. Los permisos se revalidan al leer
cuerpos y en cada frame WebSocket. La captura CDP es de sólo lectura: no se activa
intercepción Fetch ni se sustituyen cuerpos o cabeceras del envío.

## Pruebas y alcance

`npm run verify`: **593 pruebas, 592 aprobadas, 1 omitida, 0 fallos**.

Las pruebas cubren JSONL real en un directorio temporal, privacidad ante texto
inyectado incluso en campos de metadatos, correlación opaca, escrituras concurrentes,
rotación y errores de escritura. El recibo del motor se verifica con 60 registros
antiguos y con un fallo de disco inducido.

La integración inicia el principal con Electron simulado, apaga la mediación,
mantiene EVO MEMORY, reconoce un POST y entrega una respuesta por eventos CDP.
Verifica el artifact literal en memoria y la confirmación persistida en el JSONL,
sin el prompt ni la respuesta en ese informe. Comprueba que no hubo comandos CDP
de intercepción o modificación del envío.

Son eventos controlados/replay y archivos de prueba reales. No equivalen a haber
mantenido una conversación propia en ChatGPT en vivo. El diagnóstico que se genere
al ejecutar esta versión en el equipo del usuario es la evidencia de esa sesión.

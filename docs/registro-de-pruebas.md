# Registro de pruebas manuales

Pruebas hechas por el usuario en Electron real, con un perfil restaurado. Cada
fila dice qué hash estaba instalado, en qué modo se probó y qué se observó. Lo
que no se registró en su momento queda como «fecha no registrada»: no se
completa a mano después.

| fecha | hash probado | modo | qué se probó | resultado | quién |
|---|---|---|---|---|---|
| fecha no registrada | def44b3 (P0-1) | enforce | «hola» y tarjeta de prueba 4111… | mediación OK; diálogo → «Cancelar envío» → franja roja «NEXO retuvo tu envío» y Actividad «NEXO retuvo un envío con datos sensibles»; el envío cancelado no cuenta | usuario, Electron real |
| 16/11/2026 (reloj del PC del usuario) | b9d1692 (P0-2) | enforce | «hola» en chat nuevo y tarjeta de prueba | «hola»: config recibida, texto mediado, memoria inyectada, stream-end con texto, contadores 1 mensaje/1 respuesta; tarjeta: diálogo → «Cancelar envío» → franja roja. Observación: el contador hoy rotulado «turnos sin resultado claro» = 0 (entonces «turnos realizados»; ver P0-3c y P0-3g) | usuario, Electron real |

## Reglas de la prueba

1. Usar sólo la tarjeta de prueba 4111 1111 1111 1111; nunca una tarjeta real.
2. Empezar en un chat nuevo, no en una conversación ya abierta.
3. Anotar los contadores iniciales en 0 antes de escribir el mensaje.
4. No pegar cabeceras ni cookies en la conversación de prueba.
5. Restaurar el perfil a off al terminar.

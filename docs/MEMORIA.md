# La pestaña Memoria: qué es cada número y qué se hace con un registro cifrado

## Los cuatro números no significan lo mismo

En la pestaña conviven cuatro cifras que se leían como si fueran una:

| Cifra | Qué es | De dónde sale |
|---|---|---|
| **mensajes / respuestas** | hechos de la conversación: cuántos mensajes salieron y cuántas respuestas se cerraron | contadores del motor (`nexo:stats`), panel de Actividad |
| **memorias** | registros **vigentes** que EVO destiló (hechos, decisiones, restricciones, episodios…) | `stats.active` |
| **episodios** | resúmenes de un tramo de conversación (`El usuario planteó: … · Se respondió: …`) | `stats.byKind.episode` |
| **tokens guardados** | suma de tokens de las memorias vigentes | `stats.tokens` |
| **tokens del contexto** | lo que realmente viaja en el próximo envío, bajo presupuesto | `stats.lastUsed` (último `compile`) |

Los dos últimos se confundían: el panel mostraba los tokens guardados con la
etiqueta «tokens en contexto». Que la memoria tenga 336 tokens guardados no
quiere decir que se envíen 336: el compilador elige una parte y descarta el
resto. Ahora el panel dice «tokens guardados» y aparte informa el contexto del
último envío.

## Un registro «Se respondió» no es una respuesta

Un **episodio** es un resumen que el motor arma cada `episodeEvery` turnos: toma
el primer enunciado de cada turno del tramo y lo pega. «Se respondió: …» es la
etiqueta de la parte del asistente dentro de ese resumen. Por eso:

- no es un registro de respuestas ni se corresponde uno a uno con ellas;
- no suma al contador de respuestas (ese cuenta cierres de stream reales);
- puede repetir texto de varios turnos, porque es un resumen, no un duplicado.

Los episodios repetidos se fusionan al insertarse: el mismo tramo dos veces no
crea dos episodios iguales.

## Por qué aparecían registros cifrados (`gAAAAA…`)

`gAAAAA` es la firma de un token **Fernet** (`cryptography.fernet`, de Python):
el texto guardado no era lenguaje, era un bloque cifrado por otra herramienta.
Llegó dentro de un paquete de continuidad importado. Nada en NEXO cifra la
memoria: lo que se veía era el token tal cual, guardado como si fuera una
memoria.

Qué se hizo, sin borrar ni alterar nada:

1. **Alta**: `MemoryStore.add` rechaza un texto que no es lenguaje
   (`looksEncrypted`) y la importación lo informa como «sin leer (cifradas)» en
   vez de tragárselo en silencio.
2. **Panel**: un registro ya guardado que no se puede leer se muestra como
   «Registro cifrado — no se puede leer», con su tipo y sus acciones; el token
   crudo ya no se escupe. Sigue en el archivo, intacto.
3. **Contexto**: ningún registro ilegible viaja al modelo, ni siquiera fijado, y
   no gasta presupuesto. `compile` lo excluye y no lo marca como «memoria usada».
4. **Leyenda**: cuenta sólo memorias vigentes (antes incluía las reemplazadas y
   no cuadraba con el número de memorias), y añade «cifradas, sin leer: N».

## Qué queda fuera de este cambio

- **No se conectó** ni se rediseñó la captura de memoria: sigue alimentándose
  desde `ConversationGuard` cuando la mediación está activa (turno del usuario al
  preparar el envío, turno del asistente al cerrar la respuesta) y desde la
  importación de paquetes.
- **No se borra** ningún registro cifrado existente: se conserva, se marca y no
  viaja.
- **No hay persistencia de contadores** entre reinicios: siguen siendo de sesión.

# ChatGPT → memoria local (0.1.20)

## Fallo reproducido

La captura previa dependía de nuevas peticiones fetch/CDP. No había una lectura
inicial del historial que ChatGPT ya había renderizado. Además, EVO MEMORY
conserva información destilada: un saludo corto o el texto completo de una
respuesta no equivalían a una transcripción persistente.

La prueba «ChatGPT ya abierto» fallaba sin cambios de producción: abrir una página
con mensajes visibles de AuroraVisible, sin enviar una petición nueva, no
incorporaba esos mensajes a memoria. Evidencia local:
`/home/user/memoria-conversacion-antes.log`.

## Recorrido implementado

1. `src/core/chatgptConversation.js` lee sólo nodos de mensaje con roles user y
   assistant, manteniendo identidad y Markdown, sin composer ni botones.
2. La capa ejecuta una lectura inicial y un MutationObserver agrupado a 500 ms.
   Funciona al cargar un historial y al cambiar los mensajes; no depende de fetch.
3. Preload transmite `conversation-snapshot`. El principal valida que el emisor
   sea una pestaña ChatGPT HTTPS y que su URL actual coincida con la captura.
   La ruta del emisor, no el ID enviado por la página, decide la conversación.
4. EVO MEMORY actualiza mensajes por ID y guarda la transcripción en el **mismo
   archivo JSON del perfil**, junto a las memorias existentes, sin reemplazarlas.
   Se usa el escritor atómico existente. Una revisión reemplaza el parcial, no
   agrega otra copia. Un snapshot idéntico no vuelve a destilarse.
5. Mientras existe el botón Stop se archiva el parcial; al desaparecer se destilan
   hechos, decisiones y pendientes mediante `remember`, para poder recuperarlos
   como contexto con el motor existente. No se envía todo el historial a la IA.
6. El panel muestra las transcripciones en **Memoria → Conversaciones de ChatGPT
   guardadas**, separadas de los hechos destilados. El texto se escapa antes de
   renderizarlo. «Vaciar memoria» elimina también estas transcripciones.

No se llama al motor de contadores al leer historial: los mensajes antiguos no
suman envíos, respuestas ni tokens. La estimación por palabras se mantiene.
Un fallo de escritura deja diagnóstico visible y el estado pendiente en memoria.

## Alcance y privacidad

- Sólo mensajes **cargados en la página**, no toda la cuenta ni mensajes que
  ChatGPT no haya cargado. No hay llamadas a APIs privadas ni lectura de cookies.
- Los chats `temporary-chat=true` y los sitios ajenos se excluyen. Se respeta
  `memory.enabled=false`. La información queda local, sin nube adicional.
- La lectura usa los atributos de rol de ChatGPT. Si cambia esa estructura, no
  inventa una conversación a partir del texto general de la interfaz.
- Hasta 50 conversaciones, 200 mensajes y 250 000 caracteres por conversación;
  hasta 10 000 caracteres por mensaje. Los recortes se indican en el panel. Al
  alcanzar la retención salen las transcripciones menos recientemente actualizadas;
  no se borran por ello las memorias destiladas existentes.
- En conversaciones sin ID de ruta (chat nuevo/anónimo), la captura se asocia
  provisionalmente a la pestaña. Las conversaciones `/c/…` se separan por ruta.
- No se migra ni elimina el expediente anterior. El formato admite archivos
  anteriores sin transcripciones.

## Verificación

583 pruebas: 582 aprobadas, 1 omitida, 0 fallos en `npm run verify`.
Pruebas adicionales cubren lectura sin fetch, DOM → preload → IPC → memoria,
revisión de mensajes sin duplicación, contadores intactos, emisor/URL incorrectos,
roles/Markdown, recortes, exclusión de chats temporales, escritura fallida y
persistencia al reconstruir el motor desde un archivo temporal real. Una memoria
anterior y los mensajes cortos siguen presentes al reabrir ese archivo.

Son pruebas de integración con DOM/Electron simulados y almacenamiento real de
prueba; no equivalen a una conversación propia en ChatGPT en vivo.

# Grabaciones externas de ChatGPT anonimizadas

Origen: https://github.com/Adr1enR1chard/ecologits-extension/tree/05502ec6943cc55a87a2884bd6927eb85be5c995/test/fixtures/chatgpt
Commit fijado: `05502ec6943cc55a87a2884bd6927eb85be5c995`. Copias sin cambios de los seis streams; MPL-2.0 (ver LICENSE).
Autor/proyecto de origen: Adr1enR1chard/ecologits-extension y sus contribuidores.

El README de fixtures del origen documenta cómo se graban desde `__ecologitsStreams`
y se anonimizan conservando estructura, orden, deltas y campos del protocolo:
https://github.com/Adr1enR1chard/ecologits-extension/blob/05502ec6943cc55a87a2884bd6927eb85be5c995/test/fixtures/README.md

El catálogo del origen marca estos seis casos con `howToRecord`, a diferencia de
sus casos escritos a mano. Incluye SSE autenticado normal, Thinking largo,
regeneración y aborto; y NDJSON sin cuenta normal y detenido.
https://github.com/Adr1enR1chard/ecologits-extension/blob/05502ec6943cc55a87a2884bd6927eb85be5c995/test/fixtures/chatgpt/fixtures.ts

No son conversaciones realizadas en esta sesión, ni una captura del usuario de
NEXO. Su reproducción comprueba compatibilidad con formatos registrados; no
reemplaza la validación en vivo requerida por el usuario. No hay prompts privados,
credenciales ni tokens utilizables: textos/identidades están anonimizados por el origen.

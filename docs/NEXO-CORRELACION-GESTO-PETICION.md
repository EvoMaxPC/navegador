# Corrección exclusiva de correlación gesto ↔ petición

## Alcance

Se modifica únicamente la correlación local de `src/inject/index.js`, sus pruebas
en `test/bpe-input-routes.test.js` y este informe. Sin cambios en tokenizadores,
tabla de modelos, fórmula BPE, preload, engine de contadores, CDP, memoria, lectura
DOM o interfaz. No se añade ninguna dependencia.

Respaldo previo del árbol limpio en commit
`6d42e841769640ee8ab93a6f84a28b9556ebe67a`:
`respaldo-6d42e84.zip`.
SHA-256: `71eccc7d163323e123d278dcd5c4e061c4d680f44cea368cdf133a3cc230be0f`.

## Defecto reproducido

`yaContadoPorGesto(chars)` utilizaba `!chars || chars === gesto.chars`.
Por ejemplo, un gesto ya anunciado para `hola` y una petición posterior para
`chau` podían compartir ID sólo porque ambos tienen cuatro caracteres.

También se consumía cualquier gesto pendiente antes de comprobar su relación
con la petición, y dos gestos con textos diferentes dentro de 800 ms se podían
tratar como un doble evento del mismo gesto.

La huella `fingerprint` existente **no representa texto exacto**: normaliza
mayúsculas, espacios y Unicode. Sustituir la comparación de longitud por sólo esa
huella no bastaría. La regresión `Hola`/`hola` verifica que sus huellas coinciden,
pero sus messageId no deben hacerlo.

## Corrección

- Se compara el **texto literal original** de la petición con `gesto.tokenText`,
  con igualdad estricta, sin normalización ni recorte. El gesto local no expone
  un ID de proveedor compartido; no se inventa uno.
- Tanto el gesto pendiente como el ya anunciado usan la misma comprobación.
- Una petición diferente no consume ni cancela el gesto pendiente o ya anunciado.
- Si una petición coincide con el gesto pendiente, no se intenta enlazar además
  con un gesto anterior: el pendiente correspondiente tiene prioridad.
- La supresión de doble evento dentro de 800 ms requiere también el mismo texto
  literal. Si llega un gesto con otro texto, se anuncia el anterior antes de
  registrar el nuevo, sin perderlo.
- Un enlace consume el gesto contado una sola vez; otra petición posterior recibe
  su propio ID.
- Un cuerpo sin texto legible no se enlaza por tener cero caracteres. Para DPU se
  señala internamente si el prompt se leyó de la petición: copiar el texto del
  gesto como respaldo no constituye prueba independiente de identidad.

No se cambian valores BPE, reglas de conteo, selección de modelos, requests ni
respuestas. El indicador interno DPU sólo interviene en esta decisión de enlace.

## Regresiones ejecutadas sobre el bundle real

1. `hola` ya anunciado por gesto → gesto `chau` pendiente → petición `chau` →
   petición tardía `hola`: se mantienen exactamente dos IDs, cada uno asociado a
   su texto, aunque ambos textos midan cuatro caracteres.
2. Petición `chau` durante un gesto pendiente `hola`: no consume su timer; el
   aviso posterior y la petición de `hola` conservan su propio ID.
3. Dos gestos con textos distintos de igual longitud dentro de 800 ms: no se
   descarta el segundo como doble clic, y ambos reciben IDs propios.
4. `Hola` y `hola`: mismo hash normalizado y longitud, distinto texto e ID.
5. Cuerpo ilegible después de un gesto: no hereda su ID por longitud cero.
6. DPU sin prompt: el texto copiado del gesto no se usa para probar la correlación.
7. Control positivo: una petición realmente coincidente reutiliza el ID del gesto
   una vez; la siguiente petición no reutiliza ese gesto consumido.

Las pruebas verifican también que el cuerpo enviado permanece intacto.

### Prueba roja/verde

Se compiló temporalmente en `build/inject.js` (ignorado por Git) el código anterior
obtenido con `git show HEAD:src/inject/index.js`, sin cambiar de rama ni modificar
el archivo fuente versionado. Ejecutando las siete nuevas regresiones:
**6 fallaron y 1 pasó**, reproduciendo los defectos.

Después se reconstruyó el bundle con la corrección usando `npm run build:inject`:

- **41 pruebas focalizadas correctas, 0 fallos, 0 omitidas.** Incluye las siete
  regresiones, las rutas BPE/DPU existentes, la capa inyectada y contadores CDP.
- **Suite completa: 1047 totales, 1046 correctas, 0 fallos, 1 omitida.**
- La omitida es `empaquetar.mjs produce un .exe con su asar`, que requiere
  `NEXO_ELECTRON_ZIP_DIR`; no se presenta como prueba ejecutada correctamente.
- `npm run build:inject`: correcto; bundle de inyección y lectores reconstruidos.

Registros: `/home/user/deliveries/nexo-correlacion/`.

```
npm run build:inject
node --test test/bpe-input-routes.test.js test/capa-inyectada.test.js test/contadores-cdp.test.js
npm test
```

## Límites que esta corrección no pretende resolver

La igualdad literal en una ventana temporal no demuestra identidad universal
entre envíos legítimos **idénticos** sin un ID compartido. Se conserva el alcance
local y acotado del estado de gestos existente: no se agrega una cola histórica
ilimitada ni se cambia la correlación de respaldo del engine principal.

Esta revisión verifica y corrige el caso señalado de textos **distintos** con la
misma longitud, las colisiones de huella normalizada y el consumo incorrecto de
gestos locales. Las pruebas ejecutan el bundle real en un DOM/transportes
simulados; no se realizó una sesión real de ChatGPT ni una prueba Windows manual.

# Rendimiento

Este documento explica **cómo se mide** Nexo y **qué se cambió**, con números
antes y después. Es la parte del proyecto que envejece más rápido: sin una forma
de medir, «optimizar» es cambiar código al azar y quedarse con lo que parece
más rápido.

Todo lo que sigue se reproduce con dos comandos:

```bash
npm run bench    # números finos, tabla comparativa
npm test         # incluye el presupuesto de rendimiento (test/rendimiento.test.js)
```

El banco de pruebas (`scripts/bench.mjs`) no mide el navegador «en general»:
mide las cinco operaciones que el usuario *siente*, con tamaños de datos
realistas (respuestas de 6 000–20 000 caracteres, historial de 4 000 visitas,
300 turnos de memoria) y toma la **mediana** de muchas repeticiones después de
calentar el JIT.

## Dónde se va el tiempo

Un navegador de chat tiene tres presupuestos de tiempo distintos:

| Momento | Qué tiene que pasar | Presupuesto |
| --- | --- | --- |
| Abrir la aplicación | Proceso principal, ventana, primera pintura | < 1 s percibido |
| Escribir en la barra | Sugerencias en cada tecla | < 16 ms (un cuadro) |
| Recibir una respuesta | Filtro del stream, carácter por carácter | < 1 ms por trozo |

La memoria es el cuarto presupuesto: un navegador que ocupa 1 GB de RAM con una
pestaña abierta no compite, por más rápido que sea.

## Línea base y resultados

Medido en el mismo contenedor Linux, Node 22, antes y después de esta etapa.
Los valores absolutos dependen de la máquina: lo que importa es la proporción.

| Operación | Antes | Después | Mejora |
| --- | --- | --- | --- |
| Barra: sugerencias (4 000 visitas + 200 marcadores) | 9,28 ms por tecla | **0,25 ms** | 37× |
| Historial: `search` sobre 4 000 entradas | 9,19 ms | **0,44 ms** | 21× |
| `lowerPreservingLength` (6 000 caracteres) | 0,242 ms | **0,012 ms** | 20× |
| `repeatingSuffix` (6 000 caracteres) | 0,364 ms | **0,157 ms** | 2,3× |
| `tokenize` con posiciones (6 000 caracteres) | 0,230 ms | **0,129 ms** | 1,8× |
| `analyzeTail` (6 000 caracteres) | 0,227 ms | **0,102 ms** | 2,2× |
| Código inyectado en cada página | 47,1 kB | **25,6 kB** (9,4 kB gzip) | 46 % menos |
| Idiomas de Chromium empaquetados | 60 archivos | **5 archivos** | ~9 MB menos |

Una aclaración honesta: el centinela sobre 20 000 caracteres **subió** de
0,29 ms a 0,44 ms. No es una regresión: ahora hace un trabajo que antes no
hacía (ver «el chequeo que nunca corría»). Se paga 0,015 µs por carácter —un
cuadro de pantalla son 16 000 µs— a cambio de detectar bucles de verdad.

## Los cuatro cambios

### 1. El historial se normalizaba entero, en cada tecla

`HistoryStore.search` pasaba por `normalizeText` el título y la URL de **todas**
las entradas en cada consulta: con 4 000 visitas son 8 000 cadenas de texto
normalizadas (descomposición NFD, quita de acentos, limpieza de signos) para
responder una sola pregunta.

Ahora hay un **índice normalizado en paralelo** (`this.index`) que se arma una
vez y se actualiza de tres formas:

- al agregar una visita, se inserta al principio (no se reconstruye nada);
- al recargar el historial, se marca como nulo y se rearma en la próxima consulta;
- al borrar, podar o recortar por límite, se invalida.

Se guarda como arrays paralelos y no como objetos, y la búsqueda recorre por
índice en vez de con `filter` + `map`. El desempate temporal —que se aplicaba a
cada coincidencia— sólo se calcula si hay coincidencia.

Los marcadores recibieron el mismo tratamiento (`BookmarkStore#searchIndex`), y
la invalidación se prueba en `test/rendimiento.test.js`: después de `add` y de
`clear` el índice tiene que reflejar el cambio.

### 2. `toLowerCase` era el trabajo más caro del análisis

`lowerPreservingLength` existía por una razón válida: `toLowerCase()` puede
**cambiar la longitud** de un texto (`İ` pasa a dos unidades de código) y los
índices tienen que seguir apuntando al original para poder recortarlo.

El problema era el método: un bucle sobre **cada carácter** con una
concatenación de string por carácter. En 6 000 caracteres eso son 6 000
llamadas y 6 000 concatenaciones: 0,242 ms, más que todo el resto del análisis
junto.

La solución conserva la garantía y usa el camino rápido: se llama a
`toLowerCase()` nativo y, **si la longitud no cambió** (el caso de todo el texto
latino salvo excepciones rarísimas), se devuelve tal cual. Si cambió, se paga el
bucle lento. De 0,242 ms a 0,012 ms.

### 3. Sin un string por carácter: el sufijo repetido

Para detectar «el modelo está repitiendo un párrafo», `repeatingSuffix` invierte
el texto y busca el prefijo común más largo entre el texto y cada uno de sus
sufijos (función Z). El original hacía:

```js
const rev = s.split('').reverse().join(''); // un array de 6 000 strings de 1 char
const z = zFunction(rev);                   // comparaciones de strings
```

Ahora el texto se invierte en un `Uint16Array` (códigos de carácter) y la
función Z opera sobre **números** (`zFunctionCodes`). Comparar números es más
rápido que comparar strings y no se crea un string por carácter. El algoritmo
es el mismo, así que los resultados no cambian: por eso los tests del análisis
siguen pasando sin tocarlos.

Lo mismo con los tokens: `tokenizeWithSpans` devolvía un objeto por palabra y
`analyzeTail` lo convertía en un array de strings con `map`. Ahora
`tokenizeWithStarts` devuelve tres arrays paralelos (tokens, inicio, fin) en una
sola pasada, y la expresión regular se reutiliza entre llamadas.

### 4. Las sondas del centinela copiaban 6 000 caracteres para mirar 32

El centinela revisa el texto mientras llega. Cada 24 caracteres hacía:

```js
const tail = this.raw.slice(-32).toLowerCase();          // 32 caracteres
const window = this.raw.slice(from).toLowerCase();        // hasta 6 000
return window.indexOf(tail) !== -1;
```

Es decir: cada 24 caracteres del modelo se generaba basura equivalente a 250
veces el tamaño de la respuesta. Ahora el centinela mantiene una **copia en
minúsculas** del texto acumulado (`this.low`), actualizada sumando el delta ya
convertido: el costo pasa a ser una conversión por trozo en lugar de una por
sonda, y la búsqueda usa `lastIndexOf` con posición inicial —sin recortar nada—.
Si un delta raro cambia de longitud al pasar a minúsculas (los mismos `İ`), la
copia se recalcula entera una vez y las posiciones no se desincronizan.

La sonda de tartamudeo («palabra palabra palabra palabra palabra») usaba una
expresión regular con **retrorreferencia** sobre 160 caracteres. Las
retrorreferencias son de lo más lento del motor de expresiones regulares; ahora
se recorre la ventana a mano comparando palabra con palabra.

### El chequeo que nunca corría

Buscando por qué el centinela no detectaba ciertos bucles apareció un error de
lógica: el análisis completo (`analyzeTail` + estado de bloques de código) decía
ejecutarse «cada 512 caracteres», pero el contador se reiniciaba en **cada**
sonda de 24 caracteres:

```js
this.lastCheck = this.raw.length;          // cada 24 caracteres
if (!probe && since < this.deepCheckEvery) return;   // `since` nunca llegaba a 512
```

Con `since` siempre igual a 24, la condición `since < 512` era siempre
verdadera: el análisis profundo **sólo** corría cuando la sonda disparaba. El
centinela dependía por completo de dos heurísticas de 32 y 160 caracteres.

Ahora hay dos contadores (`lastCheck` para la sonda, `lastDeepCheck` para el
análisis) y el análisis completo corre cada 1 200 caracteres o cuando la sonda
dispara. Cuesta 0,02 µs por carácter y hace que la detección no dependa de una
sola ventana.

## Electron: lo que se apaga antes de arrancar

Cada servicio de Chromium que no se usa cuesta un proceso en segundo plano o
trabajo de red desde el primer segundo:

```js
app.commandLine.appendSwitch('disable-features',
  'Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,' +
  'InterestFeedContentSuggestions,HeavyAdPrivacyMitigations');
```

Ninguno tiene interfaz en Nexo: no hay traducción, no hay Chromecast, no hay
sugerencias de exploración. Además:

- **sin corrector ortográfico** (`session.setSpellCheckerEnabled(false)`): evita
  un proceso y la descarga de diccionarios; el campo de la barra ya declara
  `spellcheck="false"` y las pestañas heredan la misma decisión;
- **idiomas**: de los 60 archivos `.pak` de Chromium se conservan español e
  inglés (`en-US` es obligatorio como respaldo interno);
- **código inyectado minificado** (25,6 kB): se compila en cada página nueva y
  también en cada `iframe`; `npm run build:inject -- --dev` lo deja legible
  cuando hay que depurar.

## Cómo se mide el arranque real

`src/main/perf.js` deja marcas durante el arranque (`proceso`, `ready`,
`ajustes`, `memoria`, `perfil`, `motor`, `ventana`, `shell`) y resume el consumo
de todos los procesos (`app.getAppMetrics()`). `nexo.exe --smoke` las incluye en
su informe, así que **cada compilación de Windows publica sus propios números**:

```
tiempos: proceso 3,1 ms · ready 214,8 ms · ajustes 219,4 ms · memoria 231,0 ms ·
         perfil 243,7 ms · motor 251,2 ms · ventana 268,9 ms · shell 402,6 ms
principal: 96,4 MB (heap 41,2 MB)
procesos: 6 · 328,7 MB
por tipo: browser 96,4 MB, Tab 78,1 MB, GPU 62,0 MB, Utility 46,3 MB
```

Eso es lo que permite decidir con datos en lugar de con intuición: si `shell`
domina, el problema es la interfaz; si domina `ready`, es Electron y no hay
mucho que hacer desde el código.

## El trinquete: presupuesto en CI

`test/rendimiento.test.js` fija techos generosos (3 ms para el análisis, 8 ms
para la barra, 60 kB para el código inyectado) y falla si alguien los cruza. No
es un cronómetro: es un trinquete. Un cambio futuro que cuadruplique la
búsqueda del historial rompe la compilación en vez de degradar el navegador en
silencio.

Los techos son amplios a propósito: la integración continua corre en máquinas
compartidas y virtualizadas. Los números finos, para comparar dos versiones del
código, salen de `npm run bench`.

## Qué no se optimizó, y por qué

- **Filtro SSE (7,3 MB/s)**: 0,28 µs por carácter. Una respuesta típica de
  2 000 caracteres cuesta 0,57 ms. Optimizarlo más sería ruido frente a la red.
- **Memoria EVO (`recall` 5,4 ms)**: corre una vez por mensaje enviado, no en un
  bucle. Es el precio de buscar en 300 turnos con BM25 + MMR.
- **Caché de código V8 y compresión del asar**: se evaluaron y quedaron fuera
  porque el beneficio medible no justifica el riesgo de arranque en Windows;
  las marcas de `perf.js` permiten retomarlo con datos si hace falta.
- **Migrar de `<webview>` a `WebContentsView`**: es mejora de memoria y
  aislamiento, pero también un cambio de arquitectura que exige rehacer la
  intermediación con la interfaz. Está anotado como paso de la etapa 4 (CDP).

# EVO MEMORY

El primer pilar del navegador: **memoria, contexto, corrección y optimización**
entre vos y cualquier IA —ChatGPT, Claude, Gemini, Ollama y compañía—.

El problema que resuelve es concreto y económico: cada chat empieza de cero, así
que pagás dos veces por la misma información. Primero en tokens: pegás el
historial entero o lo repetís a mano. Después en calidad: el modelo olvida una
decisión que tomaste hace veinte mensajes y te hace elegirla otra vez. Nada de
eso es culpa del modelo; es que la memoria estaba afuera de la conversación.

EVO MEMORY la mueve adentro del navegador: destila cada turno en unidades
pequeñas y verificables, las guarda en tu máquina y devuelve solo lo que hace
falta para el mensaje que estás por mandar.

---

## La idea en una línea

> No le pidas a la IA que recuerde más. Dale un contexto que valga más.

---

## Qué hace

### 1. Destila la conversación mientras ocurre

Cada turno se parte en frases y cada frase se clasifica contra reglas explícitas
(`src/memory/extract.js`):

| Tipo | Qué captura | Vida media |
| --- | --- | --- |
| `goal` | objetivos del proyecto | 365 días |
| `decision` | «decidimos», «usamos», «elegimos» | 180 días |
| `constraint` | «no podemos», límites, requisitos | 120 días |
| `preference` | «prefiero», estilo, formato | 180 días |
| `task` | «queda pendiente», «falta», «próximo paso» | 14 días |
| `issue` | fallos observados: errores, excepciones, regresiones | 30 días |
| `fact` | datos con ancla dura: puertos, rutas, versiones, URLs, ids | 90 días |
| `artifact` | bloques de código reutilizables | 120 días |
| `question` | preguntas abiertas del usuario | 7 días |
| `episode` | resumen de los últimos 8 turnos | 30 días |

Reglas del destilado:

- **Una pregunta no es una decisión.** «¿Qué decidimos sobre el motor?» se guarda
  como hilo abierto, nunca como decisión.
- **Un fallo resuelto no es un problema abierto.** La regla de `issue` lleva una
  lista de exclusión: «se arregla con…» describe una solución, no un problema.
- **Los saludos no entran.** Hay un filtro de ruido que descarta muletillas,
  «como modelo de lenguaje» y frases por debajo de 24 caracteres.
- **Cada memoria sabe por qué existe.** Toda unidad guarda `reason` («fallo
  observado», «bloque de código reutilizable», «contiene 5432») y `confidence`.

### 2. Evita que la memoria crezca sin control

Tres mecanismos, en este orden:

1. **Fusión**: si dos memorias comparten ≥ 82 % de términos (Jaccard), se
   fusionan y suma el contador de usos. Repetir no engorda el archivo.
2. **Sucesión**: si dos memorias son del mismo tipo, del mismo proyecto, se
   parecen ≥ 62 % y **se contradicen** (polaridad invertida o números distintos),
   la vieja se archiva —`supersededAt`, nunca se borra— y la nueva queda activa.
   Así «el límite es 5 minutos» deja de competir con «el límite es 30 minutos».
3. **Límite duro**: por encima de `maxItems` se descarta lo menos saliente,
   protegiendo siempre lo fijado, los objetivos y las decisiones.

### 3. Recupera con seis señales, no con una

`src/memory/rank.js` puntúa cada memoria candidata:

```
score = (0.32·léxico + 0.24·semántico + 0.12·anclas + 0.18·saliencia
         + 0.09·frescura + 0.05·intención)
        × (0.6 + 0.4·peso del tipo)
        × (1 − 0.65·solapamiento)
```

- **Léxico**: BM25 sobre un índice invertido propio.
- **Semántico**: coseno TF-IDF con IDF del corpus. No es un embedding: es
  similitud distribucional, suficiente para desambiguar dentro de un proyecto.
- **Anclas**: si la consulta trae `5432`, la memoria con `5432` sube.
- **Saliencia**: importancia del tipo × frescura (`0.5^(días/vida media)`).
- **Intención**: «¿qué falta?» prioriza pendientes; «¿qué decidimos?», decisiones.
- **Diversidad**: selección MMR (λ = 0.74) para no llenar el contexto con cinco
  versiones de la misma frase.

Y una red de seguridad: si la consulta no coincide con nada, igual devuelve lo
más saliente. El peor error de un motor de memoria es devolver vacío cuando sí
había algo importante.

### 4. Compila el contexto bajo presupuesto

`src/memory/context.js` reparte el presupuesto en capas y reasigna lo que sobra:

| Capa | Tope | Qué contiene |
| --- | --- | --- |
| Fijado | 12 % | lo que el usuario marcó como crítico |
| Proyecto | 22 % | objetivos, decisiones, restricciones, preferencias |
| Recuperado | 26 % | lo relevante para **esta** consulta |
| Episodios | 10 % | resumen de turnos ya plegados |
| Trabajo | 30 % | los últimos turnos, literales |

Detalles que importan:

- Los turnos recientes van **literales**: reescribir lo último que dijo el usuario
  es la forma más rápida de perder información.
- Los episodios solo se incluyen si hay turnos plegados; si el historial entra
  completo, repetirlos sería pagar dos veces.
- Las líneas del resumen que ya viajan como memoria se eliminan (Jaccard > 0.78).
- El bloque compilado se delimita con `[EVO · …] … [/EVO]` para poder quitarlo
  del texto sin romper lo demás.

### 5. Mide el ahorro con una línea base honesta

`stats.baselineTokens` es lo que costaría pegar **todo** el historial disponible;
`stats.used` es lo que ocupa el contexto compilado. De ahí salen `savedTokens`,
`savedPct` y `compression`. Si el contexto compilado costara más que el historial,
`savedPct` vale 0 y `overheadTokens` muestra el exceso: no hay maquillaje.

### 6. Exporta la continuidad

`handoff()` produce un paquete en dos formatos: JSON (reimportable por Nexo) y
markdown (pegable en cualquier chat). Reimportarlo pasa otra vez por el mismo
motor, así que deduplica y archiva contradicciones en lugar de duplicar.

### 7. Se refuerza con el uso

Cada memoria usada en un contexto compilado suma un uso y gana importancia. Lo
que sirve sube; lo que nunca se usa envejece y cae solo.

---

## Qué **no** hace (y no va a fingir)

- **No convierte un modelo chico en uno grande.** No agrega parámetros ni
  conocimiento del mundo. Ordena y prioriza lo que ya está en la conversación.
- **No elimina los límites del proveedor.** Si el plan corta a los 8 000 tokens,
  el navegador no puede saltarse eso; puede hacer que esos tokens rindan más.
- **No es un embedding.** La similitud es TF-IDF + grupos conceptuales curados
  (21 grupos bilingües). Un sinónimo fuera de esos grupos no se puentea.
- **No verifica hechos.** Guarda lo que dijiste con su contexto; si dijiste algo
  falso, lo recuerda con la misma fidelidad. Marca procedencia, no verdad.
- **No adivina intenciones profundas.** La intención es un puñado de reglas
  léxicas, auditable en un archivo.
- **No funciona igual en todos los idiomas.** Está afinado para español (con
  inglés como secundario): stopwords, sufijos y conceptos.

---

## API

```js
import { EvoMemory } from './src/memory/index.js';

const memory = new EvoMemory({
  storage: { read: () => localStorage.getItem('evo'), write: (d) => localStorage.setItem('evo', d) },
  projectId: 'mi-proyecto',
  projectName: 'Mi proyecto',
  maxItems: 6000,
  episodeEvery: 8,
});

memory.remember({ role: 'user', content: 'Decidimos usar PostgreSQL 16.' });
memory.recall('¿qué base de datos decidimos?');           // [{ item, score, parts }]
memory.compile({ query, history, budgetTokens: 2500 });    // { payload, stats, blocks, memoryIds }
memory.handoff();                                          // { markdown, items, counts }
memory.importHandoff(packet);                              // { added, merged, superseded }
memory.pin(id, true);
memory.forget(id);
memory.stats();
```

En el navegador la memoria se crea una sola vez por perfil
(`src/main/memory.js`, archivo atómico en el directorio de usuario) y se comparte
entre todas las pestañas: la continuidad es entre sitios, no dentro de uno.

El bloque `[EVO · …]` que llega al modelo es el mismo que ves en *Memoria → Ver lo
que se envía*, y en la sala de pruebas aparece como **Mensaje mediado**.

---

## Pruebas

Las 57 pruebas de `test/memory-*.test.js` cubren: normalización y stemming,
expansión conceptual, anclas, BM25/coseno/Jaccard, fusión, sucesión por
contradicción, límite duro, persistencia con archivo corrupto, recuperación por
léxico/intención/ancla, red de seguridad, aislamiento por proyecto, MMR,
penalización de redundancia, presupuesto y redistribución de capas, plegado de
turnos, estadísticas de ahorro, extracción por reglas, preguntas, código, ruido,
episodios, refuerzo por uso y ida y vuelta del paquete de continuidad.

```bash
npm test
```

---

## Archivos

```
src/memory/lexicon.js   normalización, stemming, TF-IDF, BM25, conceptos, anclas
src/memory/item.js      tipos, importancia, frescura, fusión, contradicción
src/memory/extract.js   reglas de destilado y resumen de episodios
src/memory/store.js     índice invertido, deduplicación, persistencia, límite
src/memory/rank.js      seis señales, intención, MMR
src/memory/context.js   compilador por capas con presupuesto
src/memory/handoff.js   paquete de continuidad (JSON + markdown)
src/memory/engine.js    fachada EvoMemory y métricas
src/main/memory.js      almacenamiento atómico del proceso principal
```

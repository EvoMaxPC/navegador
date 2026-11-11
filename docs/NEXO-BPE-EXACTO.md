# Corrección del conteo BPE de entrada — NEXO 0.1.33

## Estado de verificación

**184 comparaciones independientes con OpenAI tiktoken 0.12.0: cero discrepancias**
en IDs y longitud. **72 modelos verificados** contra su módulo de
`gpt-tokenizer` 4.1.0 y la tabla de compatibilidad oficial de tiktoken.

**203 pruebas nuevas del conteo/captura: correctas.**
**Suite completa: 1011 totales, 1010 correctas, 0 fallos, 1 omitida**
(empaquetado Windows/Electron, que requiere `NEXO_ELECTRON_ZIP_DIR`).

Esto verifica BPE sobre texto visible en los casos reproducibles indicados, **no
el consumo facturado de OpenAI**. La unicidad entre transportes se verifica cuando
hay ID de mensaje compartido; **no se garantiza para observaciones anónimas que no
exponen una identidad compartida**. Ese caso se señala expresamente en Actividad.
No se declara cumplida una garantía universal de deduplicación que no puede
probarse sin la identidad del envío.

## Respaldo anterior al cambio

Antes de modificar se creó `respaldo-antes-de-bpe.zip` con el árbol completo
versionado de la rama, que estaba limpio, en el commit base
`055c703ba0dc9b7abb7189cc109755cec4a01bed`.

SHA-256:
`975b1fcad2c8b26cad889ea9dfb842945f85340838629faf40308682bc757cab`.

Ubicación del respaldo y registros: `/home/user/deliveries/nexo-bpe/`.
La rama permanece `arena/4678aef7-navegador`. El commit de entrega se informa en
`ENTREGA.txt` del ZIP y en la respuesta final; el ZIP contiene todo el proyecto
fuente, sin perfil privado, `.git` ni dependencias descargadas.

## Causas raíz encontradas

1. Red y CDP aplicaban `located.value.trim()` al texto del cuerpo; el gesto del
   compositor aplicaba `textoDelCuadro().trim()`. Esto eliminaba espacios y saltos
   de los bordes antes de contar. El resultado podía ser BPE válido, pero **de otra
   cadena**, no del texto original.
2. `countGptTokens` elegía por expresión regular y enviaba cualquier otro modelo,
   incluso vacío, `auto` o desconocido, al encoding predeterminado. Una respuesta
   numérica no demostraba compatibilidad con el modelo observado.
3. La observación de red podía decodificar cada fragmento de `uploadData` a UTF-8
   antes de unirlo: un emoji partido entre fragmentos podía transformarse en
   caracteres de sustitución. Ahora se concatenan los bytes y se decodifica una
   sola vez; un cuerpo incompleto/ilegible no se presenta como texto íntegro.
4. La deduplicación se apoyaba en huella, tiempo y fuente distinta. No distinguía
   de forma concluyente dos envíos idénticos con fuentes intercaladas. Además, un
   segundo aviso de la página podía generar otro registro visible aunque el motor
   ya lo hubiera descartado del total.
5. El conteo repetido para motor y log se ejecutaba por separado. Los modelos no
   identificados y las estimaciones heredadas se podían agregar al mismo total de
   entrada, sin distinguir su fiabilidad.

## Fórmula implementada

```
T = |E_m(S)| = encode_Em(S_original).length
```

Implementación: `src/core/gptTokens.cjs`.

- Rechaza textos que no sean cadenas con `TypeError`.
- Pasa la cadena original a `encode`, sin trim, replace, normalización Unicode,
  cambios de tabulaciones, eliminación de emojis o conversión de caracteres.
- Cadena vacía con modelo/encoding identificado: **0**.
- Literal como `<|endoftext|>` se trata como texto ordinario, no como una
  instrucción de control. En tiktoken se compara con `disallowed_special=()`; en
  JavaScript se usa `disallowedSpecial: new Set()`.
- Modelo vacío, `auto` o no verificado: **null**, `tokenExact: false` y
  `tokenMethod: unknown-model`; no se presenta cero ni un estimado como BPE exacto.
- La caché por encoding y texto es local, acotada y no persistida. Reutiliza el
  resultado matemático, **no elimina envíos legítimos con texto idéntico**.

Se usan los campos de modelo observados en la solicitud (`model`, `model_slug` y
los metadatos ya soportados). No se deduce el modelo por la apariencia de la web,
el nombre de una conversación ni el proveedor por sí solo. Si ChatGPT solicita
`auto`, no se afirma conocer qué modelo oculto lo atenderá.

## Selección del encoding

La tabla cerrada está en `src/core/bpe-models.json` (72 entradas) y se incluye íntegra
bajo `models` en `BPE-OFICIAL-COMPARACION.json`.

| Modelos comprobados, entre otros | Encoding |
|---|---|
| GPT-5, GPT-5 mini/nano y snapshots incluidos en la tabla | o200k_base |
| GPT-4.1, mini/nano y snapshots incluidos | o200k_base |
| GPT-4o, mini y snapshots incluidos; chatgpt-4o-latest | o200k_base |
| o1/o3/o4-mini y variantes incluidas | o200k_base |
| GPT-4, GPT-4 turbo y snapshots incluidos | cl100k_base |
| GPT-3.5 turbo y variantes incluidas | cl100k_base |
| Modelos fuera de la tabla, incluyendo aliases no verificados | sin BPE exacto |
| Otros proveedores sin tokenizador compatible instalado | estimación heredada separada, nunca BPE exacto |

La tabla se obtuvo comprobando el encoding de los módulos `model/<modelo>.js` de
la biblioteca instalada contra `tiktoken.encoding_name_for_model(modelo)`, no por
un prefijo aproximado en tiempo de ejecución. El script verifica **cada entrada**.
La exportación `modelsMap.o200k_base` de esta versión instalada está vacía; no se
utiliza ese vacío para adoptar un encoding por defecto. Tampoco se invoca su
exportación CJS `models`, que falla con `ReferenceError: turbo is not defined`.
No se modificó la dependencia ni se parcheó `node_modules`.

## Integridad de cada envío

- `userMessageIdentity` extrae el `id` del último mensaje con rol user del cuerpo,
  sin calcularlo a partir del contenido. Se propaga por fetch/preload, red y CDP.
- La identidad se delimita por pestaña y proveedor. Los avisos del mismo ID
  comparten registro y alias de respuesta, aunque lleguen en distinto orden.
- Dos IDs distintos, aunque el texto sea idéntico, cuentan como dos envíos.
- La red conserva también el ID de petición de Electron como identificador local;
  CDP conserva el de su solicitud. SSE sigue siendo una ruta de **respuesta**, no
  vuelve a sumar entrada.
- Un aviso del compositor sin modelo puede completarse al llegar la solicitud
  identificada, sin sumar otro mensaje ni los tokens dos veces. Se actualizan los
  contadores y se notifica la shell.
- En cada ruta se reutiliza la medición en motor/log, y hay caché BPE acotada por
  proceso. Preload no reenvía `tokenText` al registro ni persiste el texto.
- Los avisos ya correlacionados no crean otro registro visible de envío.

### Límite explícito: rutas sin identidad compartida

Para conservar los proveedores existentes, se mantiene un respaldo de correlación
por fuente, huella y ventana temporal cuando falta el ID del proveedor. Cada
fuente sólo se empareja una vez por registro, y dos IDs explícitos diferentes
**nunca** se fusionan por ese respaldo.

Aun así, sin identidad compartida no hay evidencia suficiente para distinguir
siempre «otro observador del mismo envío» de «otro envío idéntico». Se expone
`inputCorrelationUnverified` y una advertencia en Cómo se mide tu actividad.
La correlación es acotada a la sesión; no se afirma deduplicación universal de
reintentos anónimos o de observaciones fuera de la ventana/retención local.
Una sesión real de ChatGPT, DPU u otro proveedor que oculte modelo/IDs debe seguir
indicándose como no verificada, no como una validación exacta completa.

## Categorías independientes

| Dato | Campo / tratamiento |
|---|---|
| BPE del texto original del usuario con modelo verificado | `inputTokens` |
| Estimaciones heredadas de otros proveedores/metadatos antiguos | `estimatedInputTokens`, no sumadas a BPE |
| Mensajes sin modelo/texto verificable | `unknownInputMessages` |
| Correlación de envíos sin identidad verificada | `inputCorrelationUnverified` |
| Salida visible heredada | `outputTokens`, continúa etiquetada como estimación por palabras; **no se convirtió a BPE ni se afirma exactitud** |
| Instrucciones/contexto interno oculto | `hiddenContextTokens: null` |
| Tokens facturables | `providerBilledTokens: null`, sin fuente oficial de usage |

No se suma el BPE de entrada con estimaciones de salida, contexto oculto o
facturación. Esta corrección no modifica el contador de salida, la memoria
conversacional, los motores de optimización ni el texto que decide enviar el
mediador ya existente. Las pruebas de captura confirman que la observación no
modifica el cuerpo ni el compositor. No se rediseñó la interfaz: sólo se precisa
el rótulo de entrada y su explicación en los detalles de Actividad.

## Verificación independiente y reproducción

El informe máquina `BPE-OFICIAL-COMPARACION.json` contiene, para **cada comparación**:
`text` completo sin modificar, modelo, encoding, hash UTF-8, `nexoIds`, `nexo`,
`officialIds`, `official` y `match`.

La referencia no es otra llamada a la misma biblioteca JS: es **OpenAI tiktoken
0.12.0**, con su implementación Rust. Sus tablas `.tiktoken` se cargan desde los
recursos de la dependencia npm únicamente tras verificar sus SHA-256 contra los
hashes oficiales fijados en `tiktoken_ext.openai_public`. El registro oficial de
tiktoken vuelve a comprobar esos hashes; la comparación funciona sin acceso a
los servidores de blobs de OpenAI. No se sustituyen el algoritmo ni las expresiones
regulares del tokenizador oficial.

Se comparan **toda la secuencia de IDs y su longitud**, no sólo el número. Son
56 textos por cada uno de los dos encodings (24 casos dirigidos y 32 fuzz
reproducibles), más 72 comprobaciones de selección de modelo: **184**.

```
npm ci
npm run build:inject
python -m venv .venv-verificacion
# Activar el entorno según el sistema, después:
python -m pip install tiktoken==0.12.0
python scripts/verify-bpe-official.py
node --test test/bpe-exact.test.js test/bpe-capture.test.js
npm test
```

El entorno Python es sólo de verificación; no es dependencia de NEXO. Si se crea
en el repositorio, no debe incluirse en el ZIP ni versionarse.

Las pruebas de integración ejecutan main real con Electron simulado, el bundle
real de inyección y el preload real. Comprueban bytes de solicitud sin cambios,
espacios, CRLF, tabs, acentos combinados, emojis, Unicode invisible, fragmentos
UTF-8, orden de observadores, dos envíos idénticos legítimos y un registro visible
por envío identificado. Las regresiones existentes cubren SSE, historial DOM,
respuestas, EVO, Comprensión y proveedores.

**No se realizó una sesión real con cuenta ChatGPT ni se ejecutó un binario de
Windows.** La omitida de empaquetado no se cuenta como prueba correcta.

## Casos dirigidos (texto exacto serializado como JSON)

Los escapes `\n`, `\r`, `\t` de la siguiente tabla representan exactamente esos
caracteres, no espacios sustituidos. Para el texto largo se incluye el string
íntegro en el informe JSON, sin abreviarlo ni normalizarlo.

| Caso | Texto original (JSON) | GPT-4 turbo / cl100k: NEXO = oficial | GPT-5 / o200k: NEXO = oficial |
|---|---|---:|---:|
| normal | `"Hola, mundo."` | 4 = 4 | 4 = 4 |
| bordes | `"  Hola, mundo.  "` | 7 = 7 | 6 = 6 |
| espacios | `"uno    dos       tres"` | 5 = 5 | 5 = 5 |
| saltos | `"primera\nsegunda\n\ntercera\n"` | 10 = 10 | 9 = 9 |
| CRLF | `"uno\r\ndos\r\n"` | 4 = 4 | 4 = 4 |
| tabulaciones | `"\tuno\tdos\t"` | 5 = 5 | 5 = 5 |
| acentos | `"\u00c1rbol, caf\u00e9, ping\u00fcino, acci\u00f3n."` | 12 = 12 | 12 = 12 |
| enye | `"\u00d1and\u00fa, ni\u00f1o, \u00bf\u00a1\u20ac\u00a3\u00a5\u00a9\u2122!?"` | 15 = 15 | 14 = 14 |
| emoji | `"Hola \ud83d\ude00\ud83d\ude80"` | 5 = 5 | 4 = 4 |
| emoji-combinado | `"\ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66 \ud83c\udde6\ud83c\uddf7 \u2764\ufe0f"` | 35 = 35 | 23 = 23 |
| vacio | `""` | 0 = 0 | 0 = 0 |
| solo-espacios | `"   "` | 1 = 1 | 1 = 1 |
| solo-saltos | `"\n\n"` | 1 = 1 | 1 = 1 |
| solo-tabs | `"\t\t"` | 1 = 1 | 1 = 1 |
| NFC | `"caf\u00e9"` | 2 = 2 | 2 = 2 |
| NFD | `"cafe\u0301"` | 3 = 3 | 3 = 3 |
| invisibles | `"a\u200bb\u00a0c\ufeff"` | 6 = 6 | 6 = 6 |
| literal-especial | `"<\u007cendoftext\u007c> <\u007cim_start\u007c>"` | 12 = 12 | 13 = 13 |
| multilingue | `"\u4f60\u597d\u4e16\u754c \u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 \u65e5\u672c\u8a9e"` | 19 = 19 | 8 = 8 |
| largo | `rows[case="largo"].text` del JSON (string completo) | 4680 = 4680 | 3960 = 3960 |
| repetido-1 | `"Enviar lo mismo"` | 3 = 3 | 3 = 3 |
| repetido-2 | `"Enviar lo mismo"` | 3 = 3 | 3 = 3 |
| consecutivo-1 | `"Primer mensaje"` | 3 = 3 | 2 = 2 |
| consecutivo-2 | `"Segundo mensaje distinto"` | 5 = 5 | 3 = 3 |

La tabla usa modelos representativos; la tabla completa de 72 modelos se valida por separado en el mismo informe.

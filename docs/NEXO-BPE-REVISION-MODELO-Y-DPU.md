# Revisión BPE — selección de modelo, ruta alternativa y DPU

## Motivo de esta revisión

La revisión del usuario identificó un defecto real: `model: "auto"` tenía
prioridad sobre un `metadata.model_slug` concreto en el mismo cuerpo. También
señaló estimaciones de entrada en la inyección y que el test del preload comparaba
contra la misma biblioteca JS, no una referencia independiente.

Se creó respaldo del árbol limpio **antes** de modificar:
`respaldo-be484c6.zip`, commit base
`be484c6975e38599512dd781e7c27e006110b305`.

SHA-256 del respaldo:
`128f26c3d395c25549b7c0a79ccf61136475223bfdb7f45ca2a4d5a70264d1b6`.

## 1. Selección de modelo corregida primero

`gptModelFromRequest()` distingue entre identificadores concretos y selectores de
enrutamiento (`auto`, `automatic`, `default`, `dynamic`, `unknown`). Selecciona
el primer identificador no selector declarado en los campos existentes.

Ejemplos probados:

```js
gptModelFromRequest({model:'auto', metadata:{model_slug:'gpt-5'}})
// 'gpt-5'

gptModelFromRequest({model:'auto', conversation_mode:{model:'gpt-5'}})
// 'gpt-5'

gptModelFromRequest({model:'gpt-4o', metadata:{model_slug:'gpt-5'}})
// 'gpt-4o': conserva la prioridad del campo principal si ya es concreto.

gptModelFromRequest({model:'auto'})
// 'auto': no inventa qué modelo atenderá una selección automática.
```

La tabla cerrada de compatibilidad sigue verificando el identificador resultante:
que un string no sea un selector **no** lo convierte en un modelo compatible.
Un identificador concreto fuera de la tabla sigue produciendo conteo `null`.
No se cambia ni normaliza el texto del usuario.

La función es la misma utilizada por red, CDP e inyección. Hay pruebas sobre los
handlers reales de red y CDP, además de la función y el bundle, para el cuerpo
`model:auto + metadata.model_slug:gpt-5`.

## 2. Entrada GPT sin estimaciones en gesto, JSON o DPU

En la página, el metadato de entrada GPT ahora es **null** hasta el conteo BPE del
preload. Se eliminan las estimaciones de esas rutas:

- Compositor alternativo: entrega el texto original, sin calcular tokens por regla.
- Solicitud JSON: entrega el texto original y el modelo seleccionado del cuerpo.
- Formulario DPU: lee `model`, `model_slug`, `metadata` y `conversation_mode` del
  mismo formulario cuando estén disponibles. Soporta `URLSearchParams`,
  `FormData`, string URL-encoded y cuerpo de un objeto `Request`.
- DPU con modelo verificado: el preload calcula `encode(textoOriginal).length`.
- DPU sin modelo identificable: mantiene `tokens:null`, `tokenExact:false` y
  `tokenMethod:unknown-model`. No puede afirmarse conteo exacto sin encoding.
- Prompt DPU vacío, con modelo verificado: 0. Prompt ausente/ilegible: null, no 0.

Las estimaciones de **otros proveedores** continúan aisladas en
`legacyProviderInputTokens()`, que retorna null inmediatamente para ChatGPT.
Las otras llamadas a `estimateTokens` de la inyección corresponden a la salida
heredada y no al conteo BPE de entrada. No se elimina esa compatibilidad ni se
presentan sus estimaciones como BPE exacto.

### Hallazgo adicional de la prueba del compositor

El gesto guardaba `nuevo.id`, pero al anunciarlo no lo pasaba como `messageId`;
el anunciador generaba otro identificador. Al llegar la petición tardía se
reutilizaba el primero, no el anunciado. Se corrige pasando explícitamente
`messageId:nuevo.id`. La prueba verifica igualdad del ID entre gesto y petición,
y que la segunda observación aporte el modelo y BPE sin inventar otro envío.

## 3. Comparación oficial aplicada al preload

La comparación independiente del núcleo ya existía en
`scripts/verify-bpe-official.py` y `docs/BPE-OFICIAL-COMPARACION.json`. La crítica
sobre **el test específico del preload** era válida: comparaba con
`gpt-tokenizer`, de modo que esa prueba aislada sólo comprobaba el envoltorio.

Ahora:

1. `test/preload-tokens.test.js` ya no importa `countTokens` de `gpt-tokenizer`.
2. Comprueba el resultado de `outgoingMetadata` contra los valores `official` y la
   longitud de `officialIds` generados por OpenAI tiktoken. Casos específicos para
   ambos encodings: texto normal, bordes, tabulaciones, saltos, CRLF, emojis,
   combinaciones de emojis, Unicode NFD, acentos y cadena vacía.
3. El test del bridge real usa también una referencia oficial, no otro conteo JS.
4. El script independiente se amplía para ejecutar el **preload real** sobre cada
   fila antes de compararlo con OpenAI tiktoken 0.12.0. Cada registro agrega
   `preload` y `preloadEncoding`; `match` exige que también coincidan con la
   referencia oficial, además de los IDs y longitud del núcleo.

Resultado reproducido: **184 filas comparadas, 0 discrepancias**.
Cada fila conserva el texto completo exacto, modelo, encoding, IDs de NEXO e IDs
oficiales. Se mantienen los hashes oficiales de las tablas BPE verificados por
el registro de tiktoken. La dependencia de ejecución no cambió:
**gpt-tokenizer 4.1.0**.

Ejemplo de referencia utilizado también en las rutas reales:

| Texto original serializado como JSON | Modelo | Encoding | NEXO / preload | tiktoken |
|---|---|---|---:|---:|
| `"  Hola, mundo.  "` | gpt-5 | o200k_base | 6 | 6 |
| `"  Hola, mundo.  "` | gpt-4-turbo | cl100k_base | 7 | 7 |
| `""` | gpt-5 | o200k_base | 0 | 0 |

El texto de cada caso no se reconstruye a partir de los escapes de esta tabla:
los tests reciben directamente el string íntegro del informe JSON.

## 4. Pruebas ejecutadas

- `npm run build:inject`: correcto, bundle de inyección y lectores reconstruidos.
- Verificador independiente con **OpenAI tiktoken 0.12.0**: 184 filas, 0 discrepancias
  en núcleo y preload real.
- Pruebas focalizadas: **274 correctas, 0 fallos, 0 omitidas**.
- `npm test`: **1040 totales, 1039 correctas, 0 fallos, 1 omitida**.
  La omitida requiere el entorno de empaquetado Windows/Electron.

La primera suite completa detectó tres contratos antiguos que exigían tokens
estimados o cero para texto ilegible en la página. Se actualizaron a **null antes
del preload** conforme al nuevo contrato; no se retiraron esas pruebas. La prueba
nueva de solicitud tardía detectó el defecto de ID descrito arriba, que fue
corregido antes de la validación final.

Registros y respaldo: `/home/user/deliveries/nexo-bpe-revision/`.

## Alcance y límites

Sólo se modifica código de producción en `src/core/text.js` y
`src/inject/index.js`; el resto de cambios son pruebas, verificador e informes.
Sin rediseño de interfaz, sin dependencia nueva de ejecución y sin modificar
motores de memoria, lectura DOM, Comprensión, salida o facturación.

Continúan los límites declarados: DPU sin modelo no tiene BPE exacto; las
observaciones sin ID compartido no permiten certificar unicidad universal;
contexto oculto y facturación no se conocen. No se realizó sesión real con cuenta
ChatGPT ni validación manual del binario en Windows. El ZIP es proyecto fuente,
no instalador Windows validado.

Reproducción del verificador (Python sólo para QA):

```
npm ci
npm run build:inject
python -m pip install tiktoken==0.12.0
python scripts/verify-bpe-official.py
node --test test/preload-tokens.test.js test/bpe-input-routes.test.js test/bpe-capture.test.js test/bpe-exact.test.js test/contadores-red.test.js test/capa-inyectada.test.js
npm test
```

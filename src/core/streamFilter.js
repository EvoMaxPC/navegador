/**
 * Filtro de streams SSE.
 *
 * Envuelve el cuerpo de una respuesta `text/event-stream` y reescribe el texto
 * que viaja dentro de cada evento. Todo lo demás —nombre del evento, `id`,
 * `retry:`, comentarios de latido y metadatos— se reenvía **tal cual llegó**:
 * el cliente del sitio no tiene que notar nada salvo que la respuesta deja de
 * repetirse.
 *
 * Cuatro reglas que sostienen la corrección:
 *
 *  1. **Qué es texto lo decide el adaptador del proveedor**
 *     (`streamAdapters.js`), no una heurística suelta sobre claves.
 *
 *  2. **Si el centinela corta**, los eventos siguientes se siguen enviando pero
 *     sin texto. Cortar el stream dejaría al cliente esperando un cierre que
 *     nunca llega, y el sitio se quedaría «escribiendo» para siempre.
 *
 *  3. **El búfer de retención** implica que los últimos caracteres todavía no
 *     salieron. En un protocolo acumulado no se puede escribir el texto
 *     recibido: hay que escribir el **entregado**, o el texto retenido se vería
 *     como algo que aparece y desaparece.
 *
 *  4. **El texto pendiente sale antes del cierre.** Al llegar un evento de fin
 *     de bloque o de mensaje se entrega lo retenido en un evento sintético con
 *     la forma del último evento de texto, y después sí el cierre. Al final del
 *     stream, `[DONE]` va último.
 */

import { outcomeFromEvent } from './turnOutcome.js';
import { parseSSE, passthroughSSE, rewriteSSE, serializeSSE } from './sse.js';
import { StreamSentinel } from './streamSentinel.js';
import { createAdapter } from './streamAdapters.js';

const encoder = new TextEncoder();

/**
 * Resumen **estructural** del stream para el diagnóstico: cuenta formas, no
 * valores. Lo publica el proceso principal sólo con `NEXO_DIAG=1`
 * (`diag-stream-end`), y sirve para saber qué llegó cuando el acumulador saca 0
 * caracteres: cuántos eventos, cuántos JSON, qué nombres de evento y de clave,
 * qué tipo tiene `v` y cuántos eventos el extractor consideró portadores.
 *
 * Nunca guarda contenido: los nombres pasan por `LISTA_BLANCA` y lo que no
 * encaja se cuenta como `otros`; las listas quedan acotadas en variedad y en
 * longitud total.
 */
const LISTA_BLANCA = /^[a-z_]{1,24}$/;
const TOPE_NOMBRES = 12;
const TOPE_NOMBRES_RENDER = 2000;
const TOPE_TIPOS_V = 40;
const TOPE_SALIDA = 400;

/** Rutas `p` normalizadas: dígitos a `N`, sin nada más que esto. */
const RUTA_DIAG = /^\/[a-z_/N]{1,48}$/;
/** Valores de `o`: sólo letras y `_`, como los nombres. */
const OPERACION_DIAG = /^[a-z_]{1,16}$/;
const TOPE_ANIDADO = 12;

/* --- esqueleto por evento: la FORMA del stream, nunca sus valores ---------- */

/** Profundidad máxima que se recorre al dibujar el esqueleto. */
const ESQ_PROFUNDIDAD = 4;
/** Claves y elementos por objeto/array antes de resumir con «+N». */
const ESQ_ANCHO = 8;
/** Eventos que se dibujan: los primeros de cada stream. */
const ESQ_EVENTOS = 24;
/** A partir de aquí, el aviso se parte en varios en vez de cortarse. */
const ESQ_TROZO = 2400;

/** Claves que sí se imprimen literales, y sólo si pasan la lista blanca. */
const ESQ_LITERALES = new Set(['p', 'o', 'type', 'kind', 'event', 'role', 'content_type', 'status', 'channel', 'marker']);
/** Un literal publicable: dígitos a N y sólo letras, `_` y `/`. */
const ESQ_LITERAL = /^[a-z_/]{1,48}$/;

/**
 * Dibuja la forma de un valor: nombres de clave, tipos y longitudes de cadena.
 * **Ningún texto sale de aquí** salvo los literales de `ESQ_LITERALES` que
 * pasen la lista blanca; el resto es `s<longitud>`.
 */
function dibujar(valor, clave, profundidad, salida) {
  if (typeof valor === 'string') {
    const literal = ESQ_LITERALES.has(clave) ? valor.replace(/\d+/g, 'N').toLowerCase() : '';
    salida.push(literal && ESQ_LITERAL.test(literal) ? literal : `s${valor.length}`);
    return;
  }
  if (typeof valor === 'number') { salida.push('n'); return; }
  if (typeof valor === 'boolean') { salida.push(String(valor)); return; }
  if (valor === null || valor === undefined) { salida.push(String(valor)); return; }
  if (profundidad >= ESQ_PROFUNDIDAD) { salida.push(Array.isArray(valor) ? '[…]' : '{…}'); return; }

  if (Array.isArray(valor)) {
    salida.push('[');
    const vistos = valor.slice(0, ESQ_ANCHO);
    vistos.forEach((item, i) => {
      if (i) salida.push(',');
      dibujar(item, '', profundidad + 1, salida);
    });
    if (valor.length > ESQ_ANCHO) salida.push(`,+${valor.length - ESQ_ANCHO}`);
    salida.push(']');
    return;
  }

  salida.push('{');
  const claves = Object.keys(valor);
  claves.slice(0, ESQ_ANCHO).forEach((original, i) => {
    const nombre = String(original).trim().toLowerCase();
    const publicable = LISTA_BLANCA.test(nombre) ? nombre : 'k?';
    if (i) salida.push(',');
    salida.push(`${publicable}:`);
    dibujar(valor[original], publicable, profundidad + 1, salida);
  });
  if (claves.length > ESQ_ANCHO) salida.push(`,+${claves.length - ESQ_ANCHO}`);
  salida.push('}');
}

/** Una firma por evento: nombre SSE + forma del JSON, o clasificación del no-JSON. */
function firmaEvento(evt, data) {
  const salida = [];
  const nombre = String(evt.event || '').trim().toLowerCase();
  salida.push(nombre && LISTA_BLANCA.test(nombre) ? `${nombre} ` : '');
  const json = safeJson(data);
  if (!json) {
    const c = clasificarNoJson(data, false);
    return `${salida.join('')}nojson:${c.longitud}:${c.clase}`;
  }
  salida.push('<');
  dibujar(json, '', 0, salida);
  salida.push('>');
  return salida.join('');
}

/** Normaliza una ruta `p`: los índices numéricos pasan a `N`. */
function normalizarRuta(crudo) {
  const ruta = String(crudo === null || crudo === undefined ? '' : crudo).replace(/\d+/g, 'N');
  return RUTA_DIAG.test(ruta) ? ruta.slice(0, 48) : 'otra';
}

/** Un valor de `o` publicable, o `otra`. */
function normalizarOperacion(crudo) {
  const valor = typeof crudo === 'string' ? crudo.trim().toLowerCase() : '';
  return OPERACION_DIAG.test(valor) ? valor : 'otra';
}

/**
 * Clasifica un evento que no es JSON **sin guardar nada de su contenido**: sólo
 * longitud, clase del primer carácter, si era el último y si equivale a `[DONE]`
 * con espacios o CRLF.
 */
function clasificarNoJson(data, esUltimo) {
  const crudo = String(data === null || data === undefined ? '' : data);
  const limpio = crudo.trim();
  const primero = limpio[0] || '';
  const clase = !limpio ? 'vacio'
    : /[a-zA-Z]/.test(primero) ? 'letra'
      : /\d/.test(primero) ? 'digito' : 'simbolo';
  return {
    longitud: limpio.length,
    clase,
    ultimo: Boolean(esUltimo),
    esDone: /^\[\s*DONE\s*\]$/i.test(limpio.replace(/\r\n/g, '\n')),
    conCrlf: /\r/.test(crudo),
  };
}

function contarNombre(lista, crudo, contador) {
  const nombre = typeof crudo === 'string' ? crudo.trim().toLowerCase() : '';
  if (LISTA_BLANCA.test(nombre)) {
    if (!lista.includes(nombre)) {
      if (lista.length >= TOPE_NOMBRES) return;
      lista.push(nombre);
    }
    return;
  }
  // Sin nombre utilizable: sólo se cuenta, nunca se guarda.
  if (contador) contador.otros += 1;
}

function tipoDeV(valor) {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return 'array';
  return typeof valor;
}

/**
 * Cierra el nivel 2: listas renderizadas y acotadas, y banderas de "hubo algo
 * fuera de la lista blanca". Sin un solo valor de texto.
 */
function resumirAnidado(anidado) {
  const lista = (valores) => valores.slice(0, TOPE_ANIDADO).join(',').slice(0, 300);
  const mensaje = anidado.mensaje;
  return {
    vArray: anidado.vArray,
    elementos: anidado.elementos,
    clavesElemento: lista(anidado.clavesElemento),
    tiposElementoV: lista(anidado.tiposElementoV),
    opsEvento: lista(anidado.opsEvento),
    opsElemento: lista(anidado.opsElemento),
    rutasParche: lista(anidado.rutasParche),
    rutasEvento: lista(anidado.rutasEvento),
    vObjetoClaves: lista(anidado.vObjetoClaves),
    fueraDeLista: Boolean(anidado.opOtra || anidado.rutasOtra || anidado.rutasEventoOtra || anidado.vObjetoOtra),
    mensaje: {
      roles: lista(mensaje.roles),
      tipos: lista(mensaje.tipos),
      estados: lista(mensaje.estados),
      canales: lista(mensaje.canales),
      metadataClaves: lista(mensaje.metadataClaves),
      descartados: mensaje.descartados,
      sinTexto: mensaje.sinTexto,
      aceptados: mensaje.aceptados,
      vistos: mensaje.vistos,
      causas: { ...mensaje.causas },
      assistantSi: mensaje.assistantSi,
      assistantNo: mensaje.assistantNo,
      otra: Boolean(mensaje.otra),
      descartes: mensaje.descartes.slice(0, 12),
      ocultoLevantado: mensaje.ocultoLevantado,
      cierre: Boolean(mensaje.cierre),
      removes: mensaje.removes.slice(0, 6),
      removesOtra: Boolean(mensaje.removesOtra),
    },
    rutaTexto: { ...anidado.rutaTexto },
    noJson: anidado.noJson,
  };
}

/**
 * Reparte el esqueleto en trozos de `ESQ_TROZO` caracteres, sin cortar ningún
 * evento por la mitad. Devuelve el texto de cada aviso.
 */
export function trocearEsqueleto(firmas, tope = ESQ_TROZO) {
  const trozos = [];
  let actual = '';
  for (const firma of firmas) {
    const pieza = actual ? ` | ${firma}` : firma;
    if (actual && actual.length + pieza.length > tope) {
      trozos.push(actual);
      actual = firma;
    } else {
      actual += pieza;
    }
  }
  if (actual) trozos.push(actual);
  return trozos;
}

function resumirEstructura(resumen) {
  const recorta = (lista) => {
    const caben = [];
    let total = 0;
    for (const nombre of lista) {
      if (total + nombre.length + 1 > TOPE_NOMBRES_RENDER) break;
      caben.push(nombre);
      total += nombre.length + 1;
    }
    return caben.join(',');
  };
  return {
    eventos: resumen.eventos,
    conDatos: resumen.conDatos,
    jsonValido: resumen.jsonValido,
    jsonInvalido: resumen.jsonInvalido,
    sinEvento: resumen.sinEvento,
    dones: resumen.dones,
    nombresEvento: recorta(resumen.nombresEvento),
    claves: recorta(resumen.claves),
    clavesOtros: resumen.clavesOtros,
    tiposV: recorta(resumen.tiposV),
    portadores: resumen.portadores,
    lineas: resumen.lineas,
  };
}

/**
 * @param {{
 *   format?: 'sse'|'ndjson'|'auto',
 *   settings?: object,
 *   adapter?: string|null,
 *   deltaPaths?: string[]|null,
 *   language?: string,
 *   host?: string|null,
 *   onStop?: (info: object) => void,
 *   onText?: (info: { text: string, deliveredChars: number }) => void,
 *   onEnd?: (info: object) => void,
 *   onError?: (info: { stage: string, message: string }) => void
 * }} opts
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createStreamFilter(opts = {}) {
  const sentinel = new StreamSentinel({
    settings: opts.settings,
    host: opts.host ?? null,
    language: opts.language || 'es',
  });

  // El adaptador puede entrar como objeto (pruebas, modos experimentales) o
  // como nombre del catálogo de proveedores.
  const adapter =
    opts.adapter && typeof opts.adapter === 'object'
      ? opts.adapter
      : createAdapter(opts.adapter || opts.provider || null, { deltaPaths: opts.deltaPaths || null });

  const decoder = new TextDecoder();
  let buffered = '';
  let format = opts.format || 'sse';
  let ended = false;
  const chatgpt = opts.adapter === 'chatgpt' || opts.provider === 'chatgpt';
  let protocolEnded = false;
  let outcome = null;
  const observeOutcome = (json) => {
    const next = outcomeFromEvent(json);
    if (next && (!outcome || outcome === 'completed')) outcome = next;
    if (chatgpt && (next === 'failed' || next === 'cancelled')) protocolEnded = true;
  };
  // Resumen estructural del stream (`diag-stream-end`). Se calcula siempre
  // —es un contador de formas, sin contenido y sin coste apreciable— porque el
  // filtro no conoce `NEXO_DIAG`; el proceso principal decide si lo publica.
  const estructura = {
    eventos: 0, conDatos: 0, jsonValido: 0, jsonInvalido: 0, sinEvento: 0, dones: 0,
    nombresEvento: [], claves: [], clavesOtros: 0, tiposV: [], portadores: 0, lineas: 0,
  };
  // Nivel 2: la forma de lo que va **dentro** de `v` (arrays de parches,
  // mensajes anidados) y los descartes del adaptador. Sólo nombres, rutas
  // normalizadas y conteos; nunca valores de texto.
  const anidado = {
    vArray: 0, elementos: 0, clavesElemento: [], tiposElementoV: [],
    opsEvento: [], opsElemento: [], opOtra: false,
    rutasParche: [], rutasOtra: false, rutasEvento: [], rutasEventoOtra: false,
    vObjetoClaves: [], vObjetoOtra: false,
    mensaje: { roles: [], tipos: [], estados: [], canales: [],
      metadataClaves: [], descartados: 0, sinTexto: 0, aceptados: 0,
      causas: { rol: 0, tipo: 0, fragmento: 0, oculto: 0, canal: 0, otra: 0 },
      assistantSi: 0, assistantNo: 0, vistos: 0, otra: false, descartes: [],
      ocultoLevantado: 0, removes: [], removesOtra: false, cierre: false },
    // Forma de `v` en los eventos que apuntan a una parte de texto, y cuántos
    // de ellos dieron segmento.
    rutaTexto: { string: 0, array: 0, object: 0, otro: 0, conSegmento: 0 },
    noJson: null,
  };
  // Esqueleto de los primeros eventos. Se calcula siempre —es una pasada de
  // formas sobre datos ya parseados— y main decide si lo publica.
  const esqueleto = [];
  const anotarEsqueleto = (evt) => {
    if (esqueleto.length >= ESQ_EVENTOS) return;
    esqueleto.push(firmaEvento(evt, evt.data));
  };
  const empujar = (lista, valor, tope = TOPE_ANIDADO) => {
    if (lista.length < tope && !lista.includes(valor)) lista.push(valor);
  };
  const contarEvento = (evt) => {
    estructura.eventos += 1;
    anotarEsqueleto(evt);
    if (!evt.hasData) return false;
    estructura.conDatos += 1;
    if (!evt.event) estructura.sinEvento += 1;
    else contarNombre(estructura.nombresEvento, evt.event, null);
    return true;
  };
  /** Cuenta la forma de un JSON ya leído. `portador` = el extractor sacó texto. */
  const contarJson = (json, portador) => {
    estructura.jsonValido += 1;
    if (portador) estructura.portadores += 1;
    if (Array.isArray(json)) return;                    // sin claves de primer nivel
    if (!json || typeof json !== 'object') return;
    for (const clave of Object.keys(json)) contarNombre(estructura.claves, clave, estructura);
    if ('v' in json) {
      const tipo = tipoDeV(json.v);
      if (estructura.tiposV.length < TOPE_TIPOS_V && !estructura.tiposV.includes(tipo)) {
        if (LISTA_BLANCA.test(tipo)) estructura.tiposV.push(tipo);
      }
      contarAnidado(json);
    }
  };

  /**
   * Nivel 2: la forma de `v` cuando es array u objeto. Mira nombres de clave,
   * tipos, rutas normalizadas y etiquetas del mensaje; **nunca** un valor de
   * texto.
   */
  const contarAnidado = (json) => {
    if (typeof json?.p === 'string') {
      const ruta = normalizarRuta(json.p);
      if (ruta === 'otra') anidado.rutasEventoOtra = true;
      else empujar(anidado.rutasEvento, ruta);
    }
    if (typeof json?.o === 'string') {
      const op = normalizarOperacion(json.o);
      if (op === 'otra') anidado.opOtra = true;
      else empujar(anidado.opsEvento, op);
    }
    const valor = json?.v;
    if (Array.isArray(valor)) {
      anidado.vArray += 1;
      anidado.elementos += valor.length;
      for (const elemento of valor.slice(0, 256)) {
        if (!elemento || typeof elemento !== 'object' || Array.isArray(elemento)) continue;
        for (const clave of Object.keys(elemento)) {
          const nombre = String(clave).trim().toLowerCase();
          if (LISTA_BLANCA.test(nombre)) empujar(anidado.clavesElemento, nombre);
          else anidado.vObjetoOtra = true;
        }
        if ('v' in elemento) {
          const tipoElemento = tipoDeV(elemento.v);
          if (LISTA_BLANCA.test(tipoElemento)) empujar(anidado.tiposElementoV, tipoElemento);
        }
        if (typeof elemento.o === 'string') {
          const op = normalizarOperacion(elemento.o);
          if (op === 'otra') anidado.opOtra = true;
          else empujar(anidado.opsElemento, op);
        }
        if (typeof elemento.p === 'string') {
          const ruta = normalizarRuta(elemento.p);
          if (ruta === 'otra') anidado.rutasOtra = true;
          else empujar(anidado.rutasParche, ruta);
        }
      }
      return;
    }
    if (!valor || typeof valor !== 'object') return;
    for (const clave of Object.keys(valor)) {
      const nombre = String(clave).trim().toLowerCase();
      if (LISTA_BLANCA.test(nombre)) empujar(anidado.vObjetoClaves, nombre);
      else anidado.vObjetoOtra = true;
    }
    // Hipótesis alternativa: ¿el mensaje se descartó por rol/tipo/fragmento?
    // Sólo se miran sus etiquetas, nunca su texto.
    const mensaje = valor.message;
    if (!mensaje || typeof mensaje !== 'object' || Array.isArray(mensaje)) return;
    // Se deja constancia de que el mensaje llegó, aunque después se descarte.
    anidado.mensaje.vistos += 1;
    const etiqueta = (crudo) => {
      const texto = typeof crudo === 'string' ? crudo.trim().toLowerCase() : '';
      return LISTA_BLANCA.test(texto) ? texto : null;
    };
    const guardar = (lista, crudo) => {
      if (crudo === undefined) return;
      const texto = etiqueta(crudo);
      if (texto) empujar(lista, texto); else anidado.mensaje.otra = true;
    };
    guardar(anidado.mensaje.roles, mensaje.author?.role);
    guardar(anidado.mensaje.tipos, mensaje.content?.content_type);
    guardar(anidado.mensaje.estados, mensaje.status);
    guardar(anidado.mensaje.canales, mensaje.channel);
    if (mensaje.metadata && typeof mensaje.metadata === 'object' && !Array.isArray(mensaje.metadata)) {
      for (const clave of Object.keys(mensaje.metadata)) {
        const nombre = String(clave).trim().toLowerCase();
        if (LISTA_BLANCA.test(nombre)) empujar(anidado.mensaje.metadataClaves, nombre);
        else anidado.mensaje.otra = true;
      }
    }
  };
  const pendingChunks = [];
  let plainText = '';
  let lineText = '';
  let liveDeliveredChars = 0;
  const reportText = (text) => {
    if (!text) return;
    liveDeliveredChars += text.length;
    opts.onText?.({ text, deliveredChars: liveDeliveredChars });
  };

  const consumeLines = (final = false) => {
    const lines = buffered.split('\n');
    buffered = final ? '' : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      estructura.lineas += 1;
      const json = safeJson(line);
      if (!json) { estructura.jsonInvalido += 1; continue; }
      observeOutcome(json);
      const plan = adapter.read(json);
      const delta = (plan.segments || []).map((segment) => segment.newText).join('');
      contarJson(json, Boolean(delta));
      lineText += delta;
      reportText(delta);
      if (chatgpt && json.type === 'end') protocolEnded = true;
    }
  };

  // NDJSON se observaba sin mediación: conservar los bytes y usar el mismo
  // adaptador para su contenido, sin convertirlo al protocolo SSE.
  const finishCapture = (interrupted = false) => {
    if (ended) return;
    ended = true;
    if (format === 'ndjson') consumeLines(true);
    const verdict = sentinel.finish();
    // El proveedor dijo que el mensaje del asistente terminó (status final +
    // `end_turn`). Con eso, la heurística de puntuación no marca «cortada»: una
    // respuesta completa que acaba sin punto no lo está. Sólo cuenta si el
    // stream cerró como completado; cortado, abortado o interrumpido, igual.
    const cierreSeguro = anidado.mensaje.cierre && outcome !== 'failed' && outcome !== 'cancelled' && !interrupted;
    const text = format === 'ndjson' ? (adapter.snapshot?.() ?? lineText)
      : format === 'text' ? plainText : verdict.delivered;
    opts.onEnd?.({
      stopped: format === 'sse' && verdict.stopped,
      code: interrupted ? 'stream-interrupted' : verdict.stopReason,
      truncated: interrupted || (format === 'sse' && verdict.truncated && !cierreSeguro),
      truncationReason: interrupted ? 'stream-interrupted'
        : (cierreSeguro ? null : verdict.truncationReason),
      deliveredChars: text.length,
      droppedChars: format === 'sse' ? verdict.droppedChars : 0,
      text, dropped: format === 'sse' ? verdict.dropped : '',
      outcome: outcome === 'failed' || outcome === 'cancelled' ? outcome
        : (interrupted || verdict.stopped) ? 'unknown' : outcome || 'completed',
      interrupted, model: adapter.model?.() || '',
      estructura: { ...resumirEstructura(estructura), anidado: resumirAnidado(anidado) },
      esqueleto: esqueleto.slice(),
    });
  };
  let stoppedReported = false;
  let failureReported = false;
  const delayed = [];

  const reportStop = () => {
    if (stoppedReported) return;
    stoppedReported = true;
    opts.onStop?.({
      code: sentinel.stopReason,
      droppedChars: sentinel.raw.length - sentinel.delivered.length,
      deliveredChars: sentinel.delivered.length,
    });
  };

  /**
   * Reparte el texto que el centinela acaba de entregar entre los tramos del
   * evento.
   *
   * Puede ocurrir que lo entregado ahora incluya texto retenido de eventos
   * anteriores: el centinela entrega de forma continua y el cable tiene eventos
   * discretos. Ese excedente se pone al principio del primer tramo, que es su
   * lugar en el orden del texto.
   */
  const distribute = (segments, emit) => {
    const values = segments.map(() => '');
    let restante = emit || '';
    let primero = true;
    for (let i = 0; i < segments.length && restante; i += 1) {
      if (segments[i].cumulative) continue;
      const toma = Math.min(segments[i].newText.length, restante.length);
      values[i] = restante.slice(0, toma);
      restante = restante.slice(toma);
      if (primero) {
        primero = false;
        if (restante) {
          values[i] = restante + values[i];
          restante = '';
        }
      }
    }
    if (restante) {
      const index = segments.findIndex((segment) => !segment.cumulative);
      if (index >= 0) values[index] = restante + values[index];
    }
    // Acumulado: el cliente reemplaza el contenido, así que se le da el texto
    // que ya tiene (el entregado), nunca el recibido.
    segments.forEach((segment, i) => {
      if (segment.cumulative) values[i] = sentinel.delivered;
    });
    return values;
  };

  /** Evento sintético con el texto que quedaba retenido. */
  const pendingEvent = (text) => {
    const synth = adapter.pending({ text, delivered: sentinel.delivered });
    if (!synth || !synth.json) return '';
    return serializeSSE({ event: synth.event || 'message', data: JSON.stringify(synth.json) });
  };

  /** Entrega lo retenido sin cerrar el turno (antes de un evento de cierre). */
  const flushPending = () => {
    const text = sentinel.release();
    reportText(text);
    return text ? pendingEvent(text) : '';
  };

  /** Procesa un evento ya parseado y devuelve lo que hay que escribir en el cable. */
  const handleEvent = (evt, esUltimo = false) => {
    contarEvento(evt);
    // ChatGPT recibe el fin lógico sin esperar EOF; primero liberar lo retenido.
    // Los otros proveedores conservan su cierre diferido.
    if (evt.data === '[DONE]' || evt.data === 'DONE') {
      estructura.dones += 1;
      if (chatgpt) {
        protocolEnded = true;
        outcome ||= 'completed';
        return flushPending() + passthroughSSE(evt);
      }
      delayed.push(evt);
      return '';
    }

    // Latidos, `retry:` y comentarios: sin datos que interpretar.
    if (!evt.hasData) return passthroughSSE(evt);

    if (chatgpt && evt.event === 'error') {
      outcome = 'failed';
      protocolEnded = true;
    }
    const json = safeJson(evt.data);
    if (!json) {
      estructura.jsonInvalido += 1;
      // Sin volcar contenido: longitud, clase del primer carácter y forma.
      anidado.noJson ||= clasificarNoJson(evt.data, esUltimo);
      return passthroughSSE(evt);
    }

    observeOutcome(json);
    const plan = adapter.read(json);
    // Sólo el cierre de la conversación: un mensaje oculto o una herramienta
    // puede finalizar antes de que llegue la respuesta visible.
    if (chatgpt && json.type === 'message_stream_complete') protocolEnded = true;
    const segments = plan.segments || [];
    if (plan.descartados) anidado.mensaje.descartados += plan.descartados;
    if (plan.sinTexto) anidado.mensaje.sinTexto += plan.sinTexto;
    if (plan.aceptados) anidado.mensaje.aceptados += plan.aceptados;
    if (Array.isArray(plan.descartes) && plan.descartes.length) {
      // Tope de 12 por stream: son firmas, no un registro completo.
      for (const firma of plan.descartes) {
        if (anidado.mensaje.descartes.length >= 12) break;
        anidado.mensaje.descartes.push(firma);
      }
    }
    if (plan.cierre) anidado.mensaje.cierre = true;
    if (plan.ocultoLevantado) anidado.mensaje.ocultoLevantado += plan.ocultoLevantado;
    if (Array.isArray(plan.removes) && plan.removes.length) {
      for (const ruta of plan.removes) {
        if (anidado.mensaje.removes.length >= 6) break;
        if (anidado.mensaje.removes.includes(ruta)) continue;
        // Ruta normalizada o, si no encaja, `s<longitud>`: el resto se marca.
        if (/^\/message\/[A-Za-z_/]{1,56}$/.test(ruta) || /^s\d{1,6}$/.test(ruta)) {
          anidado.mensaje.removes.push(ruta);
        } else anidado.mensaje.removesOtra = true;
      }
    }
    if (plan.assistantSi) anidado.mensaje.assistantSi += plan.assistantSi;
    if (plan.assistantNo) anidado.mensaje.assistantNo += plan.assistantNo;
    if (plan.causas) {
      for (const causa of Object.keys(anidado.mensaje.causas)) {
        if (plan.causas[causa]) anidado.mensaje.causas[causa] += plan.causas[causa];
      }
    }
    if (plan.porEvento) {
      for (const forma of Object.keys(anidado.rutaTexto)) {
        if (forma !== 'conSegmento' && plan.porEvento[forma]) anidado.rutaTexto[forma] += plan.porEvento[forma];
      }
      if (plan.segmentos) anidado.rutaTexto.conSegmento += plan.segmentos;
    }
    contarJson(json, segments.length > 0);

    if (!segments.length) {
      // Evento de control. Si cierra un bloque o el mensaje, el texto retenido
      // tiene que salir antes que él.
      const body = passthroughSSE(evt);
      return plan.terminal || protocolEnded ? flushPending() + body : body;
    }

    const delta = segments.map((segment) => segment.newText).join('');
    const result = sentinel.push(delta);
    const values = distribute(segments, result.emit);
    reportText(result.emit);
    adapter.write(json, segments, values, evt.event);

    if (result.stopped) reportStop();

    const body = rewriteSSE(evt, JSON.stringify(json));
    // Un evento que trae texto y además cierra: el texto ya salió en él, así que
    // no se libera nada acá; lo que quede se entrega en el cierre siguiente.
    return body;
  };

  /**
   * Un fallo del adaptador no puede romper el stream del sitio.
   *
   * Un `throw` dentro de `transform()` cierra el cuerpo de la respuesta: la
   * página recibe la petición de chat rota y el sitio muestra su propio error
   * de red. Por eso, si el adaptador falla, el evento se reenvía **tal cual
   * llegó** y el fallo se informa una sola vez. La mediación puede entonces
   * quedarse sin efecto en ese evento, pero nunca romper la conversación.
   */
  const safeHandle = (evt, esUltimo = false) => {
    try {
      return handleEvent(evt, esUltimo);
    } catch (error) {
      if (!failureReported) {
        failureReported = true;
        opts.onError?.({ stage: 'event', message: String(error?.message || error) });
      }
      return passthroughSSE(evt);
    }
  };

  const stream = new TransformStream({
    transform(chunk, controller) {
      const decoded = decoder.decode(chunk, { stream: true });
      buffered += decoded;
      if (format === 'auto') {
        pendingChunks.push(chunk);
        const head = buffered.trimStart();
        if (!head || (!head.includes('\n') && head.length < 512 && !/^[{[]/.test(head))) return;
        format = /^[{[]/.test(head) ? 'ndjson' : /^(?:data|event|id|retry):|^:/.test(head) ? 'sse' : 'text';
        if (format !== 'sse') for (const raw of pendingChunks) controller.enqueue(raw);
        pendingChunks.length = 0;
        if (format === 'text') { plainText += buffered; reportText(buffered); buffered = ''; return; }
        if (format === 'ndjson') {
          consumeLines();
          if (protocolEnded) finishCapture();
          return;
        }
      } else if (format === 'ndjson') {
        controller.enqueue(chunk);
        consumeLines();
        if (protocolEnded) finishCapture();
        return;
      } else if (format === 'text') {
        controller.enqueue(chunk);
        plainText += decoded;
        reportText(decoded);
        buffered = '';
        return;
      }
      const { events, rest } = parseSSE(buffered);
      buffered = rest;
      if (!events.length) return;

      let out = '';
      events.forEach((evt, i) => { out += safeHandle(evt, i === events.length - 1); });
      if (out) controller.enqueue(encoder.encode(out));
      if (protocolEnded) finishCapture();
    },

    flush(controller) {
      buffered += decoder.decode();
      if (format === 'auto') {
        const head = buffered.trimStart();
        format = /^[{[]/.test(head) ? 'ndjson' : /^(?:data|event|id|retry):|^:/.test(head) ? 'sse' : 'text';
        if (format !== 'sse') for (const raw of pendingChunks) controller.enqueue(raw);
        pendingChunks.length = 0;
        if (format === 'text') { plainText += buffered; reportText(buffered); }
      }
      if (format !== 'sse') { finishCapture(); return; }
      let out = '';

      // 1) Un evento final sin la línea en blanco todavía se procesa; si llegó
      //    cortado por la red, se reenvía tal cual (que el cliente decida).
      if (buffered.trim()) {
        const resto = buffered;
        buffered = '';
        try {
          const { events } = parseSSE(`${resto}\n\n`);
          const ultimo = events[0];
          out += ultimo && safeJson(ultimo.data) ? safeHandle(ultimo) : resto;
        } catch {
          out += resto;
        }
      }

      // 2) Cierre del centinela: entrega lo retenido antes de los cierres.
      try {
        out += flushPending();
      } catch (error) {
        if (!failureReported) {
          failureReported = true;
          opts.onError?.({ stage: 'flush', message: String(error?.message || error) });
        }
      }

      // 3) Ahora sí, los eventos que estaban esperando (`[DONE]`).
      for (const evt of delayed) out += passthroughSSE(evt);
      if (out) controller.enqueue(encoder.encode(out));

      finishCapture();
    },
  });
  // pipeTo rechaza si el origen falla o el consumidor cancela: notificar una
  // única captura parcial sin ocultar ese error a la página.
  stream.finishInterrupted = () => finishCapture(true);
  return stream;
}

function safeJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

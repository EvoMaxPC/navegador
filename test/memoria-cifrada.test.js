/**
 * Pestaña Memoria: qué entra, qué se muestra y qué significa cada número.
 *
 * El caso que lo motivó: el panel mostraba «4 memorias», «336 tokens en
 * contexto» y «episodios: 4», con registros «Se respondió» que en realidad eran
 * tokens cifrados (`gAAAAA…`, formato Fernet de Python) traídos por un paquete
 * importado. Cuatro cosas distintas leídas como si fueran la misma:
 *
 *   1. mensajes y respuestas detectados (contadores del panel de actividad);
 *   2. episodios guardados en memoria;
 *   3. memorias vigentes;
 *   4. tokens del contexto que se envía.
 *
 * Estas pruebas fijan la separación y que nada existente se borre.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EvoMemory } from '../src/memory/engine.js';
import { looksEncrypted, toPublic } from '../src/memory/item.js';

/** Tokens Fernet como los que aparecieron en el panel. */
const CIFRADO =
  'gAAAAABm3k9Xy8Kq1Zr7Tb2LmN4pQ6rS8tU0vW2xY4zA6bC8dE0fG2hI4jK6lM8nO0pQ2rS4tU6vW8xY0zA';
const CIFRADO_2 = 'gAAAAABm3k9Zy8Kq1Zr7Tb2LmN4pQ6rS8tU0vW2xY4zA6bC8dE0fG2hI4jK6lM8nO0pQ2';

function almacenEnMemoria(inicial = null) {
  let datos = inicial;
  return {
    read: () => datos,
    write: (nuevo) => {
      datos = nuevo;
    },
    get datos() {
      return datos;
    },
  };
}

/** Un motor con el expediente que dejó el paquete importado. */
function motorConCifradas() {
  const storage = almacenEnMemoria();
  const evo = new EvoMemory({ storage, projectId: 'default', episodeEvery: 4, now: () => 1_700_000_000_000 });

  // Se fuerzan los registros cifrados saltando la guardia de alta: así se
  // reproduce un expediente viejo, que es lo que hay que seguir mostrando.
  const rellenos = [
    'El despliegue se hace a mano los martes por la tarde con el equipo de guardia.',
    'La base de datos quedó con Postgres y un respaldo diario fuera del servidor.',
  ];
  for (const relleno of rellenos) {
    const item = evo.store.add({ kind: 'episode', text: relleno });
    assert.equal(item.action, 'created');
  }
  for (const item of evo.store.all()) {
    item.text = item.id.endsWith('0') ? CIFRADO : CIFRADO_2;
    item.tokens = 120;
  }
  return { evo, storage };
}

/* ------------------------------------------------------------------ */
/* 1. qué es un registro cifrado                                       */
/* ------------------------------------------------------------------ */

test('un token cifrado se reconoce y una frase no', () => {
  assert.equal(looksEncrypted(CIFRADO), true, 'token Fernet');
  assert.equal(looksEncrypted('adssaf'), false, 'un mensaje corto del usuario');
  assert.equal(looksEncrypted('¿Podrías aclararme qué necesitas? 😊'), false, 'una respuesta real');
  assert.equal(
    looksEncrypted('El usuario planteó: adssaf · Se respondió: ¿Podrías aclararme qué necesitas? 😊'),
    false,
    'un episodio legible',
  );
  assert.equal(
    looksEncrypted('https://github.com/EvoMaxPC/navegador/releases/tag/v0.1.7'),
    false,
    'una URL larga no es un cifrado',
  );
});

/* ------------------------------------------------------------------ */
/* 2. alta: no entran nuevos cifrados, lo guardado no se toca          */
/* ------------------------------------------------------------------ */

test('un paquete importado no mete registros cifrados y lo existente queda intacto', () => {
  const storage = almacenEnMemoria();
  const evo = new EvoMemory({ storage, projectId: 'default' });
  evo.store.add({ kind: 'fact', text: 'El proyecto se llama NEXO y usa Electron.' });

  const resultado = evo.importHandoff({
    projectId: 'default',
    sections: {
      episode: [{ text: `Se respondió: ${CIFRADO}` }],
      fact: [{ text: CIFRADO }],
      decision: [{ text: 'Se decidió no guardar registros cifrados.' }],
    },
  });

  assert.equal(resultado.added, 1, 'sólo entra lo legible');
  assert.equal(resultado.ignored, 2, 'los dos cifrados se informan, no se cuelan');
  assert.equal(evo.list().length, 2, 'la memoria previa sigue ahí');
  assert.ok(
    evo.list().some((item) => item.text === 'El proyecto se llama NEXO y usa Electron.'),
    'sin alterar lo que ya estaba',
  );
});

test('un expediente con registros cifrados se conserva y se marca como ilegible', () => {
  const { evo } = motorConCifradas();
  const guardadas = evo.store.all();

  const listado = evo.list();
  assert.equal(listado.length, guardadas.length, 'no se borra ninguna');
  assert.ok(listado.every((item) => item.readable === false), 'todas se marcan ilegibles');
  assert.equal(listado[0].text, guardadas[0].text, 'el texto guardado no se reescribe');
  assert.equal(toPublic(guardadas[0]).readable, false, 'el panel recibe la marca');
});

/* ------------------------------------------------------------------ */
/* 3. los cuatro números son cuatro cosas                              */
/* ------------------------------------------------------------------ */

test('memorias, episodios y tokens guardados se cuentan por separado', () => {
  const { evo } = motorConCifradas();
  const stats = evo.stats();

  assert.equal(stats.active, evo.list().length, '«memorias» es lo vigente');
  assert.equal(stats.encrypted, stats.active, 'y se dice cuántas no se pueden leer');
  assert.equal(
    Object.values(stats.byKind).reduce((suma, n) => suma + n, 0),
    stats.active,
    'la leyenda suma exactamente las memorias vigentes',
  );
  assert.equal(stats.byKind.episode, stats.active, 'todas son episodios en este caso');
});

test('los tokens guardados no son los tokens del contexto enviado', () => {
  const storage = almacenEnMemoria();
  const evo = new EvoMemory({ storage, projectId: 'default' });
  evo.store.add({ kind: 'decision', text: 'Se decidió medir la captura en el proceso principal.' });
  evo.store.add({ kind: 'constraint', text: 'No se agregan módulos nuevos al navegador.' });

  const antes = evo.stats();
  assert.ok(antes.tokens > 0, 'hay tokens guardados');
  assert.equal(antes.lastUsed, 0, 'todavía no se envió contexto');

  const compilado = evo.compile({ query: 'captura', budgetTokens: 4000 });
  const despues = evo.stats();
  assert.ok(despues.lastUsed > 0, 'el contexto usado se informa aparte');
  assert.equal(despues.tokens, antes.tokens, 'mirar el contexto no cambia lo guardado');
  assert.notEqual(despues.lastUsed, despues.tokens, 'y no se informa el mismo número en los dos sitios');
  assert.ok(String(compilado.payload || '').length > 0, 'y el contexto tiene texto real');
});

/* ------------------------------------------------------------------ */
/* 4. episodios: resúmenes, no registro de respuestas                  */
/* ------------------------------------------------------------------ */

test('un episodio es un resumen del tramo y no se duplica al repetirse', () => {
  const storage = almacenEnMemoria();
  const evo = new EvoMemory({ storage, projectId: 'default', episodeEvery: 4 });

  const turnos = [
    { role: 'user', content: 'adssaf' },
    { role: 'assistant', content: '¿Podrías aclararme qué necesitas? 😊' },
    { role: 'user', content: 'Necesito que los contadores sumen bien.' },
    { role: 'assistant', content: 'Reviso el camino de captura y lo corregimos.' },
  ];
  for (const turno of turnos) evo.remember(turno, { conversationId: 'conv-1' });

  const episodios = evo.store.all({ kinds: ['episode'] });
  assert.equal(episodios.length, 1, 'el tramo produce un episodio');
  assert.match(episodios[0].text, /Se respondió:/, 'con el resumen de lo respondido');

  // El mismo tramo otra vez no crea otro episodio igual.
  for (const turno of turnos) evo.remember(turno, { conversationId: 'conv-1' });
  assert.equal(evo.store.all({ kinds: ['episode'] }).length, 1, 'sin duplicar el mismo resumen');
});

test('un episodio con texto cifrado no se crea', () => {
  const storage = almacenEnMemoria();
  const evo = new EvoMemory({ storage, projectId: 'default', episodeEvery: 4 });
  const cifrado = CIFRADO;

  for (const turno of [
    { role: 'user', content: cifrado },
    { role: 'assistant', content: cifrado },
    { role: 'user', content: cifrado },
    { role: 'assistant', content: cifrado },
  ]) {
    evo.remember(turno, { conversationId: 'conv-cifrada' });
  }

  assert.equal(evo.store.all({ kinds: ['episode'] }).length, 0, 'un resumen ilegible no se guarda');
});

/* ------------------------------------------------------------------ */
/* 5. el contexto enviado no lleva basura                              */
/* ------------------------------------------------------------------ */

test('un registro cifrado no viaja en el contexto, ni siquiera fijado', () => {
  const storage = almacenEnMemoria();
  const evo = new EvoMemory({ storage, projectId: 'default', episodeEvery: 50 });

  // Se fija y se deja como episodio: las dos capas que más peso tienen.
  const cifrada = evo.store.add({ kind: 'decision', text: 'Se decidió fijar el registro para la prueba.' }).item;
  cifrada.text = CIFRADO;
  cifrada.tokens = 300;
  evo.store.pin(cifrada.id, true);
  const episodio = evo.store.add({ kind: 'episode', text: 'El despliegue se hace a mano los martes por la tarde.' }).item;
  episodio.text = `Se respondió: ${CIFRADO}`;

  const compilado = evo.compile({ query: 'despliegue', budgetTokens: 3000, history: [] });
  assert.ok(!String(compilado.payload).includes('gAAAAA'), 'el token no se envía');
  assert.equal(
    compilado.memoryIds.includes(cifrada.id),
    false,
    'y el registro cifrado no cuenta como memoria usada',
  );
  // El expediente sigue completo: no se borró nada.
  assert.equal(evo.store.all().length, 2, 'las dos memorias siguen guardadas');
});

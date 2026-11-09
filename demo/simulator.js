/**
 * Simulador de modelo para la sala de pruebas.
 *
 * No es un modelo real: es un guion que reproduce los fallos típicos de una
 * generación larga (bucle de párrafo, tartamudeo, lista infinita, corte de
 * red, negativa). La mediación que se ve al otro lado sí es la de verdad: es
 * el mismo motor que usa el navegador.
 */

const P1 =
  'El centinela retiene los últimos caracteres en lugar de pintarlos al instante. Esa pequeña demora cambia todo: cuando la repetición se detecta, el texto repetido todavía está en el búfer y se descarta entero.';

const P2 =
  'Sin ese búfer habría que tapar lo ya escrito, y tapar es siempre peor que no mostrar: el usuario ve el salto, pierde la confianza y el hilo de la respuesta.';

const P3 =
  'La sonda compara el final del texto con el texto anterior mediante una búsqueda de subcadena. Es una operación baratísima y descarta el 99 % de los casos antes de ejecutar el análisis completo.';

const P4 =
  'El análisis completo calcula el período más corto del sufijo repetido con la función Z sobre la cadena invertida. Con eso se sabe qué bloque se repite y en qué punto exacto empezó la repetición.';

export const SCENARIOS = [
  {
    id: 'bucle-parrafo',
    label: 'Bucle de párrafo (el clásico)',
    hint: 'El modelo repite el mismo párrafo indefinidamente.',
    badge: 'repeat-unit',
    prompt: 'Explícame cómo detectar bucles en una respuesta que llega en streaming.',
    raw: [
      '## Detección de bucles en streaming',
      '',
      'Un bucle no es un error de red: es el modelo volviendo sobre un estado anterior. Se detecta mirando el final del texto, no el principio.',
      '',
      P1,
      '',
      P2,
      '',
      P1,
      '',
      P2,
      '',
      P1,
      '',
      P2,
      '',
      P1,
      '',
    ].join('\n'),
    continuation: [
      P3,
      '',
      'Con esas tres capas —búfer, sonda y análisis— el corte llega antes de que el usuario vea nada raro, y la continuación retoma donde el modelo se perdió.',
    ].join('\n'),
  },
  {
    id: 'tartamudeo',
    label: 'Tartamudeo de tokens',
    hint: 'La misma palabra se repite hasta degradar la respuesta.',
    badge: 'stutter',
    prompt: '¿Por qué la validación del formulario falla al enviar?',
    raw:
      'El problema está en la validación del formulario y la la la la la la la la la la la la respuesta del servidor no llega a tiempo. ' +
      'El campo de correo se valida en el cliente pero el servidor espera un formato distinto.',
    continuation:
      'La validación del cliente acepta espacios al final del correo y el servidor los rechaza. Recortá el valor con trim() antes de enviarlo y el error desaparece.',
  },
  {
    id: 'lista-infinita',
    label: 'Lista que se reescribe',
    hint: 'El modelo reinicia la numeración una y otra vez.',
    badge: 'line-loop',
    prompt: 'Dame los pasos para reproducir el fallo de sesión.',
    raw: [
      'Pasos para reproducir:',
      '',
      '1. Abrí la consola del navegador con F12.',
      '2. Iniciá sesión con un usuario de prueba.',
      '3. Recargá la pestaña mientras carga el perfil.',
      '',
      '1. Abrí la consola del navegador con F12.',
      '2. Iniciá sesión con un usuario de prueba.',
      '3. Recargá la pestaña mientras carga el perfil.',
      '',
      '1. Abrí la consola del navegador con F12.',
      '2. Iniciá sesión con un usuario de prueba.',
      '3. Recargá la pestaña mientras carga el perfil.',
    ].join('\n'),
    continuation:
      'Con la red en «Slow 3G» desde DevTools el fallo se reproduce siempre en el segundo intento.\n\nEl error real es que el token se renueva en paralelo a la carga del perfil y la segunda petición viaja con el token viejo.',
  },
  {
    id: 'corte',
    label: 'Respuesta cortada a mitad',
    hint: 'La red se corta y la frase queda abierta.',
    badge: 'truncation',
    prompt: '¿Cómo configuro el proxy corporativo en la aplicación?',
    raw:
      'Para configurar el proxy corporativo necesitas tres datos: el host, el puerto y el certificado de la autoridad interna. ' +
      'Primero exportá la variable HTTPS_PROXY con el formato http://usuario:clave@host:puerto, después',
    continuation:
      'registrá el certificado con la variable NODE_EXTRA_CA_CERTS apuntando al archivo .pem, y por último reiniciá la aplicación para que tome las variables.\n\nSi el proxy pide autenticación NTLM, la variable por sí sola no alcanza: hay que usar un proxy local que haga la negociación.',
  },
  {
    id: 'negativa',
    label: 'Negativa del modelo',
    hint: 'El modelo se niega y la conversación se traba.',
    badge: 'refusal',
    prompt: 'Necesito entender cómo se explota una inyección SQL en mi propio panel.',
    raw:
      'Lo siento, pero no puedo ayudar con eso. Como modelo de lenguaje no tengo acceso a esa información.',
    continuation: '',
  },
  {
    id: 'limpia',
    label: 'Respuesta limpia (control)',
    hint: 'Sin fallos: Nexo no interviene la recepción.',
    badge: 'clean',
    prompt: '¿Qué diferencia hay entre un índice B-tree y uno GIN en PostgreSQL?',
    raw: [
      'Un **B-tree** mantiene las claves ordenadas. Sirve para igualdad y para rangos: `WHERE fecha > ...` o `ORDER BY` aprovechan el índice directamente.',
      '',
      'Un **GIN** indexa los elementos internos de un valor compuesto —arrays, `jsonb`, texto completo—. Es la opción cuando buscás «contiene» dentro de una estructura, no cuando comparás el valor entero.',
      '',
      'Regla práctica: B-tree para escalares y rangos, GIN para búsquedas dentro de documentos.',
    ].join('\n'),
    continuation: '',
  },
];

/** Historial precargado: una conversación real de diseño, ya larga. */
export const SEED_HISTORY = [
  {
    role: 'user',
    content:
      'Estamos diseñando un navegador basado en Chromium que media las conversaciones con IA. La idea es interceptar el mensaje antes de enviarlo y la respuesta antes de mostrarla.',
  },
  {
    role: 'assistant',
    content:
      'Buena idea, pero conviene separar dos capas: el enganche de red, que no depende de la interfaz, y el adaptador de DOM, que sí. El primero sobrevive a los rediseños de cada sitio; el segundo es un refuerzo.',
  },
  {
    role: 'user',
    content:
      'Decidimos que el motor viva en un módulo isomorfo, sin dependencias, testeable en Node y en el navegador al mismo tiempo. Nada de llamar a un servicio externo para analizar texto.',
  },
  {
    role: 'assistant',
    content:
      'Eso obliga a que la detección sea determinista: período de repetición, diversidad léxica y entropía de una ventana. El pendiente es cómo cortar un bucle sin que se note en pantalla.',
  },
  {
    role: 'user',
    content:
      'La restricción es dura: el usuario está leyendo mientras el texto llega. Si el corte llega tarde, ya vio el párrafo repetido y la magia se rompe.',
  },
  {
    role: 'assistant',
    content:
      'Entonces hay que retener texto en un búfer antes de pintarlo. Con unos cien caracteres de retención el bucle se descarta antes de existir en el DOM, y la latencia sigue siendo imperceptible.',
  },
  {
    role: 'user',
    content:
      'El error que vimos en la primera prueba fue exactamente ese: el corte llegaba tres líneas tarde porque el análisis se ejecutaba cada 120 caracteres y el párrafo medía 168.',
  },
  {
    role: 'assistant',
    content:
      'Ese error se arregla con una sonda barata por cada fragmento: si el final del texto ya apareció antes, se ejecuta el análisis completo; si no, se sigue adelante. El coste por token queda despreciable.',
  },
  {
    role: 'user',
    content:
      'Anotá que el script de pruebas corre con node --test y no tiene ninguna dependencia. La suite tiene que cubrir bucle de párrafo, tartamudeo, lista reescrita y respuesta cortada.',
  },
  {
    role: 'assistant',
    content:
      'Anotado. Falta decidir si la continuación es automática o la confirma el usuario, y qué hacer al segundo bucle con el mismo patrón: ahí ya conviene reintentar con otra estructura en vez de continuar.',
  },
];

export function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
}

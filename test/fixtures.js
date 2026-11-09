/** Fixtures compartidos por los tests. */

export const PARAGRAPH =
  'La arquitectura propuesta separa el enganche de red del adaptador de interfaz, de modo que el motor sigue funcionando aunque el sitio cambie sus selectores o su diseño.';

export const LOOPING_ANSWER = [
  '## Estrategia de reintentos',
  '',
  'Un reintento con espera exponencial evita saturar el servicio cuando la red falla. La primera espera es corta y se duplica en cada intento.',
  '',
  '### Puntos clave',
  '- El límite de intentos debe ser finito.',
  '- Cada intento debe registrar el motivo del fallo.',
  '- La espera no debe bloquear el hilo principal.',
  '',
  PARAGRAPH,
  '',
  PARAGRAPH,
  '',
  PARAGRAPH,
].join('\n');

export const STUTTER_ANSWER =
  'El problema está en la validación del formulario y la la la la la la la la respuesta del servidor.';

export const LINE_LOOP_ANSWER = [
  'Pasos para reproducir:',
  '1. Abrir la consola del navegador.',
  '2. Repetir la petición con el mismo token.',
  '2. Repetir la petición con el mismo token.',
  '2. Repetir la petición con el mismo token.',
  '2. Repetir la petición con el mismo token.',
].join('\n');

export const TRUNCATED_ANSWER =
  'Para configurar el proxy necesitas tres datos: el host, el puerto y el certificado. Primero';

export const REFUSAL_ANSWER =
  'Lo siento, pero no puedo ayudar con eso. Como modelo de lenguaje no tengo acceso a esa información.';

export const CLEAN_ANSWER = [
  'Tres formas de evitar el bucle:',
  '',
  '1. **Limitar la longitud** de la unidad repetida antes de cortar.',
  '2. **Medir diversidad léxica** en una ventana deslizante.',
  '3. **Cortar en el inicio de la repetición**, no en el final.',
  '',
  'Con esas tres reglas el corte queda limpio y la continuación tiene sentido.',
].join('\n');

export const LONG_HISTORY = [
  { role: 'user', content: 'Necesito migrar la base de datos a PostgreSQL 16 antes del viernes.' },
  { role: 'assistant', content: 'Podemos hacerlo por partes. Primero un dump lógico y luego una verificación de integridad.' },
  { role: 'user', content: 'Decidimos usar pg_dump con el flag --no-owner y restaurar en un contenedor de pruebas.' },
  { role: 'assistant', content: 'Perfecto. El pendiente es validar las secuencias y los índices después de restaurar.' },
  { role: 'user', content: 'La restricción es que no podemos parar el servicio más de 5 minutos.' },
  { role: 'assistant', content: 'Entonces conviene una réplica lógica con publicación y suscripción.' },
  { role: 'user', content: 'El error que vimos fue una excepción de clave duplicada en la tabla pedidos.' },
  { role: 'assistant', content: 'Ese error suele venir de secuencias desincronizadas tras la restauración.' },
  { role: 'user', content: '¿Cómo verificamos el puerto 5432 y el endpoint de salud?' },
  { role: 'assistant', content: 'Con pg_isready y una consulta a la vista pg_stat_activity.' },
  { role: 'user', content: 'Anotá que el script de migración vive en scripts/migrate.js y corre con npm run migrate.' },
  { role: 'assistant', content: 'Anotado. Falta decidir quién aprueba el cambio en producción.' },
];

export const MESSY_PROMPT = `necesito   que me expliques el plan de migración
necesito   que me expliques el plan de migración
y que sea breve pero muy detallado paso a paso`;

/** Genera un stream de deltas a partir de un texto, en trozos. */
export function chunk(text, size = 17) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

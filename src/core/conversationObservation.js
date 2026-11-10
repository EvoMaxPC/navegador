/** Etapa 1: ventana observacional, nunca autoridad de instrucciones ni evidencia de ejecución. */
export const OBSERVATION_LIMIT = 24;
export const OBSERVATION_PREVIEW = 4000;
export function emptyObservation() {
  return {
    version: 1,
    revision: 0,
    cursor: null,
    ledger: [],
    messages: [],
    warnings: [],
  };
}
export function validateObservation(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !(
      value.cursor === null ||
      (typeof value.cursor === 'string' && value.cursor.length <= 256)
    ) ||
    !Array.isArray(value.ledger) ||
    value.ledger.length > 256 ||
    value.ledger.some(
      (x) =>
        !x ||
        typeof x.id !== 'string' ||
        x.id.length > 256 ||
        typeof x.digest !== 'string' ||
        x.digest.length > 64,
    ) ||
    !Array.isArray(value.messages) ||
    value.messages.length > OBSERVATION_LIMIT ||
    value.messages.some(
      (x) =>
        !x ||
        !['user', 'assistant'].includes(x.role) ||
        typeof x.id !== 'string' ||
        x.id.length > 256 ||
        typeof x.digest !== 'string' ||
        x.digest.length > 64 ||
        typeof x.preview !== 'string' ||
        x.preview.length > OBSERVATION_PREVIEW ||
        !Number.isSafeInteger(x.chars) ||
        x.chars < 0 ||
        !['complete', 'streaming', 'clipped'].includes(x.status) ||
        !Number.isFinite(x.observed_at),
    ) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 3 ||
    value.warnings.some((x) => typeof x !== 'string' || x.length > 500)
  )
    throw Error('Estado observacional incompatible');
  return value;
}
/** Recibe roles/identidades del lector existente y hashes calculados por main. */
export function planObservation(
  previous,
  turns,
  { bootstrap = false, streaming = false, now = Date.now() } = {},
) {
  const before = previous || emptyObservation();
  validateObservation(before);
  const clean = turns.filter(
    (t) =>
      t &&
      ['user', 'assistant'].includes(t.role) &&
      typeof t.id === 'string' &&
      t.id.length <= 256 &&
      typeof t.content === 'string' &&
      t.content.trim() &&
      typeof t.digest === 'string',
  );
  const users = clean.filter((t) => t.role === 'user');
  if (!users.length)
    return { observation: before, users: [], skipped: 'no-user-turn' };
  const next = structuredClone(before),
    known = new Map(before.ledger.map((e) => [e.id, e.digest]));
  let anchor = users.findIndex((t) => t.id === before.cursor);
  if (anchor < 0 && before.cursor !== null)
    anchor = users.reduce((last, t, i) => (known.has(t.id) ? i : last), -1);
  next.warnings = [];
  let selected;
  if (before.cursor === null) selected = bootstrap ? users : [users.at(-1)];
  else if (anchor < 0) {
    selected = known.has(users.at(-1).id) ? [] : [users.at(-1)];
    next.warnings.push(
      'Falta el punto de continuidad en la ventana visible. Sólo se considera el último usuario nuevo; no se reconstruye el historial ausente.',
    );
  } else
    selected = users.filter(
      (t, i) =>
        (i > anchor && !known.has(t.id)) ||
        (t.id === before.cursor && known.get(t.id) !== t.digest),
    );
  const readable = selected.filter((t) => !t.clipped);
  if (selected.some((t) => t.clipped))
    next.warnings.push(
      'Hay un mensaje de usuario recortado: no se interpretó como instrucción completa.',
    );
  const last = users.at(-1);
  if (
    !last.clipped &&
    /(?:\.\.\.|…|[:,]|\b(?:y|pero|porque|and|because))\s*$/i.test(last.content)
  )
    next.warnings.push(
      'La última solicitud podría estar incompleta; es una señal heurística, no una conclusión confirmada.',
    );
  // No avanzar sobre un usuario recortado: su versión completa debe poder reintentarse.
  for (const t of users.filter((t) => !t.clipped)) {
    known.delete(t.id);
    known.set(t.id, t.digest);
  }
  next.ledger = [...known].slice(-256).map(([id, digest]) => ({ id, digest }));
  if (anchor >= 0 || before.cursor === null || readable.length)
    next.cursor = users.filter((t) => !t.clipped).at(-1)?.id || before.cursor;
  for (const t of clean.slice(-OBSERVATION_LIMIT)) {
    const old = next.messages.find((e) => e.id === t.id && e.role === t.role);
    const status = t.clipped
      ? 'clipped'
      : t.role === 'assistant' && streaming
        ? 'streaming'
        : 'complete';
    if (old?.digest === t.digest && old.status === status) continue;
    const item = {
      id: t.id,
      role: t.role,
      digest: t.digest,
      chars: t.content.length,
      preview:
        t.role === 'assistant' ? t.content.slice(0, OBSERVATION_PREVIEW) : '',
      preview_clipped:
        t.role === 'assistant' && t.content.length > OBSERVATION_PREVIEW,
      status,
      certainty: 'observed-not-verified',
      authority: 'conversation-data-only',
      observed_at: now,
    };
    next.messages = next.messages.filter(
      (e) => !(e.id === t.id && e.role === t.role),
    );
    next.messages.push(item);
  }
  next.messages = next.messages.slice(-OBSERVATION_LIMIT);
  // El orden de los IDs no representa avance ni ejecución; sólo orden del DOM validado.
  const changed =
    JSON.stringify({ ...next, revision: 0 }) !==
    JSON.stringify({ ...before, revision: 0 });
  if (changed) next.revision = before.revision + 1;
  return {
    observation: next,
    users: readable,
    changed,
    skipped:
      !readable.length && (last.clipped || selected.some((t) => t.clipped))
        ? 'clipped-user-turn'
        : undefined,
  };
}

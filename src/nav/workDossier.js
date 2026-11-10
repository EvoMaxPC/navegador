/** Expediente local. Datos explícitos; no IA, no acceso web, sin dependencia de EVO. */
export const DOSSIER_VERSION = 1;
export const MAX_DOSSIER_BYTES = 4_000_000;
export class DossierError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}
export function workspaceKey(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,48}$/.test(value))
    throw new DossierError('Espacio inválido');
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max)
    throw new DossierError(`Texto inválido (máximo ${max} caracteres)`);
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (required && !clean) throw new DossierError('Completá el texto');
  return clean;
}
function oneOf(value, list) {
  if (!list.includes(value)) throw new DossierError('Opción inválida');
  return value;
}
export function emptyDossier(workspaceId, now = Date.now()) {
  return {
    version: DOSSIER_VERSION,
    workspaceId: workspaceKey(workspaceId),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    goal: { text: '', criteria: [], revision: 0 },
    goalHistory: [],
    nextStep: '',
    tasks: [],
    notes: [],
    resources: [],
    evidence: [],
    decisions: [],
    preferences: { detail: 'expanded', start: 'continue' },
  };
}
const limits = {
  tasks: 200,
  notes: 200,
  resources: 200,
  evidence: 200,
  decisions: 100,
};
function add(d, collection, item) {
  if (d[collection].length >= limits[collection])
    throw new DossierError(
      'Se alcanzó el límite del expediente. Exportá y organizá el contenido antes de agregar más.',
    );
  d[collection].push(item);
}
function find(d, collection, id) {
  const item = d[collection].find((x) => x.id === id);
  if (!item) throw new DossierError('El registro ya no existe', 'not-found');
  return item;
}
function references(d, ids) {
  if (
    !Array.isArray(ids) ||
    ids.length > 20 ||
    ids.some((id) => typeof id !== 'string')
  )
    throw new DossierError('Referencias inválidas');
  return [...new Set(ids)].map((id) => find(d, 'evidence', id).id);
}
function webURL(value) {
  const clean = text(value, 2048, true);
  let url;
  try {
    url = new URL(clean);
  } catch {
    throw new DossierError('Dirección inválida');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new DossierError('Sólo recursos HTTP(S) sin credenciales');
  return url.href;
}
function resource(d, source, id, now) {
  const url = webURL(source?.url);
  let r = d.resources.find((r) => r.url === url);
  if (!r) {
    r = {
      id,
      url,
      title: text(source.title, 300),
      capturedAt: source.capturedAt ?? now,
    };
    add(d, 'resources', r);
  }
  return r;
}
/** Operación pura. Las fuentes sólo se suministran desde main, no desde payload IPC. */
export function mutateDossier(
  current,
  input,
  { now = Date.now(), id, source = null } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DossierError('Operación inválida');
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision !== current.revision
  )
    throw new DossierError(
      'El expediente cambió en otra vista. Recargá antes de guardar.',
      'conflict',
    );
  if (typeof id !== 'string' || !id)
    throw new DossierError('Falta identificador');
  const d = structuredClone(current);
  switch (input.type) {
    case 'goal': {
      const value = text(input.text, 2000, true);
      if (!Array.isArray(input.criteria) || input.criteria.length > 20)
        throw new DossierError('Máximo 20 criterios');
      const criteria = input.criteria.map((x) => text(x, 300, true));
      if (
        value !== d.goal.text ||
        JSON.stringify(criteria) !== JSON.stringify(d.goal.criteria)
      ) {
        if (d.goalHistory.length >= 50)
          throw new DossierError(
            'Límite de 50 revisiones de objetivo; exportá el expediente antes de comenzar otro.',
          );
        if (d.goal.text) d.goalHistory.push({ ...d.goal, archivedAt: now });
        d.goal = { text: value, criteria, revision: d.goal.revision + 1 };
        for (const decision of d.decisions) decision.needsReview = true;
      }
      break;
    }
    case 'continuation':
      d.nextStep = text(input.text, 3000);
      break;
    case 'preferences':
      d.preferences = {
        detail: oneOf(input.detail, ['compact', 'expanded']),
        start: oneOf(input.start, ['continue', 'evidence', 'tasks']),
      };
      break;
    case 'add-task':
      add(d, 'tasks', {
        id,
        text: text(input.text, 1000, true),
        status: 'todo',
        createdAt: now,
      });
      break;
    case 'task-status':
      find(d, 'tasks', input.id).status = oneOf(input.status, [
        'todo',
        'doing',
        'done',
      ]);
      break;
    case 'add-note':
      add(d, 'notes', {
        id,
        text: text(input.text, 4000, true),
        createdAt: now,
      });
      break;
    case 'attach-tab':
      if (!source) throw new DossierError('Falta el recurso nativo');
      resource(d, source, id, now);
      break;
    case 'capture-evidence': {
      if (!source) throw new DossierError('Falta la selección nativa');
      const r = resource(d, source, `${id}-source`, now);
      add(d, 'evidence', {
        id,
        resourceId: r.id,
        quote: source.quote, // Conservar el fragmento nativo exacto; el validador comprueba longitud/contenido.
        clipped: source.clipped === true,
        capturedAt: source.capturedAt ?? now,
        method: 'native-selection',
        review: 'unverified',
        annotation: text(input.annotation || '', 2000),
      });
      break;
    }
    case 'add-decision':
      if (!d.goal.text) throw new DossierError('Definí primero el objetivo');
      add(d, 'decisions', {
        id,
        text: text(input.text, 2000, true),
        evidenceIds: references(d, input.evidenceIds),
        goalRevision: d.goal.revision,
        needsReview: false,
        createdAt: now,
      });
      break;
    case 'review-decision': {
      const decision = find(d, 'decisions', input.id);
      decision.goalRevision = d.goal.revision;
      decision.needsReview = false;
      decision.reviewedAt = now;
      break;
    }
    case 'remove': {
      const collection = oneOf(input.collection, Object.keys(limits));
      find(d, collection, input.id);
      if (
        collection === 'resources' &&
        d.evidence.some((e) => e.resourceId === input.id)
      )
        throw new DossierError('Quitá primero las evidencias de este recurso');
      d[collection] = d[collection].filter((x) => x.id !== input.id);
      if (collection === 'evidence')
        for (const dec of d.decisions) {
          if (dec.evidenceIds.includes(input.id)) {
            dec.evidenceIds = dec.evidenceIds.filter((x) => x !== input.id);
            dec.needsReview = true;
          }
        }
      break;
    }
    default:
      throw new DossierError('Acción no permitida');
  }
  d.revision += 1;
  d.updatedAt = now;
  validateDossier(d, current.workspaceId);
  return d;
}
/** Validación estricta del archivo completo: un formato desconocido nunca se sobrescribe. */
export function validateDossier(d, workspaceId) {
  const fail = () => {
    throw new DossierError(
      'Archivo de expediente inválido o incompatible',
      'storage',
    );
  };
  if (
    !d ||
    d.version !== DOSSIER_VERSION ||
    d.workspaceId !== workspaceKey(workspaceId) ||
    !Number.isSafeInteger(d.revision) ||
    d.revision < 0
  )
    fail();
  if (!Number.isFinite(d.createdAt) || !Number.isFinite(d.updatedAt)) fail();
  const goal = (g) => {
    if (
      !g ||
      !Number.isSafeInteger(g.revision) ||
      g.revision < 0 ||
      !Array.isArray(g.criteria) ||
      g.criteria.length > 20
    )
      fail();
    text(g.text, 2000);
    for (const c of g.criteria) text(c, 300, true);
  };
  goal(d.goal);
  if (!Array.isArray(d.goalHistory) || d.goalHistory.length > 50) fail();
  d.goalHistory.forEach(goal);
  text(d.nextStep, 3000);
  if (!d.preferences) fail();
  oneOf(d.preferences.detail, ['compact', 'expanded']);
  oneOf(d.preferences.start, ['continue', 'evidence', 'tasks']);
  const ids = new Set();
  for (const [name, limit] of Object.entries(limits)) {
    if (!Array.isArray(d[name]) || d[name].length > limit) fail();
    for (const item of d[name]) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(item.id) ||
        ids.has(item.id)
      )
        fail();
      ids.add(item.id);
      if (name === 'tasks') {
        text(item.text, 1000, true);
        oneOf(item.status, ['todo', 'doing', 'done']);
      }
      if (name === 'notes') text(item.text, 4000, true);
      if (name === 'resources') {
        webURL(item.url);
        text(item.title, 300);
      }
      if (name === 'evidence') {
        text(item.quote, 8000, true);
        text(item.annotation, 2000);
        oneOf(item.review, ['unverified']);
        if (
          item.method !== 'native-selection' ||
          !d.resources.some((r) => r.id === item.resourceId) ||
          typeof item.clipped !== 'boolean'
        )
          fail();
      }
      if (name === 'decisions') {
        text(item.text, 2000, true);
        references(d, item.evidenceIds);
        if (
          typeof item.needsReview !== 'boolean' ||
          !Number.isSafeInteger(item.goalRevision) ||
          item.goalRevision > d.goal.revision ||
          item.goalRevision < 0
        )
          fail();
      }
      const ts =
        name === 'resources' || name === 'evidence'
          ? item.capturedAt
          : item.createdAt;
      if (!Number.isFinite(ts)) fail();
    }
  }
  if (new TextEncoder().encode(JSON.stringify(d)).length > MAX_DOSSIER_BYTES)
    throw new DossierError('El expediente excede 4 MB');
  return d;
}
/** Exportación explícita, no paquete EVO: no llama verificado al contenido. */
export function dossierMarkdown(d) {
  const plain = (s) => String(s).replace(/[<>\\`*_\[\]#|]/g, '\\$&');
  const lines = [
    '# NEXO · Expediente de objetivo',
    '',
    '> Exportación local. Citas y notas no equivalen a hechos verificados.',
    '',
    '## Objetivo',
    plain(d.goal.text || 'Sin definir'),
    ...d.goal.criteria.map((c) => `- ${plain(c)}`),
    '',
    '## Continuar',
    plain(d.nextStep || 'Sin punto de continuación'),
    '',
    '## Tareas',
    ...d.tasks.map(
      (t) =>
        `- [${t.status === 'done' ? 'x' : ' '}] ${plain(t.text)} (${t.status})`,
    ),
    '',
    '## Fuentes y evidencias',
  ];
  for (const e of d.evidence) {
    const r = d.resources.find((r) => r.id === e.resourceId);
    lines.push(
      '',
      `### ${plain(r.title || r.url)}`,
      plain(r.url),
      `Captura: ${new Date(e.capturedAt).toISOString()} · Sin verificar${e.clipped ? ' · Fragmento truncado' : ''}`,
      '',
      ...e.quote.split('\n').map((l) => `> ${plain(l)}`),
      '',
      plain(e.annotation),
    );
  }
  lines.push(
    '',
    '## Recursos',
    ...d.resources.map((r) => `- ${plain(r.title)} — ${plain(r.url)}`),
    '',
    '## Decisiones',
  );
  for (const dec of d.decisions)
    lines.push(
      `- ${plain(dec.text)}${dec.needsReview ? ' — REQUIERE REVISIÓN' : ' — declarada por el usuario'}`,
      `  Evidencias: ${dec.evidenceIds.join(', ') || 'ninguna vinculada'}`,
    );
  lines.push(
    '',
    '## Notas',
    ...d.notes.map((n) => `- ${plain(n.text)}`),
    '',
    '## Revisiones anteriores del objetivo',
    ...d.goalHistory.map(
      (g) =>
        `- r${g.revision}: ${plain(g.text)}; criterios: ${g.criteria.map(plain).join('; ')}`,
    ),
  );
  return lines.join('\n') + '\n';
}

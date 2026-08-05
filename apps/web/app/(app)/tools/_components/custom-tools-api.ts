/**
 * The browser half of the custom-tools panel.
 *
 * WHY THIS IS NOT `@/lib/custom-tools`. That module is `server-only` and
 * imports `@cortex/agent-tools` for `Definition` — pulling either into a client
 * bundle drags `node:crypto`, `node:dns` and pdf-parse's `fs` access into the
 * browser and breaks the production build. So the shapes below MIRROR
 * `DefinitionSchema` (packages/agent-tools/src/custom-tools/definition.ts) and
 * `CustomToolView` (apps/web/lib/custom-tools.ts) by hand. If either of those
 * changes, this is the file that has to follow.
 *
 * The API is the authority on validity: everything here validates only enough
 * to keep the form from sending an obviously broken payload, and the server's
 * `problems[]` is what the person actually reads.
 */

export const CUSTOM_TOOLS_ENDPOINT = '/api/custom-tools';

export type CustomToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type CustomToolAuthType = 'none' | 'header' | 'bearer' | 'basic';
export type CustomToolBodyEncoding = 'none' | 'json' | 'form';
export type CustomToolFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'string_array';

export const METHODS: CustomToolMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const WRITE_METHODS: CustomToolMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function isWriteMethod(method: string): boolean {
  return (WRITE_METHODS as string[]).includes(method.toUpperCase());
}

export interface CustomToolField {
  name: string;
  type: CustomToolFieldType;
  required: boolean;
  description: string;
  enum?: string[];
}

/** Mirrors `Definition`. Sent as-is on POST, and partially on PATCH. */
export interface CustomToolDraft {
  slug: string;
  name: string;
  description: string;
  fields: CustomToolField[];
  method: CustomToolMethod;
  urlTemplate: string;
  headers: Record<string, string>;
  bodyEncoding: CustomToolBodyEncoding;
  bodyTemplate?: unknown;
  authType: CustomToolAuthType;
  authHeaderName?: string;
  authUsername?: string;
  /** Write-only. Absent means "leave the stored one alone". */
  authSecret?: string;
  responsePath?: string;
  responseMaxChars: number;
  timeoutMs: number;
  allowInsecureHttp: boolean;
  followRedirects: boolean;
  requiresConfirmation?: boolean;
  rateLimitPerMinute: number;
  enabled: boolean;
}

/** Mirrors `CustomToolView` (admins) and `CustomToolPublicView` (everyone else). */
export interface CustomToolView {
  id: string;
  toolId: string;
  name: string;
  description: string;
  requiresConfirmation: boolean;
  enabled: boolean;
  /** Present only on the admin view. */
  slug?: string;
  fields?: CustomToolField[];
  method?: CustomToolMethod;
  urlTemplate?: string;
  headers?: Record<string, string>;
  bodyEncoding?: CustomToolBodyEncoding;
  bodyTemplate?: unknown;
  authType?: CustomToolAuthType;
  authHeaderName?: string | null;
  authUsername?: string | null;
  authConfigured?: boolean;
  responsePath?: string | null;
  responseMaxChars?: number;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  followRedirects?: boolean;
  rateLimitPerMinute?: number;
  lastTestedAt?: string | null;
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CustomToolsList {
  tools: CustomToolView[];
  canManage: boolean;
  atCapacity: boolean;
  maxTools: number;
  /** Set when the list could not be read at all. */
  error: string | null;
}

/** Mirrors the tester's response body. */
export interface CustomToolTestResponse {
  ok: boolean;
  elapsedMs?: number;
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
  };
  chain?: string[];
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    truncated: boolean;
  } | null;
  modelResult?: { ok: boolean; status: number | null; message?: string; data?: unknown };
  /** Set when the route refused before running anything. */
  error?: string;
  problems?: string[];
}

export const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;
export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

export const EMPTY_FIELD: CustomToolField = {
  name: '',
  type: 'string',
  required: true,
  description: '',
};

export const EMPTY_DRAFT: CustomToolDraft = {
  slug: '',
  name: '',
  description: '',
  fields: [],
  method: 'GET',
  urlTemplate: '',
  headers: {},
  bodyEncoding: 'none',
  authType: 'none',
  authHeaderName: '',
  authUsername: '',
  authSecret: '',
  responsePath: '',
  responseMaxChars: 8_000,
  timeoutMs: 10_000,
  allowInsecureHttp: false,
  followRedirects: false,
  rateLimitPerMinute: 20,
  enabled: true,
};

/** `Consultar inventario` → `consultar_inventario`. Accents folded, not dropped. */
export function slugify(raw: string): string {
  const base = raw
    .normalize('NFD')
    // Combining diacritics only (U+0300–U+036F), all inside the BMP — biome's
    // surrogate-pair warning does not apply to this range.
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: BMP-only range
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  // The slug must start with a letter (SLUG_RE); a name beginning with a digit
  // would otherwise produce something the API refuses with no explanation.
  return /^[a-z]/.test(base) ? base : base ? `h_${base}`.slice(0, 48) : '';
}

/** `{{guia}}` occurrences inside a template string. */
export function placeholdersIn(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let match = re.exec(text);
  while (match) {
    if (match[1]) out.push(match[1]);
    match = re.exec(text);
  }
  return [...new Set(out)];
}

/**
 * The description is the whole ballgame: it is the only thing the model reads
 * when deciding whether this tool is the right one for what was asked. Too
 * short and it never gets picked. This is not validation for the API's sake —
 * it is the difference between a tool that gets used and one that sits there.
 */
export function describeDescriptionQuality(description: string): {
  tone: 'faint' | 'amber' | 'emerald';
  text: string;
} {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    return {
      tone: 'faint',
      text: 'Cortex lee esto —y solo esto— para decidir cuándo usar la herramienta. Es lo más importante del formulario.',
    };
  }
  if (trimmed.length < 60) {
    return {
      tone: 'amber',
      text: 'Va corta. Di también en qué situación conviene usarla y qué devuelve, no solo qué hace.',
    };
  }
  return {
    tone: 'emerald',
    text: 'Buen tamaño. Léela de nuevo preguntándote: ¿alguien que no conoce tu API sabría cuándo usarla?',
  };
}

/** Client-side problems, in the same voice the server uses. */
export function draftProblems(draft: CustomToolDraft): string[] {
  const problems: string[] = [];

  if (!draft.name.trim()) problems.push('Ponle un nombre a la herramienta.');
  if (!SLUG_RE.test(draft.slug)) {
    problems.push(
      'El identificador debe empezar por una letra y tener entre 2 y 48 caracteres: minúsculas, números y guion bajo.',
    );
  }
  const description = draft.description.trim();
  if (description.length < 10) {
    problems.push('La descripción es lo que lee el modelo: necesita al menos 10 caracteres.');
  }
  if (draft.urlTemplate.trim().length < 8)
    problems.push('Falta la dirección a la que va a llamar.');

  const names = new Set(draft.fields.map((f) => f.name.trim()));
  for (const field of draft.fields) {
    if (!FIELD_NAME_RE.test(field.name.trim())) {
      problems.push(
        `"${field.name || 'sin nombre'}" no sirve como nombre de dato: empieza por letra y usa solo letras, números y guion bajo.`,
      );
    }
    if (!field.description.trim()) {
      problems.push(`El dato "${field.name}" no tiene descripción; sin ella el modelo adivina.`);
    }
  }

  const used = new Set([
    ...placeholdersIn(draft.urlTemplate),
    ...Object.values(draft.headers).flatMap(placeholdersIn),
    ...(draft.bodyEncoding === 'none'
      ? []
      : placeholdersIn(JSON.stringify(draft.bodyTemplate ?? ''))),
  ]);
  for (const name of used) {
    if (!names.has(name)) problems.push(`La plantilla usa {{${name}}}, pero no hay un dato así.`);
  }

  if (draft.authType === 'header' && !(draft.authHeaderName ?? '').trim()) {
    problems.push('Falta el nombre de la cabecera donde va la llave.');
  }
  if (draft.authType === 'basic' && !(draft.authUsername ?? '').trim()) {
    problems.push('La autenticación básica necesita un usuario.');
  }
  if (draft.bodyEncoding !== 'none' && draft.method === 'GET') {
    problems.push('Una petición GET no lleva cuerpo.');
  }

  return problems;
}

/**
 * Strips the fields the API refuses when empty. `authSecret: ''` on an edit
 * would fail zod's `min(1)` even though the person only meant "do not change
 * it", so an empty secret is dropped rather than sent.
 */
export function toPayload(draft: CustomToolDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    slug: draft.slug,
    name: draft.name.trim(),
    description: draft.description.trim(),
    fields: draft.fields.map((f) => ({
      name: f.name.trim(),
      type: f.type,
      required: f.required,
      description: f.description.trim(),
      ...(f.enum && f.enum.length > 0 ? { enum: f.enum } : {}),
    })),
    method: draft.method,
    urlTemplate: draft.urlTemplate.trim(),
    headers: draft.headers,
    bodyEncoding: draft.bodyEncoding,
    authType: draft.authType,
    responseMaxChars: draft.responseMaxChars,
    timeoutMs: draft.timeoutMs,
    allowInsecureHttp: draft.allowInsecureHttp,
    followRedirects: draft.followRedirects,
    rateLimitPerMinute: draft.rateLimitPerMinute,
    enabled: draft.enabled,
  };
  if (draft.bodyEncoding !== 'none') payload.bodyTemplate = draft.bodyTemplate ?? {};
  if (draft.authType === 'header' && draft.authHeaderName?.trim()) {
    payload.authHeaderName = draft.authHeaderName.trim();
  }
  if (draft.authType === 'basic' && draft.authUsername?.trim()) {
    payload.authUsername = draft.authUsername.trim();
  }
  if (draft.authSecret?.trim()) payload.authSecret = draft.authSecret;
  if (draft.responsePath?.trim()) payload.responsePath = draft.responsePath.trim();
  if (draft.requiresConfirmation !== undefined) {
    payload.requiresConfirmation = draft.requiresConfirmation;
  }
  return payload;
}

/** A saved tool back into a form draft. The secret is never returned, so it starts empty. */
export function toDraft(tool: CustomToolView): CustomToolDraft {
  return {
    slug: tool.slug ?? '',
    name: tool.name,
    description: tool.description,
    fields: tool.fields ?? [],
    method: tool.method ?? 'GET',
    urlTemplate: tool.urlTemplate ?? '',
    headers: tool.headers ?? {},
    bodyEncoding: tool.bodyEncoding ?? 'none',
    bodyTemplate: tool.bodyTemplate,
    authType: tool.authType ?? 'none',
    authHeaderName: tool.authHeaderName ?? '',
    authUsername: tool.authUsername ?? '',
    authSecret: '',
    responsePath: tool.responsePath ?? '',
    responseMaxChars: tool.responseMaxChars ?? 8_000,
    timeoutMs: tool.timeoutMs ?? 10_000,
    allowInsecureHttp: tool.allowInsecureHttp ?? false,
    followRedirects: tool.followRedirects ?? false,
    requiresConfirmation: tool.requiresConfirmation,
    rateLimitPerMinute: tool.rateLimitPerMinute ?? 20,
    enabled: tool.enabled,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface ApiFailure {
  error: string;
  problems: string[];
}

async function readFailure(res: Response): Promise<ApiFailure> {
  try {
    const body = (await res.json()) as { error?: unknown; problems?: unknown };
    const problems = Array.isArray(body.problems) ? body.problems.map(String) : [];
    if (typeof body.error === 'string') return { error: body.error, problems };
    // A zod flatten() comes back as an object; the field messages are what help.
    if (body.error && typeof body.error === 'object') {
      const flat = body.error as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
      const fromFields = Object.entries(flat.fieldErrors ?? {}).map(
        ([field, messages]) => `${field}: ${messages.join(', ')}`,
      );
      return {
        error: 'La definición no pasó la validación.',
        problems: [...(flat.formErrors ?? []), ...fromFields, ...problems],
      };
    }
    return { error: `El servidor respondió ${res.status}.`, problems };
  } catch {
    return { error: `El servidor respondió ${res.status}.`, problems: [] };
  }
}

export async function loadCustomTools(signal?: AbortSignal): Promise<CustomToolsList> {
  const empty: CustomToolsList = {
    tools: [],
    canManage: false,
    atCapacity: false,
    maxTools: 0,
    error: null,
  };
  let res: Response;
  try {
    res = await fetch(CUSTOM_TOOLS_ENDPOINT, { signal });
  } catch {
    return { ...empty, error: 'No se pudo contactar al servidor.' };
  }
  if (!res.ok) {
    const failure = await readFailure(res);
    return { ...empty, error: failure.error };
  }
  try {
    const body = (await res.json()) as Partial<CustomToolsList>;
    return {
      tools: body.tools ?? [],
      canManage: body.canManage ?? false,
      atCapacity: body.atCapacity ?? false,
      maxTools: body.maxTools ?? 0,
      error: null,
    };
  } catch {
    return { ...empty, error: 'No se entendió la respuesta del servidor.' };
  }
}

export type SaveOutcome =
  | { ok: true; tool: CustomToolView; warning: string | null }
  | { ok: false; error: string; problems: string[] };

export async function saveCustomTool(
  draft: CustomToolDraft,
  editingId?: string,
): Promise<SaveOutcome> {
  const res = await fetch(
    editingId ? `${CUSTOM_TOOLS_ENDPOINT}/${editingId}` : CUSTOM_TOOLS_ENDPOINT,
    {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPayload(draft)),
    },
  );
  if (!res.ok) {
    const failure = await readFailure(res);
    return { ok: false, ...failure };
  }
  const body = (await res.json()) as { tool?: CustomToolView; warning?: string | null };
  if (!body.tool) {
    return { ok: false, error: 'El servidor no devolvió la herramienta guardada.', problems: [] };
  }
  return { ok: true, tool: body.tool, warning: body.warning ?? null };
}

export async function deleteCustomTool(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${CUSTOM_TOOLS_ENDPOINT}/${id}`, { method: 'DELETE' });
  if (res.status === 204) return { ok: true };
  const failure = await readFailure(res);
  return { ok: false, error: failure.error };
}

export async function runCustomToolTest(
  id: string,
  input: Record<string, unknown>,
): Promise<CustomToolTestResponse> {
  let res: Response;
  try {
    res = await fetch(`${CUSTOM_TOOLS_ENDPOINT}/${id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
  } catch {
    return { ok: false, error: 'No se pudo contactar al servidor.' };
  }
  try {
    const body = (await res.json()) as CustomToolTestResponse;
    if (!res.ok) return { ...body, ok: false };
    return body;
  } catch {
    return { ok: false, error: 'No se entendió la respuesta del probador.' };
  }
}

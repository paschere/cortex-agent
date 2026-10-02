import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FIELD_KEY_RE, TRACKER_SLUG_RE } from '../trackers/schema';
import type { WorkSourceKind, WorkStatus } from './types';

/**
 * LA FORMA DEL REGISTRO DE TRABAJO: vocabulario, ajustes y las reglas puras
 * que comparten la ingesta, las herramientas y las vistas.
 *
 * Nada de aquí lee la base ni el reloj (salvo `bogotaDayOf`, que recibe la
 * fecha). Las reglas que importan —quién es «Laura», qué es un tipo de trabajo,
 * cuándo dos registros del chat son el mismo— viven aquí para poder probarlas
 * sin base y para que el chat, la sincronización y las vistas digan lo mismo.
 */

export const WORK_SOURCE_KINDS = [
  'management_case',
  'commitment',
  'tracker_row',
  'receivable',
  'approval',
  'request',
  'routine',
  'manual',
  'chat',
  'sheet',
  'whatsapp',
] as const satisfies readonly WorkSourceKind[];

export const WORK_STATUSES = ['open', 'done', 'cancelled'] as const satisfies readonly WorkStatus[];

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  open: 'Por hacer',
  done: 'Hecho',
  cancelled: 'Ya no aplica',
};

export const WORK_SOURCE_LABEL: Record<WorkSourceKind, string> = {
  management_case: 'Gerencia',
  commitment: 'Compromisos',
  tracker_row: 'Tabla',
  receivable: 'Cartera',
  approval: 'Aprobaciones',
  request: 'Solicitudes',
  routine: 'Rutina',
  manual: 'A mano',
  chat: 'Chat',
  sheet: 'Hoja',
  whatsapp: 'WhatsApp',
};

/**
 * Las fuentes de Cortex que la sincronización lee sola. Cartera y solicitudes
 * NO están: hoy no existe en Cortex una cartera asignada a un cobrador ni una
 * tabla de solicitudes con responsable. Cuando una empresa las lleva en una
 * tabla inventada, entran por `trackerMappings` como cualquier otra.
 */
export const SYNCED_SOURCES = ['management_case', 'commitment', 'tracker_row', 'approval'] as const;
export type SyncedSource = (typeof SYNCED_SOURCES)[number];

/** Las fuentes que alguien puede declarar al registrar trabajo a mano. */
export const RECORDABLE_SOURCES = [
  'manual',
  'chat',
  'sheet',
  'whatsapp',
  'routine',
  'request',
  'receivable',
] as const satisfies readonly WorkSourceKind[];
export type RecordableSource = (typeof RECORDABLE_SOURCES)[number];

/** Los tipos con que entra lo que Cortex ya tiene. */
export const WORK_TYPE = {
  managementCase: 'caso',
  internalCommitment: 'compromiso',
  commitment: 'vencimiento',
  decision: 'decisión',
} as const;

export const TEAM_VISIBILITY = ['self', 'team', 'all'] as const;
export type TeamVisibility = (typeof TEAM_VISIBILITY)[number];
export const TEAM_VISIBILITY_LABEL: Record<TeamVisibility, string> = {
  self: 'cada persona ve sólo lo suyo',
  team: 'cada persona ve lo de su equipo',
  all: 'todos ven el trabajo de todo el equipo',
};

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/** Sin tildes y en minúsculas; la eñe se queda (es otra letra). */
export function foldText(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .split('ñ')
    .map((part) => part.normalize('NFD').replace(/\p{M}/gu, ''))
    .join('ñ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** « Despacho  urgente» → «despacho urgente»: minúsculas y un solo espacio. */
export function normalizeWorkType(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 60);
}

export const workTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((v) => normalizeWorkType(v));

/** ¿Este tipo se mide en esta empresa? `null` = se miden todos. */
export function isMeasured(workType: string, measured: readonly string[] | null): boolean {
  if (!measured || measured.length === 0) return true;
  const key = foldText(workType);
  return measured.some((m) => foldText(m) === key);
}

// ---------------------------------------------------------------------------
// Fechas (Bogotá: UTC−5 todo el año)
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** El día de Bogotá de un instante. */
export function bogotaDayOf(instant: string | Date): string {
  const t = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  return new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Un día como instante: el mediodía de Bogotá si no es hoy (así nunca cambia
 * de día al pasar por UTC), o el instante dado si el día es hoy.
 */
export function dayToInstant(day: string, now: Date = new Date()): string {
  if (bogotaDayOf(now) === day) return now.toISOString();
  return new Date(`${day}T12:00:00-05:00`).toISOString();
}

/** Lo que trae una fuente como fecha: día, instante, o nada. */
export function readDate(value: unknown): { day: string } | { instant: string } | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (isIsoDay(v)) return { day: v };
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : { instant: new Date(t).toISOString() };
}

// ---------------------------------------------------------------------------
// Quién es quién
// ---------------------------------------------------------------------------

export interface WorkDirectoryPerson {
  id: string;
  name: string | null;
  email: string;
  role?: string | null;
}

export type PersonMatch =
  | { kind: 'found'; id: string; label: string }
  | { kind: 'ambiguous'; label: string; candidates: Array<{ id: string; label: string }> }
  | { kind: 'unknown'; label: string }
  | { kind: 'empty' };

export function personLabelOf(p: WorkDirectoryPerson): string {
  return p.name?.trim() || p.email;
}

/** Para nombres de gente, la eñe también se pliega: «Pena» es «Peña» en un teclado sin eñe. */
const nameKey = (value: string) => foldText(value).replace(/ñ/g, 'n');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * De lo que dice una fuente («Laura», «laura@acme.co», «LAURA GÓMEZ», un id) a
 * una persona del equipo. Nunca adivina: si dos personas se llaman Laura, es
 * ambiguo y quien llama decide (el chat pregunta; la sincronización deja el
 * ítem sin asignar con el nombre a la vista).
 */
export function resolvePerson(people: readonly WorkDirectoryPerson[], raw: unknown): PersonMatch {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  const text = String(raw).trim();
  if (!text) return { kind: 'empty' };
  const label = text.slice(0, 160);

  if (UUID_RE.test(text)) {
    const p = people.find((x) => x.id.toLowerCase() === text.toLowerCase());
    return p ? { kind: 'found', id: p.id, label: personLabelOf(p) } : { kind: 'unknown', label };
  }

  const folded = nameKey(text);
  if (folded.includes('@')) {
    const p = people.find((x) => x.email.trim().toLowerCase() === folded);
    return p ? { kind: 'found', id: p.id, label: personLabelOf(p) } : { kind: 'unknown', label };
  }

  const exact = people.filter((p) => p.name && nameKey(p.name) === folded);
  if (exact.length === 1 && exact[0])
    return { kind: 'found', id: exact[0].id, label: personLabelOf(exact[0]) };
  if (exact.length > 1) return ambiguous(label, exact);

  // Por palabras: «Laura» encuentra a «Laura Gómez»; «laura g» también.
  const words = folded.split(' ').filter(Boolean);
  const byWords = people.filter((p) => {
    const tokens = [
      ...(p.name ? nameKey(p.name).split(' ') : []),
      nameKey(p.email.split('@')[0] ?? '').replace(/[._-]+/g, ' '),
    ]
      .join(' ')
      .split(' ')
      .filter(Boolean);
    return words.every((w) => tokens.some((t) => tokenMatches(t, w, words.length)));
  });
  if (byWords.length === 1 && byWords[0])
    return { kind: 'found', id: byWords[0].id, label: personLabelOf(byWords[0]) };
  if (byWords.length > 1) return ambiguous(label, byWords);
  return { kind: 'unknown', label };
}

/** Una palabra entera, un prefijo de 3+ letras, o una inicial junto a otra palabra. */
function tokenMatches(token: string, word: string, wordCount: number): boolean {
  if (token === word) return true;
  if (word.length >= 3) return token.startsWith(word);
  return word.length === 1 && wordCount > 1 && token.startsWith(word);
}

function ambiguous(label: string, people: WorkDirectoryPerson[]): PersonMatch {
  return {
    kind: 'ambiguous',
    label,
    candidates: people.slice(0, 8).map((p) => ({ id: p.id, label: personLabelOf(p) })),
  };
}

// ---------------------------------------------------------------------------
// La huella de lo registrado sin referencia
// ---------------------------------------------------------------------------

/**
 * Lo dicho en el chat no trae id. Dos registros con los MISMOS hechos (misma
 * persona, tipo, título, día, cantidad y unidad) son el mismo registro: así
 * «registra que Laura despachó 12 guías hoy», dicho dos veces, cuenta una.
 * Quien registre de verdad dos veces lo mismo el mismo día lo dice con una
 * referencia distinta (`ref`).
 */
export function factsRef(facts: {
  assignee: string | null;
  workType: string;
  title: string;
  day: string;
  quantity?: number | null;
  unit?: string | null;
}): string {
  const canonical = [
    facts.assignee ?? '',
    foldText(facts.workType),
    foldText(facts.title),
    facts.day,
    facts.quantity ?? '',
    foldText(facts.unit ?? ''),
  ].join('\u0001');
  return `h:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

const fieldKey = z.string().regex(FIELD_KEY_RE);
const valueList = z.array(z.string().trim().min(1).max(80)).max(20);

/** Cómo una tabla inventada se vuelve trabajo. */
export const trackerMappingSchema = z.object({
  tracker: z.string().trim().regex(TRACKER_SLUG_RE),
  workType: workTypeSchema,
  /** El campo con el nombre (o correo) de quien responde. */
  assigneeField: fieldKey,
  /** El campo de estado; sin él, la fila está abierta hasta que tenga fecha de cierre. */
  statusField: fieldKey.nullable().default(null),
  /** Valores de `statusField` que quieren decir «hecho». */
  doneValues: valueList.default([]),
  /** Valores de `statusField` que quieren decir «ya no aplica». */
  cancelledValues: valueList.default([]),
  dueField: fieldKey.nullable().default(null),
  quantityField: fieldKey.nullable().default(null),
  unit: z.string().trim().min(1).max(30).nullable().default(null),
  titleField: fieldKey.nullable().default(null),
  teamField: fieldKey.nullable().default(null),
  doneAtField: fieldKey.nullable().default(null),
  openedAtField: fieldKey.nullable().default(null),
});
export type TrackerMapping = z.infer<typeof trackerMappingSchema>;
export type TrackerMappingInput = z.input<typeof trackerMappingSchema>;

export interface WorkSettings {
  measuredTypes: string[] | null;
  sources: SyncedSource[];
  trackerMappings: TrackerMapping[];
  teamVisibility: TeamVisibility;
  syncState: Record<string, string>;
  lastSyncedAt: string | null;
}

export const DEFAULT_WORK_SETTINGS: WorkSettings = {
  measuredTypes: null,
  sources: [...SYNCED_SOURCES],
  trackerMappings: [],
  teamVisibility: 'self',
  syncState: {},
  lastSyncedAt: null,
};

/** Una fila de `work_settings` (o ninguna) → ajustes con sus valores por defecto. */
export function adaptWorkSettings(row: Record<string, unknown> | null): WorkSettings {
  if (!row) return { ...DEFAULT_WORK_SETTINGS, sources: [...SYNCED_SOURCES] };
  const mappings = Array.isArray(row.tracker_mappings)
    ? row.tracker_mappings
        .map((m) => trackerMappingSchema.safeParse(m))
        .filter((r) => r.success)
        .map((r) => (r as { data: TrackerMapping }).data)
    : [];
  const sources = Array.isArray(row.sources)
    ? (row.sources as unknown[]).filter((s): s is SyncedSource =>
        (SYNCED_SOURCES as readonly unknown[]).includes(s),
      )
    : [...SYNCED_SOURCES];
  const visibility = TEAM_VISIBILITY.includes(row.team_visibility as TeamVisibility)
    ? (row.team_visibility as TeamVisibility)
    : 'self';
  const measured = Array.isArray(row.measured_types)
    ? (row.measured_types as unknown[]).filter((t): t is string => typeof t === 'string')
    : null;
  const state =
    row.sync_state && typeof row.sync_state === 'object' && !Array.isArray(row.sync_state)
      ? Object.fromEntries(
          Object.entries(row.sync_state as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        )
      : {};
  return {
    measuredTypes: measured?.length ? measured : null,
    sources,
    trackerMappings: mappings,
    teamVisibility: visibility,
    syncState: state,
    lastSyncedAt: typeof row.last_synced_at === 'string' ? row.last_synced_at : null,
  };
}

/** Huella de un mapeo: si cambia, esa tabla se relee entera. */
export function mappingHash(m: TrackerMapping): string {
  return createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 16);
}

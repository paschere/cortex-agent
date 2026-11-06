import { gunzipSync, gzipSync } from 'node:zlib';
import type { Snapshot } from '../versions-shape';

/**
 * COPIAS POR APP: LA FORMA DEL ARCHIVO Y SUS REGLAS, EN PURO (migración 0247).
 *
 * Una copia es una foto de la app: configuración, código y las filas de TODAS
 * las tablas que usa. Aquí vive todo lo que no toca la base: el formato del
 * archivo (JSON → gzip), qué tablas «usa» una app, las diferencias contra hoy,
 * el plan de lo que cambia al restaurar y la retención. Se prueba en
 * backups.test.ts con copias escritas a mano.
 */

export const BACKUP_VERSION = 1;
export const BACKUP_BUCKET = 'app-backups';

/** Filas que se guardan por tabla (más, se marca `truncated`). */
export const MAX_ROWS_PER_TABLE = 50_000;
/** Tamaño máximo del archivo ya comprimido: viaja en hex por PostgREST (files/store.ts). */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

export const BACKUP_KINDS = ['diaria', 'antes_de_cambio', 'manual'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_KIND_LABEL: Record<BackupKind, string> = {
  diaria: 'Diaria',
  antes_de_cambio: 'Antes de un cambio',
  manual: 'Manual',
};

export interface BackupTracker {
  id: string;
  slug: string;
  name: string;
  description: string;
  fields: unknown;
  origins: unknown;
}

export interface BackupRow {
  id: string;
  label: string;
  values: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupTable {
  tracker: BackupTracker;
  rows: BackupRow[];
  /** Cuántas filas había (puede ser más que `rows.length` si se truncó). */
  total: number;
  truncated: boolean;
}

export interface BackupConfig {
  /** La fila de custom_apps tal cual (incluye ubicación y geocercas). */
  app: Record<string, unknown>;
  /** La foto del borrador (la misma que una versión publicada): pantallas con su spec, roles, tableros, portal. */
  snapshot: Snapshot;
  /** Reglas (custom_app_automations) tal cual. */
  automations: Array<Record<string, unknown>>;
  /** Avisos automáticos por rol (custom_app_notice_config.config). */
  noticeConfig: Record<string, unknown> | null;
  /** Número de la última versión publicada (referencia; no se restaura la publicación). */
  publishedVersion: number | null;
}

export interface BackupCode {
  files: Record<string, string>;
  fileMeta: Record<string, unknown>;
  sdkVersion: string;
  /** Id de la compilación publicada al copiar (referencia: los bundles se recompilan). */
  publishedBuildId: string | null;
  /** Sólo los NOMBRES de los secretos; sus valores nunca entran a una copia. */
  secretNames: string[];
}

export interface BackupAppDb {
  schema: string;
  tables: Record<
    string,
    { rows: Array<Record<string, unknown>>; total: number; truncated: boolean }
  >;
}

export interface BackupContent {
  v: typeof BACKUP_VERSION;
  app: { id: string; slug: string; name: string };
  createdAt: string;
  kind: BackupKind;
  reason: string;
  config: BackupConfig;
  code: BackupCode | null;
  tables: Record<string, BackupTable>;
  appDb: BackupAppDb | null;
  /** Avisos de lo que no se pudo copiar (una tabla que ya no existe, la base propia no disponible…). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Formato: JSON → gzip
// ---------------------------------------------------------------------------

export function packBackup(content: BackupContent): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(content), 'utf8'), { level: 9 });
}

export function unpackBackup(bytes: Uint8Array): BackupContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(Buffer.from(bytes)).toString('utf8'));
  } catch {
    throw new Error('El archivo de la copia está dañado o no se puede leer.');
  }
  const c = parsed as Partial<BackupContent> | null;
  if (!c || c.v !== BACKUP_VERSION || !c.config || !c.tables || !c.app)
    throw new Error('El archivo de la copia no tiene el formato esperado.');
  return { warnings: [], code: null, appDb: null, ...c } as BackupContent;
}

export function backupPath(orgId: string, appId: string, backupId: string): string {
  return `${orgId}/${appId}/${backupId}.json.gz`;
}

/** Resumen por tabla: slug → filas. Es lo que se guarda en la columna `tables` para listar sin abrir el archivo. */
export function tableCounts(content: Pick<BackupContent, 'tables'>): Record<string, number> {
  return Object.fromEntries(Object.entries(content.tables).map(([slug, t]) => [slug, t.total]));
}

// ---------------------------------------------------------------------------
// Qué tablas usa una app
// ---------------------------------------------------------------------------

/** Cada valor de una llave `tracker`/`table` del JSON (reglas, specs): así se nombran las tablas. */
export function trackerRefsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) trackerRefsIn(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((k === 'tracker' || k === 'table' || k === 'parentTracker') && typeof v === 'string')
        into.add(v);
      else trackerRefsIn(v, into);
    }
  }
  return into;
}

/**
 * Las tablas que usa una app: las que nombran los permisos de sus roles + las
 * de sus pantallas (vistas) + las de sus reglas. Se devuelven SIN comprobar que
 * existan; quien copia las busca en la empresa y avisa de las que no.
 */
export function tableSlugsOf(input: {
  roles: Array<{ permissions: unknown }>;
  specs: unknown[];
  automations: unknown[];
}): string[] {
  const out = new Set<string>();
  for (const r of input.roles) {
    const tables = (r.permissions as { tables?: Record<string, unknown> } | null)?.tables;
    for (const slug of Object.keys(tables ?? {})) out.add(slug);
  }
  for (const spec of input.specs) trackerRefsIn(spec, out);
  for (const a of input.automations) {
    const rule = a as { trigger?: unknown; conditions?: unknown; actions?: unknown };
    trackerRefsIn(rule.trigger, out);
    trackerRefsIn(rule.conditions, out);
    trackerRefsIn(rule.actions, out);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Diferencias contra hoy
// ---------------------------------------------------------------------------

export interface LiveRow {
  id: string;
  label: string;
  values: Record<string, unknown>;
}

export interface FieldChange {
  field: string;
  /** Lo que dice la copia. */
  was: unknown;
  /** Lo que dice hoy. */
  now: unknown;
}

export interface RowDiff {
  id: string;
  label: string;
  changes: FieldChange[];
}

export interface TableDiff {
  slug: string;
  /** Filas que hoy existen y la copia no tenía (restaurar la tabla las borraría). */
  added: Array<{ id: string; label: string }>;
  /** Filas que la copia tenía y hoy no existen (restaurar las recrea). */
  removed: Array<{ id: string; label: string }>;
  /** Filas que existen en las dos con valores distintos. */
  changed: RowDiff[];
  unchanged: number;
  /** La copia es parcial: «borradas» puede incluir filas que no cupieron. */
  truncated: boolean;
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function rowChanges(
  was: { label: string; values: Record<string, unknown> },
  now: { label: string; values: Record<string, unknown> },
): FieldChange[] {
  const out: FieldChange[] = [];
  if (was.label !== now.label) out.push({ field: '(nombre)', was: was.label, now: now.label });
  const keys = new Set([...Object.keys(was.values), ...Object.keys(now.values)]);
  for (const k of [...keys].sort()) {
    if (!same(was.values[k], now.values[k]))
      out.push({ field: k, was: was.values[k], now: now.values[k] });
  }
  return out;
}

export function diffTable(slug: string, backup: BackupTable, live: LiveRow[]): TableDiff {
  const byId = new Map(backup.rows.map((r) => [r.id, r]));
  const liveIds = new Set(live.map((r) => r.id));
  const added = live.filter((r) => !byId.has(r.id)).map((r) => ({ id: r.id, label: r.label }));
  const removed = backup.rows
    .filter((r) => !liveIds.has(r.id))
    .map((r) => ({ id: r.id, label: r.label }));
  const changed: RowDiff[] = [];
  let unchanged = 0;
  for (const row of live) {
    const was = byId.get(row.id);
    if (!was) continue;
    const changes = rowChanges(was, row);
    if (changes.length) changed.push({ id: row.id, label: row.label, changes });
    else unchanged++;
  }
  return { slug, added, removed, changed, unchanged, truncated: backup.truncated };
}

/** Lo que haría restaurar la tabla entera: filas que se recrean, se cambian y se borran. */
export interface RestorePlan {
  create: number;
  update: number;
  remove: number;
}

export function planTableRestore(diff: TableDiff): RestorePlan {
  return {
    create: diff.removed.length,
    update: diff.changed.length,
    // Una copia truncada no sabe qué más había: no se borra nada que no pueda comparar.
    remove: diff.truncated ? 0 : diff.added.length,
  };
}

export function describeTableRestore(slug: string, p: RestorePlan): string {
  const parts = [
    p.create
      ? `${p.create} ${p.create === 1 ? 'fila se vuelve a crear' : 'filas se vuelven a crear'}`
      : '',
    p.update
      ? `${p.update} ${p.update === 1 ? 'fila vuelve' : 'filas vuelven'} a sus valores de la copia`
      : '',
    p.remove
      ? `${p.remove} ${p.remove === 1 ? 'fila nueva se borra' : 'filas nuevas se borran'}`
      : '',
  ].filter(Boolean);
  return parts.length
    ? `En «${slug}»: ${parts.join('; ')}.`
    : `«${slug}» ya está igual que en la copia: no cambia nada.`;
}

// ---------------------------------------------------------------------------
// Retención
// ---------------------------------------------------------------------------

export const KEEP_DAILY = 30;
export const KEEP_OTHER_DAYS = 90;
export const KEEP_FAILED_DAYS = 30;

export interface RetentionRow {
  id: string;
  kind: BackupKind;
  status: 'ok' | 'failed';
  created_at: string;
}

/**
 * Ids que se borran de las copias de UNA app: se quedan las 30 diarias más
 * nuevas y las manuales y «antes de cambio» de los últimos 90 días; los
 * intentos fallidos sobran a los 30 días.
 */
export function backupsToDelete(rows: RetentionRow[], now: Date): string[] {
  const day = 24 * 3600 * 1000;
  const age = (r: RetentionRow) => (now.getTime() - new Date(r.created_at).getTime()) / day;
  const doomed: string[] = [];
  const dailies = rows
    .filter((r) => r.kind === 'diaria' && r.status === 'ok')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  for (const r of dailies.slice(KEEP_DAILY)) doomed.push(r.id);
  for (const r of rows) {
    if (r.status === 'failed' && age(r) > KEEP_FAILED_DAYS) doomed.push(r.id);
    else if (r.status === 'ok' && r.kind !== 'diaria' && age(r) > KEEP_OTHER_DAYS)
      doomed.push(r.id);
  }
  return [...new Set(doomed)];
}

/** Hora de Bogotá (UTC-5 todo el año) de un instante. */
export function bogotaParts(now: Date): { hour: number; dayStartUtc: Date } {
  const local = new Date(now.getTime() - 5 * 3600 * 1000);
  const dayStartUtc = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 5, 0, 0),
  );
  return { hour: local.getUTCHours(), dayStartUtc };
}

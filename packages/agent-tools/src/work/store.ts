import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type DirectoryRow, listDirectory } from '../directory/store';
import { getTrackerBySlug } from '../trackers/store';
import type { WorkDraft } from './adapters';
import {
  type SyncedSource,
  type TeamVisibility,
  type TrackerMapping,
  type WorkDirectoryPerson,
  type WorkSettings,
  adaptWorkSettings,
  isIsoDay,
  personLabelOf,
} from './shape';
import type { WorkItem, WorkPerson, WorkSourceKind, WorkStatus } from './types';

/**
 * LECTURA Y ESCRITURA DEL REGISTRO DE TRABAJO (migración 0174).
 *
 * `db` es siempre un handle con alcance de espacio de trabajo: nada de aquí
 * filtra por `organization_id` a mano, y toda escritura la estampa el handle.
 *
 * LA ESCRITURA ES IDEMPOTENTE POR CONSTRUCCIÓN. Un ítem se identifica por su
 * identidad en la fuente (source_kind, source_system, source_ref), con índice
 * único en la base. `upsertWorkItems` lee primero lo que ya hay, cuenta lo que
 * no cambió y sólo escribe lo nuevo o lo distinto: correr la sincronización
 * dos veces, o registrar dos veces lo mismo desde el chat, deja una fila.
 */

export const WORK_ITEM_COLUMNS =
  'id, assignee_id, assignee_label, work_type, title, status, opened_at, due_on, due_at, done_at, last_activity_at, quantity, unit, team, source_kind, source_system, source_ref, recorded_by, created_at, updated_at';

/** Un ítem del registro con lo que la fila sabe además del contrato. */
export interface WorkRecord extends WorkItem {
  assigneeLabel: string | null;
  recordedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function adaptWorkRow(row: Row): WorkRecord {
  const system = str(row.source_system);
  return {
    id: String(row.id),
    assigneeId: str(row.assignee_id),
    assigneeLabel: str(row.assignee_label),
    workType: String(row.work_type),
    title: String(row.title),
    status: row.status as WorkStatus,
    openedAt: String(row.opened_at),
    dueAt: str(row.due_at) ?? str(row.due_on),
    doneAt: str(row.done_at),
    lastActivityAt: str(row.last_activity_at),
    quantity: num(row.quantity),
    unit: str(row.unit),
    team: str(row.team),
    source: {
      kind: row.source_kind as WorkSourceKind,
      system,
      ref: String(row.source_ref),
    },
    recordedBy: str(row.recorded_by),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

const instant = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** El borrador como columnas. El vencimiento va a `due_on` si es un día y a `due_at` si es un instante. */
export function draftToRow(d: WorkDraft): Row {
  const due = d.dueAt?.trim() || null;
  return {
    assignee_id: d.assigneeId,
    assignee_label: d.assigneeId ? null : (d.assigneeLabel?.slice(0, 160) ?? null),
    work_type: d.workType,
    title: d.title.slice(0, 300),
    status: d.status,
    opened_at: instant(d.openedAt) ?? new Date().toISOString(),
    due_on: due && isIsoDay(due) ? due : null,
    due_at: due && !isIsoDay(due) ? instant(due) : null,
    done_at: d.status === 'done' ? (instant(d.doneAt) ?? new Date().toISOString()) : null,
    last_activity_at: instant(d.lastActivityAt),
    quantity: typeof d.quantity === 'number' && Number.isFinite(d.quantity) ? d.quantity : null,
    unit: d.unit?.trim() ? d.unit.trim().slice(0, 30) : null,
    team: d.team?.trim() ? d.team.trim().slice(0, 80) : null,
    source_kind: d.source.kind,
    source_system: d.source.system ?? '',
    source_ref: d.source.ref.slice(0, 200),
  };
}

const COMPARED = [
  'assignee_id',
  'assignee_label',
  'work_type',
  'title',
  'status',
  'opened_at',
  'due_on',
  'due_at',
  'done_at',
  'last_activity_at',
  'quantity',
  'unit',
  'team',
] as const;

function same(a: unknown, b: unknown, column: string): boolean {
  if ((a ?? null) === null || (b ?? null) === null) return (a ?? null) === (b ?? null);
  if (column.endsWith('_at')) return Date.parse(String(a)) === Date.parse(String(b));
  if (column === 'quantity') return Number(a) === Number(b);
  if (column === 'due_on') return String(a).slice(0, 10) === String(b).slice(0, 10);
  return String(a) === String(b);
}

const keyOf = (kind: unknown, system: unknown, ref: unknown) =>
  `${String(kind)}\u0001${String(system ?? '')}\u0001${String(ref)}`;

export interface UpsertWorkResult {
  inserted: string[];
  updated: string[];
  unchanged: number;
  /** Cada borrador → su id en el registro, por clave de fuente. */
  ids: Map<string, string>;
}

/** Lee lo que ya hay para estas identidades de fuente. */
export async function existingWorkByKeys(
  db: SupabaseClient,
  drafts: readonly WorkDraft[],
): Promise<Map<string, Row>> {
  const groups = new Map<string, { kind: string; system: string; refs: string[] }>();
  for (const d of drafts) {
    const g = `${d.source.kind}\u0001${d.source.system ?? ''}`;
    const entry = groups.get(g) ?? {
      kind: d.source.kind,
      system: d.source.system ?? '',
      refs: [],
    };
    entry.refs.push(d.source.ref);
    groups.set(g, entry);
  }
  const out = new Map<string, Row>();
  for (const { kind, system, refs } of groups.values()) {
    const unique = [...new Set(refs)];
    for (let i = 0; i < unique.length; i += 100) {
      const { data, error } = await db
        .from('work_items')
        .select(WORK_ITEM_COLUMNS)
        .eq('source_kind', kind)
        .eq('source_system', system)
        .in('source_ref', unique.slice(i, i + 100));
      if (error) throw error;
      for (const r of (data ?? []) as unknown as Row[])
        out.set(keyOf(r.source_kind, r.source_system, r.source_ref), r);
    }
  }
  return out;
}

/**
 * Escribe los borradores: inserta lo nuevo, actualiza lo que cambió, cuenta lo
 * igual. Dos borradores con la misma identidad en un mismo lote: gana el
 * último. `recordedBy` sólo se pone al nacer la fila.
 */
export async function upsertWorkItems(
  db: SupabaseClient,
  drafts: readonly WorkDraft[],
  opts: { recordedBy?: string | null } = {},
): Promise<UpsertWorkResult> {
  const byKey = new Map<string, WorkDraft>();
  for (const d of drafts) byKey.set(keyOf(d.source.kind, d.source.system ?? '', d.source.ref), d);
  const list = [...byKey.values()];
  const result: UpsertWorkResult = { inserted: [], updated: [], unchanged: 0, ids: new Map() };
  if (list.length === 0) return result;

  const existing = await existingWorkByKeys(db, list);
  const now = new Date().toISOString();
  const toInsert: Row[] = [];
  const toUpdate: Array<{ id: string; row: Row }> = [];

  for (const d of list) {
    const key = keyOf(d.source.kind, d.source.system ?? '', d.source.ref);
    const row = draftToRow(d);
    const prev = existing.get(key);
    if (!prev) {
      toInsert.push({ ...row, recorded_by: opts.recordedBy ?? null });
      continue;
    }
    // Una fecha de cierre aproximada no mueve la que ya estaba.
    if (d.doneAtApprox && prev.status === 'done' && row.status === 'done' && prev.done_at)
      row.done_at = prev.done_at;
    result.ids.set(key, String(prev.id));
    if (COMPARED.every((c) => same(prev[c], row[c], c))) {
      result.unchanged += 1;
      continue;
    }
    toUpdate.push({ id: String(prev.id), row });
  }

  for (let i = 0; i < toInsert.length; i += 200) {
    const { data, error } = await db
      .from('work_items')
      .insert(toInsert.slice(i, i + 200))
      .select('id, source_kind, source_system, source_ref');
    if (error) throw error;
    for (const r of (data ?? []) as Row[]) {
      result.inserted.push(String(r.id));
      result.ids.set(keyOf(r.source_kind, r.source_system, r.source_ref), String(r.id));
    }
  }
  for (const { id, row } of toUpdate) {
    const { error } = await db
      .from('work_items')
      .update({ ...row, updated_at: now })
      .eq('id', id);
    if (error) throw error;
    result.updated.push(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export interface WorkListFilter {
  /** Sólo estas personas. `null`/ausente = sin restricción por persona. */
  assigneeIds?: readonly string[] | null;
  /** Sólo lo que no tiene responsable. */
  onlyUnassigned?: boolean;
  workType?: string | null;
  status?: WorkStatus | null;
  /** Lo cerrado desde este instante (incluido). */
  doneSince?: string | null;
  /** Lo creado o cambiado desde este instante. */
  changedSince?: string | null;
  limit?: number;
}

export async function listWorkItems(
  db: SupabaseClient,
  filter: WorkListFilter = {},
): Promise<{ items: WorkRecord[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000));
  if (filter.assigneeIds && filter.assigneeIds.length === 0 && !filter.onlyUnassigned)
    return { items: [], truncated: false };
  let q = db
    .from('work_items')
    .select(WORK_ITEM_COLUMNS)
    .order('opened_at', { ascending: false })
    .limit(limit + 1);
  if (filter.onlyUnassigned) q = q.is('assignee_id', null);
  else if (filter.assigneeIds) q = q.in('assignee_id', [...filter.assigneeIds]);
  if (filter.workType) q = q.eq('work_type', filter.workType);
  if (filter.status) q = q.eq('status', filter.status);
  if (filter.doneSince) q = q.gte('done_at', filter.doneSince);
  if (filter.changedSince) q = q.gte('updated_at', filter.changedSince);
  const { data, error } = await q;
  if (error) throw error;
  const rows = ((data ?? []) as unknown as Row[]).map(adaptWorkRow);
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function getWorkItemsByIds(
  db: SupabaseClient,
  ids: readonly string[],
): Promise<WorkRecord[]> {
  const unique = [...new Set(ids)];
  const out: WorkRecord[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await db
      .from('work_items')
      .select(WORK_ITEM_COLUMNS)
      .in('id', unique.slice(i, i + 100));
    if (error) throw error;
    out.push(...((data ?? []) as unknown as Row[]).map(adaptWorkRow));
  }
  return out;
}

/**
 * Lo que respalda las cifras de un período: lo abierto hoy, más lo cerrado
 * desde `since` (el inicio del período anterior, para comparar). Lo cancelado
 * no entra: no cuenta en ningún lado.
 */
export async function workItemsForPeriod(
  db: SupabaseClient,
  since: string,
  opts: { assigneeIds?: readonly string[] | null; cap?: number } = {},
): Promise<{ items: WorkRecord[]; truncated: boolean }> {
  const cap = opts.cap ?? 4000;
  const [open, done] = await Promise.all([
    listWorkItems(db, { status: 'open', assigneeIds: opts.assigneeIds, limit: cap }),
    listWorkItems(db, {
      status: 'done',
      doneSince: since,
      assigneeIds: opts.assigneeIds,
      limit: cap,
    }),
  ]);
  return { items: [...open.items, ...done.items], truncated: open.truncated || done.truncated };
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

const SETTINGS_COLUMNS =
  'organization_id, measured_types, sources, tracker_mappings, team_visibility, sync_state, last_synced_at, updated_at';

export async function readWorkSettings(db: SupabaseClient): Promise<WorkSettings> {
  const { data, error } = await db.from('work_settings').select(SETTINGS_COLUMNS).maybeSingle();
  if (error) throw error;
  return adaptWorkSettings((data as Row | null) ?? null);
}

export interface WorkSettingsPatch {
  measuredTypes?: string[] | null;
  sources?: SyncedSource[];
  trackerMappings?: TrackerMapping[];
  teamVisibility?: TeamVisibility;
}

/** Guarda lo que cambia. Quién puede llamarla lo decide la herramienta (sólo administradores). */
export async function saveWorkSettings(
  db: SupabaseClient,
  patch: WorkSettingsPatch,
  actorId: string | null,
): Promise<WorkSettings> {
  const row: Row = { updated_by: actorId, updated_at: new Date().toISOString() };
  if (patch.measuredTypes !== undefined)
    row.measured_types = patch.measuredTypes?.length ? patch.measuredTypes : null;
  if (patch.sources !== undefined) row.sources = patch.sources;
  if (patch.trackerMappings !== undefined) row.tracker_mappings = patch.trackerMappings;
  if (patch.teamVisibility !== undefined) row.team_visibility = patch.teamVisibility;
  const { data, error } = await db
    .from('work_settings')
    .upsert(row, { onConflict: 'organization_id' })
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return adaptWorkSettings(data as Row);
}

/** El marcapáginas de la sincronización. */
export async function saveWorkSyncState(
  db: SupabaseClient,
  state: Record<string, string>,
  at: string,
): Promise<void> {
  const { error } = await db
    .from('work_settings')
    .upsert({ sync_state: state, last_synced_at: at }, { onConflict: 'organization_id' });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Personas: equipo, cargo y días fuera
// ---------------------------------------------------------------------------

export interface WorkPersonMeta {
  userId: string;
  team: string | null;
  roleLabel: string | null;
  awayDays: string[];
}

export async function listWorkPeopleMeta(db: SupabaseClient): Promise<Map<string, WorkPersonMeta>> {
  const { data, error } = await db
    .from('work_people_meta')
    .select('user_id, team, role_label, away_days')
    .limit(2000);
  if (error) throw error;
  return new Map(
    ((data ?? []) as Row[]).map((r) => [
      String(r.user_id),
      {
        userId: String(r.user_id),
        team: str(r.team),
        roleLabel: str(r.role_label),
        awayDays: Array.isArray(r.away_days)
          ? (r.away_days as unknown[]).map((d) => String(d).slice(0, 10)).filter(isIsoDay)
          : [],
      },
    ]),
  );
}

/** ¿Quién administra? `users.role = 'org_admin'`; si no se puede saber, no. */
export async function isWorkAdmin(db: SupabaseClient, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await db.from('users').select('role').eq('id', userId).maybeSingle();
  if (error) return false;
  return (data as { role?: string } | null)?.role === 'org_admin';
}

/** El directorio en la forma que usan la resolución de nombres y las cifras. */
export async function workDirectory(db: SupabaseClient): Promise<WorkDirectoryPerson[]> {
  const rows: DirectoryRow[] = await listDirectory(db);
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role }));
}

/** Las personas del contrato (`WorkPerson`): directorio + equipo, cargo y días fuera. */
export async function listWorkPeople(db: SupabaseClient): Promise<WorkPerson[]> {
  const [people, meta] = await Promise.all([workDirectory(db), listWorkPeopleMeta(db)]);
  return people.map((p) => {
    const m = meta.get(p.id);
    return {
      id: p.id,
      name: personLabelOf(p),
      email: p.email,
      team: m?.team ?? null,
      role: m?.roleLabel ?? null,
      awayDays: m?.awayDays ?? [],
    };
  });
}

export interface WorkPersonChange {
  team?: string | null;
  roleLabel?: string | null;
  addAwayDays?: string[];
  removeAwayDays?: string[];
}

/**
 * ¿Puede `actor` hacer este cambio sobre `targetId`? Nulo = sí; si no, por qué.
 *
 * Un administrador cambia todo de todos. Cualquier persona cambia SUS días
 * fuera (son suyos: vacaciones, una incapacidad) y nada más: su equipo y su
 * cargo los pone la empresa, y los días de otro no son suyos.
 */
export function workPersonChangeRefusal(
  actor: { id: string; admin: boolean },
  targetId: string,
  change: WorkPersonChange,
): string | null {
  if (actor.admin) return null;
  if (actor.id !== targetId)
    return 'Sólo un administrador puede cambiar los datos de trabajo de otra persona. Tus propios días fuera sí los puedes anotar.';
  if (change.team !== undefined || change.roleLabel !== undefined)
    return 'El equipo y el cargo los pone un administrador. Tus días fuera sí los puedes anotar tú.';
  return null;
}

export async function updateWorkPerson(
  db: SupabaseClient,
  input: { actor: { id: string; admin: boolean }; userId: string; change: WorkPersonChange },
): Promise<WorkPersonMeta> {
  const refusal = workPersonChangeRefusal(input.actor, input.userId, input.change);
  if (refusal) throw new ForbiddenError(refusal);
  for (const d of [...(input.change.addAwayDays ?? []), ...(input.change.removeAwayDays ?? [])])
    if (!isIsoDay(d)) throw new ValidationError(`«${d}» no es una fecha AAAA-MM-DD.`);

  const { data: person, error: personError } = await db
    .from('users')
    .select('id')
    .eq('id', input.userId)
    .maybeSingle();
  if (personError) throw personError;
  if (!person) throw new ValidationError('Esa persona no es de este espacio de trabajo.');

  const current = (await listWorkPeopleMeta(db)).get(input.userId);
  const days = new Set(current?.awayDays ?? []);
  for (const d of input.change.addAwayDays ?? []) days.add(d);
  for (const d of input.change.removeAwayDays ?? []) days.delete(d);
  if (days.size > 400) throw new ValidationError('Son demasiados días fuera (máximo 400).');

  const clean = (v: string | null | undefined) => (v?.trim() ? v.trim().slice(0, 80) : null);
  const row: Row = {
    user_id: input.userId,
    away_days: [...days].sort(),
    updated_by: input.actor.id,
    updated_at: new Date().toISOString(),
  };
  row.team = input.change.team !== undefined ? clean(input.change.team) : (current?.team ?? null);
  row.role_label =
    input.change.roleLabel !== undefined
      ? clean(input.change.roleLabel)
      : (current?.roleLabel ?? null);
  const { data, error } = await db
    .from('work_people_meta')
    .upsert(row, { onConflict: 'organization_id,user_id' })
    .select('user_id, team, role_label, away_days')
    .single();
  if (error) throw error;
  const r = data as Row;
  return {
    userId: String(r.user_id),
    team: str(r.team),
    roleLabel: str(r.role_label),
    awayDays: Array.isArray(r.away_days)
      ? (r.away_days as string[]).map((d) => d.slice(0, 10))
      : [],
  };
}

// ---------------------------------------------------------------------------
// Reasignar
// ---------------------------------------------------------------------------

export interface ReassignOutcome {
  assigned: WorkRecord[];
  refused: Array<{ id: string; title: string; reason: string }>;
}

/**
 * Pasa ítems a otra persona, EN SU FUENTE cuando la tienen: un compromiso
 * cambia de responsable en Compromisos, una fila de tabla cambia su campo de
 * responsable; así la próxima sincronización no lo devuelve. Un asunto de
 * Gerencia se reasigna en Gerencia (tiene revisión y reglas propias), y una
 * aprobación no se puede pasar: sólo la decide quien la pidió.
 */
export async function reassignWorkItems(
  db: SupabaseClient,
  input: {
    items: readonly WorkRecord[];
    assignee: { id: string; label: string };
    mappings: readonly TrackerMapping[];
  },
): Promise<ReassignOutcome> {
  const out: ReassignOutcome = { assigned: [], refused: [] };
  const now = new Date().toISOString();
  for (const item of input.items) {
    const refuse = (reason: string) => out.refused.push({ id: item.id, title: item.title, reason });
    if (item.assigneeId === input.assignee.id) {
      out.assigned.push(item);
      continue;
    }
    switch (item.source.kind) {
      case 'management_case':
        refuse(
          'Es un asunto de Gerencia: cámbiale el responsable en Gerencia (management.record).',
        );
        continue;
      case 'approval':
        refuse('Es una aprobación: sólo la puede decidir quien la pidió.');
        continue;
      case 'commitment': {
        const { data, error } = await db
          .from('commitments')
          .update({ owner_user_id: input.assignee.id, updated_at: now })
          .eq('id', item.source.ref)
          .select('id')
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          refuse('El compromiso ya no existe.');
          continue;
        }
        break;
      }
      case 'tracker_row': {
        const mapping = input.mappings.find((m) => m.tracker === item.source.system);
        if (!mapping) {
          refuse('Esa tabla ya no está conectada al registro de trabajo.');
          continue;
        }
        const tracker = await getTrackerBySlug(db, mapping.tracker);
        const field = tracker?.fields.find((f) => f.key === mapping.assigneeField);
        if (!tracker || !field) {
          refuse('La tabla o su campo de responsable ya no existe.');
          continue;
        }
        if (field.type === 'select' && !field.options?.includes(input.assignee.label)) {
          refuse(
            `«${field.label}» es una lista de opciones y «${input.assignee.label}» no está en ella.`,
          );
          continue;
        }
        const { data: current, error: readError } = await db
          .from('tracker_rows')
          .select('id, values')
          .eq('id', item.source.ref)
          .eq('tracker_id', tracker.id)
          .maybeSingle();
        if (readError) throw readError;
        if (!current) {
          refuse('La fila ya no existe en la tabla.');
          continue;
        }
        const values = {
          ...((current as Row).values as Record<string, unknown>),
          [mapping.assigneeField]: input.assignee.label,
        };
        const { error } = await db
          .from('tracker_rows')
          .update({ values, updated_at: now })
          .eq('id', item.source.ref)
          .eq('tracker_id', tracker.id);
        if (error) throw error;
        break;
      }
      default:
        break;
    }
    const { data, error } = await db
      .from('work_items')
      .update({ assignee_id: input.assignee.id, assignee_label: null, updated_at: now })
      .eq('id', item.id)
      .select(WORK_ITEM_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (data) out.assigned.push(adaptWorkRow(data as unknown as Row));
    else refuse('El ítem ya no está en el registro.');
  }
  return out;
}

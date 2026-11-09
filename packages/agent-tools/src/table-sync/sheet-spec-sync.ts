import { randomUUID } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitSyncEvents } from '../apps/automations/emit';
import type { SheetData } from '../kb/spreadsheets';
import { fillLookups } from '../trackers/computed';
import { applyDuplicateRule } from '../trackers/duplicates';
import { type TrackerField, rowLabel } from '../trackers/schema';
import {
  TRACKER_COLUMNS,
  type TrackerRow,
  getTrackerBySlug,
  shapeValuesDetailed,
} from '../trackers/store';
import {
  type ExistingRow,
  type FieldChange,
  type LookupRow,
  type Lookups,
  type SheetSpec,
  diffRow,
  keyPrefix,
  parseSheetSpec,
  planGrouped,
} from './sheet-spec';

/**
 * Aplica una receta (`sheet-spec.ts`) a las tablas: padres primero, después
 * las filas con su relación. Con `dryRun` hace TODO menos escribir y devuelve
 * el mismo informe, para que la primera corrida (la puesta al día) se ensaye.
 *
 * Reglas, las del dueño: la hoja gana; nada se borra (lo que ya no está en la
 * hoja sólo se lista); las filas creadas en la app (sin clave externa) no se
 * tocan; una fila cambiada en la app después de `conflictsSince` y distinta de
 * la hoja se sobrescribe y se reporta como conflicto.
 */

const REPORT_CAP = 200;
const PAGE = 1000;

export interface GroupedReport {
  dryRun: boolean;
  ranAt: string;
  tab: string;
  rowsInSheet: number;
  children: Counts;
  parents: Counts;
  /** Filas de la app que la hoja habría cambiado y que se editaron en la app después de `since`. */
  conflicts: Array<{
    tracker: string;
    key: string;
    label: string;
    appUpdatedAt: string;
    changes: FieldChange[];
  }>;
  /** En la app con clave de la hoja, pero ya no aparecen en ella. NO se borran. */
  missing: { children: number; parents: number; sample: string[] };
  /** Valores de la hoja sin fila en una tabla relacionada (por campo). */
  unresolved: Record<string, Record<string, number>>;
  skipped: Record<string, number>;
  /** Guías de la hoja que ya existen también como filas creadas en la app (sin clave de la hoja). */
  appDuplicates: string[];
  /** Filas que la tabla rechazó (reglas del campo), con motivo. */
  rejected: Array<{ key: string; reason: string }>;
  sampleNew: string[];
  sampleChanged: Array<{ key: string; changes: FieldChange[] }>;
  /** Campo → cuántas filas cambian por él. */
  changedByField: Record<string, number>;
}

interface Counts {
  planned: number;
  insert: number;
  update: number;
  unchanged: number;
  rejected: number;
}

const counts = (planned: number): Counts => ({
  planned,
  insert: 0,
  update: 0,
  unchanged: 0,
  rejected: 0,
});

async function fetchAll<T>(
  db: SupabaseClient,
  trackerId: string,
  columns: string,
  filter?: (q: ReturnType<SupabaseClient['from']>) => unknown,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('tracker_rows')
      .select(columns)
      .eq('tracker_id', trackerId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (filter) q = filter(q as never) as typeof q;
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadLookups(db: SupabaseClient, spec: SheetSpec): Promise<Lookups> {
  const lookups: Lookups = {};
  for (const r of Object.values(spec.child.relations)) {
    if (lookups[r.tracker]) continue;
    const t = await getTrackerBySlug(db, r.tracker);
    if (!t) throw new NotFoundError(`La tabla «${r.tracker}» de la receta ya no existe.`);
    const rows = await fetchAll<{ id: string; label: string; values: Record<string, unknown> }>(
      db,
      t.id,
      'id, label, values',
    );
    lookups[r.tracker] = rows.map(
      (x): LookupRow => ({ id: x.id, label: String(x.label), values: x.values ?? {} }),
    );
  }
  return lookups;
}

/** Los valores de la fila relacionada para cada campo de relación (para llenar los lookups). */
function relatedFor(
  spec: SheetSpec,
  values: Record<string, unknown>,
  lookups: Lookups,
): Record<string, Record<string, unknown> | null> {
  const related: Record<string, Record<string, unknown> | null> = {};
  for (const [field, r] of Object.entries(spec.child.relations)) {
    const raw = values[field];
    if (typeof raw !== 'string') continue;
    try {
      const id = (JSON.parse(raw) as { id?: string }).id;
      related[field] = lookups[r.tracker]?.find((x) => x.id === id)?.values ?? null;
    } catch {
      related[field] = null;
    }
  }
  return related;
}

function ownValues(
  fields: TrackerField[],
  existing: Record<string, unknown>,
  write: Record<string, string | number>,
): Record<string, unknown> {
  const known = new Set(fields.map((f) => f.key));
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => known.has(k)));
  return { ...kept, ...write };
}

export interface GroupedRun {
  report: GroupedReport;
  /** Para el aviso: filas nuevas y cambiadas de la tabla de filas. */
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export async function runGroupedSync(
  db: SupabaseClient,
  sync: {
    tracker_id: string;
    created_by: string;
    spec: unknown;
    last_run_at?: string | null;
  },
  sheet: SheetData,
  options: { dryRun?: boolean } = {},
): Promise<GroupedRun> {
  const spec: SheetSpec = parseSheetSpec(sync.spec);
  const dryRun = options.dryRun ?? false;
  const startedAt = new Date(Date.now() - 2000).toISOString();

  const { data: childData, error: cErr } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('id', sync.tracker_id)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!childData) throw new NotFoundError('La tabla de esta sincronización ya no existe.');
  const childTracker = childData as unknown as TrackerRow;
  if (childTracker.slug !== spec.child.tracker)
    throw new ValidationError(
      `La receta llena «${spec.child.tracker}» pero la sincronización es de «${childTracker.slug}».`,
    );
  const parentTracker = spec.parent ? await getTrackerBySlug(db, spec.parent.tracker) : null;
  if (spec.parent && !parentTracker)
    throw new NotFoundError(`La tabla «${spec.parent.tracker}» de la receta ya no existe.`);

  // Una captura recortada (hoja demasiado grande) haría creer que lo que falta «ya no está en la hoja».
  if (sheet.truncated)
    throw new ValidationError(
      `La captura de la pestaña «${sheet.name}» está incompleta (la fuente trajo ${sheet.rows.length} de ${sheet.totalRows ?? 'más'} filas). No se escribió nada; conecta la fuente con sólo esa pestaña.`,
    );
  const lookups = await loadLookups(db, spec);
  const plan = planGrouped(sheet, spec, lookups);
  if (plan.missingColumns.length)
    throw new ValidationError(
      `La hoja ya no trae la columna ${plan.missingColumns.map((c) => `«${c}»`).join(', ')}. Revisa la receta.`,
    );
  // Una hoja casi vacía (se subió otro archivo, se borró la pestaña) no es una puesta al día:
  // nada se borra, pero tampoco se escribe a ciegas.
  if (!plan.children.length)
    throw new ValidationError(
      'La pestaña no trae ninguna fila reconocible con esta receta. No se escribió nada.',
    );

  const since = spec.conflictsSince ?? sync.last_run_at ?? null;
  const rowCols = 'id, external_key, label, values, updated_at';
  type Row = ExistingRow & { label: string };
  const existingOf = async (trackerId: string) => {
    const rows = await fetchAll<Row>(db, trackerId, rowCols, (q) =>
      (q as unknown as { not: (c: string, o: string, v: null) => unknown }).not(
        'external_key',
        'is',
        null,
      ),
    );
    return new Map(rows.map((r) => [r.external_key, r]));
  };

  const report: GroupedReport = {
    dryRun,
    ranAt: new Date().toISOString(),
    tab: sheet.name,
    rowsInSheet: Math.max(0, sheet.rows.length - spec.headerRows),
    children: counts(plan.children.length),
    parents: counts(plan.parents.length),
    conflicts: [],
    missing: { children: 0, parents: 0, sample: [] },
    unresolved: plan.unresolved,
    skipped: plan.skipped,
    appDuplicates: [],
    rejected: [],
    sampleNew: [],
    sampleChanged: [],
    changedByField: {},
  };
  const noteChanges = (key: string, changes: FieldChange[]) => {
    for (const c of changes) report.changedByField[c.field] = (report.changedByField[c.field] ?? 0) + 1;
    if (report.sampleChanged.length < 40) report.sampleChanged.push({ key, changes });
  };

  // ---- Padres -------------------------------------------------------------
  const parentIds = new Map<string, { id: string; label: string }>();
  type Write = { id: string; key: string; values: Record<string, string | number>; label: string; existing?: Row };
  const parentInserts: Write[] = [];
  const parentUpdates: Write[] = [];
  const existingParents = parentTracker ? await existingOf(parentTracker.id) : new Map<string, Row>();
  if (parentTracker && spec.parent) {
    for (const p of plan.parents) {
      const found = existingParents.get(p.key);
      const d = diffRow(p, found, since);
      if (d.action === 'insert') {
        try {
          const shaped = shapeValuesDetailed(parentTracker.fields, d.write, {
            lenient: true,
            applyDefaults: true,
          });
          const id = randomUUID();
          const label = rowLabel(parentTracker.fields, shaped.values);
          parentInserts.push({ id, key: p.key, values: shaped.values, label });
          parentIds.set(p.key, { id, label });
          report.parents.insert += 1;
        } catch (err) {
          report.parents.rejected += 1;
          report.rejected.push({ key: p.key, reason: err instanceof Error ? err.message : 'rechazada' });
        }
      } else {
        const label = found?.label ?? '';
        parentIds.set(p.key, { id: found?.id as string, label });
        if (d.action === 'update') {
          const merged = ownValues(parentTracker.fields, found?.values ?? {}, d.write);
          try {
            const shaped = shapeValuesDetailed(parentTracker.fields, merged, { lenient: true });
            parentUpdates.push({
              id: found?.id as string,
              key: p.key,
              values: shaped.values,
              label: rowLabel(parentTracker.fields, shaped.values),
              existing: found,
            });
            report.parents.update += 1;
            noteChanges(p.key, d.changes);
            if (d.conflict && report.conflicts.length < REPORT_CAP)
              report.conflicts.push({
                tracker: parentTracker.slug,
                key: p.key,
                label,
                appUpdatedAt: new Date(found?.updated_at as string).toISOString(),
                changes: d.changes,
              });
          } catch (err) {
            report.parents.rejected += 1;
            report.rejected.push({ key: p.key, reason: err instanceof Error ? err.message : 'rechazada' });
          }
        } else report.parents.unchanged += 1;
      }
    }
  }

  // ---- Hijas ---------------------------------------------------------------
  const existingChildren = await existingOf(childTracker.id);
  const childInserts: Write[] = [];
  const childUpdates: Write[] = [];
  const planKeys = new Set(plan.children.map((c) => c.key));
  for (const c of plan.children) {
    const parent = parentIds.get(c.parentKey);
    if (spec.child.parentField && parent)
      c.values[spec.child.parentField] = JSON.stringify({ id: parent.id, label: parent.label });
    const found = existingChildren.get(c.key);
    const d = diffRow(c, found, since);
    if (d.action === 'unchanged') {
      report.children.unchanged += 1;
      continue;
    }
    try {
      if (d.action === 'insert') {
        const filled = fillLookups(childTracker.fields, c.values, relatedFor(spec, c.values, lookups));
        const shaped = shapeValuesDetailed(childTracker.fields, filled, { lenient: true, applyDefaults: true });
        const label = rowLabel(childTracker.fields, shaped.values);
        childInserts.push({ id: randomUUID(), key: c.key, values: shaped.values, label });
        report.children.insert += 1;
        if (report.sampleNew.length < 40) report.sampleNew.push(`${c.values.guia ?? c.key} · ${c.parentKey}`);
      } else {
        const merged = ownValues(childTracker.fields, found?.values ?? {}, d.write);
        const changedVia = new Set(Object.keys(d.write).filter((k) => k in spec.child.relations));
        const filled = fillLookups(childTracker.fields, merged as Record<string, string | number>, relatedFor(spec, merged, lookups), { changedVia });
        const shaped = shapeValuesDetailed(childTracker.fields, filled, { lenient: true });
        childUpdates.push({
          id: found?.id as string,
          key: c.key,
          values: shaped.values,
          label: rowLabel(childTracker.fields, shaped.values),
          existing: found,
        });
        report.children.update += 1;
        noteChanges(c.key, d.changes);
        if (d.conflict && report.conflicts.length < REPORT_CAP)
          report.conflicts.push({
            tracker: childTracker.slug,
            key: c.key,
            label: found?.label ?? '',
            appUpdatedAt: new Date(found?.updated_at as string).toISOString(),
            changes: d.changes,
          });
      }
    } catch (err) {
      report.children.rejected += 1;
      if (report.rejected.length < REPORT_CAP)
        report.rejected.push({ key: c.key, reason: err instanceof Error ? err.message : 'rechazada' });
    }
  }

  // ---- Lo que ya no está en la hoja (no se borra) -----------------------------
  const cPrefix = keyPrefix(spec.child.key);
  const missingChildren = [...existingChildren.keys()].filter((k) => k.startsWith(cPrefix) && !planKeys.has(k));
  report.missing.children = missingChildren.length;
  if (spec.parent) {
    const pKeys = new Set(plan.parents.map((p) => p.key));
    const pPrefix = keyPrefix(spec.parent.key);
    const missingParents = [...existingParents.keys()].filter((k) => k.startsWith(pPrefix) && !pKeys.has(k));
    report.missing.parents = missingParents.length;
    report.missing.sample.push(...missingParents.slice(0, 20));
  }
  report.missing.sample.unshift(...missingChildren.slice(0, 40));

  // ---- Filas creadas en la app con la misma guía ------------------------------
  const guideField = Object.entries(spec.child.fields).find(([, s]) => 'var' in s && s.var === 'guia')?.[0];
  if (guideField) {
    const appRows = await fetchAll<{ id: string; values: Record<string, unknown> }>(
      db,
      childTracker.id,
      'id, values',
      (q) => (q as unknown as { is: (c: string, v: null) => unknown }).is('external_key', null),
    );
    const sheetGuides = new Set(plan.children.map((c) => String(c.values[guideField])));
    report.appDuplicates = [
      ...new Set(appRows.map((r) => String(r.values[guideField] ?? '')).filter((g) => g && sheetGuides.has(g))),
    ].slice(0, REPORT_CAP);
  }

  if (dryRun)
    return {
      report,
      inserted: report.children.insert,
      updated: report.children.update,
      unchanged: report.children.unchanged,
      skipped: report.children.rejected + Object.values(plan.skipped).reduce((a, b) => a + b, 0),
    };

  // ---- Escribir ----------------------------------------------------------------
  const writeSet = async (
    tracker: { id: string },
    inserts: Write[],
    updates: Write[],
  ) => {
    const now = new Date().toISOString();
    for (let i = 0; i < inserts.length; i += 200) {
      const chunk = inserts.slice(i, i + 200).map((w) => ({
        id: w.id,
        tracker_id: tracker.id,
        label: w.label,
        values: w.values,
        external_key: w.key,
        created_by: sync.created_by,
      }));
      const { error } = await db.from('tracker_rows').insert(chunk);
      if (error) {
        // Otra corrida las insertó entre la lectura y ésta: fila por fila, sin error por la repetida.
        if ((error as { code?: string }).code !== '23505') throw error;
        for (const row of chunk) {
          const one = await db.from('tracker_rows').insert(row);
          if (one.error && (one.error as { code?: string }).code !== '23505') throw one.error;
        }
      }
    }
    for (const w of updates) {
      const { error } = await db
        .from('tracker_rows')
        .update({ label: w.label, values: w.values, updated_at: now })
        .eq('id', w.id)
        .eq('tracker_id', tracker.id);
      if (error) throw error;
    }
  };
  if (parentTracker) {
    await writeSet(parentTracker, parentInserts, parentUpdates);
  }
  await writeSet(childTracker, childInserts, childUpdates);
  if (childInserts.length || childUpdates.length) await applyDuplicateRule(db, childTracker.id);
  // Primero los padres, luego las filas: las reglas de totales del padre ya ven los cambios de las hijas.
  if (parentTracker && (parentInserts.length || parentUpdates.length))
    await emitSyncEvents(db, parentTracker, startedAt, { limit: 5000 });
  if (childInserts.length || childUpdates.length)
    await emitSyncEvents(db, childTracker, startedAt, { limit: 5000 });

  return {
    report,
    inserted: childInserts.length,
    updated: childUpdates.length,
    unchanged: report.children.unchanged,
    skipped: report.children.rejected + Object.values(plan.skipped).reduce((a, b) => a + b, 0),
  };
}

/** El texto corto de un informe, para el chat y el aviso. */
export function reportMarkdown(r: GroupedReport): string {
  const line = (label: string, c: Counts) =>
    `- ${label}: ${c.insert} nuevas, ${c.update} cambiadas, ${c.unchanged} sin cambios${c.rejected ? `, ${c.rejected} rechazadas` : ''} (de ${c.planned} en la hoja).`;
  const out = [
    `${r.dryRun ? '**Ensayo (no se escribió nada)**' : '**Sincronización aplicada**'} · pestaña «${r.tab}», ${r.rowsInSheet} filas.`,
    line('Guías', r.children),
    line('Manifiestos', r.parents),
    `- Conflictos (cambiadas en la app y distintas de la hoja; gana la hoja): ${r.conflicts.length}.`,
    `- Están en la app y YA NO en la hoja (no se borran): ${r.missing.children} guías, ${r.missing.parents} manifiestos.`,
  ];
  if (r.appDuplicates.length) out.push(`- Guías de la hoja que también existen creadas en la app: ${r.appDuplicates.length}.`);
  const unresolved = Object.entries(r.unresolved).flatMap(([f, m]) =>
    Object.entries(m).map(([v, n]) => `«${v}» (${f}) ×${n}`),
  );
  if (unresolved.length) out.push(`- Valores de la hoja sin fila en la tabla relacionada: ${unresolved.slice(0, 15).join('; ')}.`);
  const skipped = Object.entries(r.skipped);
  if (skipped.length) out.push(`- Saltadas: ${skipped.map(([k, n]) => `${k} ${n}`).join('; ')}.`);
  if (r.rejected.length) out.push(`- Rechazadas por reglas: ${r.rejected.slice(0, 5).map((x) => `${x.key}: ${x.reason}`).join(' | ')}.`);
  const fields = Object.entries(r.changedByField);
  if (fields.length) out.push(`- Campos que cambian: ${fields.map(([f, n]) => `${f} ×${n}`).join(', ')}.`);
  return out.join('\n');
}

export type { SheetSpec };

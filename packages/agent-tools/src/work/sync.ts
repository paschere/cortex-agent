import type { SupabaseClient } from '@supabase/supabase-js';
import { pendingToolLabel } from '../approvals/summary';
import { getTrackerBySlug } from '../trackers/store';
import {
  type CommitmentLite,
  type ManagementCaseLite,
  type PendingActionLite,
  type ProposedActionLite,
  type TrackerRowLite,
  type WorkDraft,
  commitmentToWork,
  managementCaseToWork,
  pendingActionToWork,
  proposedActionToWork,
  trackerRowToWork,
} from './adapters';
import { type TrackerMapping, isMeasured, mappingHash } from './shape';
import { readWorkSettings, saveWorkSyncState, upsertWorkItems, workDirectory } from './store';

/**
 * LA SINCRONIZACIÓN: DE LO QUE CORTEX YA TIENE AL REGISTRO DE TRABAJO.
 *
 * `syncWork(db, organizationId)` lee, de cada fuente encendida en los ajustes,
 * lo que cambió desde la última vez (un marcapáginas por fuente en
 * `work_settings.sync_state`, con cinco minutos de traslape para no perder lo
 * que se escribió en el mismo instante), lo pasa por su mapeador puro
 * (adapters.ts) y lo escribe con `upsertWorkItems`, que es idempotente. Correr
 * dos veces seguidas no cambia nada; correr después de un fallo retoma.
 *
 * Una tabla cuyo mapeo cambió (o que se conecta por primera vez) se relee
 * entera, y lo abierto de esa tabla que ya no existe pasa a «ya no aplica».
 *
 * Lo que no se mide (`measuredTypes`) no se guarda. Un responsable que ya no
 * está en el directorio queda sin asignar.
 *
 * La corre el trabajo diario `work/sync.workspace` (apps/web/inngest/functions/
 * work-sync.ts) y, si el registro lleva más de unas horas sin refrescarse,
 * `work.query` antes de contestar.
 */

const PAGE = 500;
const MAX_PAGES = 20;
const OVERLAP_MS = 5 * 60_000;
/** Las aprobaciones no tienen `updated_at`: se relee una ventana fija. */
const APPROVAL_WINDOW_DAYS = 45;

export interface WorkSyncSourceResult {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  cancelled?: number;
}

export interface WorkSyncResult {
  organizationId: string;
  at: string;
  sources: Record<string, WorkSyncSourceResult>;
  warnings: string[];
}

type Row = Record<string, unknown>;

/** Lee por páginas lo cambiado desde `since`, en orden de `updated_at`. */
async function readChanged(
  db: SupabaseClient,
  table: string,
  columns: string,
  since: string | null,
  trackerId?: string,
): Promise<{ rows: Row[]; last: string | null; capped: boolean }> {
  const rows: Row[] = [];
  let cursor = since;
  let last: string | null = since;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = db.from(table).select(columns).order('updated_at', { ascending: true }).limit(PAGE);
    if (cursor) q = q.gte('updated_at', cursor);
    if (trackerId) q = q.eq('tracker_id', trackerId);
    const { data, error } = await q;
    if (error) throw error;
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    const tail = batch.at(-1)?.updated_at;
    if (typeof tail === 'string') last = tail;
    if (batch.length < PAGE || !tail || tail === cursor) return { rows, last, capped: false };
    cursor = String(tail);
  }
  return { rows, last, capped: true };
}

const minus = (iso: string | null | undefined, ms: number) =>
  iso ? new Date(Date.parse(iso) - ms).toISOString() : null;

export async function syncWork(
  db: SupabaseClient,
  organizationId: string,
  opts: { full?: boolean; now?: Date; onlyTracker?: string } = {},
): Promise<WorkSyncResult> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const settings = await readWorkSettings(db);
  const state: Record<string, string> = { ...settings.syncState };
  const result: WorkSyncResult = { organizationId, at, sources: {}, warnings: [] };
  const people = await workDirectory(db);
  const known = new Set(people.map((p) => p.id));
  const sources = new Set(settings.sources);
  const full = Boolean(opts.full);

  async function write(name: string, read: number, drafts: Array<WorkDraft | null>) {
    let skipped = read - drafts.filter(Boolean).length;
    const kept: WorkDraft[] = [];
    for (const d of drafts) {
      if (!d) continue;
      if (!isMeasured(d.workType, settings.measuredTypes)) {
        skipped += 1;
        continue;
      }
      if (d.assigneeId && !known.has(d.assigneeId)) d.assigneeId = null;
      kept.push(d);
    }
    const r = await upsertWorkItems(db, kept);
    result.sources[name] = {
      read,
      inserted: r.inserted.length,
      updated: r.updated.length,
      unchanged: r.unchanged,
      skipped,
    };
  }

  async function guarded(name: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push(`${name}: no se pudo leer (${message.slice(0, 160)}).`);
    }
  }

  if (!opts.onlyTracker && sources.has('management_case')) {
    await guarded('Gerencia', async () => {
      const since = full ? null : minus(state.management_case, OVERLAP_MS);
      const { rows, last } = await readChanged(
        db,
        'management_cases',
        'id, data, created_at, updated_at',
        since,
      );
      await write(
        'management_case',
        rows.length,
        rows.map((r) => managementCaseToWork(r as unknown as ManagementCaseLite)),
      );
      if (last) state.management_case = last;
    });
  }

  if (!opts.onlyTracker && sources.has('commitment')) {
    await guarded('Compromisos', async () => {
      const since = full ? null : minus(state.commitment, OVERLAP_MS);
      const { rows, last } = await readChanged(
        db,
        'commitments',
        'id, title, kind, due_on, state, met_at, dropped_at, owner_user_id, review_state, created_at, updated_at',
        since,
      );
      await write(
        'commitment',
        rows.length,
        rows.map((r) => commitmentToWork(r as unknown as CommitmentLite)),
      );
      if (last) state.commitment = last;
    });
  }

  if (!opts.onlyTracker && sources.has('approval')) {
    await guarded('Aprobaciones', async () => {
      const windowStart = new Date(now.getTime() - APPROVAL_WINDOW_DAYS * 86_400_000).toISOString();
      const { data, error } = await db
        .from('mcp_pending_actions')
        .select('id, user_id, tool_id, created_at, expires_at, decision, decided_at')
        .gte('created_at', windowStart)
        .order('created_at', { ascending: true })
        .limit(3000);
      if (error) throw error;
      const pending = (data ?? []) as unknown as PendingActionLite[];
      const since = full ? null : minus(state.approval_actions, OVERLAP_MS);
      const { rows, last } = await readChanged(
        db,
        'actions',
        'id, user_id, tool_id, state, created_at, updated_at, expires_at, decided_at',
        since,
      );
      await write('approval', pending.length + rows.length, [
        ...pending.map((a) => pendingActionToWork(a, pendingToolLabel(a.tool_id), now)),
        ...rows.map((a) =>
          proposedActionToWork(
            a as unknown as ProposedActionLite,
            pendingToolLabel(String(a.tool_id)),
            now,
          ),
        ),
      ]);
      if (last) state.approval_actions = last;
    });
  }

  if (sources.has('tracker_row')) {
    for (const mapping of settings.trackerMappings) {
      if (opts.onlyTracker && mapping.tracker !== opts.onlyTracker) continue;
      await guarded(`Tabla ${mapping.tracker}`, () =>
        syncTracker(db, mapping, { full, state, people, write, result }),
      );
    }
  }

  await saveWorkSyncState(db, state, at);
  return result;
}

async function syncTracker(
  db: SupabaseClient,
  mapping: TrackerMapping,
  ctx: {
    full: boolean;
    state: Record<string, string>;
    people: Awaited<ReturnType<typeof workDirectory>>;
    write: (name: string, read: number, drafts: Array<WorkDraft | null>) => Promise<void>;
    result: WorkSyncResult;
  },
): Promise<void> {
  const tracker = await getTrackerBySlug(db, mapping.tracker);
  if (!tracker) {
    ctx.result.warnings.push(
      `La tabla «${mapping.tracker}» ya no existe; su trabajo no se actualiza.`,
    );
    return;
  }
  const cursorKey = `tracker:${mapping.tracker}`;
  const hashKey = `tracker_hash:${mapping.tracker}`;
  const hash = mappingHash(mapping);
  const whole = ctx.full || ctx.state[hashKey] !== hash || !ctx.state[cursorKey];
  const since = whole ? null : minus(ctx.state[cursorKey], OVERLAP_MS);
  const { rows, last, capped } = await readChanged(
    db,
    'tracker_rows',
    'id, label, values, created_at, updated_at',
    since,
    tracker.id,
  );
  const name = `tracker_row:${mapping.tracker}`;
  await ctx.write(
    name,
    rows.length,
    rows.map((r) => trackerRowToWork(mapping, r as unknown as TrackerRowLite, ctx.people)),
  );

  // Releída entera: lo abierto de filas que ya no existen, ya no aplica. Si la
  // lectura se cortó por tamaño, no se concluye nada de lo que no se leyó.
  if (whole && capped)
    ctx.result.warnings.push(
      `La tabla «${mapping.tracker}» es muy grande: entró una parte y el resto entra en las próximas corridas; lo borrado de ella no se descuenta en ésta.`,
    );
  if (whole && !capped) {
    const seen = new Set(rows.map((r) => String(r.id)));
    const { data, error } = await db
      .from('work_items')
      .select('id, source_ref')
      .eq('source_kind', 'tracker_row')
      .eq('source_system', mapping.tracker)
      .eq('status', 'open')
      .limit(10_000);
    if (error) throw error;
    const gone = ((data ?? []) as Row[])
      .filter((r) => !seen.has(String(r.source_ref)))
      .map((r) => String(r.id));
    for (let i = 0; i < gone.length; i += 100) {
      const { error: updateError } = await db
        .from('work_items')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .in('id', gone.slice(i, i + 100));
      if (updateError) throw updateError;
    }
    const entry = ctx.result.sources[name];
    if (entry) entry.cancelled = gone.length;
  }
  if (last) ctx.state[cursorKey] = last;
  ctx.state[hashKey] = hash;
}

/** ¿Hace cuánto no se refresca? Para que `work.query` decida si sincroniza antes. */
export function workSyncIsStale(lastSyncedAt: string | null, now: Date, maxAgeMs: number): boolean {
  if (!lastSyncedAt) return true;
  const t = Date.parse(lastSyncedAt);
  return Number.isNaN(t) || now.getTime() - t > maxAgeMs;
}

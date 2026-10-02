import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type DriveSyncRow,
  type ProcessItem,
  type RoutineRow,
  type TableSyncRow,
  shapeProcesses,
} from './processes';
import { type SetupStep, buildSetupSteps } from './setup';

/**
 * Las lecturas del Inicio en autoservicio: los cinco pasos y «tus procesos».
 *
 * Todo con el cliente de la empresa. Cada lectura se traga su propio error y
 * devuelve `null` o una lista vacía: el Inicio es la primera pantalla y no se
 * cae porque una tabla no respondió.
 */

type CountResult = PromiseLike<{ count: number | null; error: unknown }>;

async function count(query: CountResult): Promise<number | null> {
  try {
    const result = await query;
    return result.error ? null : (result.count ?? null);
  } catch {
    return null;
  }
}

async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const result = await query;
    return result.error ? [] : ((result.data ?? []) as T[]);
  } catch {
    return [];
  }
}

const sum = (...values: (number | null)[]) =>
  values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0);

export async function readSetupSteps(db: SupabaseClient, userId: string): Promise<SetupStep[]> {
  const head = { count: 'exact' as const, head: true };
  const [facts, google, trackers, knowledge, feeds, drive, syncs, routines, views, people] =
    await Promise.all([
      count(db.from('company_facts').select('id', head)),
      count(
        db.from('integrations').select('id', head).eq('user_id', userId).eq('provider', 'google'),
      ),
      count(db.from('trackers').select('id', head)),
      count(db.from('kb_documents').select('id', head)),
      count(db.from('feed_sources').select('id', head)),
      count(db.from('drive_folder_syncs').select('id', head)),
      count(db.from('tracker_syncs').select('id', head)),
      count(
        db
          .from('scheduled_jobs')
          .select('id', head)
          .eq('status', 'active')
          .or(`user_id.eq.${userId},is_global.eq.true`),
      ),
      count(db.from('custom_views').select('id', head)),
      count(db.from('users').select('id', head)),
    ]);
  return buildSetupSteps({
    facts,
    google: google === null ? null : google > 0,
    data: sum(trackers, knowledge, feeds),
    processes: sum(drive, syncs, routines),
    views,
    people,
  });
}

export async function readProcesses(db: SupabaseClient, userId: string): Promise<ProcessItem[]> {
  const [drive, syncs, jobs] = await Promise.all([
    rows<DriveSyncRow>(
      db
        .from('drive_folder_syncs')
        .select(
          'id, folder_name, interval_minutes, enabled, last_run_at, last_status, last_error, trackers(name)',
        )
        .order('created_at', { ascending: false })
        .limit(8),
    ),
    rows<TableSyncRow>(
      db
        .from('tracker_syncs')
        .select(
          'id, interval_minutes, enabled, last_run_at, last_status, last_error, trackers(name), feed_sources(name)',
        )
        .order('created_at', { ascending: false })
        .limit(8),
    ),
    rows<{ id: string; name: string; status: string; next_run_at: string | null }>(
      db
        .from('scheduled_jobs')
        .select('id, name, status, next_run_at')
        .in('status', ['active', 'paused'])
        .or(`user_id.eq.${userId},is_global.eq.true`)
        .order('created_at', { ascending: false })
        .limit(8),
    ),
  ]);

  // La última corrida de cada rutina, en UNA lectura: las recientes de todas,
  // y la primera que aparezca de cada una es la última.
  const runs = jobs.length
    ? await rows<{ job_id: string; status: string; started_at: string; error: string | null }>(
        db
          .from('scheduled_job_runs')
          .select('job_id, status, started_at, error')
          .in(
            'job_id',
            jobs.map((j) => j.id),
          )
          .order('started_at', { ascending: false })
          .limit(60),
      )
    : [];
  const lastRun = new Map<string, RoutineRow['last_run']>();
  for (const r of runs) {
    if (!lastRun.has(r.job_id)) {
      lastRun.set(r.job_id, { status: r.status, started_at: r.started_at, error: r.error });
    }
  }
  const routines: RoutineRow[] = jobs.map((j) => ({ ...j, last_run: lastRun.get(j.id) ?? null }));

  return shapeProcesses({ drive, syncs, routines });
}

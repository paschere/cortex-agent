/**
 * «TUS PROCESOS»: lo que Cortex tiene andando solo, en una sola lista.
 *
 * Hoy viven en tres tablas que nadie ve juntas — una carpeta de Drive que
 * llena una tabla, una fuente que sincroniza otra, una rutina con hora — y
 * cada una tiene su propia manera de decir que falló. Aquí se aplanan a lo
 * único que importa en el Inicio: cómo se llama, qué hace, cuándo corrió y
 * si está funcionando.
 */

export type ProcessState = 'ok' | 'error' | 'paused' | 'waiting';

export type ProcessItem = {
  id: string;
  kind: 'drive' | 'sync' | 'routine';
  name: string;
  detail: string;
  state: ProcessState;
  /** Última vez que corrió (ISO), si corrió. */
  lastRunAt: string | null;
  /** Por qué falló, en palabras de la fuente. */
  error: string | null;
  href: string;
};

export type DriveSyncRow = {
  id: string;
  folder_name: string;
  interval_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  trackers: { name: string } | { name: string }[] | null;
};

export type TableSyncRow = {
  id: string;
  interval_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  trackers: { name: string } | { name: string }[] | null;
  feed_sources: { name: string | null } | { name: string | null }[] | null;
};

export type RoutineRow = {
  id: string;
  name: string;
  status: string;
  next_run_at: string | null;
  last_run: { status: string; started_at: string; error: string | null } | null;
};

const one = <T>(rel: T | T[] | null): T | null => (Array.isArray(rel) ? (rel[0] ?? null) : rel);

function every(minutes: number) {
  if (minutes < 60) return `cada ${minutes} minutos`;
  if (minutes === 60) return 'cada hora';
  if (minutes % 60 === 0 && minutes < 1440) return `cada ${minutes / 60} horas`;
  return 'una vez al día';
}

function stateOf(enabled: boolean, status: string | null): ProcessState {
  if (!enabled) return 'paused';
  if (status === 'error') return 'error';
  if (status === 'ok') return 'ok';
  return 'waiting';
}

export function shapeProcesses(input: {
  drive: DriveSyncRow[];
  syncs: TableSyncRow[];
  routines: RoutineRow[];
}): ProcessItem[] {
  const items: ProcessItem[] = [
    ...input.drive.map((d): ProcessItem => {
      const table = one(d.trackers)?.name ?? 'una tabla';
      return {
        id: `drive:${d.id}`,
        kind: 'drive',
        name: `${d.folder_name.trim() || 'Carpeta de Drive'} → ${table}`,
        detail: `Lee los archivos nuevos ${every(d.interval_minutes)}`,
        state: stateOf(d.enabled, d.last_status),
        lastRunAt: d.last_run_at,
        error: d.last_error,
        href: '/chat?panel=trackers',
      };
    }),
    ...input.syncs.map((s): ProcessItem => {
      const table = one(s.trackers)?.name ?? 'una tabla';
      const source = one(s.feed_sources)?.name?.trim() || 'Una fuente';
      return {
        id: `sync:${s.id}`,
        kind: 'sync',
        name: `${source} → ${table}`,
        detail: `Trae filas nuevas y cambios ${every(s.interval_minutes)}`,
        state: stateOf(s.enabled, s.last_status),
        lastRunAt: s.last_run_at,
        error: s.last_error,
        href: '/chat?panel=trackers',
      };
    }),
    ...input.routines.map((r): ProcessItem => {
      const last = r.last_run;
      const state: ProcessState =
        r.status !== 'active'
          ? 'paused'
          : last?.status === 'error'
            ? 'error'
            : last
              ? 'ok'
              : 'waiting';
      return {
        id: `routine:${r.id}`,
        kind: 'routine',
        name: r.name,
        detail: 'Rutina con hora fija',
        state,
        lastRunAt: last?.started_at ?? null,
        error: last?.status === 'error' ? last.error : null,
        href: '/schedules',
      };
    }),
  ];
  // Lo que falló primero: es lo único de la lista que pide algo.
  const rank: Record<ProcessState, number> = { error: 0, waiting: 1, ok: 2, paused: 3 };
  return items.sort(
    (a, b) => rank[a.state] - rank[b.state] || (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''),
  );
}

export const PROCESS_STATE_LABEL: Record<ProcessState, string> = {
  ok: 'Funcionando',
  error: 'Necesita atención',
  paused: 'En pausa',
  waiting: 'Por arrancar',
};

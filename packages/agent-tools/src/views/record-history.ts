import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import type { ViewSource } from './compute';
import { type RecordHistoryRaw, findDetailTarget } from './record';
import type { TimelinePart, ViewSpec } from './spec';

/**
 * LO QUE SE LEE DE LA BASE PARA LA LÍNEA DE TIEMPO DE UN REGISTRO.
 *
 * Ocurre DESPUÉS de leer las fuentes con el scope del rol (`loadViewSources`):
 * `findDetailTarget` busca la fila entre las filas que el rol ya puede ver, y
 * sólo si la encuentra se lee su historia. Una fila que el rol no ve no
 * dispara ni una consulta más.
 *
 * Tres fuentes, todas atadas al registro:
 *   - su creación: `tracker_rows.created_by` / `created_by_app_user`, que ya
 *     viaja en la fila leída;
 *   - `custom_view_events` por `tracker_row_id`: ediciones, movimientos de
 *     tarjeta y botones (de CUALQUIER vista o pantalla que tocara esa fila:
 *     es la historia del registro, no de una pantalla), con el antes → después;
 *   - `custom_app_automation_runs` por `trigger_ref` (`<suceso>:<fila>`), sólo
 *     dentro de una app y sólo para un miembro de Cortex: un cliente externo o
 *     el enlace público no ven qué automatizaciones tiene la empresa.
 *
 * QUIÉN, SEGÚN QUIÉN MIRA. Un miembro ve nombres. Un usuario externo de la app
 * o el enlace público ven «Tú» para lo suyo y «El equipo» para el personal
 * interno: ningún nombre ni correo interno sale hacia afuera.
 */

export type RecordViewer =
  | { kind: 'member'; id: string | null }
  | { kind: 'app_user'; id: string }
  | { kind: 'public' };

const EVENT_LIMIT = 200;
const RUN_LIMIT = 20;

interface EventRow {
  id: string;
  kind: 'edit' | 'move' | 'action';
  action_id: string | null;
  changes: Record<string, { from?: unknown; to?: unknown }> | null;
  actor: string | null;
  actor_kind: 'member' | 'app_user' | null;
  created_at: string;
}

async function memberNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { data } = await db.from('users').select('id, name, email').in('id', ids);
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string | null; email: string | null }>).map((u) => [
      u.id,
      u.name?.trim() || u.email?.split('@')[0] || 'Alguien',
    ]),
  );
}

async function appUserNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { data } = await db.from('custom_app_users').select('id, name').in('id', ids);
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string | null }>).map((u) => [
      u.id,
      u.name?.trim() || 'Un usuario',
    ]),
  );
}

/** Cómo se nombra a quien hizo algo, según quien lo está mirando. */
export function actorLabel(
  who: { id: string | null; kind: 'member' | 'app_user' } | null,
  viewer: RecordViewer,
  names: { members: Map<string, string>; appUsers: Map<string, string> },
): string | null {
  if (!who || !who.id) return viewer.kind === 'public' ? null : 'Alguien con el enlace';
  if (viewer.kind !== 'public' && viewer.id === who.id && viewer.kind === who.kind) return 'Tú';
  if (viewer.kind === 'member')
    return (who.kind === 'member' ? names.members : names.appUsers).get(who.id) ?? 'Alguien';
  return who.kind === 'member' ? 'El equipo' : 'Otra persona';
}

export async function loadRecordHistory(
  db: SupabaseClient,
  input: {
    rowId: string;
    row: { created_at: string; created_by?: string | null; created_by_app_user?: string | null };
    show: ReadonlySet<TimelinePart>;
    viewer: RecordViewer;
    /** Dentro de una aplicación: para las corridas de sus automatizaciones. */
    appId?: string | null;
  },
): Promise<RecordHistoryRaw> {
  const { rowId, row, viewer } = input;
  const wantsRuns =
    input.show.has('automations') && viewer.kind === 'member' && Boolean(input.appId);
  const [{ data: eventData }, runData] = await Promise.all([
    db
      .from('custom_view_events')
      .select('id, kind, action_id, changes, actor, actor_kind, created_at')
      .eq('tracker_row_id', rowId)
      .order('created_at', { ascending: false })
      .limit(EVENT_LIMIT),
    wantsRuns
      ? db
          .from('custom_app_automation_runs')
          .select('id, automation_id, status, finished_at, created_at')
          .eq('app_id', input.appId as string)
          .like('trigger_ref', `%:${rowId}`)
          .in('status', ['succeeded', 'failed'])
          .order('created_at', { ascending: false })
          .limit(RUN_LIMIT)
          .then((r) => r.data)
      : Promise.resolve(null),
  ]);
  const events = (eventData ?? []) as unknown as EventRow[];
  const runs = (runData ?? []) as Array<{
    id: string;
    automation_id: string;
    status: string;
    finished_at: string | null;
    created_at: string;
  }>;

  const memberIds = new Set<string>();
  const appUserIds = new Set<string>();
  const note = (id: string | null | undefined, kind: 'member' | 'app_user') => {
    if (id) (kind === 'member' ? memberIds : appUserIds).add(id);
  };
  note(row.created_by, 'member');
  note(row.created_by_app_user, 'app_user');
  for (const e of events) note(e.actor, e.actor_kind === 'app_user' ? 'app_user' : 'member');

  const automationIds = [...new Set(runs.map((r) => r.automation_id))];
  const [members, appUsers, automationNames] = await Promise.all([
    viewer.kind === 'member' ? memberNames(db, [...memberIds]) : Promise.resolve(new Map()),
    viewer.kind === 'member' ? appUserNames(db, [...appUserIds]) : Promise.resolve(new Map()),
    automationIds.length
      ? db
          .from('custom_app_automations')
          .select('id, name')
          .in('id', automationIds)
          .then(
            (r) =>
              new Map(
                ((r.data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]),
              ),
          )
      : Promise.resolve(new Map<string, string>()),
  ]);
  const names = { members, appUsers };

  const createdBy = row.created_by_app_user
    ? { id: row.created_by_app_user, kind: 'app_user' as const }
    : row.created_by
      ? { id: row.created_by, kind: 'member' as const }
      : null;

  return {
    created: { at: row.created_at, by: createdBy ? actorLabel(createdBy, viewer, names) : null },
    events: events.map((e) => ({
      id: e.id,
      at: e.created_at,
      kind: e.kind,
      actionId: e.action_id,
      changes: e.changes ?? {},
      by: actorLabel(
        { id: e.actor, kind: e.actor_kind === 'app_user' ? 'app_user' : 'member' },
        viewer,
        names,
      ),
    })),
    runs: runs.map((r) => ({
      id: r.id,
      at: r.finished_at ?? r.created_at,
      automation: automationNames.get(r.automation_id) ?? 'Automatización',
      ok: r.status === 'succeeded',
    })),
  };
}

/**
 * Todo lo que `computeView` necesita para abrir `?fila=`: qué detalle, y la
 * historia del registro. Null si no hay fila pedida. Si el rol no ve la fila
 * (o no existe), vuelve con `history: null` y el detalle dice «no la encuentro».
 */
export async function loadRecordContext(
  db: SupabaseClient,
  spec: Pick<ViewSpec, 'blocks'>,
  sources: Map<string, ViewSource>,
  request: { rowId: string | null | undefined; blockId?: string | null },
  options: { viewer: RecordViewer; appId?: string | null; now?: Date } = {
    viewer: { kind: 'public' },
  },
): Promise<{ rowId: string; blockId: string | null; history: RecordHistoryRaw | null } | null> {
  const rowId = request.rowId?.trim();
  if (!rowId || !/^[0-9a-f-]{36}$/i.test(rowId)) return null;
  const today = bogotaToday(options.now);
  const target = findDetailTarget(spec, sources, rowId, request.blockId, today);
  if (!target) return { rowId, blockId: null, history: null };
  const cfg = target.block.timeline;
  if (cfg === false) return { rowId, blockId: target.block.id, history: null };
  const show = new Set<TimelinePart>(
    cfg?.show ?? ['created', 'changes', 'approvals', 'automations', 'files'],
  );
  const history = await loadRecordHistory(db, {
    rowId,
    row: target.row,
    show,
    viewer: options.viewer,
    appId: options.appId,
  }).catch(() => null);
  return { rowId, blockId: target.block.id, history };
}

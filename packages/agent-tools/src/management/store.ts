import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday, deriveState } from '../commitments/shape';
import { lastClosedPeriod } from '../goals/shape';
import {
  type ManagementCase,
  type ManagementEvent,
  type ManagementProfile,
  type ManagementSignal,
  defaultManagementProfile,
  managementCaseSchema,
  managementProfileSchema,
  validateManagementTransition,
} from './shape';

export class ManagementError extends Error {}
const columns = 'id,data,revision,created_by,updated_by,created_at,updated_at';
export async function readManagement(db: SupabaseClient) {
  const [cases, profile, people] = await Promise.all([
    db
      .from('management_cases')
      .select(columns)
      .order('updated_at', { ascending: false })
      .limit(501),
    db.from('management_profiles').select('data,revision,updated_at').maybeSingle(),
    db.from('users').select('id,name,email').order('name').limit(1001),
  ]);
  for (const result of [cases, profile, people])
    if (result.error)
      throw new ManagementError(
        'No se pudo leer Gerencia. Comprueba la conexión y la migración 0130.',
      );
  const rows = (cases.data ?? []) as ManagementCase[];
  return {
    cases: rows.slice(0, 500),
    profile: (profile.data as ManagementProfile | null) ?? {
      data: defaultManagementProfile,
      revision: 0,
      updated_at: '',
    },
    people: (people.data ?? []).slice(0, 1000) as {
      id: string;
      name: string | null;
      email: string;
    }[],
    truncated: rows.length > 500 || (people.data?.length ?? 0) > 1000,
  };
}

/** Sources retain their own permissions. Approvals/errands are personal, cases are company-shared. */
export async function readManagementSignals(
  db: SupabaseClient,
  userId: string,
  today = bogotaToday(),
) {
  const now = new Date().toISOString();
  const [commitments, goals, readings, approvals, errands] = await Promise.all([
    db
      .from('commitments')
      .select('id,title,due_on,notice_days,state,owner_user_id')
      .eq('review_state', 'confirmed')
      .not('state', 'in', '(met,dropped)')
      .order('due_on')
      .limit(101),
    db.from('goals').select('id,label,cadence').eq('state', 'active').limit(101),
    db
      .from('goal_readings')
      .select('goal_id,status,period_start,display,computed_at')
      .order('period_start', { ascending: false })
      .limit(501),
    db
      .from('mcp_pending_actions')
      .select('id,tool_id,expires_at')
      .eq('user_id', userId)
      .is('decision', null)
      .gt('expires_at', now)
      .order('expires_at')
      .limit(101),
    db
      .from('errands')
      .select('id,request,state')
      .eq('user_id', userId)
      .in('state', ['blocked', 'failed', 'exhausted'])
      .limit(101),
  ]);
  const signals: ManagementSignal[] = [];
  const warnings: string[] = [];
  const results = [commitments, goals, readings, approvals, errands];
  const names = ['Compromisos', 'Metas', 'Lecturas de metas', 'Aprobaciones', 'Encargos'];
  results.forEach((r, i) => {
    if (r.error) warnings.push(`${names[i]} no disponible; no se puede concluir que esté al día.`);
    else if ((r.data?.length ?? 0) >= (i === 2 ? 501 : 101))
      warnings.push(`${names[i]}: vista parcial; abre el módulo para consultar el resto.`);
  });
  if (!commitments.error)
    for (const r of commitments.data?.slice(0, 100) ?? []) {
      const state = deriveState(r, today);
      if (state !== 'overdue' && state !== 'due_soon') continue;
      signals.push({
        key: `commitment:${r.id}`,
        title: r.title,
        dueOn: r.due_on,
        ownerId: r.owner_user_id,
        impact: state === 'overdue' ? 'high' : 'medium',
        reason: state === 'overdue' ? 'Compromiso vencido' : 'Compromiso por vencer',
        href: '/commitments',
      });
    }
  if (!goals.error && !readings.error)
    for (const g of goals.data?.slice(0, 100) ?? []) {
      const expected = lastClosedPeriod(g.cadence as 'week' | 'month', today).start;
      const latest = readings.data?.find((r) => r.goal_id === g.id && r.period_start === expected);
      if (!latest || latest.status === 'unmeasurable') {
        signals.push({
          key: `goal:${g.id}:${expected}`,
          title: g.label,
          reason: 'Sin medición válida del último período cerrado',
          href: '/goals',
          dueOn: null,
          ownerId: null,
          impact: 'medium',
        });
      } else if (latest.status === 'breached') {
        signals.push({
          key: `goal:${g.id}:${expected}`,
          title: g.label,
          reason: `Fuera de meta en el último período cerrado: ${latest.display}`,
          href: '/goals',
          dueOn: null,
          ownerId: null,
          impact: 'high',
        });
      }
    }
  if (!approvals.error)
    for (const r of approvals.data?.slice(0, 100) ?? [])
      signals.push({
        key: `approval:${r.id}`,
        title: `Revisar ${r.tool_id}`,
        reason: 'Requiere tu aprobación; no se ha ejecutado',
        href: '/approvals',
        dueOn: null,
        ownerId: userId,
        impact: 'high',
      });
  if (!errands.error)
    for (const r of errands.data?.slice(0, 100) ?? [])
      signals.push({
        key: `errand:${r.id}`,
        title: r.request.slice(0, 180),
        reason:
          r.state === 'blocked' ? 'Encargo bloqueado' : 'Encargo detenido sin resultado completo',
        href: `/errands/${r.id}`,
        dueOn: null,
        ownerId: userId,
        impact: 'medium',
      });
  return { signals, warnings, readAt: now };
}

export async function getManagementCase(db: SupabaseClient, id: string) {
  const result = await db.from('management_cases').select(columns).eq('id', id).maybeSingle();
  if (result.error) throw new ManagementError('No se pudo consultar el asunto.');
  if (!result.data) throw new ManagementError('Asunto no encontrado.');
  return result.data as ManagementCase;
}
export async function readManagementEvents(
  db: SupabaseClient,
  id: string,
): Promise<ManagementEvent[]> {
  await getManagementCase(db, id);
  const result = await db
    .from('management_events')
    .select('id,actor_id,case_id,revision,created_at,data')
    .eq('case_id', id)
    .order('revision', { ascending: false })
    .limit(100);
  if (result.error) throw new ManagementError('No se pudo leer el historial.');
  return result.data as ManagementEvent[];
}

export async function saveManagementCase(
  db: SupabaseClient,
  actorId: string,
  input: unknown,
  options: { id?: string; revision?: number; humanReview?: boolean } = {},
) {
  const parsed = managementCaseSchema.safeParse(input);
  if (!parsed.success)
    throw new ManagementError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  const data = parsed.data;
  const previous = options.id ? await getManagementCase(db, options.id) : null;
  const actor = await db.from('users').select('role').eq('id', actorId).maybeSingle();
  if (actor.error || !actor.data) throw new ManagementError('No se pudo comprobar tu acceso.');
  validateManagementTransition(
    previous?.data ?? null,
    data,
    options.humanReview === true && actor.data.role === 'org_admin',
    bogotaToday(),
  );
  if (!previous && data.sourceKey) {
    const { signals } = await readManagementSignals(db, actorId);
    const source = signals.find((s) => s.key === data.sourceKey);
    if (!source) throw new ManagementError('La señal ya no está disponible. Actualiza la página.');
    // Prevent source-link forgery. The user is explicitly copying a visible signal into a shared case.
    data.sourceUrl = source.href;
  }
  const result = await db.rpc('management_save_case', {
    p_actor_id: actorId,
    p_id: options.id ?? null,
    p_revision: options.revision ?? 0,
    p_data: data,
    p_human_review: options.humanReview === true,
  });
  if (result.error) {
    if (result.error.code === '23505')
      throw new ManagementError('Esta señal ya tiene un asunto. Abre el existente.');
    throw new ManagementError(
      result.error.code === 'P0001' ? result.error.message : 'No se pudo guardar el asunto.',
    );
  }
  const saved = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!saved?.id)
    throw new ManagementError('No se recibió el asunto guardado. Actualiza la página.');
  return saved as ManagementCase;
}
export async function saveManagementProfile(
  db: SupabaseClient,
  actorId: string,
  input: unknown,
  revision: number,
) {
  const data = managementProfileSchema.parse(input);
  const result = await db.rpc('management_save_profile', {
    p_actor_id: actorId,
    p_revision: revision,
    p_data: data,
  });
  if (result.error)
    throw new ManagementError(
      result.error.code === 'P0001' ? result.error.message : 'No se pudo guardar la configuración.',
    );
  const saved = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!saved?.revision)
    throw new ManagementError('No se recibió la configuración guardada. Actualiza la página.');
  return saved as ManagementProfile;
}

import 'server-only';

/**
 * Lo que la consola del fundador sabe de cada empresa propia.
 *
 * ===========================================================================
 * QUÉ SE LEE Y CON QUÉ LLAVE
 * ===========================================================================
 * Dos clases de lecturas, y la frontera entre ellas es la de siempre:
 *
 *  - Las de `ba_*` (membresías, invitaciones) son tablas `shared` y se leen por
 *    el `pool`, con un `= any($1)` sobre ids que salen de `listOwnedCompanies`,
 *    nunca del navegador.
 *  - Las de datos de la empresa (plan, consumo, integraciones, rutinas,
 *    auditoría) van por `getOrgScopedClient(empresa)`, UNA empresa por manejador,
 *    igual que `readFounderOverview`. Así el registro de inquilinos sigue siendo
 *    el que pone el filtro, y un descuido aquí no puede mezclar dos empresas.
 *
 * Cada empresa se lee por separado y falla por separado: una que no responde
 * sale «sin lectura» y las demás siguen, como en el inicio global.
 *
 * ===========================================================================
 * SÓLO EMPRESAS PROPIAS
 * ===========================================================================
 * Plan, asientos, consumo y personas son datos de quien dirige la empresa. En
 * las empresas donde la cuenta es gerente o colaboradora, la consola enseña lo
 * mismo que antes (sus pendientes) y un enlace para entrar; los datos de
 * administración los ve dentro de esa empresa, con los permisos de esa empresa.
 */

import type { MeterState } from '@cortex/agent-tools';
import { readWorkspaceUsage } from '@cortex/agent-tools';
import { pool } from './auth';
import { type CompanyGroup, listCompanyGroups } from './company-groups';
import type { OwnedCompany } from './founder-guard';
import { type FounderOverviewData, readFounderOverview } from './founder-overview';
import { type HealthTone, healthOf } from './founder-rules';
import { listMemberships } from './organization';
import { getOrgScopedClient } from './supabase/service';
import { WORKSPACE_LIMIT } from './workspace-limits';

/** Días que cuentan como «falló hace poco» para una rutina. */
export const FAILED_RUNS_WINDOW_DAYS = 7;

export interface CompanyHealth {
  organizationId: string;
  status: 'ready' | 'unavailable';
  createdAt: string | null;
  planName: string | null;
  subscriptionStatus: 'active' | 'past_due' | 'canceled' | null;
  seats: { used: number; maximum: number | null; full: boolean } | null;
  answers: {
    used: number;
    limit: number | null;
    ratio: number | null;
    state: MeterState;
  } | null;
  members: number;
  pendingInvitations: number;
  integrations: number | null;
  routines: { active: number; failedRecently: number } | null;
  lastActivityAt: string | null;
  health: { tone: HealthTone; label: string };
}

async function countOf(result: PromiseLike<{ count: number | null; error: unknown }>) {
  const read = await result;
  if (read.error) throw read.error;
  return read.count ?? 0;
}

/** Membresías e invitaciones de todas las empresas propias, en dos consultas. */
async function readRosterCounts(organizationIds: string[]) {
  const members = new Map<string, number>();
  const invitations = new Map<string, number>();
  if (organizationIds.length === 0) return { members, invitations };
  const [memberRows, invitationRows] = await Promise.all([
    pool.query<{ organizationId: string; count: string }>(
      `select "organizationId", count(*)::text as count from public.ba_member
        where "organizationId" = any($1::text[]) group by "organizationId"`,
      [organizationIds],
    ),
    pool.query<{ organizationId: string; count: string }>(
      `select "organizationId", count(*)::text as count from public.ba_invitation
        where "organizationId" = any($1::text[]) and status = 'pending'
        group by "organizationId"`,
      [organizationIds],
    ),
  ]);
  for (const row of memberRows.rows) members.set(row.organizationId, Number(row.count));
  for (const row of invitationRows.rows) invitations.set(row.organizationId, Number(row.count));
  return { members, invitations };
}

/**
 * La lectura de administración de UNA empresa propia.
 *
 * `blocked` viene del inicio global (errands bloqueados) para que la señal de
 * salud no pida esa cifra dos veces.
 */
export async function readCompanyHealth(
  company: OwnedCompany,
  roster: { members: number; pendingInvitations: number },
  blocked: number | null,
  at: Date = new Date(),
): Promise<CompanyHealth> {
  const base = {
    organizationId: company.id,
    createdAt: company.createdAt ?? null,
    members: roster.members,
    pendingInvitations: roster.pendingInvitations,
  };
  try {
    const db = getOrgScopedClient(company.id);
    const since = new Date(at.getTime() - FAILED_RUNS_WINDOW_DAYS * 86_400_000).toISOString();
    const [usage, integrations, activeRoutines, failedRuns, lastAudit] = await Promise.all([
      readWorkspaceUsage(db, company.id, at),
      db.from('integrations').select('provider').limit(1000),
      countOf(
        db
          .from('scheduled_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
      ),
      countOf(
        db
          .from('scheduled_job_runs')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'error')
          .gte('started_at', since),
      ),
      db
        .from('audit_events')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const providers = integrations.error
      ? null
      : new Set((integrations.data ?? []).map((row) => String(row.provider ?? ''))).size;
    const answers = usage.meters.answers;
    const subscriptionStatus = usage.status;
    return {
      ...base,
      status: 'ready',
      planName: usage.plan.name,
      subscriptionStatus,
      seats: { used: usage.seats.used, maximum: usage.seats.maximum, full: usage.seats.full },
      answers: {
        used: answers.used,
        limit: answers.limit,
        ratio: answers.ratio,
        state: answers.state,
      },
      integrations: providers,
      routines: { active: activeRoutines, failedRecently: failedRuns },
      lastActivityAt: lastAudit.error
        ? null
        : ((lastAudit.data as { created_at?: string } | null)?.created_at ?? null),
      health: healthOf({
        meterState: answers.state,
        seatsFull: usage.seats.full,
        failedRuns7d: failedRuns,
        blocked,
        subscriptionStatus,
      }),
    };
  } catch (err) {
    console.error('[founder-console] no se pudo leer la empresa', company.id, err);
    return {
      ...base,
      status: 'unavailable',
      planName: null,
      subscriptionStatus: null,
      seats: null,
      answers: null,
      integrations: null,
      routines: null,
      lastActivityAt: null,
      health: { tone: 'neutral', label: 'Sin lectura' },
    };
  }
}

export interface FounderConsoleData {
  overview: FounderOverviewData;
  /** Salud por empresa propia; las demás no aparecen aquí. */
  health: Record<string, CompanyHealth>;
  groups: CompanyGroup[];
  /** empresa → grupo, para el filtro. */
  groupOf: Record<string, string>;
  ownedCount: number;
  ownedLimit: number;
  availableForGroups: Array<{ id: string; name: string }>;
}

export async function readFounderConsole(
  accountId: string,
  email: string,
  owned: OwnedCompany[],
): Promise<FounderConsoleData> {
  const memberships = await listMemberships(accountId);
  const ownedIds = owned.map((company) => company.id);
  const [overview, groups, roster] = await Promise.all([
    readFounderOverview(memberships, email),
    listCompanyGroups(accountId),
    readRosterCounts(ownedIds),
  ]);
  const blockedOf = new Map(overview.workspaces.map((item) => [item.workspace.id, item.blocked]));
  const healthList = await Promise.all(
    owned.map((company) =>
      readCompanyHealth(
        company,
        {
          members: roster.members.get(company.id) ?? 0,
          pendingInvitations: roster.invitations.get(company.id) ?? 0,
        },
        blockedOf.get(company.id) ?? null,
      ),
    ),
  );
  const groupOf: Record<string, string> = {};
  for (const group of groups) for (const company of group.companies) groupOf[company.id] = group.id;
  return {
    overview,
    health: Object.fromEntries(healthList.map((item) => [item.organizationId, item])),
    groups,
    groupOf,
    ownedCount: owned.length,
    ownedLimit: WORKSPACE_LIMIT,
    availableForGroups: owned
      .filter((company) => !groupOf[company.id])
      .map((company) => ({ id: company.id, name: company.name })),
  };
}

/** La lectura de una sola empresa propia, para su ficha. */
export async function readOwnedCompanyHealth(company: OwnedCompany): Promise<CompanyHealth> {
  const roster = await readRosterCounts([company.id]);
  const blocked = await countOf(
    getOrgScopedClient(company.id)
      .from('errands')
      .select('id', { count: 'exact', head: true })
      .eq('state', 'blocked'),
  ).catch(() => null);
  return readCompanyHealth(
    company,
    {
      members: roster.members.get(company.id) ?? 0,
      pendingInvitations: roster.invitations.get(company.id) ?? 0,
    },
    blocked,
  );
}

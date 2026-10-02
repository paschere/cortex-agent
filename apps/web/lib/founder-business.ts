import 'server-only';

/**
 * Las cifras de negocio del centro de mando, empresa propia por empresa propia.
 *
 * ===========================================================================
 * QUÉ SE LEE Y CON QUÉ LLAVE
 * ===========================================================================
 * Todo por `getOrgScopedClient(empresa)`, UNA empresa por manejador, igual que
 * founder-console.ts: el registro de inquilinos pone el filtro y un descuido
 * aquí no puede mezclar dos empresas. Las empresas salen de
 * `requireFounderContext` (ba_member, en esta petición), nunca del navegador.
 * Sólo empresas PROPIAS: la plata de una empresa donde la cuenta es gerente la
 * ve dentro de esa empresa, con los permisos de esa empresa.
 *
 * Las cifras se calculan con las MISMAS funciones que el Inicio de cada empresa
 * (payments/risk.ts, payments/recovered-store.ts, self-service/read.ts): dos
 * fórmulas de «plata en riesgo» se separan el día que alguien toque una.
 *
 * ===========================================================================
 * CADA LECTURA FALLA SOLA, Y NINGUNA DEMORA LA PÁGINA
 * ===========================================================================
 * Cada cifra de cada empresa es una lectura aislada con su propio tope de
 * tiempo: si la cartera de una empresa no responde, esa cifra sale «sin dato»
 * y lo demás sigue. Las empresas se leen de a `CONCURRENCY` a la vez —con
 * veinte empresas y una docena de consultas cada una, todas juntas saturarían
 * el pool— y la página no las espera: /overview pinta primero lo rápido y
 * estas cifras llegan después por streaming (ver overview/page.tsx).
 */

import {
  PULSE_SLUG,
  bogotaToday,
  moneyAtRisk,
  moneyRecovered,
  readPulseSnapshots,
  shiftDay,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readBranding } from './branding/store';
import type { BusinessMap, CompanyBusiness } from './founder-business-shape';
import { safeBrandColor } from './founder-business-shape';
import type { OwnedCompany } from './founder-guard';
import { readSetupSteps } from './self-service/read';
import { setupProgress } from './self-service/setup';
import { getOrgScopedClient } from './supabase/service';
import { workspaceHref } from './workspace-context';

/** Empresas leídas a la vez. */
export const CONCURRENCY = 4;
/** Tope por cifra: más que esto y la cifra sale «sin dato». */
export const READ_TIMEOUT_MS = 6_000;
/** Ventana de «la rutina está fallando»: su última corrida en estos días fue un error. */
const FAILING_WINDOW_DAYS = 7;
/** Una foto del pulso más vieja que esto ya no dice cómo va el mes. */
const SNAPSHOT_MAX_AGE_DAYS = 6;

class ReadTimeout extends Error {}

/** La cifra, o `null` si falló o tardó demasiado. El motivo queda en el registro. */
async function settle<T>(
  what: string,
  organizationId: string,
  read: () => PromiseLike<T>,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReadTimeout()), timeoutMs);
      }),
    ]);
  } catch (err) {
    console.warn(
      `[founder-business] ${what} de ${organizationId}:`,
      err instanceof ReadTimeout ? `más de ${timeoutMs} ms` : err,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `map` con a lo sumo `limit` promesas vivas a la vez, en el orden de entrada. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

async function headCount(
  query: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** El id del directorio de la empresa (`public.users`) de quien mira, por su correo. */
export async function directoryUserId(db: SupabaseClient, email: string): Promise<string | null> {
  const { data, error } = await db.from('users').select('id').eq('email', email).maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

/**
 * Procesos con error: rutinas activas cuya ÚLTIMA corrida de la semana falló,
 * más sincronizaciones (carpetas de Drive, hojas, programa contable) encendidas
 * cuya última vuelta terminó en error. Una rutina que falló el lunes y anduvo
 * el martes ya no está fallando.
 */
async function readFailing(db: SupabaseClient, at: Date): Promise<CompanyBusiness['failing']> {
  const since = new Date(at.getTime() - FAILING_WINDOW_DAYS * 86_400_000).toISOString();
  const [runs, drive, sheets, accounting] = await Promise.all([
    db
      .from('scheduled_job_runs')
      .select('job_id, status, started_at, scheduled_jobs!inner(status)')
      .eq('scheduled_jobs.status', 'active')
      .in('status', ['ok', 'error'])
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(500),
    headCount(
      db
        .from('drive_folder_syncs')
        .select('id', { count: 'exact', head: true })
        .eq('enabled', true)
        .eq('last_status', 'error'),
    ),
    headCount(
      db
        .from('tracker_syncs')
        .select('id', { count: 'exact', head: true })
        .eq('enabled', true)
        .eq('last_status', 'error'),
    ),
    headCount(
      db
        .from('accounting_connections')
        .select('id', { count: 'exact', head: true })
        .eq('enabled', true)
        .eq('last_status', 'error'),
    ),
  ]);
  if (runs.error) throw runs.error;
  const last = new Map<string, string>();
  for (const run of (runs.data ?? []) as Array<{ job_id: string; status: string }>) {
    if (!last.has(run.job_id)) last.set(run.job_id, run.status);
  }
  const routines = [...last.values()].filter((status) => status === 'error').length;
  const syncs = drive + sheets + accounting;
  return { routines, syncs, total: routines + syncs };
}

/**
 * Las ventas del mes, de la última foto del pulso (0171) — no se recalcula la
 * vista: eso es leer cientos de filas por empresa. Si la empresa no tiene
 * pulso, o la foto es vieja o de otro mes, no hay cifra: «sin dato», nunca
 * una cifra vieja disfrazada de hoy.
 */
async function readPulse(
  db: SupabaseClient,
  today: string,
): Promise<{ view: boolean; sales: CompanyBusiness['sales'] }> {
  const view = await db
    .from('custom_views')
    .select('id')
    .eq('slug', PULSE_SLUG)
    .is('archived_at', null)
    .limit(1)
    .maybeSingle();
  if (view.error) throw view.error;
  const viewId = (view.data?.id as string | undefined) ?? null;
  if (!viewId) return { view: false, sales: null };
  const [latest] = await readPulseSnapshots(
    db,
    viewId,
    shiftDay(today, -SNAPSHOT_MAX_AGE_DAYS),
    today,
  );
  if (!latest) return { view: true, sales: null };
  const month = latest.facts.find((fact) => fact.key === 'ventas_mes');
  if (!month || month.value === null || month.period !== `month:${today.slice(0, 7)}`)
    return { view: true, sales: null };
  const previous = latest.facts.find((fact) => fact.key === 'ventas_mes.anterior');
  return {
    view: true,
    sales: { month: month.value, previous: previous?.value ?? null, asOf: latest.day },
  };
}

/** La decisión más vieja que espera a esta persona: aprobaciones y acciones propuestas. */
async function readOldestDecision(
  db: SupabaseClient,
  userId: string,
  at: Date,
): Promise<string | null> {
  const now = at.toISOString();
  const [approval, action] = await Promise.all([
    db
      .from('mcp_pending_actions')
      .select('created_at')
      .eq('user_id', userId)
      .is('decision', null)
      .gt('expires_at', now)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    db
      .from('actions')
      .select('created_at')
      .eq('user_id', userId)
      .eq('state', 'proposed')
      .gt('expires_at', now)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (approval.error) throw approval.error;
  if (action.error) throw action.error;
  const dates = [approval.data?.created_at, action.data?.created_at].filter(
    (value): value is string => typeof value === 'string',
  );
  return dates.sort()[0] ?? null;
}

/** Todo lo de negocio de UNA empresa propia. Nunca lanza. */
export async function readCompanyBusiness(
  company: Pick<OwnedCompany, 'id'>,
  email: string,
  at: Date = new Date(),
): Promise<CompanyBusiness> {
  const id = company.id;
  const db = getOrgScopedClient(id);
  const today = bogotaToday();
  const userId = await settle('el directorio', id, () => directoryUserId(db, email));

  const [risk, recovered, pulse, failing, setup, oldest, brand] = await Promise.all([
    settle('la plata en riesgo', id, () => moneyAtRisk(db, { today })),
    settle('lo recuperado', id, () => moneyRecovered(db, { today })),
    settle('el pulso', id, () => readPulse(db, today)),
    settle('los procesos', id, () => readFailing(db, at)),
    userId
      ? settle('la puesta en marcha', id, async () =>
          setupProgress(await readSetupSteps(db, userId)),
        )
      : Promise.resolve(null),
    userId
      ? settle('las decisiones', id, () => readOldestDecision(db, userId, at))
      : Promise.resolve(null),
    settle('la marca', id, () => readBranding(db)),
  ]);

  return {
    organizationId: id,
    risk: risk
      ? {
          total: risk.cop.total,
          receivablesOverdue: risk.cop.receivablesOverdue,
          overdueInvoices: risk.cop.overdueInvoices,
          paymentsOverdue: risk.cop.paymentsOverdue,
          paymentsDueSoon: risk.cop.paymentsDueSoon,
          finesPending: risk.cop.finesPending,
          others: risk.otherCurrencies
            .filter((other) => other.receivablesOverdue > 0)
            .map((other) => ({
              currency: other.currency,
              amount: other.receivablesOverdue,
              invoices: other.overdueInvoices,
            })),
        }
      : null,
    recovered: recovered
      ? {
          month: recovered.cop.month,
          monthInvoices: recovered.cop.monthInvoices,
          total: recovered.cop.total,
          others: recovered.otherCurrencies
            .filter((other) => other.month > 0)
            .map((other) => ({ currency: other.currency, month: other.month })),
        }
      : null,
    sales: pulse?.sales ?? null,
    failing,
    setup: setup
      ? {
          ready: setup.ready,
          total: setup.total,
          percent: setup.percent,
          next: setup.next?.title ?? null,
        }
      : null,
    oldestDecisionAt: oldest,
    pulseView: pulse ? pulse.view : null,
    brand: brand
      ? {
          name: brand.display_name?.trim() || null,
          color: safeBrandColor(brand.primary_color),
          // El logo se pide por la ruta con sesión, con `?workspace=` para que el
          // servidor lo resuelva en ESA empresa tras comprobar la membresía.
          logoUrl:
            brand.logo_path && brand.logo_version
              ? workspaceHref(id, `/api/branding/logo?v=${encodeURIComponent(brand.logo_version)}`)
              : null,
        }
      : null,
  };
}

/** Las cifras de todas las empresas propias, de a `CONCURRENCY`. Nunca lanza. */
export async function readOwnedBusiness(
  owned: ReadonlyArray<Pick<OwnedCompany, 'id'>>,
  email: string,
  at: Date = new Date(),
): Promise<BusinessMap> {
  const list = await mapLimit(owned, CONCURRENCY, (company) =>
    readCompanyBusiness(company, email, at).catch((err) => {
      console.error('[founder-business] no se pudo leer la empresa', company.id, err);
      return null;
    }),
  );
  return Object.fromEntries(
    list
      .filter((item): item is CompanyBusiness => item !== null)
      .map((item) => [item.organizationId, item]),
  );
}

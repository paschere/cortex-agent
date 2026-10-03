import 'server-only';
import { listMandates, mandateState } from '@/lib/mandates/store';
import {
  type SettingsState,
  autopilotState,
  connectionsState,
  mandatesState,
  modulesState,
  peopleState,
  planState,
  tokensState,
} from '@/lib/settings/state-text';
import { listPlans, readAutopilotSettings, readBillingAccess } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SettingsStateKey } from './registry';

/**
 * LOS DATOS CORTOS DEL RECIBIDOR DE AJUSTES, los que cuestan una lectura.
 *
 * Cada uno se pide sólo si la persona va a ver la entrada que lo muestra, y
 * cada uno es independiente: una lectura que falle cuesta ese dato (la entrada
 * sale sin su resumen), nunca la pantalla. Eso es lo que significa el
 * `.catch(() => null)` de abajo: no es tragarse el error, es una pantalla de
 * enlaces que no debe caerse porque la tabla de llaves tardó.
 *
 * Los datos que ya se leen para los formularios (memoria, correo, avisos,
 * perfil) los arma la página con `state-text.ts`; aquí van los demás.
 */

type Loader = () => Promise<SettingsState | null>;

async function count(
  q: PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number | null> {
  const { count: n, error } = await q;
  if (error) return null;
  return n ?? 0;
}

export async function loadSettingsStates(opts: {
  db: SupabaseClient;
  userId: string;
  wanted: ReadonlySet<SettingsStateKey>;
  modulesOnCount: number;
}): Promise<Partial<Record<SettingsStateKey, SettingsState>>> {
  const { db, userId, wanted, modulesOnCount } = opts;

  const loaders: Partial<Record<SettingsStateKey, Loader>> = {
    modulos: async () => modulesState(modulesOnCount),
    personas: async () => {
      const n = await count(db.from('users').select('id', { count: 'exact', head: true }));
      return n === null ? null : peopleState(n);
    },
    mandatos: async () => {
      const rows = await listMandates(db);
      return mandatesState(rows.filter((r) => mandateState(r) === 'active').length);
    },
    plan: async () => {
      const [plans, billing] = await Promise.all([listPlans(db), readBillingAccess(db)]);
      const code = billing.subscription?.planCode;
      const plan = plans.find((p) => p.code === code) ?? plans[0];
      if (!plan) return null;
      return planState(plan.name, {
        status: billing.access.status,
        daysLeft: billing.access.daysLeft,
      });
    },
    conexiones: async () => {
      const { data, error } = await db.from('integrations').select('provider').limit(1000);
      if (error) return null;
      const providers = new Set((data ?? []).map((r: { provider: string }) => r.provider));
      return connectionsState(providers.size);
    },
    piloto: async () => {
      const s = await readAutopilotSettings(db);
      return autopilotState(s.enabled, s.runHour);
    },
    tokens: async () => {
      const n = await count(
        db
          .from('mcp_tokens')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .is('revoked_at', null),
      );
      return n === null ? null : tokensState(n);
    },
  };

  const keys = [...wanted].filter((k) => loaders[k]);
  const settled = await Promise.all(
    keys.map(async (k) => [k, await (loaders[k] as Loader)().catch(() => null)] as const),
  );
  const out: Partial<Record<SettingsStateKey, SettingsState>> = {};
  for (const [k, v] of settled) if (v) out[k] = v;
  return out;
}

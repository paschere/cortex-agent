import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { bogotaParts, createBackup, pruneBackups } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * LA COPIA DIARIA DE CADA APP (migración 0247, docs/plans/copias-por-app.md).
 *
 * A las 2:00 a. m. de Bogotá cada app activa (no archivada) deja una copia
 * «diaria» (configuración, código y todas las filas de las tablas que usa) y se
 * podan las vencidas (30 diarias; manuales y «antes de cambio» 90 días).
 *
 * CÓMO CORRE SIN TOCAR EL WORKER. Un cron nuevo exige redesplegar services/jobs
 * (el manifiesto vive allá). Para que esto funcione con sólo desplegar la app
 * web, el barrido cuelga del trabajo horario `apps/location.sweep` (minuto 5):
 * cada hora, desde las 2:00 de Bogotá, hace la copia de las apps que AÚN no
 * tienen una diaria de hoy. Así la primera corrida (2:05) las hace todas y las
 * siguientes sólo reintentan lo que falló o no alcanzó (tope de 2 intentos
 * fallidos por app y día). Es idempotente por construcción.
 *
 * SIN ALCANCE, SÓLO PARA ENUMERAR. Se leen (id, organization_id) de las apps y
 * (app_id, status) de las copias de hoy con el handle crudo; cada copia corre
 * después con el handle de SU empresa.
 */

const BUDGET_MS = 600_000;
const MAX_FAILED_TRIES = 2;

export interface BackupSweepResult {
  made: number;
  failed: number;
  pending: number;
  pruned: number;
  skipped?: string;
}

export async function runDailyBackups(
  now: Date = new Date(),
  budgetMs: number = BUDGET_MS,
): Promise<BackupSweepResult> {
  const { hour, dayStartUtc } = bogotaParts(now);
  if (hour < 2) return { made: 0, failed: 0, pending: 0, pruned: 0, skipped: 'antes de las 2:00' };
  const raw = getSupabaseServiceClient();
  const { data: apps, error } = await raw
    .from('custom_apps')
    .select('id, organization_id')
    .is('archived_at', null)
    .limit(5000);
  if (error) throw error;
  const { data: today, error: todayErr } = await raw
    .from('custom_app_backups')
    .select('app_id, status')
    .eq('kind', 'diaria')
    .gte('created_at', dayStartUtc.toISOString())
    .limit(10000);
  if (todayErr) throw todayErr;
  const done = new Set<string>();
  const fails = new Map<string, number>();
  for (const r of (today ?? []) as Array<{ app_id: string; status: string }>) {
    if (r.status === 'ok') done.add(r.app_id);
    else fails.set(r.app_id, (fails.get(r.app_id) ?? 0) + 1);
  }
  const todo = ((apps ?? []) as Array<{ id: string; organization_id: string }>).filter(
    (a) => !done.has(a.id) && (fails.get(a.id) ?? 0) < MAX_FAILED_TRIES,
  );
  const started = Date.now();
  let made = 0;
  let failed = 0;
  let pruned = 0;
  let i = 0;
  for (; i < todo.length; i++) {
    if (Date.now() - started > budgetMs) break;
    const app = todo[i] as { id: string; organization_id: string };
    const db = getOrgScopedClient(app.organization_id);
    try {
      await createBackup(db, app.id, { kind: 'diaria', reason: 'Copia diaria', userId: null });
      made++;
      pruned += await pruneBackups(db, app.id, now);
    } catch (err) {
      failed++;
      logger.warn({ err, appId: app.id }, 'app backup: daily copy failed');
    }
  }
  logger.info('app backups: daily sweep', { made, failed, pending: todo.length - i, pruned });
  return { made, failed, pending: todo.length - i, pruned };
}

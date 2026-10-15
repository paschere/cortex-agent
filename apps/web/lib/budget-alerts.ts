import 'server-only';
import { notify } from '@/lib/notifications/notify';
import {
  budgetAlertHref,
  budgetAlerts,
  claimBudgetAlert,
  loadBudgetAlertSettings,
  loadBudgetReport,
  orgAdmins,
  releaseBudgetAlert,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LAS ALERTAS DE PRESUPUESTO SALEN SOLAS (0228).
 *
 * Una vez al día (en el barrido de la mañana de la cartera), por empresa: los
 * gastos del mes que cruzaron el umbral de aviso o el de «se pasó» y de los que
 * todavía no se avisó. Un aviso por (presupuesto, categoría, mes, nivel): subir
 * de «cerca» a «se pasó» avisa de nuevo, repetir el mismo nivel no. La campana
 * respeta las preferencias de cada persona (`notify` las lee en la puerta). Si
 * no hay a quién avisar, se suelta el reclamo para que mañana se reintente.
 */
export async function runBudgetAlerts(
  db: SupabaseClient,
  opts: { today: string },
): Promise<{ alerts: number; notified: number }> {
  const settings = await loadBudgetAlertSettings(db);
  if (!settings.enabled) return { alerts: 0, notified: 0 };
  const report = await loadBudgetReport(db, {
    year: Number(opts.today.slice(0, 4)),
    today: opts.today,
    viewerId: null,
  });
  if (!report.budget || !report.vs) return { alerts: 0, notified: 0 };
  const alerts = budgetAlerts(report.vs, settings);
  if (!alerts.length) return { alerts: 0, notified: 0 };
  const admins = await orgAdmins(db);
  let notified = 0;
  for (const alert of alerts) {
    if (!admins.length) break;
    if (!(await claimBudgetAlert(db, report.budget.id, alert))) continue;
    let delivered = 0;
    for (const userId of admins) {
      const id = await notify(db, {
        userId,
        kind: 'budget_alert',
        title: alert.title,
        body:
          alert.level === 'excedido'
            ? `Se pasó del presupuesto del mes por $ ${Math.round(alert.over).toLocaleString('es-CO')}. Mira los movimientos que lo explican.`
            : `Va en ${Math.round(alert.ratio * 100)} % del presupuesto del mes (aviso desde ${settings.warnPct} %).`,
        href: budgetAlertHref(alert),
        dedupeKey: `budget:${report.budget.id}:${alert.category}:${alert.month}:${alert.level}:${userId}`,
        groupKey: `budget_alert:${report.budget.id}:${alert.category}`,
      }).catch((err) => {
        logger.warn({ err }, 'budget alert notify failed');
        return null;
      });
      if (id) delivered += 1;
    }
    if (delivered === 0) {
      // Nadie lo recibió (campana apagada o fallo): el índice no debe tragarse el aviso.
      await releaseBudgetAlert(db, report.budget.id, alert).catch(() => undefined);
    } else notified += 1;
  }
  return { alerts: alerts.length, notified };
}

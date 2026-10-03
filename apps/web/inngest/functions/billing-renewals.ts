import { runBillingRenewals } from '@/lib/billing/renewals';
import type { JobHandler } from '@/lib/jobs';

/**
 * `billing/renewals` — una vez al día (manifiesto de services/jobs): escribe el
 * estado efectivo del cobro y manda los recordatorios de prueba, renovación,
 * mora y solo lectura. Todo el trabajo está en lib/billing/renewals.ts.
 */
export const billingRenewalsJob: JobHandler = async ({ step }) => {
  return await step.run('sweep', () => runBillingRenewals());
};

import 'server-only';
import { logger } from '@cortex/core';
import { getOrgScopedClient } from '../supabase/service';
import { SIGNUP_PLAN_COOKIE, signupMode, trialDays, trialPlanCode } from './config';
import { startTrial } from './ledger';

/**
 * La prueba de una empresa recién creada, SÓLO con SIGNUP_MODE=open.
 *
 * Lo llama `lib/organization.ts` justo después de insertar la empresa (la del
 * registro y las adicionales del fundador). En 'invite' y 'request' no hace
 * nada: esas empresas siguen naciendo en `enterprise` por el disparador de la
 * 0114, igual que hoy.
 *
 * El plan elegido viaja en una cookie desde /signup (como el nombre de la
 * empresa); si no está o no es un plan de prueba, va TRIAL_PLAN o Equipo.
 *
 * NUNCA rompe la creación de la empresa: si algo falla se anota y la empresa
 * queda como hoy (sin fila de cobro = sin bloqueo). Un registro que falla por
 * la prueba es peor que una prueba que no arrancó.
 */
export async function startTrialIfOpen(organizationId: string): Promise<void> {
  if (signupMode() !== 'open') return;
  try {
    let requested: string | null = null;
    try {
      const { cookies } = await import('next/headers');
      requested = (await cookies()).get(SIGNUP_PLAN_COOKIE)?.value ?? null;
    } catch {
      /* Fuera de una petición: va el plan por defecto. */
    }
    const planCode = trialPlanCode(requested);
    const { started } = await startTrial(getOrgScopedClient(organizationId), {
      organizationId,
      planCode,
      days: trialDays(),
    });
    if (started) logger.info('billing: prueba iniciada', { organizationId, planCode });
  } catch (err) {
    logger.error('billing: no se pudo iniciar la prueba', {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

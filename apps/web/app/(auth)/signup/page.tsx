import { SignupConsent } from '@/components/legal/SignupConsent';
import {
  isTrialPlanCode,
  signupMode,
  signupNeedsCode,
  trialDays,
  trialPlanCode,
} from '@/lib/billing/config';
import { SignupForm } from './SignupForm';

export const dynamic = 'force-dynamic';

/**
 * /signup — el flujo lo decide SIGNUP_MODE (lib/billing/config.ts), en el
 * servidor; el formulario sólo pinta lo que le toca:
 *
 *   invite   como siempre: código si SIGNUP_INVITE_CODE está puesto.
 *   request  código personal (el del correo de aprobación) siempre.
 *   open     sin código, empresa obligatoria y plan de prueba a elegir.
 *
 * La comprobación de verdad sigue en `assertMaySignUp` (lib/auth.ts): esto es
 * presentación.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const { plan } = await searchParams;
  const mode = signupMode();
  return (
    <SignupForm
      mode={mode}
      needsCode={signupNeedsCode(mode, Boolean((process.env.SIGNUP_INVITE_CODE ?? '').trim()))}
      trialDays={trialDays()}
      defaultPlan={trialPlanCode(isTrialPlanCode(plan) ? plan : null)}
      // RANURA DEL CONSENTIMIENTO (legal, 0188): la casilla de la autorización
      // de tratamiento (components/legal/SignupConsent.tsx). Lo que se guarda
      // lo hace components/legal/ConsentGate.tsx en la primera página con sesión.
      consent={<SignupConsent />}
    />
  );
}

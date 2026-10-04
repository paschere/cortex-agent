import { SignupConsent } from '@/components/legal/SignupConsent';
import {
  isTrialPlanCode,
  signupMode,
  signupNeedsCode,
  trialDays,
  trialPlanCode,
} from '@/lib/billing/config';
import { safeNextPath } from '@/lib/invite-landing';
import { readInvitationLanding } from '@/lib/team/invitation-landing';
import { invitationIdFromNext, landingState } from '@/lib/team/invitation-landing-shape';
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
  searchParams: Promise<{ plan?: string; next?: string }>;
}) {
  const { plan, next } = await searchParams;
  const mode = signupMode();

  /**
   * ¿VIENE DE UNA INVITACIÓN? El correo se busca AQUÍ, en el servidor, a partir
   * del id que ya trae el destino (`?next=/accept-invitation/<id>`), y no se
   * pasa como `?email=`: una dirección en la URL queda en el historial, en los
   * registros del proxy y en el `Referer`, y cualquiera podría armar un enlace
   * que precargue un correo ajeno. Sólo una invitación viva y pendiente
   * precarga algo; cualquier otro caso es el registro de siempre.
   */
  const invitationId = invitationIdFromNext(safeNextPath(next));
  const invitation = invitationId ? await readInvitationLanding(invitationId) : null;
  const invite =
    invitation && landingState(invitation) === 'valid'
      ? {
          email: invitation.email,
          organizationName: invitation.organizationName,
          inviterName: invitation.inviterName,
          loginHref: `/login?next=${encodeURIComponent(`/accept-invitation/${invitation.id}`)}`,
        }
      : null;

  return (
    <SignupForm
      invite={invite}
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

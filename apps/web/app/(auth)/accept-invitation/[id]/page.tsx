import { auth } from '@/lib/auth';
import { readInvitationLanding } from '@/lib/team/invitation-landing';
import {
  companyInitial,
  invitationPath,
  justCreated,
  landingAction,
  landingState,
} from '@/lib/team/invitation-landing-shape';
import {
  expiryCountdown,
  expiryDate,
  invitationRoleBlurb,
  invitationRoleLabel,
} from '@/lib/team/invitation-roles';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { AuthBody, AuthDocument, AuthMasthead, AuthTitle } from '../../_components/AuthDocument';
import { InvitationActions } from './InvitationActions';

export const dynamic = 'force-dynamic';

// Un enlace de invitación no se indexa ni se muestra en buscadores.
export const metadata: Metadata = {
  title: 'Invitación',
  robots: { index: false, follow: false },
};

/**
 * La página a la que llega el enlace del correo (/accept-invitation/<id>).
 *
 * ES PÚBLICA, y esa es la mitad del arreglo: quien recibe una invitación casi
 * nunca tiene cuenta todavía, y antes el middleware lo mandaba a /login sin
 * decirle quién lo invitó ni a qué. Ahora ve la empresa, quién invitó, con qué
 * rol entra y cuándo vence — y desde ahí crea la cuenta con el correo ya puesto.
 *
 * Qué se muestra en cada situación lo decide `landingState` / `landingAction`
 * (puros, con prueba); esta página sólo los pinta. Un id que no existe contesta
 * lo mismo que cualquier enlace muerto: «no encontramos esta invitación», sin
 * pistas de si existió.
 */
export default async function AcceptInvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { id } = await params;
  const { auto } = await searchParams;
  const [invite, session] = await Promise.all([
    readInvitationLanding(id),
    auth.api.getSession({ headers: await headers() }),
  ]);

  const state = landingState(invite);
  const viewer = session?.user
    ? ({ kind: 'signed-in', email: session.user.email } as const)
    : ({ kind: 'anonymous' } as const);
  const action = landingAction(state, viewer, invite?.email ?? null);
  const here = invitationPath(id);

  // Ni el nombre de la empresa ni nada más sale si la invitación no está viva o
  // aceptada: un enlace muerto no es una ventana a la empresa.
  const showsDetails = invite && (state === 'valid' || state === 'accepted' || state === 'expired');

  let actions: ReactNode = null;
  if (invite && action === 'signup-or-login') {
    // `auto=1` viaja en el destino del registro: venir de crear la cuenta con
    // este enlace equivale a aceptar. El login, en cambio, NO lo lleva: quien ya
    // tenía cuenta decide con los dos botones.
    const signupNext = encodeURIComponent(`${here}?auto=1`);
    actions = (
      <InvitationActions
        invitationId={id}
        kind="signup-or-login"
        signupHref={`/signup?next=${signupNext}`}
        loginHref={`/login?next=${encodeURIComponent(here)}`}
      />
    );
  } else if (invite && action === 'respond') {
    actions = (
      <InvitationActions
        invitationId={id}
        kind="respond"
        auto={auto === '1' && justCreated(session?.user.createdAt)}
      />
    );
  } else if (invite && action === 'switch-account') {
    actions = (
      <InvitationActions
        invitationId={id}
        kind="switch-account"
        invitedEmail={invite.email}
        loginHref={`/login?next=${encodeURIComponent(here)}`}
      />
    );
  } else if (action === 'open-app') {
    actions = <InvitationActions invitationId={id} kind="open-app" />;
  } else if (action === 'login-only') {
    actions = (
      <InvitationActions
        invitationId={id}
        kind="login-only"
        loginHref={`/login?next=${encodeURIComponent('/')}`}
      />
    );
  }

  return (
    <AuthDocument>
      <AuthMasthead note="Te invitaron a trabajar con Cortex." />
      <AuthBody>
        {showsDetails ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              {invite.organizationLogo ? (
                <img
                  src={invite.organizationLogo}
                  alt=""
                  className="h-11 w-11 rounded-sm border border-border object-cover"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 items-center justify-center rounded-sm bg-primary-soft text-lg font-bold text-primary"
                >
                  {companyInitial(invite.organizationName)}
                </span>
              )}
              <div className="min-w-0">
                <div className="field-label">Empresa</div>
                <div className="truncate text-base font-semibold text-ink">
                  {invite.organizationName}
                </div>
              </div>
            </div>

            <AuthTitle
              hint={
                state === 'valid'
                  ? 'Cortex es el gerente de IA de tu empresa: recuerda cómo trabaja, cuida la cartera y la caja y hace lo rutinario con tu aprobación.'
                  : undefined
              }
            >
              {state === 'accepted'
                ? 'Esta invitación ya se aceptó'
                : state === 'expired'
                  ? 'Esta invitación venció'
                  : `${invite.inviterName} te invitó a ${invite.organizationName}`}
            </AuthTitle>

            {state === 'expired' && (
              <p className="mb-5 text-sm leading-snug text-ink-muted">
                Venció el {expiryDate(invite.expiresAt)}. Pídele a {invite.inviterName} que te la
                envíe de nuevo: es un clic para esa persona.
              </p>
            )}

            {state === 'valid' && (
              <dl className="mb-5 space-y-3 rounded-sm border border-border bg-surface-2 p-4 text-sm">
                <Row label="Tu rol">
                  <span className="font-semibold text-ink">{invitationRoleLabel(invite.role)}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {invitationRoleBlurb(invite.role)}
                  </span>
                </Row>
                <Row label="Correo invitado">
                  <span className="break-all font-mono text-ink">{invite.email}</span>
                </Row>
                <Row label="Vence">
                  <span className="text-ink">
                    {expiryCountdown(invite.expiresAt).replace('vence ', '')}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {expiryDate(invite.expiresAt)}
                  </span>
                </Row>
              </dl>
            )}

            {state === 'valid' && invite.message && (
              <blockquote className="mb-5 whitespace-pre-line rounded-sm border-l-4 border-primary bg-primary-soft px-4 py-3 text-sm leading-snug text-ink">
                <span className="field-label mb-1 block">Mensaje de {invite.inviterName}</span>
                {invite.message}
              </blockquote>
            )}

            {viewer.kind === 'signed-in' && action === 'switch-account' && invite && (
              <p className="mb-4 rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-xs leading-snug text-ink">
                Entraste como <span className="font-mono">{viewer.email}</span>, pero esta
                invitación es para <span className="font-mono">{invite.email}</span>. Para aceptarla
                tienes que entrar con ese correo.
              </p>
            )}
            {viewer.kind === 'anonymous' && state === 'valid' && invite && (
              <p className="mb-4 text-xs leading-snug text-ink-faint">
                Si todavía no tienes cuenta, la creas con{' '}
                <span className="font-mono">{invite.email}</span> y entras directo a{' '}
                {invite.organizationName}.
              </p>
            )}

            {actions}
          </>
        ) : (
          <AuthTitle
            hint={
              state === 'closed'
                ? 'Quien te invitó la canceló, o ya la habías rechazado. Si crees que es un error, pídele que te invite de nuevo.'
                : 'Revisa que el enlace esté completo o pídele a quien te invitó que te lo envíe otra vez.'
            }
          >
            {state === 'closed'
              ? 'Esta invitación ya no está disponible'
              : 'No encontramos esta invitación'}
          </AuthTitle>
        )}
      </AuthBody>
    </AuthDocument>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

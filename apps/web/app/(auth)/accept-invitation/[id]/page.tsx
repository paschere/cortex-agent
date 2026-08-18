'use client';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/provenance';
import { authClient } from '@/lib/auth-client';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import {
  AuthBody,
  AuthDocument,
  AuthError,
  AuthMasthead,
  AuthTitle,
} from '../../_components/AuthDocument';

/**
 * Landing page for organization invitation emails
 * (/accept-invitation/<invitationId>). The route is session-protected by
 * middleware, so an invitee without an account signs up / signs in first and
 * is bounced back here via the ?next= param.
 */
export default function AcceptInvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function respond(action: 'accept' | 'reject') {
    setState('working');
    setErr(null);
    const { data, error } =
      action === 'accept'
        ? await authClient.organization.acceptInvitation({ invitationId: id })
        : await authClient.organization.rejectInvitation({ invitationId: id });
    if (error) {
      setErr(
        error.message ??
          'No se pudo responder la invitación; puede que ya haya vencido. Pide una nueva.',
      );
      setState('idle');
      return;
    }
    /**
     * ACEPTAR NO TE METÍA EN EL ESPACIO, Y ESE ERA EL FALLO ENTERO.
     *
     * `acceptInvitation` de better-auth crea la membresía y NO toca
     * `activeOrganizationId` de la sesión (comprobado en la 1.6.24). Así que la
     * persona aceptaba, volvía a `/`, y seguía en el espacio vacío que se le
     * había fabricado al registrarse: la empresa que la invitó existía, ella era
     * miembro, y no la veía por ningún lado.
     *
     * El id del espacio sale de lo que devolvió el propio aceptar, y se manda a
     * `/api/organizations/active`, que es la MISMA ruta que usa el selector — y
     * por tanto la misma comprobación de membresía contra la base antes de mover
     * la sesión. No se inventa aquí una segunda forma de cambiar de espacio.
     *
     * Si algo falla, no se bloquea: la membresía YA existe, así que se sigue a
     * `/` y el peor caso es que aterrice en su otro espacio y tenga que elegir
     * este en el selector. Eso es un inconveniente; quedarse en esta pantalla
     * después de haber aceptado sería un callejón.
     */
    if (action === 'accept') {
      const joined = data as { member?: { organizationId?: string } } | null;
      const organizationId = joined?.member?.organizationId;
      if (organizationId) {
        await fetch('/api/organizations/active', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId }),
        }).catch(() => {});
      }
    }

    setState('done');
    // Recarga entera y no `router.push`: el espacio activo acaba de cambiar y
    // todo el árbol de servidor está renderizado contra el anterior.
    if (action === 'accept') window.location.assign('/');
    else router.push('/login');
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        <AuthTitle hint="Al aceptar, tu cuenta queda ligada al espacio de trabajo y a sus agentes, su Brain Knowledge y sus integraciones.">
          Invitación al espacio de trabajo
        </AuthTitle>

        {/* The invitation id is the one checkable fact on this screen — it is
            what an admin needs if the invite has to be traced. */}
        <Field label="Invitación" className="mb-5">
          <span className="block truncate" title={id}>
            {id}
          </span>
        </Field>

        <div className="flex gap-3">
          <Button
            type="button"
            disabled={state !== 'idle'}
            onClick={() => respond('accept')}
            className="flex-1 py-2.5"
          >
            {state === 'working' ? 'Un momento…' : 'Aceptar'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={state !== 'idle'}
            onClick={() => respond('reject')}
            className="flex-1 py-2.5"
          >
            Rechazar
          </Button>
        </div>

        {err && <AuthError>{err}</AuthError>}
      </AuthBody>
    </AuthDocument>
  );
}

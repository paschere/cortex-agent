import { auth } from '@/lib/auth';
import { safeNextPath } from '@/lib/invite-landing';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthBody, AuthDocument, AuthMasthead, AuthTitle } from '../_components/AuthDocument';
import { SwitchAccount } from './SwitchAccount';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ese espacio no está en tu cuenta · Cortex' };

/**
 * A DONDE LLEGA UN ENLACE DE UN ESPACIO QUE NO ES DE ESTA CUENTA.
 *
 * Un enlace con `?workspace=` nombra una empresa concreta, y `requireSession`
 * nunca cae a otra cuando la pestaña la pidió explícitamente (lib/organization.ts):
 * eso es lo correcto, pero antes se veía como «Application error» con un número.
 * El caso típico no es un intruso, es alguien con dos cuentas que abrió el enlace
 * en el navegador donde tiene la otra. Así que se dice con qué correo está
 * dentro y se ofrecen las dos salidas: su propio espacio, o entrar con la cuenta
 * correcta y volver al mismo enlace.
 *
 * Vive en (auth) y no en (app) porque el layout de (app) resuelve el espacio, y
 * ése es justo el paso que aquí no se puede dar.
 */
export default async function WorkspaceUnavailablePage({
  searchParams,
}: { searchParams: Promise<{ next?: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  const { next } = await searchParams;
  const back = safeNextPath(next ?? null);
  if (!session?.user) redirect(back ? `/login?next=${encodeURIComponent(back)}` : '/login');

  return (
    <AuthDocument>
      <AuthMasthead />
      <AuthBody>
        <AuthTitle
          hint={
            <>
              Abriste un enlace de una empresa a la que la cuenta{' '}
              <strong className="font-semibold text-ink">{session.user.email}</strong> no pertenece.
              Puede que ese enlace sea de otra cuenta tuya, o que ya no tengas acceso.
            </>
          }
        >
          Ese espacio no está en esta cuenta
        </AuthTitle>
        <SwitchAccount loginHref={back ? `/login?next=${encodeURIComponent(back)}` : '/login'} />
      </AuthBody>
    </AuthDocument>
  );
}

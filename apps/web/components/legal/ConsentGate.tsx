import {
  currentAccount,
  pendingConsents,
  recordConsents,
  requestFingerprint,
} from '@/lib/legal/consent-store';
import { SIGNUP_CONSENT_COOKIE, decodeSignupConsent, missingConsents } from '@/lib/legal/versions';
import { logger } from '@cortex/core';
import { cookies } from 'next/headers';
import { ConsentModal } from './ConsentModal';

/**
 * EL AVISO QUE NO SE PUEDE SALTAR.
 *
 * Va en los dos layouts con sesión ((app) y (chat)). Si a la persona le falta
 * aceptar la versión vigente de la autorización de tratamiento o de los
 * términos, la aplicación queda tapada por un aviso que sólo se cierra
 * aceptando (o saliendo). Es lo que hace que subir una versión en
 * lib/legal/versions.ts vuelva a pedirla a todo el mundo.
 *
 * LA CASILLA DEL REGISTRO. Quien se acaba de registrar ya marcó la casilla, y
 * la marca viajó en la cookie SIGNUP_CONSENT_COOKIE. Si la persona no tiene
 * NINGUNA autorización previa (cuenta nueva) y la cookie cubre las versiones
 * vigentes, se guarda aquí con origen «registro» — la IP y el navegador son los
 * de esta misma visita, un instante después — y no se le vuelve a preguntar.
 * Con autorizaciones previas la cookie se ignora: una revocación reciente no
 * puede deshacerse sola con una cookie vieja.
 *
 * SI LA TABLA NO RESPONDE, NO SE BLOQUEA A NADIE. Un fallo de la base (o la
 * 0188 sin aplicar) no puede dejar a todas las empresas fuera de su
 * herramienta: se registra el error y la página sigue. Es la misma postura del
 * middleware con la sesión (fail open, el control real está en otra parte).
 */
export async function ConsentGate({ organizationId }: { organizationId: string }) {
  try {
    const account = await currentAccount();
    if (!account) return null;
    const pending = await pendingConsents(account.id);
    if (pending.missing.length === 0) return null;

    if (!pending.hadPrevious) {
      const fromSignup = decodeSignupConsent((await cookies()).get(SIGNUP_CONSENT_COOKIE)?.value);
      if (fromSignup.length > 0 && missingConsents(fromSignup).length === 0) {
        const fp = await requestFingerprint();
        await recordConsents({
          accountId: account.id,
          organizationId,
          documents: pending.missing,
          source: 'registro',
          ipHash: fp.ipHash,
          userAgent: fp.userAgent,
        });
        return null;
      }
    }

    return <ConsentModal missing={pending.missing} updated={pending.hadPrevious} />;
  } catch (err) {
    logger.error('legal: no se pudo comprobar la autorización de tratamiento', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

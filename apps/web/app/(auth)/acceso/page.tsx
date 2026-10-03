import { signupMode } from '@/lib/billing/config';
import { redirect } from 'next/navigation';
import { AccessRequestForm } from './AccessRequestForm';

export const dynamic = 'force-dynamic';

/**
 * /acceso — «Pide tu acceso». Sólo con SIGNUP_MODE=request.
 *
 * En los otros modos la página no tiene sentido: en 'invite' no hay quien
 * revise (se pide por el canal de siempre) y en 'open' cualquiera entra solo.
 * Se manda a /signup en vez de pintar un formulario que nadie va a leer.
 */
export default function AccessRequestPage() {
  if (signupMode() !== 'request') redirect('/signup');
  return <AccessRequestForm />;
}

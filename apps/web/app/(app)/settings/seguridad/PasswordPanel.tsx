'use client';

import { Button } from '@/components/ui/button';
import { Panel, PanelHead } from '@/components/ui/panel';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage } from '@/lib/auth-error-message';
import { KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';

/**
 * Cambiar (o crear) la contraseña: se manda un enlace al correo de la cuenta,
 * el mismo flujo de «Olvidé mi contraseña». Un solo camino para las dos cosas
 * —quien entra sólo con Google también crea así su primera contraseña— y la
 * prueba de identidad es poder abrir ese correo.
 */
export function PasswordPanel({ email, hasPassword }: { email: string; hasPassword: boolean }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setBusy(false);
    if (failure) {
      setError(authErrorMessage(failure, 'No se pudo enviar el enlace. Inténtalo de nuevo.'));
      return;
    }
    setSent(true);
  }

  return (
    <Panel>
      <PanelHead title="Contraseña" icon={<KeyRound className="h-4 w-4" />} />
      <div className="space-y-3 px-6 pb-6 pt-3 text-sm">
        <p className="text-ink-muted">
          {hasPassword
            ? 'Te enviamos un enlace a tu correo para elegir una contraseña nueva.'
            : 'Tu cuenta entra con Google. Crea una contraseña si quieres entrar también con correo o activar la verificación en dos pasos: te enviamos un enlace a tu correo.'}
        </p>
        {sent ? (
          <p className="rounded-sm border border-emerald/30 bg-emerald-soft px-3 py-2 text-xs text-ink">
            Listo. Revisa <strong className="font-semibold">{email}</strong> y abre el enlace.
          </p>
        ) : (
          <Button variant="outline" onClick={() => void send()} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {hasPassword ? 'Enviarme el enlace para cambiarla' : 'Enviarme el enlace para crearla'}
          </Button>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
          >
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

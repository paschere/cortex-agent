'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  AuthBody,
  AuthDocument,
  AuthError,
  AuthMasthead,
  AuthTitle,
} from '../_components/AuthDocument';

/**
 * TOTP challenge shown after a correct password when the account has
 * two-factor enabled (see onTwoFactorRedirect in lib/auth-client.ts).
 * Accepts either a 6-digit authenticator code or a backup code.
 */
export default function TwoFactorPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [trust, setTrust] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: trust });
    setLoading(false);
    if (error) {
      setErr(
        error.message ??
          (useBackup
            ? 'Ese código de respaldo no fue aceptado. Cada uno sirve una sola vez: prueba con otro.'
            : 'Ese código no fue aceptado. Los códigos cambian cada 30 segundos: escribe el actual.'),
      );
      return;
    }
    router.push('/');
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        <AuthTitle
          hint={
            useBackup
              ? 'Escribe uno de los códigos de respaldo que guardaste al activar la verificación en dos pasos.'
              : 'Escribe el código de 6 dígitos de tu app de autenticación.'
          }
        >
          Verificación en dos pasos
        </AuthTitle>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="totp-code" className="field-label">
              {useBackup ? 'Código de respaldo' : 'Código de autenticación'}
            </label>
            {/* The code is the one thing on this screen that gets read digit by
                digit, so it gets the widest, largest monospaced setting in the
                whole auth flow. */}
            <input
              id="totp-code"
              type="text"
              required
              inputMode={useBackup ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={useBackup ? 'xxxx-xxxx' : '000000'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="tabular mt-1 w-full rounded-sm border border-border bg-surface-2 px-3 py-3 text-center text-[19px] tracking-[0.3em] text-ink transition-colors placeholder:text-ink-faint focus:border-primary focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10"
            />
          </div>

          {!useBackup && (
            <label className="flex items-center gap-2 text-[12px] text-ink-muted">
              <input
                type="checkbox"
                checked={trust}
                onChange={(e) => setTrust(e.target.checked)}
                className="accent-primary"
              />
              Confiar en este dispositivo por 60 días
            </label>
          )}

          <Button type="submit" disabled={loading} className="w-full py-2.5">
            {loading ? 'Verificando…' : 'Verificar'}
          </Button>
        </form>

        <button
          type="button"
          onClick={() => {
            setUseBackup((v) => !v);
            setCode('');
            setErr(null);
          }}
          className="mt-4 w-full text-center text-[12px] font-semibold text-primary hover:underline"
        >
          {useBackup ? 'Usar el código de la app' : 'Usar un código de respaldo'}
        </button>

        {err && <AuthError>{err}</AuthError>}
      </AuthBody>
    </AuthDocument>
  );
}

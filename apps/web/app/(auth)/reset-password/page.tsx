'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  AuthBody,
  AuthDocument,
  AuthError,
  AuthField,
  AuthMasthead,
  AuthTitle,
} from '../_components/AuthDocument';

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setErr(
        'Este enlace no trae token de recuperación. Pide uno nuevo desde «¿Olvidaste tu contraseña?».',
      );
      return;
    }
    setLoading(true);
    setErr(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setLoading(false);
    if (error) {
      setErr(
        error.message ??
          'Este enlace ya no sirve. Pide uno nuevo desde «¿Olvidaste tu contraseña?».',
      );
      return;
    }
    router.push('/login');
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        <AuthTitle hint="Elige una que no uses en ninguna otra parte. Reemplaza la anterior de inmediato.">
          Elige una contraseña nueva
        </AuthTitle>
        <form onSubmit={submit} className="space-y-3">
          <AuthField
            label="Contraseña nueva"
            mono
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            placeholder="10 caracteres o más"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={loading} className="w-full py-2.5">
            {loading ? 'Guardando…' : 'Guardar contraseña'}
          </Button>
        </form>
        <p className="mt-4 text-center text-[12px]">
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Volver a iniciar sesión
          </Link>
        </p>
        {err && <AuthError>{err}</AuthError>}
      </AuthBody>
    </AuthDocument>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams requires a Suspense boundary during prerender.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

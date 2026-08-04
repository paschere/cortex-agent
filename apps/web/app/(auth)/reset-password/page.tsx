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
      setErr('This link carries no reset token. Request a new one from Forgot password.');
      return;
    }
    setLoading(true);
    setErr(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setLoading(false);
    if (error) {
      setErr(
        error.message ?? 'This link no longer works. Request a new one from Forgot password.',
      );
      return;
    }
    router.push('/login');
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        <AuthTitle hint="Pick something you don't use anywhere else. It replaces the old password immediately.">
          Choose a new password
        </AuthTitle>
        <form onSubmit={submit} className="space-y-3">
          <AuthField
            label="New password"
            mono
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            placeholder="10 characters or more"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={loading} className="w-full py-2.5">
            {loading ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
        <p className="mt-4 text-center text-[12px]">
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Back to sign in
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

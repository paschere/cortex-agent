'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import Link from 'next/link';
import { useState } from 'react';
import {
  AuthBody,
  AuthDocument,
  AuthError,
  AuthField,
  AuthMasthead,
  AuthTitle,
} from '../_components/AuthDocument';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setLoading(false);
    if (error) {
      setErr(error.message ?? 'The request did not go through. Check the address and try again.');
      return;
    }
    setSent(true);
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        {sent ? (
          <AuthTitle
            hint={
              <>
                If an account exists for <span className="font-mono text-ink">{email}</span>, a
                reset link is on its way. It stops working after{' '}
                <span className="tabular">1 hour</span>.
              </>
            }
          >
            Check your inbox
          </AuthTitle>
        ) : (
          <>
            <AuthTitle hint="Give us the address on the account and we'll send a link to choose a new password.">
              Reset your password
            </AuthTitle>
            <form onSubmit={submit} className="space-y-3">
              <AuthField
                label="Email"
                mono
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" disabled={loading} className="w-full py-2.5">
                {loading ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
          </>
        )}

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

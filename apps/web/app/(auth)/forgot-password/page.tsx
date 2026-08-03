'use client';

import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';

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
      setErr(error.message ?? 'Request failed');
      return;
    }
    setSent(true);
  }

  return (
    <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
      <h1 className="text-xl font-extrabold tracking-tight">Reset your password</h1>
      {sent ? (
        <p className="mt-2 text-[13px] leading-snug text-ink-muted">
          If an account exists for <span className="font-semibold">{email}</span>, a reset link is on
          its way. The link is valid for 1 hour.
        </p>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-snug text-ink-muted">
            Enter your email and we&apos;ll send you a link to choose a new password.
          </p>
          <form onSubmit={submit} className="mt-5 space-y-3">
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-[13px] outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </>
      )}
      <p className="mt-4 text-center text-[11.5px] text-ink-faint">
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
      {err && (
        <p className="mt-4 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {err}
        </p>
      )}
    </div>
  );
}

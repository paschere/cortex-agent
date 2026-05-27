'use client';

import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signIn() {
    setLoading(true);
    setErr(null);
    try {
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: new URLSearchParams(window.location.search).get('next') ?? '/',
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign in failed');
      setLoading(false);
    }
  }

  return (
    <div className="max-w-sm w-full rounded-2xl border bg-white dark:bg-neutral-900 p-8 shadow-sm">
      <h1 className="text-2xl font-semibold mb-2">Zipdev Agent</h1>
      <p className="text-neutral-500 text-sm mb-6">
        Sign in with your @zipdev.com Google account.
      </p>
      <button
        type="button"
        onClick={signIn}
        disabled={loading}
        className="w-full rounded-xl bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 py-2.5 font-medium hover:opacity-90 disabled:opacity-50"
      >
        {loading ? 'Redirecting…' : 'Continue with Google'}
      </button>
      {err && <p className="mt-4 text-sm text-red-600">{err}</p>}
    </div>
  );
}

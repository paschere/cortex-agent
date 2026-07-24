'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
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
    <div className="w-full max-w-sm overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="hero-mesh px-8 py-10 text-white">
        <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-white/15 backdrop-blur">
          <Sparkles className="h-6 w-6" />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight">Zippy</h1>
        <p className="mt-1 text-[13px] text-white/75">Your AI sales co-pilot.</p>
      </div>
      <div className="p-8">
        <p className="mb-6 text-[13px] text-ink-muted">
          Sign in with your <span className="font-semibold text-ink">@zipdev.com</span> Google account.
        </p>
        <button
          type="button"
          onClick={signIn}
          disabled={loading}
          className="w-full rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
        >
          {loading ? 'Redirecting…' : 'Continue with Google'}
        </button>
        {err && <p className="mt-4 text-sm text-rose">{err}</p>}
      </div>
    </div>
  );
}

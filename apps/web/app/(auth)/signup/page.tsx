'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Zap } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'google' | 'email' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function signUpGoogle() {
    setLoading('google');
    setErr(null);
    try {
      await authClient.signIn.social({ provider: 'google', callbackURL: '/' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign up failed');
      setLoading(null);
    }
  }

  async function signUpEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading('email');
    setErr(null);
    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: '/',
    });
    if (error) {
      setErr(error.message ?? 'Sign up failed');
      setLoading(null);
      return;
    }
    // Verification email goes out on signup (sendOnSignUp) — tell the user.
    setDone(true);
  }

  if (done) {
    return (
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
        <h1 className="text-xl font-extrabold tracking-tight">Check your inbox</h1>
        <p className="mt-2 text-[13px] leading-snug text-ink-muted">
          We sent a verification link to <span className="font-semibold">{email}</span>. Click it to
          activate your Cortex account.
        </p>
        <Link
          href="/login"
          className="mt-6 block w-full rounded-pill bg-primary py-2.5 text-center font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="hero-mesh relative px-8 py-7 text-white">
        <h1 className="text-2xl font-extrabold tracking-tight">Create your Cortex account</h1>
        <p className="mt-1 text-[13px] font-medium text-white/80">
          Start free. Invite your team to a shared workspace when you&apos;re ready.
        </p>
      </div>

      <div className="p-8">
        <form onSubmit={signUpEmail} className="space-y-3">
          <input
            type="text"
            required
            autoComplete="name"
            placeholder="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-[13px] outline-none focus:border-primary"
          />
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-[13px] outline-none focus:border-primary"
          />
          <input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            placeholder="Password (10+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-[13px] outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={loading !== null}
            className="w-full rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
          >
            {loading === 'email' ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-ink-faint">
          <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          onClick={signUpGoogle}
          disabled={loading !== null}
          className="flex w-full items-center justify-center gap-2 rounded-pill border border-border py-2.5 font-semibold text-ink transition-colors hover:bg-primary-soft disabled:opacity-50"
        >
          {loading === 'google' ? (
            'Redirecting…'
          ) : (
            <>
              <Zap className="h-4 w-4" /> Continue with Google
            </>
          )}
        </button>

        <p className="mt-4 text-center text-[11.5px] text-ink-faint">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Sign in
          </Link>
        </p>

        {err && (
          <p className="mt-4 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
            {err}
          </p>
        )}
      </div>
    </div>
  );
}

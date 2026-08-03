'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShieldCheck, Workflow, BrainCircuit, Zap } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

const HIGHLIGHTS = [
  { icon: BrainCircuit, text: 'Every system your company runs, in one brain' },
  { icon: Workflow, text: 'Reusable playbooks and unattended routines' },
  { icon: ShieldCheck, text: 'You approve every write — everything is audited' },
];

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'google' | 'email' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function nextUrl() {
    return new URLSearchParams(window.location.search).get('next') ?? '/';
  }

  async function signInGoogle() {
    setLoading('google');
    setErr(null);
    try {
      await authClient.signIn.social({ provider: 'google', callbackURL: nextUrl() });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign in failed');
      setLoading(null);
    }
  }

  async function signInEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading('email');
    setErr(null);
    const { error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: nextUrl(),
    });
    if (error) {
      setErr(error.message ?? 'Sign in failed');
      setLoading(null);
    }
  }

  return (
    <div className="w-full max-w-sm overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="hero-mesh relative px-8 py-9 text-white">
        <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-white/15 backdrop-blur">
          {/* App icon lives at /icon.png (Next metadata) — same mark as the tab. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" className="h-9 w-9" />
        </span>
        <h1 className="mt-5 text-3xl font-extrabold tracking-tight">Cortex</h1>
        <p className="mt-1 text-[13px] font-medium text-white/80">
          The AI super-agent for your whole company. It sells, recruits, runs ops, and never sleeps.
        </p>
      </div>

      <div className="p-8">
        <ul className="mb-6 space-y-2.5">
          {HIGHLIGHTS.map((h) => (
            <li key={h.text} className="flex items-start gap-2.5 text-[12.5px] leading-snug text-ink-muted">
              <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-[7px] bg-primary-soft text-primary">
                <h.icon className="h-3 w-3" />
              </span>
              {h.text}
            </li>
          ))}
        </ul>

        <form onSubmit={signInEmail} className="space-y-3">
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
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-[10px] border border-border bg-transparent px-3 py-2.5 text-[13px] outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={loading !== null}
            className="w-full rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
          >
            {loading === 'email' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-ink-faint">
          <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          onClick={signInGoogle}
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

        <div className="mt-4 flex items-center justify-between text-[11.5px] text-ink-faint">
          <Link href="/forgot-password" className="hover:text-ink-muted">
            Forgot password?
          </Link>
          <Link href="/signup" className="font-semibold text-primary hover:underline">
            Create an account
          </Link>
        </div>

        {err && (
          <p className="mt-4 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
            {err}
          </p>
        )}
      </div>
    </div>
  );
}

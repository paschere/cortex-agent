'use client';

import { useState } from 'react';
import { ShieldCheck, Workflow, BrainCircuit, Zap } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

const HIGHLIGHTS = [
  { icon: BrainCircuit, text: 'Every system Zipdev runs, in one brain' },
  { icon: Workflow, text: 'Reusable playbooks and unattended routines' },
  { icon: ShieldCheck, text: 'You approve every write — everything is audited' },
];

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
      <div className="hero-mesh relative px-8 py-9 text-white">
        <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-white/15 backdrop-blur">
          {/* App icon lives at /icon.png (Next metadata) — same mark as the tab. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" className="h-9 w-9" />
        </span>
        <h1 className="mt-5 text-3xl font-extrabold tracking-tight">Zippy</h1>
        <p className="mt-1 text-[13px] font-medium text-white/80">
          Zipdev&apos;s super-agent. It sells, recruits, runs HR, and never sleeps.
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

        <button
          type="button"
          onClick={signIn}
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-pill bg-primary py-2.5 font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
        >
          {loading ? (
            'Redirecting…'
          ) : (
            <>
              <Zap className="h-4 w-4" /> Continue with Google
            </>
          )}
        </button>
        <p className="mt-3 text-center text-[11.5px] text-ink-faint">
          Use your <span className="font-semibold text-ink-muted">@zipdev.com</span> account
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

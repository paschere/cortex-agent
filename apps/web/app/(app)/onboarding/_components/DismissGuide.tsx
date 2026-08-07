'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Closing the guide. It is never closed for you — see readOnboarding. */
export function DismissGuide() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function dismiss() {
    setBusy(true);
    try {
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: true }),
      });
      startTransition(() => router.push('/dashboard'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void dismiss()}
      disabled={busy}
      className="text-[12.5px] font-semibold text-ink-faint transition-colors duration-150 hover:text-ink motion-reduce:transition-none"
    >
      {busy ? 'Cerrando…' : 'No me muestres esta guía'}
    </button>
  );
}

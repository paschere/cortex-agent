'use client';

import { Loader2, Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** La contraseña de una vista compartida. El servidor recuerda el acceso 12 horas. */
export function PasswordGate({ token, name }: { token: string; name: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="mx-auto mt-10 max-w-sm rounded-card border border-border bg-surface p-6 shadow-card sm:mt-16">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
        <Lock className="h-5 w-5" />
      </span>
      <h1 className="mt-4 text-lg font-bold text-ink">{name}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Esta vista está protegida. Escribe la contraseña que te compartieron.
      </p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const res = await fetch('/api/views/public/unlock', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token, password }),
            }).catch(() => null);
            if (res?.ok) {
              router.refresh();
              return;
            }
            const body = (await res?.json().catch(() => null)) as { error?: string } | null;
            setError(body?.error ?? 'No se pudo comprobar. Inténtalo otra vez.');
          });
        }}
      >
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Contraseña"
          className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        />
        {error && (
          <p role="alert" className="text-xs text-rose">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || !password}
          className="cortex-primary-button inline-flex w-full items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-45"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Abrir
        </button>
      </form>
    </div>
  );
}

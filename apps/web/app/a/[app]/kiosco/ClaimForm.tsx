'use client';

import { claimKioskPairingAction } from '@/lib/apps/kiosk-actions';
import { Loader2, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** El botón que deja ESTE celular en modo kiosco (el enlace nunca lo hace solo: una vista previa del enlace no debe gastar el código). */
export function ClaimForm({
  appId,
  appName,
  code,
}: { appId: string; appName: string; code: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mx-auto mt-10 max-w-sm rounded-card border border-border bg-surface p-6 shadow-card sm:mt-16">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
        <Smartphone className="h-5 w-5" aria-hidden />
      </span>
      <h1 className="mt-4 text-lg font-bold text-ink">Dejar este celular en modo kiosco</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {appName} quedará en este celular para que cada persona entre con su PIN. Hazlo sólo en el
        celular que se queda en la planta.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs text-rose">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await claimKioskPairingAction(appId, code);
            if (!res.ok) return setError(res.error);
            router.replace(`/a/${appId}`);
            router.refresh();
          })
        }
        className="cortex-primary-button mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-45"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Dejar este celular en modo kiosco
      </button>
    </div>
  );
}

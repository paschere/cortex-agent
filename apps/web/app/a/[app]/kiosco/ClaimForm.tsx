'use client';

import { AppIllustration } from '@/components/apps/AppIllustration';
import { claimKioskPairingAction } from '@/lib/apps/kiosk-actions';
import { Loader2 } from 'lucide-react';
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
    <div className="app-hero mx-auto mt-2 max-w-sm rounded-[1.75rem] border border-border p-6 text-center shadow-pop sm:mt-10">
      <AppIllustration kind="lock" className="mx-auto" />
      <h1 className="mt-4 text-xl font-extrabold leading-tight tracking-tight text-ink">
        Dejar este celular en modo kiosco
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        {appName} quedará en este celular para que cada persona entre con su PIN. Hazlo sólo en el
        celular que se queda en la planta.
      </p>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-sm bg-rose-soft px-3 py-2 text-xs font-semibold text-rose"
        >
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
        className="app-press cortex-primary-button mt-5 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-pill bg-primary px-4 text-base font-bold text-white shadow-pop hover:bg-primary-strong disabled:opacity-45"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Dejar este celular en modo kiosco
      </button>
    </div>
  );
}

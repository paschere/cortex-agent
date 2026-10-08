'use client';

import { type ChallengeHandoff, ChallengeHelper } from '@/components/browser/ChallengeHelper';
import { Button } from '@/components/ui/button';
import { useCallback, useEffect, useState } from 'react';

interface View {
  kind: 'checkpoint' | 'login';
  state: 'waiting' | 'resolved' | 'unresolved';
  flow: string;
  ask: string;
  expiresAt: string;
  reason: string | null;
  handoff: ChallengeHandoff | null;
}

/**
 * La pantalla para resolver la espera de una automatización.
 *
 *   trámite parado   la misma ventana de siempre (ChallengeHelper): el código
 *                    se teclea, el captcha lo resuelve LA PERSONA con un clic en
 *                    la pestaña. Nunca se automatiza.
 *   sesión vencida   se vuelve a iniciar sesión en el perfil (en Trámites) y
 *                    aquí se avisa «ya entré».
 */
export function WaitResolver({ waitId }: { waitId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/browser/automation-waits/${waitId}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? 'No pude leer esta espera.');
      return;
    }
    setView(data as View);
  }, [waitId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error)
    return (
      <p role="alert" className="rounded-md border border-red-300 p-3 text-sm text-red-600">
        {error}
      </p>
    );
  if (!view) return <p className="text-sm text-ink-muted">Cargando…</p>;

  if (view.state === 'resolved' || done)
    return (
      <output className="block rounded-md border border-border p-4 text-sm">
        {done || 'Ya se atendió. La automatización sigue sola.'}
      </output>
    );
  if (view.state === 'unresolved')
    return (
      <p className="rounded-md border border-border p-4 text-sm">
        Quedó sin resolver: {view.reason ?? 'se acabó el tiempo'}. La próxima corrida de la
        automatización vuelve a intentarlo.
      </p>
    );

  if (view.kind === 'login')
    return (
      <div className="space-y-3 rounded-md border border-border p-4 text-sm">
        <p>{view.ask}</p>
        <p className="text-ink-muted">
          Abre el navegador de Cortex, elige el perfil del trámite, entra al portal con tu cuenta y
          vuelve aquí.
        </p>
        <div className="flex gap-2">
          <a
            className="rounded-pill border border-border px-3 py-1.5 text-xs font-semibold"
            href="/browser"
          >
            Abrir el navegador
          </a>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const res = await fetch(`/api/browser/automation-waits/${waitId}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ op: 'resolve' }),
              });
              setBusy(false);
              if (res.ok) setDone('Listo. La automatización vuelve a consultar el portal.');
              else setError('No pude registrar que ya entraste.');
            }}
          >
            Ya inicié sesión, continuar
          </Button>
        </div>
      </div>
    );

  if (!view.handoff)
    return (
      <p className="rounded-md border border-border p-4 text-sm">
        La sesión del navegador ya no está abierta, así que el trámite no se puede retomar. La
        corrida quedará sin resolver.
      </p>
    );
  return (
    <ChallengeHelper
      handoff={view.handoff}
      onFinished={({ message }) => {
        setDone(`${message} La automatización sigue sola en un minuto.`);
      }}
    />
  );
}

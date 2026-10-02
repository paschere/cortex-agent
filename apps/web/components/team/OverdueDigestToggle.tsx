'use client';

import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { BellRing, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { TeamActionResult } from './types';

/**
 * EL INTERRUPTOR DEL RESUMEN DIARIO DE VENCIDOS (0177).
 *
 * Una casilla para toda la empresa: si está encendida, cada mañana hábil cada
 * responsable recibe UN aviso con lo suyo vencido en el registro de trabajo
 * («Tienes 3 vencidos: …»), dentro de su franja y nunca en sus días fuera.
 * Nadie recibe lo vencido de otra persona.
 */
export function OverdueDigestToggle({
  initial,
  save,
}: {
  initial: boolean;
  save: (input: { enabled: boolean }) => Promise<TeamActionResult>;
}) {
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function toggle() {
    const next = !enabled;
    setBusy(true);
    setNote(null);
    const r = await save({ enabled: next }).catch(() => ({
      ok: false as const,
      error: 'No hubo conexión con Cortex.',
    }));
    setBusy(false);
    if (r.ok) {
      setEnabled(next);
      setNote({ ok: true, text: r.note });
    } else setNote({ ok: false, text: r.error });
  }

  return (
    <Panel className="mt-6 flex flex-wrap items-start gap-4 p-5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-2">
        <BellRing className="h-4 w-4 text-primary" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-bold text-ink">Recordarle a cada quien lo suyo vencido</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Un solo aviso por persona, cada mañana hábil, con lo que tiene vencido («Tienes 3
          vencidos: …») y un enlace a Mi semana. Respeta la franja en que cada quien acepta avisos y
          sus días fuera. Nadie recibe lo vencido de otra persona.
        </p>
        {note && (
          <output className={clsx('mt-2 block text-xs', note.ok ? 'text-emerald' : 'text-rose')}>
            {note.text}
          </output>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Recordarle a cada quien lo suyo vencido"
        onClick={() => void toggle()}
        disabled={busy}
        className={clsx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60',
          enabled ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        {busy ? (
          <Loader2
            className="mx-auto h-3.5 w-3.5 animate-spin text-white motion-reduce:animate-none"
            aria-hidden
          />
        ) : (
          <span
            className={clsx(
              'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
              enabled ? 'translate-x-5' : 'translate-x-0.5',
            )}
          />
        )}
      </button>
    </Panel>
  );
}

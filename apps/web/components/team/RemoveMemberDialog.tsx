'use client';

import { Button } from '@/components/ui/button';
import { TEAM_OFFBOARDING_NOTICE } from '@/lib/team-offboarding';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Loader2, ShieldAlert, UserMinus, X } from 'lucide-react';
import { useState } from 'react';

/**
 * Retirar a alguien de una empresa, con la salida explicada ANTES de confirmar.
 *
 * `TEAM_OFFBOARDING_NOTICE` existía desde la 0138 y no lo pintaba nadie: el
 * disparador revocaba credenciales y pausaba rutinas sin que quien pulsaba lo
 * supiera. Aquí se dice qué se corta, qué se conserva y qué queda por hacer,
 * y el botón destructivo sólo aparece dentro del diálogo.
 *
 * Lo usan «Personas» de la empresa y la consola del fundador. La acción llega
 * por prop y es la que decide; este componente sólo pinta lo que contesta.
 */
export function RemoveMemberDialog({
  personLabel,
  companyName,
  onConfirm,
  onDone,
  compact = false,
  disabled = false,
}: {
  personLabel: string;
  companyName: string;
  onConfirm: () => Promise<{ ok: boolean; message?: string; error?: string }>;
  onDone?: () => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await onConfirm();
      if (!result.ok) {
        setError(result.message ?? result.error ?? 'No se pudo retirar a esta persona.');
        return;
      }
      setOpen(false);
      onDone?.();
    } catch {
      setError('No se pudo retirar a esta persona. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Retirar a ${personLabel} de ${companyName}`}
          title="Retirar de la empresa"
          className={clsx(
            'inline-flex min-h-8 items-center gap-1.5 rounded-pill text-xs font-semibold text-ink-muted transition-colors hover:bg-rose-soft hover:text-rose focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose/40 disabled:cursor-not-allowed disabled:opacity-40',
            compact ? 'w-8 justify-center' : 'px-2.5',
          )}
        >
          <UserMinus className="h-3.5 w-3.5" aria-hidden />
          {!compact && 'Retirar'}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(520px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm border border-rose/30 bg-rose-soft text-rose">
                <ShieldAlert className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-bold text-ink">
                  {TEAM_OFFBOARDING_NOTICE.title}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-ink-muted">
                  Retirar a <strong className="font-semibold text-ink">{personLabel}</strong> de{' '}
                  <strong className="font-semibold text-ink">{companyName}</strong>.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className="rounded-sm p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
              aria-label="Cerrar"
              disabled={busy}
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
            <p className="text-ink">{TEAM_OFFBOARDING_NOTICE.summary}</p>
            <p className="text-ink-muted">{TEAM_OFFBOARDING_NOTICE.retained}</p>
            <p className="rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              {TEAM_OFFBOARDING_NOTICE.followUp} Sus otros espacios no cambian.
            </p>
            {error && (
              <p
                role="alert"
                className="rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
              >
                {error}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                Cancelar
              </Button>
            </Dialog.Close>
            <Button type="button" variant="danger" onClick={confirm} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Retirar acceso
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

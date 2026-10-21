'use client';

import { type DialogRequest, settleDialog, subscribeDialogs } from '@/lib/ui/dialog-queue';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';

/**
 * Pinta, de una en una, las preguntas de `confirmDialog` / `promptDialog`.
 * Accesible (foco atrapado, Escape cancela, el foco vuelve a donde estaba),
 * con el estilo del sistema en claro y oscuro, y botones de 44 px en el
 * teléfono. Va una sola vez en `Providers`.
 */
export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  useEffect(() => subscribeDialogs(setQueue), []);
  const current = queue[0];
  if (!current) return null;
  return <Ask key={queue.length + current.title} req={current} />;
}

function Ask({ req }: { req: DialogRequest }) {
  const [text, setText] = useState(req.kind === 'prompt' ? req.initial : '');
  const done = useRef(false);

  function finish(ok: boolean) {
    if (done.current) return;
    done.current = true;
    if (req.kind === 'confirm') req.resolve(ok);
    else req.resolve(ok ? text.trim().slice(0, req.maxLength) : null);
    settleDialog(req);
  }

  const danger = req.kind === 'confirm' && req.tone === 'danger';
  return (
    <Dialog.Root open onOpenChange={(open) => !open && finish(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] animate-veil bg-canvas/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[70] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5 shadow-pop outline-none"
          onOpenAutoFocus={(e) => {
            if (req.kind === 'confirm') return;
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLElement>('textarea,input')?.focus();
          }}
        >
          <Dialog.Title className="text-base font-semibold leading-snug text-ink">
            {req.title}
          </Dialog.Title>
          {req.message ? (
            <Dialog.Description className="mt-2 text-sm leading-relaxed text-ink-muted">
              {req.message}
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{req.title}</Dialog.Description>
          )}
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              finish(true);
            }}
          >
            {req.kind === 'prompt' && (
              <label className="block text-xs font-semibold text-ink">
                {req.label}
                <textarea
                  value={text}
                  rows={3}
                  maxLength={req.maxLength}
                  placeholder={req.placeholder}
                  onChange={(e) => setText(e.target.value)}
                  className="mt-1.5 w-full resize-none rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-normal text-ink outline-none focus:border-primary"
                />
              </label>
            )}
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => finish(false)}
                className="inline-flex min-h-11 items-center justify-center rounded-pill border border-border bg-surface px-4 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 sm:min-h-9"
              >
                {req.cancelLabel}
              </button>
              <button
                type="submit"
                className={clsx(
                  'inline-flex min-h-11 items-center justify-center rounded-pill px-4 text-xs font-semibold text-white transition-colors sm:min-h-9',
                  danger ? 'bg-rose hover:opacity-90' : 'bg-primary hover:bg-primary-strong',
                )}
              >
                {req.confirmLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

'use client';

import { Button } from '@/components/ui/button';
import { MODULE } from '@/lib/browser-shape';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, Video, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { type SavedFlow, TeachFlow } from './TeachFlow';

/**
 * Enseñar un trámite sin salir de la conversación.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PERSON STARTS THIS, AND NOT THE AGENT
 * ---------------------------------------------------------------------------
 * The obvious alternative is for Cortex to offer it the moment somebody asks
 * for something only a portal can answer. It reads well and it would work
 * badly, because teaching is not a decision, it is a task: it needs the portal
 * already open, a session already logged in, and a free minute to do the errand
 * by hand. None of that is knowable from the sentence that triggered the offer,
 * and the offer arrives at the exact moment the person was trying NOT to do the
 * work themselves. An invitation that is usually declined stops being read, and
 * the thing that stops being read here is the one that explains what a screen
 * recording captures.
 *
 * So it is explicit and it is one control, next to the other things the
 * composer can start. The person opens it when they have the tab and the
 * minute.
 *
 * ---------------------------------------------------------------------------
 * AND THE CONVERSATION FINDS OUT
 * ---------------------------------------------------------------------------
 * A trámite that reproduced is immediately usable, so the dialog closes by
 * writing the request into the composer rather than sending anybody to another
 * screen to look for what they just taught. It writes it, it does not send it:
 * most trámites take a value — a placa, a NIT — and the person is the one who
 * knows which.
 */
export function TeachFlowDialog({ onCompose }: { onCompose: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedFlow | null>(null);

  const close = () => {
    setOpen(false);
    setSaved(null);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else setOpen(true);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={`Enseñarle un ${MODULE.one} a Cortex`}
          title={`Enseñarle un ${MODULE.one}: graba la pestaña una vez y lo repite solo`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none"
        >
          <Video className="h-4 w-4" aria-hidden="true" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-veil motion-reduce:animate-none" />
        <Dialog.Content className="scroll-slim fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card bg-canvas p-4 shadow-pop focus:outline-none sm:p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-ink">
                Enséñame un {MODULE.one}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs leading-snug text-ink-muted">
                Sin salir de la conversación. Al terminar queda disponible aquí mismo.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Cerrar"
                className="-mr-1 -mt-1 shrink-0 rounded-pill p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          {saved ? (
            <div className="rounded-card border border-border bg-surface p-5 shadow-card">
              <div className="flex items-start gap-2">
                <CheckCircle2
                  className={saved.verified ? 'mt-0.5 h-4 w-4 text-emerald' : 'mt-0.5 h-4 w-4 text-amber'}
                  aria-hidden="true"
                />
                <p className="text-sm leading-relaxed text-ink">{saved.message}</p>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {saved.verified ? (
                  <Button
                    onClick={() => {
                      onCompose(`Corre el trámite «${saved.name}» `);
                      close();
                    }}
                  >
                    Pedírselo ahora
                  </Button>
                ) : (
                  <Link
                    href="/browser"
                    className="inline-flex items-center rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-card transition-all duration-150 hover:border-border-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
                  >
                    Ver en {MODULE.label}
                  </Link>
                )}
                <Button variant="ghost" onClick={close}>
                  Seguir con la conversación
                </Button>
              </div>
            </div>
          ) : (
            <TeachFlow onSaved={setSaved} onCancel={close} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

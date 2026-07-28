'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Building2, Loader2, Lock, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createSpace } from '../actions';

/**
 * Creating a personal space and creating a company-wide one are the same form
 * with different weight. The global variant says out loud who ends up reading
 * it, because "everyone's Zippy will answer from this" is the whole difference
 * and it is not visible anywhere afterwards.
 */
export function SpaceDialog({
  kind,
  onClose,
  viewerName,
}: {
  kind: 'personal' | 'global';
  onClose: () => void;
  viewerName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isGlobal = kind === 'global';

  async function submit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const res = await createSpace(name, description, kind);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(520px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span
                className={
                  isGlobal
                    ? 'grid h-8 w-8 place-items-center rounded-[10px] bg-primary-soft text-primary'
                    : 'grid h-8 w-8 place-items-center rounded-[10px] bg-surface-2 text-ink-muted'
                }
              >
                {isGlobal ? <Building2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              </span>
              <div>
                <Dialog.Title className="text-sm font-bold text-ink">
                  {isGlobal ? 'New company space' : 'New personal space'}
                </Dialog.Title>
                <Dialog.Description className="text-[11.5px] text-ink-faint">
                  {isGlobal
                    ? 'Everyone at Zipdev will be able to read it'
                    : `Only ${viewerName} will be able to read it`}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
            {isGlobal && (
              <p className="rounded-[10px] border border-amber/30 bg-amber-soft px-3 py-2.5 text-[12px] leading-relaxed text-ink">
                Everything you put in a company space becomes an answer. When anyone asks Zippy
                about this subject — in chat, in Google Chat, anywhere — it will read from here and
                quote it back as what Zipdev knows. Keep drafts and half-formed notes in a personal
                space until they are true.
              </p>
            )}

            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={isGlobal ? 'Rates and pricing' : 'My client notes'}
                className="mt-1.5 w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                What goes in here
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="One line so the next person knows what belongs here."
                className="mt-1.5 w-full resize-none rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink outline-none transition placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
            </label>

            {error && (
              <p className="rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-pill px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isGlobal ? 'Publish to everyone' : 'Create space'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

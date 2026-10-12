'use client';

import { publishAppAction, unpublishAppAction } from '@/lib/apps/phase6-actions';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type AppEditorData, BTN_PRIMARY, BTN_SECONDARY, ErrorLine } from './shared';

/**
 * Publicar con versión (0225). Lo que se edita es el BORRADOR; «Publicar» saca
 * una versión numerada y es lo único que cambia lo que ven los usuarios. Un
 * resumen de lo que cambió y una nota opcional antes de confirmar.
 */
export function PublishBar({ data }: { data: AppEditorData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const published = data.app.status === 'published';
  const draft = data.draft;
  const dirty = !published || draft?.hasChanges !== false;

  function publish() {
    setError(null);
    start(async () => {
      const res = await publishAppAction(data.app.id, note.trim() || undefined);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      setNote('');
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {published && (
          <button
            type="button"
            disabled={pending}
            className={BTN_SECONDARY}
            onClick={() =>
              start(async () => {
                const res = await unpublishAppAction(data.app.id);
                if (!res.ok) setError(res.error);
                else router.refresh();
              })
            }
          >
            Despublicar
          </button>
        )}
        <button
          type="button"
          disabled={pending || (published && !dirty)}
          className={clsx(published && dirty ? BTN_PRIMARY : BTN_SECONDARY)}
          onClick={() => setOpen((o) => !o)}
        >
          {!published ? 'Publicar' : dirty ? 'Publicar cambios' : 'Todo publicado'}
        </button>
      </div>
      {published && draft?.hasChanges && !open && (
        <p className="max-w-xs text-right text-micro text-amber">
          Cambios sin publicar{draft.summary ? `: ${draft.summary}` : ''}
        </p>
      )}
      {open && (
        <div className="w-full min-w-64 space-y-2 rounded-card border border-border bg-surface p-3 shadow-pop sm:w-80">
          <p className="text-xs font-semibold text-ink">
            Se publicará como versión {(draft?.publishedNumber ?? 0) + 1}
          </p>
          {draft && draft.changes.length > 0 && (
            <ul className="max-h-28 list-disc space-y-0.5 overflow-auto pl-4 text-xs text-ink-muted">
              {draft.changes.slice(0, 6).map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: texto repetible
                <li key={i}>{c.text}</li>
              ))}
            </ul>
          )}
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota opcional: qué cambió"
            className="h-8 w-full rounded-pill border border-border bg-surface px-3 text-xs text-ink outline-none focus:border-primary"
          />
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={publish}>
              Publicar
            </button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

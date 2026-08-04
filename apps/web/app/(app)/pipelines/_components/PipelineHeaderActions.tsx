'use client';

import { Archive, ArchiveRestore, Copy, Loader2, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Edit / Duplicate / Archive actions in the pipeline detail header. */
export function PipelineHeaderActions({ slug, archived }: { slug: string; archived: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'duplicate' | 'archive' | null>(null);

  async function duplicate() {
    setBusy('duplicate');
    try {
      const res = await fetch(`/api/pipelines/${slug}/duplicate`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        window.alert(typeof data.error === 'string' ? data.error : 'No se pudo duplicar.');
        setBusy(null);
        return;
      }
      const { slug: newSlug } = (await res.json()) as { slug: string };
      router.push(`/pipelines/${newSlug}/edit`);
      router.refresh();
    } catch {
      window.alert('Error de red. Vuelve a intentarlo.');
      setBusy(null);
    }
  }

  async function toggleArchive() {
    if (
      !archived &&
      !window.confirm('¿Archivar este pipeline? Su historial de ejecuciones se conserva.')
    )
      return;
    setBusy('archive');
    try {
      const res = archived
        ? await fetch(`/api/pipelines/${slug}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: false }),
          })
        : await fetch(`/api/pipelines/${slug}`, { method: 'DELETE' });
      if (!res.ok) {
        window.alert('Esa acción falló.');
      }
      router.refresh();
    } catch {
      window.alert('Error de red. Vuelve a intentarlo.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Link
        href={`/pipelines/${slug}/edit`}
        className="inline-flex items-center gap-1.5 rounded-card bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong"
      >
        <Pencil className="h-3.5 w-3.5" /> Editar
      </Link>
      <button
        type="button"
        onClick={duplicate}
        disabled={busy !== null}
        className="inline-flex items-center gap-1.5 rounded-card border border-border-strong px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        {busy === 'duplicate' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        Duplicar
      </button>
      <button
        type="button"
        onClick={toggleArchive}
        disabled={busy !== null}
        aria-label={archived ? 'Desarchivar el pipeline' : 'Archivar el pipeline'}
        title={archived ? 'Desarchivar el pipeline' : 'Archivar el pipeline'}
        className="grid h-9 w-9 place-items-center rounded-card border border-border-strong text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        {busy === 'archive' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : archived ? (
          <ArchiveRestore className="h-4 w-4" />
        ) : (
          <Archive className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

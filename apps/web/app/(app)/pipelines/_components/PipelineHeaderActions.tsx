'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Copy, Loader2, Pencil } from 'lucide-react';

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
        window.alert(typeof data.error === 'string' ? data.error : 'Could not duplicate.');
        setBusy(null);
        return;
      }
      const { slug: newSlug } = (await res.json()) as { slug: string };
      router.push(`/pipelines/${newSlug}/edit`);
      router.refresh();
    } catch {
      window.alert('Network error — please try again.');
      setBusy(null);
    }
  }

  async function toggleArchive() {
    if (!archived && !window.confirm('Archive this pipeline? Its run history is kept.')) return;
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
        window.alert('That action failed.');
      }
      router.refresh();
    } catch {
      window.alert('Network error — please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Link
        href={`/pipelines/${slug}/edit`}
        className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
      >
        <Pencil className="h-3.5 w-3.5" /> Edit
      </Link>
      <button
        type="button"
        onClick={duplicate}
        disabled={busy !== null}
        className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 hover:text-ink disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
      >
        {busy === 'duplicate' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        Duplicate
      </button>
      <button
        type="button"
        onClick={toggleArchive}
        disabled={busy !== null}
        aria-label={archived ? 'Unarchive pipeline' : 'Archive pipeline'}
        title={archived ? 'Unarchive pipeline' : 'Archive pipeline'}
        className="grid h-9 w-9 place-items-center rounded-card border border-border-strong bg-surface text-ink-faint shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 hover:text-ink disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
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

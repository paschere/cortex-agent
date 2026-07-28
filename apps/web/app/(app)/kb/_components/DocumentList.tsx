'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { FolderSearch, Loader2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { deleteDocument, moveDocument } from '../actions';
import type { SpaceKind } from './types';

interface Doc {
  id: string;
  title: string;
  mime: string;
  status: string;
  error_message: string | null;
  source: 'upload' | 'gdrive' | 'url';
  created_at: string;
}

async function fetchDocs(spaceId: string): Promise<Doc[]> {
  const r = await fetch(`/api/kb/documents?spaceId=${spaceId}`);
  const j = await r.json();
  return (j.documents as Doc[]) ?? [];
}

const DONE_STATUSES = new Set(['ready', 'failed']);

/** Ingestion state in words, not in the database's words. */
function statusLabel(status: string): { text: string; dot: string; tone: string } {
  if (status === 'ready') return { text: 'Searchable', dot: 'bg-emerald', tone: 'text-emerald' };
  if (status === 'failed') return { text: "Couldn't be read", dot: 'bg-rose', tone: 'text-rose' };
  return { text: 'Being read…', dot: 'bg-amber', tone: 'text-amber' };
}

export function DocumentList({
  spaceId,
  spaceName,
  canWrite,
  moveTargets,
}: {
  spaceId: string;
  spaceName: string;
  canWrite: boolean;
  moveTargets: Array<{ id: string; name: string; kind: SpaceKind }>;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ['kb-docs', spaceId],
    queryFn: () => fetchDocs(spaceId),
    // Keep polling while anything is still being indexed — a document is not
    // an answer until its text has been read.
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.every((d) => DONE_STATUSES.has(d.status)) ? false : 3000;
    },
  });

  function clearError(id: string) {
    setErrors(({ [id]: _gone, ...rest }) => rest);
  }

  async function move(doc: Doc, targetId: string) {
    if (!targetId) return;
    clearError(doc.id);
    setBusy(doc.id);
    const res = await moveDocument(doc.id, targetId);
    setBusy(null);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [doc.id]: res.error }));
      return;
    }
    setNotes((n) => ({ ...n, [doc.id]: `Moved to ${res.space}.` }));
    qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
    router.refresh();
  }

  async function remove(doc: Doc) {
    clearError(doc.id);
    setBusy(doc.id);
    const res = await deleteDocument(doc.id);
    setBusy(null);
    setConfirming(null);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [doc.id]: res.error }));
      return;
    }
    qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
    router.refresh();
  }

  if (isLoading) {
    return (
      <p className="flex items-center gap-1.5 py-2 text-[12.5px] text-ink-faint">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading…
      </p>
    );
  }

  if (docs.length === 0) {
    return (
      <p className="max-w-lg py-2 text-[12.5px] leading-relaxed text-ink-muted">
        {spaceName} is empty. Drop in a rate card, a client brief, a playbook — anything you would
        otherwise have to explain twice — and Zippy can answer from it, naming the document it used.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {docs.map((d) => {
        const isDrive = d.source === 'gdrive';
        const status = statusLabel(d.status);
        const working = busy === d.id;
        return (
          <li key={d.id} className="py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-ink">{d.title}</span>
                  <span
                    className={clsx(
                      'inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 text-[10.5px] font-semibold',
                      isDrive ? 'bg-sky-soft text-sky' : 'bg-surface-2 text-ink-muted',
                    )}
                  >
                    {isDrive ? (
                      <FolderSearch className="h-3 w-3" />
                    ) : (
                      <Upload className="h-3 w-3" />
                    )}
                    {isDrive ? 'Drive' : 'Upload'}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-faint">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={clsx('h-1.5 w-1.5 rounded-full', status.dot)} />
                    <span className={clsx('font-medium', status.tone)}>{status.text}</span>
                  </span>
                  {d.error_message && (
                    <>
                      <span>&middot;</span>
                      <span className="text-rose">{d.error_message}</span>
                    </>
                  )}
                </div>
              </div>

              {canWrite && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {moveTargets.length > 0 && (
                    <select
                      value=""
                      disabled={working}
                      onChange={(e) => move(d, e.target.value)}
                      className="h-7 rounded-pill border border-border bg-surface px-2.5 text-[11.5px] font-medium text-ink-muted focus:border-border-strong focus:outline-none disabled:opacity-50"
                      aria-label={`Move ${d.title} to another space`}
                    >
                      <option value="">Move to…</option>
                      {moveTargets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.kind === 'global' ? ' (everyone)' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setConfirming(confirming === d.id ? null : d.id)}
                    className="rounded-pill px-2.5 py-1 text-[11.5px] font-semibold text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose disabled:opacity-50"
                  >
                    {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Remove'}
                  </button>
                </div>
              )}
            </div>

            {confirming === d.id && (
              <div className="mt-2 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2.5">
                <p className="text-[12px] leading-relaxed text-ink">
                  Removing <b>{d.title}</b> deletes it and everything Zippy learned from it. Answers
                  that cited it will stop citing it. This cannot be undone.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => remove(d)}
                    className="rounded-pill bg-rose px-3 py-1 text-[11.5px] font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    Remove it
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-pill px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted transition-colors hover:bg-surface hover:text-ink"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            )}

            {errors[d.id] && (
              <p className="mt-2 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
                {errors[d.id]}
              </p>
            )}
            {notes[d.id] && !errors[d.id] && (
              <p className="mt-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-[11.5px] text-ink-muted">
                {notes[d.id]}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

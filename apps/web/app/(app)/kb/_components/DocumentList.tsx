'use client';
import { Button } from '@/components/ui/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderSearch, Upload } from 'lucide-react';

interface Doc {
  id: string;
  title: string;
  mime: string;
  status: string;
  error_message: string | null;
  source: 'upload' | 'gdrive' | 'url';
  created_at: string;
}

async function fetchDocs(collectionId: string): Promise<Doc[]> {
  const r = await fetch(`/api/kb/documents?collectionId=${collectionId}`);
  const j = await r.json();
  return (j.documents as Doc[]) ?? [];
}

const DONE_STATUSES = new Set(['ready', 'failed']);

function statusDot(status: string) {
  if (status === 'ready') return 'bg-emerald';
  if (status === 'failed') return 'bg-rose';
  return 'bg-amber';
}

function statusText(status: string) {
  if (status === 'ready') return 'text-emerald';
  if (status === 'failed') return 'text-rose';
  return 'text-amber';
}

export function DocumentList({ collectionId }: { collectionId: string }) {
  const qc = useQueryClient();

  const { data: docs = [] } = useQuery({
    queryKey: ['kb-docs', collectionId],
    queryFn: () => fetchDocs(collectionId),
    // Keep polling while any doc is still in-flight
    refetchInterval: (query) => {
      const docs = query.state.data ?? [];
      const allDone = docs.every((d) => DONE_STATUSES.has(d.status));
      return allDone ? false : 3000;
    },
  });

  async function remove(id: string) {
    await fetch(`/api/kb/documents/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['kb-docs', collectionId] });
  }

  return (
    <ul className="divide-y divide-border">
      {docs.map((d) => {
        const isDrive = d.source === 'gdrive';
        return (
          <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-ink">{d.title}</span>
                <span
                  className={
                    isDrive
                      ? 'inline-flex shrink-0 items-center gap-1 rounded-pill bg-sky-soft px-2 py-0.5 text-[11px] font-semibold text-sky'
                      : 'inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted'
                  }
                >
                  {isDrive ? <FolderSearch className="h-3 w-3" /> : <Upload className="h-3 w-3" />}
                  {isDrive ? 'Drive' : 'Upload'}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
                <span>{d.mime}</span>
                <span>&middot;</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${statusDot(d.status)}`} />
                  <span className={`font-medium ${statusText(d.status)}`}>{d.status}</span>
                </span>
                {d.error_message ? (
                  <>
                    <span>&middot;</span>
                    <span className="text-rose">{d.error_message}</span>
                  </>
                ) : null}
              </div>
            </div>
            <Button variant="ghost" onClick={() => remove(d.id)}>
              Delete
            </Button>
          </li>
        );
      })}
      {docs.length === 0 && <li className="py-2 text-sm text-ink-faint">No documents yet.</li>}
    </ul>
  );
}

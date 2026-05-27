'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';

interface Doc {
  id: string;
  title: string;
  mime: string;
  status: string;
  error_message: string | null;
  created_at: string;
}

async function fetchDocs(collectionId: string): Promise<Doc[]> {
  const r = await fetch(`/api/kb/documents?collectionId=${collectionId}`);
  const j = await r.json();
  return (j.documents as Doc[]) ?? [];
}

const DONE_STATUSES = new Set(['ready', 'failed']);

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
    <ul className="divide-y">
      {docs.map((d) => (
        <li
          key={d.id}
          className="py-2 flex items-center justify-between text-sm"
        >
          <div>
            <div className="font-medium">{d.title}</div>
            <div className="text-neutral-500 text-xs">
              {d.mime} &middot;{' '}
              <span
                className={
                  d.status === 'ready'
                    ? 'text-green-600'
                    : d.status === 'failed'
                      ? 'text-red-600'
                      : 'text-yellow-600'
                }
              >
                {d.status}
              </span>
              {d.error_message ? ` · ${d.error_message}` : ''}
            </div>
          </div>
          <Button variant="ghost" onClick={() => remove(d.id)}>
            Delete
          </Button>
        </li>
      ))}
      {docs.length === 0 && (
        <li className="py-2 text-sm text-neutral-500">No documents yet.</li>
      )}
    </ul>
  );
}

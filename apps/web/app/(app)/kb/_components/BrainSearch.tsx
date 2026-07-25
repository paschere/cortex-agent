'use client';
import { useState } from 'react';
import { Search, Sparkles, FileText } from 'lucide-react';

interface Hit {
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}

/** Hero search across every collection the user can see — "ask the brain". */
export function BrainSearch({ collectionIds }: { collectionIds: string[] }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!q.trim() || collectionIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/kb/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, collection_ids: collectionIds }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? 'Search failed');
        setHits(null);
      } else {
        setHits(j.hits ?? []);
      }
    } catch (e) {
      setError(String(e));
      setHits(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        Ask the brain
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="Search everything Zipdev knows — rates, clients, playbooks, candidates…"
            className="w-full rounded-[12px] border border-border bg-canvas py-2.5 pl-9 pr-3 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
          />
        </div>
        <button
          type="button"
          onClick={go}
          disabled={loading || !q.trim()}
          className="rounded-[12px] bg-primary px-4 text-[13px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && <p className="mt-3 text-[12.5px] text-rose">{error}</p>}

      {hits !== null && !error && (
        <div className="mt-4 space-y-2.5">
          {hits.length === 0 ? (
            <p className="text-[12.5px] text-ink-faint">
              No matches. The brain only knows what has been ingested — upload documents or ask
              Zippy to save knowledge with <code className="font-mono text-[11px]">kb.create_document</code>.
            </p>
          ) : (
            hits.map((h) => (
              <div
                key={`${h.documentId}-${h.chunkIndex}`}
                className="rounded-[12px] border border-border bg-canvas px-3.5 py-3"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-ink">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate">{h.documentTitle}</span>
                    <span className="shrink-0 font-normal text-ink-faint">· chunk {h.chunkIndex}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(Math.min(1, Math.max(0, h.score)) * 100)}%` }}
                      />
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                      {(h.score ?? 0).toFixed(2)}
                    </span>
                  </span>
                </div>
                <p className="line-clamp-3 text-[12.5px] leading-relaxed text-ink-muted">{h.content}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

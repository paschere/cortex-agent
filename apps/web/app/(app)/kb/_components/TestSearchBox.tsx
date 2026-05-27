'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Hit {
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export function TestSearchBox({ collectionId }: { collectionId: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/kb/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, collection_ids: [collectionId] }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? 'Search failed');
        setHits([]);
      } else {
        setHits(j.hits ?? []);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Try a query…"
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <Button onClick={go} disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
      {hits.map((h) => (
        <div
          key={`${h.documentId}-${h.chunkIndex}`}
          className="rounded-xl border p-3 text-sm"
        >
          <div className="font-medium text-xs text-neutral-500 mb-1">
            {h.documentTitle} &middot; chunk {h.chunkIndex} &middot; score{' '}
            {h.score.toFixed(3)}
          </div>
          <div className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">
            {h.content.slice(0, 400)}
            {h.content.length > 400 ? '…' : ''}
          </div>
        </div>
      ))}
      {hits.length === 0 && !loading && q && !error && (
        <p className="text-sm text-neutral-500">No results.</p>
      )}
    </div>
  );
}

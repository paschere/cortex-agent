'use client';
import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UploadDropzone } from './UploadDropzone';
import { DocumentList } from './DocumentList';
import { DriveConnect } from './DriveConnect';
import { TestSearchBox } from './TestSearchBox';
import { useQueryClient } from '@tanstack/react-query';

interface Collection {
  id: string;
  name: string;
  scope: 'global' | 'team' | 'user' | 'conversation';
  scope_id: string | null;
  gdrive_folder_id: string | null;
}

export function CollectionView({
  scope,
  scopeId,
  title,
}: {
  scope: 'global' | 'team' | 'user';
  scopeId: string | null;
  title: string;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();

  const load = useCallback(async () => {
    const r = await fetch('/api/kb/collections');
    const j = await r.json();
    const all = (j.collections as Collection[]) ?? [];
    const filtered = all.filter(
      (c) =>
        c.scope === scope &&
        (scopeId ? c.scope_id === scopeId : c.scope_id === null),
    );
    setCollections(filtered);
    setSelectedId((prev) => {
      if (prev && filtered.some((c) => c.id === prev)) return prev;
      return filtered[0]?.id ?? null;
    });
  }, [scope, scopeId]);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    const body: Record<string, unknown> = { name: newName, scope };
    if (scopeId) body.scope_id = scopeId;
    const r = await fetch('/api/kb/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setCreating(false);
    if (r.ok) {
      setNewName('');
      load();
    }
  }

  const selected = collections.find((c) => c.id === selectedId);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>

      <Card>
        <h2 className="font-medium mb-3">New collection</h2>
        <div className="flex gap-2">
          <Input
            placeholder="Collection name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <Button onClick={create} disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </Card>

      {collections.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {collections.map((c) => (
            <Button
              key={c.id}
              variant={c.id === selectedId ? 'default' : 'outline'}
              onClick={() => setSelectedId(c.id)}
            >
              {c.name}
            </Button>
          ))}
        </div>
      )}

      {collections.length === 0 && (
        <p className="text-sm text-neutral-500">
          No collections yet. Create one above to get started.
        </p>
      )}

      {selected && (
        <>
          <Card>
            <h2 className="font-medium mb-3">Upload documents</h2>
            <UploadDropzone
              collectionId={selected.id}
              onUploaded={() => {
                qc.invalidateQueries({
                  queryKey: ['kb-docs', selected.id],
                });
              }}
            />
          </Card>
          <Card>
            <h2 className="font-medium mb-3">Google Drive sync</h2>
            <DriveConnect />
          </Card>
          <Card>
            <h2 className="font-medium mb-3">Documents</h2>
            <DocumentList collectionId={selected.id} />
          </Card>
          <Card>
            <h2 className="font-medium mb-3">Test search</h2>
            <TestSearchBox collectionId={selected.id} />
          </Card>
        </>
      )}
    </div>
  );
}

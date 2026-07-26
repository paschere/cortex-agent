'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, Eyebrow } from '@/components/ui/panel';
import { BookOpen, User, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { DocumentList } from './DocumentList';
import { DriveSyncPanel } from './DriveSyncPanel';
import { TestSearchBox } from './TestSearchBox';
import { UploadDropzone } from './UploadDropzone';

interface Collection {
  id: string;
  name: string;
  scope: 'global' | 'team' | 'user' | 'conversation';
  scope_id: string | null;
  gdrive_folder_id: string | null;
}

const SCOPE_ICON = {
  global: BookOpen,
  team: Users,
  user: User,
} as const;

export function CollectionView({
  scope,
  scopeId,
  title,
  subtitle,
}: {
  scope: 'global' | 'team' | 'user';
  scopeId: string | null;
  title: string;
  subtitle?: string;
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
      (c) => c.scope === scope && (scopeId ? c.scope_id === scopeId : c.scope_id === null),
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
  const ScopeIcon = SCOPE_ICON[scope];

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        icon={<ScopeIcon className="h-5 w-5" />}
      />

      <div className="space-y-4">
        <Panel className="p-5">
          <Eyebrow>New collection</Eyebrow>
          <div className="mt-3 flex gap-2">
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
        </Panel>

        {collections.length > 0 && (
          <div className="flex flex-wrap gap-2">
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
          <Panel className="p-10 text-center text-[13px] text-ink-faint">
            <ScopeIcon className="mx-auto mb-3 h-8 w-8 text-primary" />
            <p className="mb-1 font-semibold text-ink">No collections yet</p>
            <p className="mx-auto max-w-md">Create one above to get started.</p>
          </Panel>
        )}

        {selected && (
          <>
            <Panel className="p-5">
              <Eyebrow>Upload documents</Eyebrow>
              <div className="mt-3">
                <UploadDropzone
                  collectionId={selected.id}
                  onUploaded={() => {
                    qc.invalidateQueries({
                      queryKey: ['kb-docs', selected.id],
                    });
                  }}
                />
              </div>
            </Panel>
            <DriveSyncPanel collectionId={selected.id} />
            <Panel className="p-5">
              <Eyebrow>Documents</Eyebrow>
              <div className="mt-3">
                <DocumentList collectionId={selected.id} />
              </div>
            </Panel>
            <Panel className="p-5">
              <Eyebrow>Test search</Eyebrow>
              <div className="mt-3">
                <TestSearchBox collectionId={selected.id} />
              </div>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}

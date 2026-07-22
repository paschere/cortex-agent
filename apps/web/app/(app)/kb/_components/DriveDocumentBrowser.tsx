'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, FileText, FolderClosed, Link2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface DriveFile {
  id: string;
  name: string;
  isFolder: boolean;
  mimeType: string;
  modifiedTime: string | null;
  size: string | null;
  md5Checksum: string | null;
}

interface BrowsePage {
  connected: boolean;
  files: DriveFile[];
  nextPageToken: string | null;
}

interface Crumb {
  id: string;
  name: string;
}

const ROOT: Crumb = { id: 'root', name: 'My Drive' };

async function fetchBrowse(parentId: string, q: string, pageToken?: string): Promise<BrowsePage> {
  const params = new URLSearchParams({ parentId });
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  const r = await fetch(`/api/kb/drive/browse?${params.toString()}`);
  if (!r.ok) throw new Error(`Browse failed (${r.status})`);
  const j = (await r.json()) as Partial<BrowsePage>;
  return {
    connected: j.connected ?? false,
    files: j.files ?? [],
    nextPageToken: j.nextPageToken ?? null,
  };
}

export function DriveDocumentBrowser({
  collectionId,
  onClose,
}: {
  collectionId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [path, setPath] = useState<Crumb[]>([ROOT]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Selected files keyed by id so we can build the import payload.
  const [selected, setSelected] = useState<Map<string, DriveFile>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const current = path[path.length - 1] ?? ROOT;
  const parentId = current.id;
  const atRoot = path.length === 1;

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['drive-folders', collectionId, parentId, debouncedSearch],
    queryFn: ({ pageParam }) => fetchBrowse(parentId, debouncedSearch, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextPageToken ?? undefined,
  });

  const connected = data?.pages[0]?.connected ?? true;
  const files = useMemo(() => (data ? data.pages.flatMap((p) => p.files) : []), [data]);

  function drillInto(folder: DriveFile) {
    setSearch('');
    setDebouncedSearch('');
    setActionError(null);
    setPath((prev) => [...prev, { id: folder.id, name: folder.name }]);
  }

  function jumpTo(index: number) {
    if (index === path.length - 1) return;
    setSearch('');
    setDebouncedSearch('');
    setActionError(null);
    setPath((prev) => prev.slice(0, index + 1));
  }

  function toggleFile(file: DriveFile) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });
  }

  function invalidateAndClose() {
    qc.invalidateQueries({ queryKey: ['kb-docs', collectionId] });
    qc.invalidateQueries({ queryKey: ['drive-sync', collectionId] });
    onClose();
  }

  async function importFiles() {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const r = await fetch('/api/kb/drive/import-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionId,
          files: Array.from(selected.values()).map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
          })),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Import failed (${r.status})`);
      }
      setSelected(new Map());
      invalidateAndClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function linkFolder() {
    if (atRoot || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const r = await fetch('/api/kb/drive/link-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionId,
          folderId: current.id,
          folderName: current.name,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Link failed (${r.status})`);
      }
      invalidateAndClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Link failed');
    } finally {
      setSubmitting(false);
    }
  }

  const selectedCount = selected.size;

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumbs */}
      <nav className="flex flex-wrap items-center gap-1 px-5 pt-4 text-[13px] text-ink-muted">
        {path.map((crumb, i) => (
          <span key={crumb.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />}
            <button
              type="button"
              onClick={() => jumpTo(i)}
              disabled={i === path.length - 1}
              className="rounded-[8px] px-1.5 py-0.5 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-default disabled:font-semibold disabled:text-ink disabled:hover:bg-transparent"
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {/* Search */}
      <div className="px-5 pt-3">
        <Input
          placeholder="Search this folder…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* List */}
      <div className="mt-3 flex-1 overflow-y-auto px-5">
        {!connected ? (
          <p className="py-10 text-center text-[13px] text-ink-muted">
            Google Drive isn’t connected yet. Connect Drive to browse and import files.
          </p>
        ) : isLoading ? (
          <ul className="divide-y divide-border">
            {['s1', 's2', 's3', 's4', 's5', 's6'].map((key) => (
              <li key={key} className="flex items-center gap-3 py-2.5">
                <span className="h-5 w-5 animate-pulse rounded-[6px] bg-surface-2" />
                <span className="h-3.5 w-1/2 animate-pulse rounded-full bg-surface-2" />
              </li>
            ))}
          </ul>
        ) : isError ? (
          <div className="my-4 rounded-[10px] border border-rose/30 bg-rose-soft px-4 py-3 text-[13px] text-rose">
            <div className="font-medium">Couldn’t load this folder.</div>
            <div className="mt-0.5 text-rose/80">
              {error instanceof Error ? error.message : 'Something went wrong.'}
            </div>
            <Button variant="outline" className="mt-2.5" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : files.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-ink-faint">
            {debouncedSearch ? 'No files match your search.' : 'This folder is empty.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {files.map((f) =>
              f.isFolder ? (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => drillInto(f)}
                    className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="grid h-6 w-6 place-items-center text-amber">
                      <FolderClosed className="h-4 w-4" />
                    </span>
                    <span className="flex-1 truncate text-[13px] font-medium text-ink">
                      {f.name}
                    </span>
                    <ChevronRight className="h-4 w-4 text-ink-faint" />
                  </button>
                </li>
              ) : (
                <li key={f.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggleFile(f)}
                      className="peer sr-only"
                    />
                    <span className="grid h-6 w-6 place-items-center rounded-[7px] border border-border bg-surface text-ink-faint transition-colors peer-checked:border-primary/40 peer-checked:bg-primary-soft peer-checked:text-primary">
                      <FileText className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex-1 truncate text-[13px] text-ink-muted peer-checked:font-medium peer-checked:text-ink">
                      {f.name}
                    </span>
                  </label>
                </li>
              ),
            )}
          </ul>
        )}

        {hasNextPage && (
          <div className="py-3 text-center">
            <Button variant="ghost" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>

      {/* Footer action bar */}
      <div className="border-t border-border px-5 py-3">
        {actionError && (
          <div className="mb-2.5 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
            {actionError}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-faint">
            {selectedCount > 0
              ? `${selectedCount} file${selectedCount === 1 ? '' : 's'} selected`
              : atRoot
                ? 'Open a folder to link it for sync'
                : 'Select files or link this folder'}
          </span>
          <div className="flex items-center gap-2">
            {!atRoot && (
              <Button variant="outline" onClick={linkFolder} disabled={submitting}>
                <Link2 className="h-3.5 w-3.5" />
                Link this folder for sync
              </Button>
            )}
            {selectedCount > 0 && (
              <Button onClick={importFiles} disabled={submitting}>
                <Download className="h-3.5 w-3.5" />
                Import {selectedCount} file{selectedCount === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

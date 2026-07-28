'use client';
import { Button } from '@/components/ui/button';
import { IconChip, Panel, PanelHead } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { useQuery } from '@tanstack/react-query';
import { FolderClosed, FolderSearch } from 'lucide-react';
import { useState } from 'react';
import { DriveBrowserModal } from './DriveBrowserModal';

interface DriveStatus {
  connected: boolean;
  folder: { id: string; name: string | null } | null;
  lastSyncedAt: string | null;
  gdriveDocCount: number;
}

async function fetchStatus(spaceId: string): Promise<DriveStatus> {
  const r = await fetch(`/api/kb/drive/status?spaceId=${spaceId}`);
  const j = (await r.json()) as Partial<DriveStatus>;
  return {
    connected: j.connected ?? false,
    folder: j.folder ?? null,
    lastSyncedAt: j.lastSyncedAt ?? null,
    gdriveDocCount: j.gdriveDocCount ?? 0,
  };
}

export function DriveSyncPanel({ spaceId }: { spaceId: string }) {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['drive-sync', spaceId],
    queryFn: () => fetchStatus(spaceId),
    // Poll while a folder is linked but the first sync hasn't landed yet.
    refetchInterval: (query) => {
      const s = query.state.data;
      if (s?.folder && !s.lastSyncedAt) return 3000;
      return false;
    },
  });

  const connected = data?.connected;
  const folder = data?.folder ?? null;
  const synced = !!folder && !!data?.lastSyncedAt;

  let right: React.ReactNode = null;
  if (data) {
    if (!connected) {
      right = 'Not connected';
    } else if (folder) {
      right = (
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${synced ? 'bg-emerald' : 'bg-amber'}`} />
          <span className={synced ? 'text-emerald' : 'text-amber'}>
            {synced ? 'Synced' : 'Syncing…'}
          </span>
        </span>
      );
    } else {
      right = 'Connected';
    }
  }

  return (
    <Panel>
      <PanelHead icon={<FolderSearch className="h-4 w-4" />} title="Google Drive" right={right} />
      <div className="px-5 pb-5 pt-3">
        {!data ? (
          <div className="h-9 w-40 animate-pulse rounded-pill bg-surface-2" />
        ) : !connected ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-ink-muted">
              Connect Google Drive to import files or link a folder for continuous sync.
            </p>
            <a
              href="/api/integrations/google?preset=drive"
              className="inline-flex items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15"
            >
              <FolderSearch className="h-3.5 w-3.5" />
              Connect Google Drive
            </a>
          </div>
        ) : folder ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-card border border-border bg-surface-2 px-3 py-2.5">
              <IconChip tone="amber">
                <FolderClosed className="h-4 w-4" />
              </IconChip>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">
                  {folder.name ?? folder.id}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${synced ? 'bg-emerald' : 'bg-amber'}`}
                  />
                  <span>
                    {data.lastSyncedAt
                      ? `Synced ${relativeTime(data.lastSyncedAt)}`
                      : 'Waiting for first sync…'}
                  </span>
                  <span>&middot;</span>
                  <span>
                    {data.gdriveDocCount} file
                    {data.gdriveDocCount === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setOpen(true)}>
                Change folder
              </Button>
              <Button variant="ghost" onClick={() => setOpen(true)}>
                Browse
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-ink-muted">
              Drive is connected. Browse to import files or link a folder for continuous sync.
            </p>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <FolderSearch className="h-3.5 w-3.5" />
              Browse Drive
            </Button>
          </div>
        )}
      </div>

      <DriveBrowserModal spaceId={spaceId} open={open} onOpenChange={setOpen} />
    </Panel>
  );
}

'use client';
import { IconChip } from '@/components/ui/panel';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderSearch, X } from 'lucide-react';
import { DriveDocumentBrowser } from './DriveDocumentBrowser';

export function DriveBrowserModal({
  spaceId,
  open,
  onOpenChange,
}: {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2.5">
              <IconChip tone="sky">
                <FolderSearch className="h-4 w-4" />
              </IconChip>
              <div>
                <Dialog.Title className="text-sm font-semibold text-ink">
                  Browse Google Drive
                </Dialog.Title>
                <Dialog.Description className="text-xs text-ink-faint">
                  Import files or link a folder for continuous sync.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 place-items-center rounded-[10px] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1">
            <DriveDocumentBrowser spaceId={spaceId} onClose={() => onOpenChange(false)} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

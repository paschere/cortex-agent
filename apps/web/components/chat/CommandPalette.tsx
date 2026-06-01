'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/40"
      onClick={onClose}
    >
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Command className="rounded-xl border shadow-xl bg-white dark:bg-neutral-900 overflow-hidden">
          <Command.Input
            placeholder="Type a command or search..."
            className="w-full px-4 py-3 text-sm outline-none border-b bg-transparent"
          />
          <Command.List className="max-h-72 overflow-y-auto p-2">
            <Command.Empty className="py-4 text-center text-sm text-neutral-500">
              No results.
            </Command.Empty>
            <Command.Group heading="Navigation">
              <Command.Item
                onSelect={() => {
                  router.push('/chat');
                  onClose();
                }}
                className="px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-neutral-100 dark:aria-selected:bg-neutral-800"
              >
                New Chat
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  router.push('/conversations');
                  onClose();
                }}
                className="px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-neutral-100 dark:aria-selected:bg-neutral-800"
              >
                Conversations
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  router.push('/kb');
                  onClose();
                }}
                className="px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-neutral-100 dark:aria-selected:bg-neutral-800"
              >
                Knowledge Base
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  router.push('/integrations');
                  onClose();
                }}
                className="px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 aria-selected:bg-neutral-100 dark:aria-selected:bg-neutral-800"
              >
                Integrations
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

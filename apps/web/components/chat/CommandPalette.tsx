'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface Entry {
  href: string;
  label: string;
  /** Extra words the fuzzy search should match, for pages people rename in their head. */
  keywords: string;
}

const NAVIGATION: Entry[] = [
  { href: '/dashboard', label: 'Dashboard', keywords: 'home overview' },
  { href: '/chat', label: 'New Chat', keywords: 'cortex ask' },
  { href: '/conversations', label: 'Conversations', keywords: 'history threads' },
  { href: '/approvals', label: 'Approvals', keywords: 'pending confirm' },
  { href: '/kb', label: 'Brain Knowledge', keywords: 'kb knowledge base docs brain search' },
  { href: '/pipelines', label: 'Pipelines', keywords: 'playbooks workflows' },
  { href: '/schedules', label: 'Routines', keywords: 'scheduled jobs cron' },
  { href: '/settings', label: 'Settings', keywords: 'preferences digest timezone' },
];

const CONNECTIONS: Entry[] = [
  {
    href: '/integrations',
    label: 'Integrations — what Cortex is connected to',
    keywords: 'google hubspot workable slack github linear apollo payroll mcp servers',
  },
  {
    href: '/mcp-tokens',
    label: 'Connect Claude — use Cortex from an AI client',
    keywords: 'claude code chatgpt mcp connector url token oauth',
  },
];

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  if (!open) return null;

  const go = (href: string) => {
    router.push(href);
    onClose();
  };

  const item = (e: Entry) => (
    <Command.Item
      key={e.href}
      value={`${e.label} ${e.keywords}`}
      onSelect={() => go(e.href)}
      className="cursor-pointer rounded-[10px] px-3 py-2 text-[13px] text-ink-muted aria-selected:bg-surface-2 aria-selected:text-ink hover:bg-surface-2 hover:text-ink"
    >
      {e.label}
    </Command.Item>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 pt-[20vh] backdrop-blur-sm"
      // Close on backdrop click only — comparing target to currentTarget avoids
      // needing a stopPropagation handler on the panel itself.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-lg">
        <Command className="overflow-hidden rounded-card border border-border bg-surface shadow-pop">
          <Command.Input
            placeholder="Type a command or search…"
            className="w-full border-b border-border bg-transparent px-4 py-3 text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
          <Command.List className="max-h-72 overflow-y-auto p-2">
            <Command.Empty className="py-4 text-center text-[13px] text-ink-faint">
              No results.
            </Command.Empty>
            <Command.Group
              heading="Navigation"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-faint"
            >
              {NAVIGATION.map(item)}
            </Command.Group>
            <Command.Group
              heading="Connections"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-faint"
            >
              {CONNECTIONS.map(item)}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

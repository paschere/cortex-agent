'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@zipdev/core';
import { clsx } from 'clsx';
import {
  AlarmClock,
  BarChart3,
  BookOpen,
  Bot,
  Cable,
  Calculator,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  ScrollText,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  UsersRound,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMobileSidebar } from './MobileSidebarContext';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  label: string;
  items: NavItem[];
  adminOnly?: boolean;
}

const SECTIONS: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/chat', label: 'Chat', icon: MessageSquare },
      { href: '/approvals', label: 'Approvals', icon: Inbox },
      { href: '/conversations', label: 'Conversations', icon: MessagesSquare },
      { href: '/kb', label: 'Knowledge Base', icon: BookOpen },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
  {
    label: 'Tools',
    items: [
      { href: '/pipelines', label: 'Pipelines', icon: Workflow },
      { href: '/tools', label: 'Tools', icon: Wrench },
      { href: '/agents', label: 'Agents', icon: Bot },
      { href: '/schedules', label: 'Scheduled Jobs', icon: AlarmClock },
      { href: '/chat?tool=rate', label: 'Rate Calculator', icon: Calculator },
    ],
  },
  {
    // A pair, deliberately adjacent: one page is Zippy reaching out to other
    // systems, the other is an AI client reaching in. They used to read as
    // duplicates when they sat in different groups under similar names.
    label: 'Connections',
    items: [
      { href: '/integrations', label: 'Integrations', icon: Plug },
      { href: '/mcp-tokens', label: 'Connect Claude', icon: Cable },
    ],
  },
  {
    label: 'System',
    adminOnly: true,
    items: [
      { href: '/admin/users', label: 'Users', icon: Users },
      { href: '/admin/teams', label: 'Teams', icon: UsersRound },
      { href: '/admin/usage', label: 'Analytics', icon: BarChart3 },
      { href: '/admin/audit', label: 'Audit Logs', icon: ScrollText },
      { href: '/admin/security', label: 'Security', icon: ShieldCheck },
    ],
  },
];

interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  agents?: { name: string } | { name: string }[] | null;
}

async function fetchConversations(): Promise<Conversation[]> {
  const r = await fetch('/api/conversations');
  if (!r.ok) return [];
  const j = await r.json();
  return (j.conversations as Conversation[]) ?? [];
}

function isActive(pathname: string, href: string): boolean {
  const base = href.split('?')[0];
  if (base === '/dashboard') return pathname === '/dashboard';
  return pathname === base || pathname.startsWith(`${base}/`);
}

function NavLink({
  item,
  collapsed,
  pathname,
}: { item: NavItem; collapsed: boolean; pathname: string }) {
  const Icon = item.icon;
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={clsx(
        'group relative flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] transition-colors',
        active
          ? 'bg-primary-soft font-semibold text-primary-ink'
          : 'font-medium text-ink-muted hover:bg-surface-2 hover:text-ink',
        collapsed && 'justify-center px-0',
      )}
    >
      {active && !collapsed && (
        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
      )}
      <Icon
        className={clsx(
          'h-[18px] w-[18px] shrink-0',
          active ? 'text-primary' : 'text-ink-faint group-hover:text-ink-muted',
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={clsx('flex items-center gap-2.5', collapsed && 'justify-center')}>
      {/* App icon (Next metadata route) — same mark as the browser tab. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.png" alt="Zippy" className="h-9 w-9 shrink-0" />
      {!collapsed && (
        <div className="leading-tight">
          <div className="text-sm font-extrabold tracking-tight text-ink">Zippy</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            by Zipdev
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarContent({
  role,
  collapsed,
  onNavigate,
}: {
  role?: Role;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 60_000,
  });

  const recent = conversations.slice(0, 5);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    // Optimistically remove from the cached list.
    queryClient.setQueryData<Conversation[]>(['conversations'], (prev) =>
      (prev ?? []).filter((c) => c.id !== id),
    );
    const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      // Re-sync on failure.
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      return;
    }
    // If the open chat was deleted, leave it.
    if (pathname === `/chat/${id}`) router.push('/chat');
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegated close for the mobile drawer — keyboard activation of the links inside already dispatches a click.
    <nav
      className="scroll-slim flex h-full flex-col gap-1 overflow-y-auto px-3 pb-4"
      onClick={onNavigate}
    >
      {SECTIONS.filter((s) => !s.adminOnly || role === 'org_admin').map((section) => (
        <div key={section.label} className="mt-3">
          {!collapsed && (
            <div className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              {section.label}
            </div>
          )}
          {collapsed && <div className="my-2 border-t border-border" />}
          <div className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <NavLink key={item.href} item={item} collapsed={collapsed} pathname={pathname} />
            ))}
          </div>
        </div>
      ))}

      {!collapsed && recent.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Recent
          </div>
          <div className="flex flex-col gap-0.5">
            {recent.map((c) => {
              const href = `/chat/${c.id}`;
              const active = pathname === href;
              return (
                <div key={c.id} className="group/conv relative">
                  <Link
                    href={href}
                    title={c.title ?? 'Untitled'}
                    className={clsx(
                      'block truncate rounded-[10px] py-1.5 pl-2.5 pr-8 text-[13px] transition-colors',
                      active
                        ? 'bg-primary-soft font-semibold text-primary-ink'
                        : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                    )}
                  >
                    {c.title?.trim() || 'Untitled'}
                  </Link>
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, c.id)}
                    aria-label="Delete conversation"
                    title="Delete conversation"
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded-[7px] p-1 text-ink-faint opacity-0 transition-opacity hover:bg-rose-soft hover:text-rose focus:opacity-100 group-hover/conv:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}

export function Sidebar({ role }: { role?: Role }) {
  const [collapsed, setCollapsed] = useState(false);
  const { open, setOpen } = useMobileSidebar();

  useEffect(() => {
    setCollapsed(localStorage.getItem('sidebar_collapsed') === 'true');
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
  }

  return (
    <>
      {/* Desktop: collapsible panel, hidden on mobile */}
      <aside
        className={clsx(
          'hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 md:flex',
          collapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <div
          className={clsx(
            'flex items-center justify-between px-3 py-4',
            collapsed && 'px-0 justify-center',
          )}
        >
          <Brand collapsed={collapsed} />
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              className="rounded-[10px] p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-muted"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>
        {collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            className="mx-auto mb-1 rounded-[10px] p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-muted"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
        <div className="min-h-0 flex-1">
          <SidebarContent role={role} collapsed={collapsed} />
        </div>
      </aside>

      {/* Mobile: Radix Dialog drawer */}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm md:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-72 border-r border-border bg-surface shadow-xl outline-none md:hidden">
            <div className="flex items-center justify-between px-3 py-4">
              <Dialog.Title asChild>
                <div>
                  <Brand collapsed={false} />
                </div>
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close menu"
                className="rounded-[10px] p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-muted"
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Navigation menu</Dialog.Description>
            <div className="h-[calc(100%-4.5rem)]">
              <SidebarContent role={role} collapsed={false} onNavigate={() => setOpen(false)} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

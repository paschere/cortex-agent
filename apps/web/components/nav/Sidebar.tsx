'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  MessageSquare,
  MessagesSquare,
  BookOpen,
  Plug,
  KeyRound,
  Bot,
  Users,
  UsersRound,
  ScrollText,
  BarChart2,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import type { Role } from '@zipdev/core';
import { useMobileSidebar } from './MobileSidebarContext';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const PRIMARY_LINKS: NavItem[] = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { href: '/kb', label: 'Knowledge Base', icon: BookOpen },
  { href: '/integrations', label: 'Integrations', icon: Plug },
  { href: '/mcp-tokens', label: 'MCP Tokens', icon: KeyRound },
  { href: '/agents', label: 'Agents', icon: Bot },
];

const ADMIN_LINKS: NavItem[] = [
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/teams', label: 'Teams', icon: UsersRound },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
  { href: '/admin/usage', label: 'Usage', icon: BarChart2 },
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

type Bucket = 'Today' | 'Yesterday' | 'This week' | 'Older';

const BUCKET_ORDER: Bucket[] = ['Today', 'Yesterday', 'This week', 'Older'];

function bucketFor(iso: string): Bucket {
  const now = new Date();
  const then = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((startOfToday.getTime() - startOfThen.getTime()) / dayMs);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'This week';
  return 'Older';
}

function groupConversations(items: Conversation[]): Array<[Bucket, Conversation[]]> {
  const groups = new Map<Bucket, Conversation[]>();
  for (const c of items) {
    const b = bucketFor(c.updated_at);
    const arr = groups.get(b) ?? [];
    arr.push(c);
    groups.set(b, arr);
  }
  return BUCKET_ORDER.filter((b) => groups.has(b)).map((b) => [b, groups.get(b)!] as [Bucket, Conversation[]]);
}

function NavLink({ item, collapsed, pathname }: { item: NavItem; collapsed: boolean; pathname: string }) {
  const Icon = item.icon;
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={clsx(
        'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-neutral-100 dark:bg-neutral-800 font-medium'
          : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
        collapsed && 'justify-center',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function SectionLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  if (collapsed) return <div className="my-2 border-t dark:border-neutral-800" />;
  return <div className="mt-4 mb-1 px-2 text-xs uppercase tracking-wider text-neutral-400">{children}</div>;
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
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 60_000,
  });

  const grouped = groupConversations(conversations);

  return (
    <nav className="flex h-full flex-col gap-0.5 overflow-y-auto p-2" onClick={onNavigate}>
      {PRIMARY_LINKS.map((item) => (
        <NavLink key={item.href} item={item} collapsed={collapsed} pathname={pathname} />
      ))}

      {role === 'org_admin' && (
        <>
          <SectionLabel collapsed={collapsed}>Admin</SectionLabel>
          {ADMIN_LINKS.map((item) => (
            <NavLink key={item.href} item={item} collapsed={collapsed} pathname={pathname} />
          ))}
        </>
      )}

      {!collapsed && (
        <>
          <SectionLabel collapsed={collapsed}>Recent</SectionLabel>
          {grouped.length === 0 ? (
            <p className="px-2 py-1 text-xs text-neutral-400">No conversations yet</p>
          ) : (
            grouped.map(([bucket, items]) => (
              <div key={bucket} className="mb-1">
                <div className="px-2 py-1 text-[11px] font-medium text-neutral-400">{bucket}</div>
                {items.map((c) => {
                  const href = `/chat/${c.id}`;
                  const active = pathname === href;
                  return (
                    <Link
                      key={c.id}
                      href={href}
                      className={clsx(
                        'block truncate rounded-lg px-2 py-1 text-sm transition-colors',
                        active
                          ? 'bg-neutral-100 dark:bg-neutral-800 font-medium'
                          : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                      )}
                      title={c.title ?? 'Untitled'}
                    >
                      {c.title?.trim() || 'Untitled'}
                    </Link>
                  );
                })}
              </div>
            ))
          )}
        </>
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
          'hidden md:flex flex-col shrink-0 border-r dark:border-neutral-800 transition-[width] duration-200',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        <div className="flex items-center justify-between p-2">
          {!collapsed && (
            <span className="px-1 text-sm font-semibold text-neutral-700 dark:text-neutral-300">Zipdev</span>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <SidebarContent role={role} collapsed={collapsed} />
        </div>
      </aside>

      {/* Mobile: Radix Dialog drawer, controlled by MobileSidebarContext */}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-72 border-r bg-white shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-950 md:hidden">
            <div className="flex items-center justify-between p-2">
              <Dialog.Title className="px-1 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                Zipdev
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close menu"
                className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Navigation menu</Dialog.Description>
            <div className="h-[calc(100%-3rem)]">
              <SidebarContent role={role} collapsed={false} onNavigate={() => setOpen(false)} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

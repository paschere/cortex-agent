'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@cortex/core';
import { clsx } from 'clsx';
import {
  AlarmClock,
  BarChart3,
  BookOpen,
  Bot,
  Cable,
  Calculator,
  ChevronRight,
  Hammer,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Radar,
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
import { useCallback, useEffect, useState } from 'react';
import { useMobileSidebar } from './MobileSidebarContext';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Draws a live count next to the label. Only 'approvals' is wired up. */
  signal?: 'approvals';
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  adminOnly?: boolean;
}

// Two tiers, because the destinations are not used at the same rate. PRIMARY is
// the handful people open every day and it sits unlabelled under the brand, so
// the eye lands on it first. Everything else lives in GROUPS, which start closed
// — twelve monthly destinations rendered flat is what made the old rail noisy.
const PRIMARY: NavItem[] = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/approvals', label: 'Approvals', icon: Inbox, signal: 'approvals' },
  { href: '/prospects', label: 'Prospects', icon: Radar },
  { href: '/conversations', label: 'Conversations', icon: MessagesSquare },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
];

const GROUPS: NavGroup[] = [
  {
    id: 'automation',
    label: 'Automation',
    items: [
      { href: '/agents', label: 'Agents', icon: Bot },
      { href: '/dev-work', label: 'Dev Work', icon: Hammer },
      // Sits above Pipelines on purpose: a pipeline is a flow somebody wrote
      // down, an orchestration is one Cortex works out for itself.
      { href: '/orchestrator', label: 'Orchestrator', icon: Network },
      { href: '/pipelines', label: 'Pipelines', icon: Workflow },
      // The page calls these Routines; the nav used to call them Scheduled Jobs.
      // One name per thing.
      { href: '/schedules', label: 'Routines', icon: AlarmClock },
      { href: '/tools', label: 'Tools', icon: Wrench },
    ],
  },
  {
    // Both are "ask Cortex something it already knows" — the corpus it reads from
    // and the pricing model it reasons with.
    id: 'knowledge',
    label: 'Knowledge',
    items: [
      { href: '/kb', label: 'Knowledge Base', icon: BookOpen },
      { href: '/chat?tool=rate', label: 'Rate Calculator', icon: Calculator },
    ],
  },
  {
    // A pair, deliberately adjacent: one page is Cortex reaching out to other
    // systems, the other is an AI client reaching in. They used to read as
    // duplicates when they sat in different groups under similar names.
    id: 'connections',
    label: 'Connections',
    items: [
      { href: '/integrations', label: 'Integrations', icon: Plug },
      { href: '/mcp-tokens', label: 'Connect Claude', icon: Cable },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
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

// Chrome rather than workflow, so it is pinned to the bottom instead of
// competing for a slot in a group.
const FOOTER: NavItem[] = [{ href: '/settings', label: 'Settings', icon: Settings }];

const COLLAPSE_KEY = 'sidebar_collapsed';
const OPEN_GROUPS_KEY = 'sidebar_open_groups';

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
  // Query-bearing entries (Rate Calculator is /chat?tool=rate) are deliberately
  // never matched: reading the query would need useSearchParams, and matching on
  // the path alone would light them up at the same time as Chat.
  if (href.includes('?')) return false;
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ApprovalBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={clsx(
          'ml-auto shrink-0 rounded-pill px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums',
          active ? 'bg-white/20 text-white' : 'bg-amber-soft text-amber',
        )}
      >
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">, {count} waiting for you</span>
    </>
  );
}

/**
 * One destination. The active row is the only saturated plum object anywhere in
 * the chrome, and the only one carrying shadow-pop — that is what makes "where
 * am I" answerable from the corner of the eye.
 */
function NavLink({
  item,
  collapsed,
  pathname,
  tier,
  pendingApprovals,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  pathname: string;
  tier: 'primary' | 'secondary';
  pendingApprovals: number;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const active = isActive(pathname, item.href);
  const primary = tier === 'primary';
  const badge = item.signal === 'approvals' && pendingApprovals > 0 ? pendingApprovals : 0;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className={clsx(
        'group relative flex items-center rounded-[10px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'motion-reduce:transition-none',
        collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5',
        !collapsed && (primary ? 'py-[9px]' : 'py-[7px]'),
        active
          ? 'bg-primary font-semibold text-white shadow-pop'
          : clsx(
              'hover:bg-surface hover:text-ink',
              primary ? 'font-medium text-ink' : 'font-medium text-ink-muted',
            ),
        primary ? 'text-[13.5px]' : 'text-[12.5px]',
      )}
    >
      <span className="relative shrink-0">
        <Icon
          className={clsx(
            primary ? 'h-[18px] w-[18px]' : 'h-4 w-4',
            active ? 'text-white' : 'text-ink-faint group-hover:text-primary',
          )}
        />
        {collapsed && badge > 0 && (
          <span
            aria-hidden="true"
            className={clsx(
              'absolute -right-1.5 -top-1.5 min-w-[15px] rounded-pill px-1 text-center text-[9.5px] font-bold leading-[15px] tabular-nums',
              active ? 'bg-white text-primary' : 'bg-amber text-white',
            )}
          >
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      {!collapsed && <span className="truncate">{item.label}</span>}
      {collapsed && badge > 0 && <span className="sr-only">{badge} waiting for you</span>}
      {!collapsed && badge > 0 && <ApprovalBadge count={badge} active={active} />}
    </Link>
  );
}

/** Open threads, hung off Chat on a hairline — they are chats, so they nest. */
function ThreadList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 60_000,
  });

  const recent = conversations.slice(0, 5);
  if (recent.length === 0) return null;

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    queryClient.setQueryData<Conversation[]>(['conversations'], (prev) =>
      (prev ?? []).filter((c) => c.id !== id),
    );
    const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      return;
    }
    if (pathname === `/chat/${id}`) router.push('/chat');
  }

  return (
    // Aligned to the centre of the Chat icon above so the rule reads as a stem.
    <div className="ml-[19px] mt-0.5 border-l border-border pl-2">
      {recent.map((c) => {
        const href = `/chat/${c.id}`;
        const active = pathname === href;
        return (
          <div key={c.id} className="group/conv relative">
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              title={c.title ?? 'Untitled'}
              className={clsx(
                'block truncate rounded-[8px] py-1.5 pl-2 pr-7 text-[12.5px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                'motion-reduce:transition-none',
                active
                  ? 'bg-primary-soft font-semibold text-primary-ink'
                  : 'text-ink-muted hover:bg-surface hover:text-ink',
              )}
            >
              {c.title?.trim() || 'Untitled'}
            </Link>
            <button
              type="button"
              onClick={(e) => handleDelete(e, c.id)}
              aria-label={`Delete conversation ${c.title?.trim() || 'Untitled'}`}
              className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-[7px] p-1 text-ink-faint opacity-0 transition-opacity hover:bg-rose-soft hover:text-rose focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose/40 group-hover/conv:opacity-100 motion-reduce:transition-none"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function GroupBlock({
  group,
  open,
  onToggle,
  pathname,
  pendingApprovals,
  onNavigate,
}: {
  group: NavGroup;
  open: boolean;
  onToggle: () => void;
  pathname: string;
  pendingApprovals: number;
  onNavigate?: () => void;
}) {
  const panelId = `nav-group-${group.id}`;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.13em] text-ink-faint transition-colors hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={clsx(
            'h-3 w-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        <span>{group.label}</span>
      </button>
      {open && (
        <div id={panelId} className="mt-0.5 flex flex-col gap-px pb-1">
          {group.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              collapsed={false}
              pathname={pathname}
              tier="secondary"
              pendingApprovals={pendingApprovals}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={clsx('flex items-center gap-2.5', collapsed && 'justify-center')}>
      {/* App icon (Next metadata route) — same mark as the browser tab. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.png" alt="Cortex" className="h-9 w-9 shrink-0" />
      {!collapsed && (
        <div className="leading-tight">
          <div className="text-[15px] font-extrabold tracking-[-0.02em] text-ink">Cortex</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            by Vertix
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarNav({
  role,
  collapsed,
  openGroups,
  onToggleGroup,
  pendingApprovals,
  onNavigate,
}: {
  role?: Role;
  collapsed: boolean;
  openGroups: string[];
  onToggleGroup: (id: string) => void;
  pendingApprovals: number;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const groups = GROUPS.filter((g) => !g.adminOnly || role === 'org_admin');

  return (
    <nav
      aria-label="Main"
      className="scroll-slim flex h-full flex-col gap-1 overflow-y-auto px-3 pb-3"
    >
      <div className="flex flex-col gap-px">
        {PRIMARY.map((item) => (
          <div key={item.href}>
            <NavLink
              item={item}
              collapsed={collapsed}
              pathname={pathname}
              tier="primary"
              pendingApprovals={pendingApprovals}
              onNavigate={onNavigate}
            />
            {item.href === '/chat' && !collapsed && <ThreadList onNavigate={onNavigate} />}
          </div>
        ))}
      </div>

      {collapsed ? (
        // A 72px rail cannot hold a disclosure, so the groups flatten into one
        // icon list with the boundaries kept as rules.
        <>
          {groups.map((group) => (
            <div key={group.id} className="flex flex-col gap-px">
              <div className="mx-2 my-1.5 border-t border-border" />
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  collapsed
                  pathname={pathname}
                  tier="secondary"
                  pendingApprovals={pendingApprovals}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          ))}
        </>
      ) : (
        <div className="mt-2 flex flex-col gap-0.5">
          {groups.map((group) => (
            <GroupBlock
              key={group.id}
              group={group}
              // The group holding the current page is always open, whatever was
              // stored — the active item must never be hidden behind a click.
              open={
                openGroups.includes(group.id) || group.items.some((i) => isActive(pathname, i.href))
              }
              onToggle={() => onToggleGroup(group.id)}
              pathname={pathname}
              pendingApprovals={pendingApprovals}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-px pt-2">
        <div className={clsx('mb-1.5 border-t border-border', collapsed && 'mx-2')} />
        {FOOTER.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            collapsed={collapsed}
            pathname={pathname}
            tier="secondary"
            pendingApprovals={pendingApprovals}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </nav>
  );
}

export function Sidebar({
  role,
  pendingApprovals = 0,
}: {
  role?: Role;
  /** Confirmations waiting on this person, counted by the layout that renders us. */
  pendingApprovals?: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  // Both preferences arrive after hydration, so the width animation stays off
  // until then — otherwise a restored collapsed rail slides shut on every load.
  const [hydrated, setHydrated] = useState(false);
  const { open, setOpen } = useMobileSidebar();

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'true');
    try {
      const raw = localStorage.getItem(OPEN_GROUPS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        setOpenGroups(parsed.filter((v): v is string => typeof v === 'string'));
      }
    } catch {
      // Corrupt value: fall back to everything closed rather than blocking the nav.
    }
    setHydrated(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  }

  const toggleGroup = useCallback((id: string) => {
    setOpenGroups((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const closeDrawer = useCallback(() => setOpen(false), [setOpen]);

  return (
    <>
      {/* Desktop: collapsible rail, hidden on mobile. Recessed against the
          canvas so the one plum active row is the only thing that lifts. */}
      <aside
        className={clsx(
          'hidden shrink-0 flex-col border-r border-border bg-surface-2 md:flex',
          hydrated && 'transition-[width] duration-200 motion-reduce:transition-none',
          collapsed ? 'w-[72px]' : 'w-[268px]',
        )}
      >
        <div
          className={clsx(
            'flex items-center justify-between px-3 py-4',
            collapsed && 'justify-center px-0',
          )}
        >
          <Brand collapsed={collapsed} />
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              className="rounded-[10px] p-1.5 text-ink-faint transition-colors hover:bg-surface hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
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
            className="mx-auto mb-2 rounded-[10px] p-1.5 text-ink-faint transition-colors hover:bg-surface hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
        <div className="min-h-0 flex-1">
          <SidebarNav
            role={role}
            collapsed={collapsed}
            openGroups={openGroups}
            onToggleGroup={toggleGroup}
            pendingApprovals={pendingApprovals}
          />
        </div>
      </aside>

      {/* Mobile: Radix Dialog drawer, always in the expanded layout. */}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm md:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-border bg-surface-2 shadow-xl outline-none md:hidden">
            <div className="flex shrink-0 items-center justify-between px-3 py-4">
              <Dialog.Title asChild>
                <div>
                  <Brand collapsed={false} />
                </div>
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close menu"
                className="rounded-[10px] p-1.5 text-ink-faint transition-colors hover:bg-surface hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Navigation menu</Dialog.Description>
            <div className="min-h-0 flex-1">
              {/* Closing is wired to each link rather than delegated from the
                  <nav>: the group headers are buttons inside the same subtree,
                  and a delegated handler shut the drawer on every expand. */}
              <SidebarNav
                role={role}
                collapsed={false}
                openGroups={openGroups}
                onToggleGroup={toggleGroup}
                pendingApprovals={pendingApprovals}
                onNavigate={closeDrawer}
              />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

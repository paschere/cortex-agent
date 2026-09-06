'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { type NavItem, buildRail } from '@/lib/nav-shape';
import type { NavCounts } from '@/lib/nav-signals';
import { recordVisit } from '@/lib/nav-usage';
import { panelForHref } from '@/lib/panels/shape';
import type { ActiveOrganization, Role } from '@cortex/core';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { ArrowUpRight, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { useMobileSidebar } from './MobileSidebarContext';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const EMPTY: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };
function matches(path: string, href: string) {
  if (href.includes('?')) return false;
  if (href === '/integrations') return path === href;
  return path === href || path.startsWith(`${href}/`);
}
function Navigation({
  role,
  counts,
  collapsed,
  onNavigate,
}: { role: Role; counts: NavCounts; collapsed: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  const panel = usePanel();
  const commands = useCommandMenu();
  const rail = buildRail([], role === 'org_admin');
  const groups = [
    { id: 'daily', label: 'Tu espacio de trabajo', items: rail.pinned },
    { id: 'pending', label: 'Decisiones y seguimiento', items: rail.waiting },
    ...rail.rest,
    rail.company,
  ];
  function row(item: NavItem) {
    const active = matches(path, item.href);
    const Icon = item.icon;
    const badge = item.signal ? counts[item.signal] : 0;
    const wanted = path.startsWith('/chat') ? panelForHref(item.href) : null;
    return (
      <Link
        key={item.href}
        href={item.href}
        title={collapsed ? item.label : undefined}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? `${item.label}${badge ? `, ${badge} pendientes` : ''}` : undefined}
        onClick={(e) => {
          recordVisit(item.href);
          if (
            wanted &&
            panel.available &&
            e.button === 0 &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            !e.altKey
          ) {
            e.preventDefault();
            panel.open(wanted);
          }
          onNavigate?.();
        }}
        className={clsx(
          'workspace-nav-link group flex min-h-9 items-center rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          collapsed ? 'justify-center px-1' : 'gap-2.5 px-2.5',
          active
            ? 'bg-primary-soft font-semibold text-primary-ink'
            : 'font-medium text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.7} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {badge > 0 && (
              <span className="rounded-md bg-surface px-1.5 text-xs tabular-nums text-ink-muted">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
            {wanted && <ArrowUpRight className="h-3 w-3 text-rail-ink-faint" />}
          </>
        )}
        {collapsed && badge > 0 && (
          <span className="ml-0.5 text-micro text-primary">{badge > 9 ? '9+' : badge}</span>
        )}
      </Link>
    );
  }
  return (
    <>
      <nav
        aria-label="Navegación principal"
        className="scroll-slim min-h-0 flex-1 overflow-y-auto px-3 pb-4"
      >
        <button
          type="button"
          onClick={() => {
            commands.setOpen(true);
            onNavigate?.();
          }}
          aria-label="Buscar en Cortex"
          className={clsx(
            'mb-4 flex h-9 w-full items-center rounded-lg border border-rail-border bg-surface text-sm text-rail-ink-muted',
            collapsed ? 'justify-center' : 'gap-2 px-2.5',
          )}
        >
          <Search className="h-4 w-4" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Buscar</span>
              <kbd className="text-micro">⌘K</kbd>
            </>
          )}
        </button>
        {groups.map((group) => (
          <div key={group.id} className="mb-4">
            {!collapsed ? (
              <p className="mb-1.5 px-2.5 text-xs font-medium text-rail-ink-faint">{group.label}</p>
            ) : (
              <div className="mx-2 mb-2 border-t border-rail-border" />
            )}
            <div className="space-y-0.5">{group.items.map(row)}</div>
          </div>
        ))}
      </nav>
      <div className="shrink-0 space-y-1 border-t border-rail-border px-3 py-3">
        {rail.footer.map(row)}
      </div>
    </>
  );
}
export function Sidebar({
  role,
  counts = EMPTY,
  organization,
}: { role: Role; counts?: NavCounts; organization?: ActiveOrganization }) {
  const path = usePathname();
  const inChat = path.startsWith('/chat');
  const mobile = useMobileSidebar();
  const [collapsed, setCollapsed] = useState(false);
  const [peek, setPeek] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('sidebar_collapsed') === 'true');
    } catch {}
  }, []);
  const compact = inChat || collapsed;
  const expanded = !compact || peek || workspaceOpen;
  function toggle() {
    setCollapsed((v) => {
      try {
        localStorage.setItem('sidebar_collapsed', String(!v));
      } catch {}
      return !v;
    });
  }
  function contents(small: boolean, onNavigate?: () => void) {
    return (
      <>
        <div
          className={clsx(
            'flex h-16 shrink-0 items-center',
            small ? 'justify-center' : 'justify-between px-5',
          )}
        >
          <Link
            href="/management"
            onClick={onNavigate}
            aria-label="Cortex, abrir Gerencia"
            className="flex items-center gap-2.5 text-rail-ink"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg text-primary-ink">
              <CortexSignature className="h-10 w-10" />
            </span>
            {!small && <span className="text-2xl font-medium tracking-[-0.06em]">cortex</span>}
          </Link>
          {!small && !inChat && !onNavigate && (
            <button
              type="button"
              aria-label={collapsed ? 'Fijar el menú expandido' : 'Contraer el menú'}
              onClick={toggle}
              className="rounded-lg p-1.5 text-rail-ink-faint hover:bg-rail-2"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>
        {organization && (
          <div
            className={clsx(
              'mb-4 shrink-0',
              small ? 'px-1' : 'mx-3 rounded-lg border border-rail-border bg-surface p-1',
            )}
          >
            <WorkspaceSwitcher
              active={organization}
              collapsed={small}
              onOpenChange={setWorkspaceOpen}
            />
          </div>
        )}
        <Navigation role={role} counts={counts} collapsed={small} onNavigate={onNavigate} />
        {small && !inChat && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Expandir el menú"
            className="mx-auto mb-3 rounded-lg p-2 text-rail-ink-muted hover:bg-rail-2"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <aside
        className={clsx(
          'relative hidden h-full shrink-0 p-2 print:hidden md:flex',
          compact ? 'w-[64px]' : 'w-[248px]',
        )}
        onMouseEnter={() => compact && setPeek(true)}
        onMouseLeave={() => setPeek(false)}
        onFocusCapture={() => compact && setPeek(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setPeek(false);
        }}
      >
        <div
          className={clsx(
            'workspace-rail flex h-full flex-col border-r border-rail-border bg-rail',
            compact ? 'absolute inset-y-2 left-2 z-40' : 'w-full',
            compact && (expanded ? 'w-[248px] shadow-pop' : 'w-[64px]'),
          )}
        >
          {contents(!expanded)}
        </div>
      </aside>
      <Dialog.Root open={mobile.open} onOpenChange={mobile.setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm md:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(300px,88vw)] flex-col bg-rail shadow-pop md:hidden"
          >
            <Dialog.Title className="sr-only">Menú de Cortex</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Cerrar el menú"
                className="absolute right-3 top-4 z-10 rounded-lg p-2 text-rail-ink-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
            {contents(false, () => mobile.setOpen(false))}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

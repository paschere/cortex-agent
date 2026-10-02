'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { CortexSignature } from '@/components/ui/cortex-signature';
import {
  type NavItem,
  type PrimaryItem,
  WAITING_ICON,
  WAITING_LABEL,
  buildRail,
  moreGroups,
  primaryActive,
  primaryNav,
} from '@/lib/nav-shape';
import type { NavCounts } from '@/lib/nav-signals';
import { recordVisit } from '@/lib/nav-usage';
import { panelForHref } from '@/lib/panels/shape';
import { workspaceHref } from '@/lib/workspace-context';
import type { ActiveOrganization, Role } from '@cortex/core';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  ArrowUpRight,
  Bell,
  ChevronDown,
  LayoutDashboard,
  MessagesSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { CorporateSupervisionNotice } from './CorporateSupervisionNotice';
import { useMobileSidebar } from './MobileSidebarContext';
import { ThemeToggle } from './ThemeToggle';
import { CreateCompanyButton, WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * EL RAIL DEL AUTOSERVICIO.
 *
 * Tres alturas, de más a menos uso:
 *
 *   1. LAS PUERTAS (`primaryNav`): Inicio, Chat, Procesos, Vistas, Datos y
 *      Equipo. Grandes, con su icono y sin agrupar — son las seis palabras con
 *      las que el diseño nuevo explica el producto.
 *   2. «TE ESPERA»: las cuatro colas con su contador vivo (`countNavSignals`).
 *      Va visible y no dentro de «Más» porque es la única fila que cambia sola
 *      y cuyo número pide algo.
 *   3. «MÁS»: todo lo demás, con sus encabezados — la consola multiempresa,
 *      Gerencia, Llamadas, Brain Knowledge, finanzas, herramientas, la
 *      administración. Plegado salvo cuando estás dentro de algo suyo. No se
 *      quitó ni un destino: `nav-shape.test.ts` sigue sumando la unión.
 */

const EMPTY: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };

function matches(path: string, href: string) {
  if (href.includes('?')) return false;
  if (href === '/chat' && path.startsWith('/chat/global')) return false;
  if (href === '/integrations') return path === href;
  return path === href || path.startsWith(`${href}/`);
}

interface Group {
  id: string;
  label: string;
  items: NavItem[];
}

function Navigation({
  role,
  counts,
  collapsed,
  onNavigate,
  organization,
  onExpand,
}: {
  role: Role;
  counts: NavCounts;
  collapsed: boolean;
  onNavigate?: () => void;
  organization?: ActiveOrganization;
  onExpand: () => void;
}) {
  const path = usePathname();
  const panel = usePanel();
  const commands = useCommandMenu();
  const admin = role === 'org_admin';
  const founder = organization?.kind === 'company' && organization.role === 'owner';
  const rail = buildRail([], admin);
  const primary = primaryNav({ admin, founder });
  const primaryHrefs = new Set(primary.map((item) => item.href));
  // «Más» corto (ver `moreGroups` en lib/nav-shape.ts): lo de la semana en tres
  // grupos, la administración aparte para quien administra, y el resto en la
  // paleta. «Todas mis empresas» lleva al centro de mando, que es global.
  const globalItems: NavItem[] = [
    { href: '/overview', label: 'Todas mis empresas', icon: LayoutDashboard },
  ];
  const groups: Group[] = moreGroups({ admin, founder }).map((g) => ({
    ...g,
    items: g.items.filter((item) => !primaryHrefs.has(item.href)),
  }));
  const waitingCount = rail.waiting.reduce(
    (sum, item) => sum + (item.signal ? counts[item.signal] : 0),
    0,
  );
  const waitingActive = rail.waiting.some((item) => matches(path, item.href));
  const moreActive =
    !primary.some((item) => primaryActive(path, item)) &&
    [...globalItems, ...groups.flatMap((g) => g.items)].some((item) => matches(path, item.href));
  const [selection, setSelection] = useState<{
    path: string;
    waiting: boolean;
    more: boolean;
  } | null>(null);
  const current = selection?.path === path ? selection : null;
  const waitingOpen = !collapsed && (current ? current.waiting : waitingActive);
  const moreOpen = !collapsed && (current ? current.more : moreActive);
  const scope = onNavigate ? 'mobile' : 'desktop';

  function hrefFor(item: NavItem) {
    const global = globalItems.some((entry) => entry.href === item.href);
    return organization && !global ? workspaceHref(organization.id, item.href) : item.href;
  }

  function onClickFor(item: NavItem) {
    const global = globalItems.some((entry) => entry.href === item.href);
    const wanted = path.startsWith('/chat') && !global ? panelForHref(item.href) : null;
    return {
      wanted,
      onClick: (e: React.MouseEvent) => {
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
      },
    };
  }

  /** Una puerta grande: icono, palabra, y nada más. */
  function door(item: PrimaryItem) {
    const active = primaryActive(path, item);
    const Icon = item.icon;
    const { onClick } = onClickFor(item);
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        title={collapsed ? item.label : undefined}
        aria-label={collapsed ? item.label : undefined}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={clsx(
          'workspace-nav-link flex min-h-11 items-center rounded-pill text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
          collapsed ? 'justify-center px-1' : 'gap-3 px-3.5',
          active
            ? 'bg-primary-soft font-bold text-primary-ink'
            : 'font-semibold text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
        {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      </Link>
    );
  }

  /** Una fila de «Te espera» o de «Más». */
  function row(item: NavItem) {
    const active = matches(path, item.href);
    const Icon = item.icon;
    const badge = item.signal ? counts[item.signal] : 0;
    const { wanted, onClick } = onClickFor(item);
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={clsx(
          'workspace-nav-link group flex min-h-9 items-center gap-2.5 rounded-pill px-3 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
          active
            ? 'bg-primary-soft font-bold text-primary-ink'
            : 'font-medium text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {badge > 0 && (
          <span className="tabular rounded-pill bg-surface px-2 text-micro font-semibold text-ink-muted ring-1 ring-border">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {wanted && <ArrowUpRight className="h-3 w-3 text-rail-ink-faint" />}
      </Link>
    );
  }

  /** Un desplegable: «Te espera» o «Más». En el rail estrecho, ensancha. */
  function disclosure({
    id,
    label,
    icon: Icon,
    open,
    active,
    count,
    onToggle,
  }: {
    id: string;
    label: string;
    icon: NavItem['icon'];
    open: boolean;
    active: boolean;
    count: number;
    onToggle: () => void;
  }) {
    return (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`sidebar-${scope}-${id}`}
        aria-label={collapsed ? `${label}${count ? `, ${count} pendientes` : ''}` : undefined}
        title={collapsed ? label : undefined}
        onClick={() => {
          if (collapsed) onExpand();
          onToggle();
        }}
        className={clsx(
          'flex min-h-11 w-full items-center rounded-pill text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
          collapsed ? 'justify-center px-1' : 'gap-3 px-3.5',
          active
            ? 'font-bold text-primary-ink'
            : 'font-semibold text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">{label}</span>
            {count > 0 && (
              <span className="tabular rounded-pill bg-primary px-2 text-micro font-bold text-white">
                {count > 99 ? '99+' : count}
              </span>
            )}
            <ChevronDown
              className={clsx(
                'h-4 w-4 text-rail-ink-faint transition-transform motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </>
        )}
        {collapsed && count > 0 && (
          <span className="tabular ml-0.5 text-micro font-bold text-primary">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>
    );
  }

  const toggle = (key: 'waiting' | 'more') =>
    setSelection({
      path,
      waiting: key === 'waiting' ? !waitingOpen : waitingOpen,
      more: key === 'more' ? !moreOpen : moreOpen,
    });

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
            'mb-4 flex h-10 w-full items-center rounded-pill border border-rail-border bg-canvas text-sm text-rail-ink-faint transition-colors hover:border-border-strong hover:text-rail-ink-muted',
            collapsed ? 'justify-center' : 'gap-2.5 px-3.5',
          )}
        >
          <Search className="h-4 w-4" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left font-medium">Buscar</span>
              <kbd className="font-sans text-micro font-semibold">⌘K</kbd>
            </>
          )}
        </button>

        <div className="space-y-1">{primary.map(door)}</div>

        <div className="mt-3 border-t border-rail-border pt-3">
          {disclosure({
            id: 'waiting',
            label: WAITING_LABEL,
            icon: WAITING_ICON,
            open: waitingOpen,
            active: waitingActive,
            count: waitingCount,
            onToggle: () => toggle('waiting'),
          })}
          <div
            id={`sidebar-${scope}-waiting`}
            hidden={!waitingOpen}
            className="mb-1 ml-5 mt-1 space-y-0.5 border-l-2 border-rail-border pl-2"
          >
            {rail.waiting.map(row)}
          </div>

          {disclosure({
            id: 'more',
            label: 'Más',
            icon: MoreHorizontal,
            open: moreOpen,
            active: moreActive,
            count: 0,
            onToggle: () => toggle('more'),
          })}
          <div id={`sidebar-${scope}-more`} hidden={!moreOpen} className="mt-1 space-y-3">
            {groups.map((group) => (
              <div key={group.id}>
                <p className="px-3 pb-1 pt-2 text-micro font-bold uppercase tracking-field text-rail-ink-faint">
                  {group.label}
                </p>
                <div className="space-y-0.5">{group.items.map(row)}</div>
              </div>
            ))}
            <div className="space-y-0.5 pb-1">
              <CreateCompanyButton />
              <button
                type="button"
                onClick={() => {
                  commands.setOpen(true);
                  onNavigate?.();
                }}
                className="workspace-nav-link flex min-h-9 w-full items-center gap-3 rounded-pill px-3 text-left text-sm font-semibold text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink"
              >
                <Search className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">Buscar cualquier pantalla</span>
                <kbd className="text-micro font-semibold text-rail-ink-faint">⌘K</kbd>
              </button>
            </div>
          </div>
        </div>
      </nav>
      <div className="shrink-0 space-y-2 border-t border-rail-border px-3 py-3">
        <div className={clsx('flex items-center gap-1', collapsed && 'flex-col')}>
          {rail.footer
            .filter((item) => item.href === '/settings')
            .map((item) =>
              collapsed ? (
                <Link
                  key={item.href}
                  href={hrefFor(item)}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={matches(path, item.href) ? 'page' : undefined}
                  onClick={onClickFor(item).onClick}
                  className="workspace-nav-link flex min-h-10 items-center justify-center rounded-pill text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink"
                >
                  <item.icon className="h-[18px] w-[18px]" strokeWidth={2} />
                </Link>
              ) : (
                <div key={item.href} className="min-w-0 flex-1">
                  {row(item)}
                </div>
              ),
            )}
          <ThemeToggle icon />
        </div>
        {!collapsed && organization?.kind === 'company' && (
          <CorporateSupervisionNotice kind={organization.kind} />
        )}
      </div>
    </>
  );
}

/** La marca: el cuadrado índigo del diseño con la espiral dentro. */
function Brand({ small, onNavigate }: { small: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href="/overview"
      onClick={onNavigate}
      aria-label="Cortex, abrir vista global"
      className="flex items-center gap-2.5 rounded-sm text-rail-ink"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary text-white shadow-card">
        <CortexSignature className="h-6 w-6" />
      </span>
      {!small && <span className="text-lg font-extrabold tracking-tight">Cortex</span>}
    </Link>
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
          <Brand small={small} onNavigate={onNavigate} />
          {!small && !inChat && !onNavigate && (
            <button
              type="button"
              aria-label={collapsed ? 'Fijar el menú expandido' : 'Contraer el menú'}
              onClick={toggle}
              className="rounded-pill p-2 text-rail-ink-faint hover:bg-rail-2 hover:text-rail-ink"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>
        {organization && (
          <div
            className={clsx(
              'mb-3 shrink-0',
              small ? 'px-1' : 'mx-3 rounded-sm border border-rail-border bg-canvas p-1',
            )}
          >
            <WorkspaceSwitcher
              active={organization}
              collapsed={small}
              onOpenChange={setWorkspaceOpen}
            />
          </div>
        )}
        <Navigation
          role={role}
          counts={counts}
          collapsed={small}
          onNavigate={onNavigate}
          organization={organization}
          onExpand={() => setPeek(true)}
        />
        {small && !inChat && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Expandir el menú"
            className="mx-auto mb-3 rounded-pill p-2 text-rail-ink-muted hover:bg-rail-2"
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
          'relative hidden h-full shrink-0 print:hidden md:flex',
          compact ? 'w-[72px]' : 'w-[264px]',
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
            compact ? 'absolute inset-y-0 left-0 z-40' : 'w-full',
            compact && (expanded ? 'w-[264px] shadow-pop' : 'w-[72px]'),
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
            className="fixed inset-y-0 left-0 z-50 flex w-[min(320px,88vw)] flex-col rounded-r-card bg-rail shadow-pop md:hidden"
          >
            <Dialog.Title className="sr-only">Menú de Cortex</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Cerrar el menú"
                className="absolute right-3 top-3.5 z-10 rounded-pill p-2.5 text-rail-ink-muted hover:bg-rail-2"
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

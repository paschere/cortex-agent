'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { authClient } from '@/lib/auth-client';
import {
  type NavItem,
  type NavSection,
  WAITING_AFTER,
  WAITING_ICON,
  WAITING_LABEL,
  buildRail,
} from '@/lib/nav-shape';
import type { NavCounts, ShellSignals } from '@/lib/nav-signals';
import { recordVisit } from '@/lib/nav-usage';
import { panelForHref } from '@/lib/panels/shape';
import { workspaceHref } from '@/lib/workspace-context';
import type { ModuleKey } from '@cortex/agent-tools';
import type { ActiveOrganization, Role } from '@cortex/core';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  ArrowUpRight,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
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
 * EL RAIL, CALMADO.
 *
 * Tres alturas, de más a menos uso:
 *
 *   1. ARRIBA (`rail.pinned`): Chat, Hoy (el plan del día de Cortex, con las
 *      cosas que esperan decisión), «Te espera» (las cuatro colas en UNA fila
 *      con la suma, que se despliega), Vistas, Aplicaciones, Tablas y Cerebro.
 *   2. SECCIONES PLEGABLES con encabezados en español llano (Mi día, Clientes y
 *      ventas, Plata…). Cada una recuerda en `localStorage` si estaba abierta;
 *      sin elección previa sólo «Mi día» y la que contiene la pantalla actual
 *      salen abiertas. Los módulos apagados no dejan encabezados colgando.
 *   3. AL PIE: la tarjeta de «Puesta en marcha» (sólo mientras falte y sólo para
 *      quien administra), y Ajustes, tema y cerrar sesión.
 *
 * No se quitó ni un destino: `nav-shape.test.ts` suma la unión, y lo que no
 * esté en el rail se alcanza con ⌘K.
 */

const EMPTY: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };
const NO_MODULES_OFF: ModuleKey[] = [];
const NO_SIGNALS: ShellSignals = { pilot: 0, setup: null };
const SECTIONS_KEY = 'sidebar_sections';

function matches(path: string, href: string) {
  if (href.includes('?')) return false;
  if (href === '/chat' && path.startsWith('/chat/global')) return false;
  if (href === '/integrations') return path === href;
  return path === href || path.startsWith(`${href}/`);
}

function readSavedSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function Navigation({
  role,
  counts,
  signals,
  collapsed,
  onNavigate,
  organization,
  onExpand,
  modulesOff,
}: {
  /** Módulos que la empresa apagó (0186): sus pantallas no salen en el menú. */
  modulesOff: ModuleKey[];
  role: Role;
  counts: NavCounts;
  signals: ShellSignals;
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
  const rail = buildRail([], admin, modulesOff, signals.setup === null);
  const globalItems: NavItem[] = [
    { href: '/overview', label: 'Todas mis empresas', icon: LayoutDashboard },
  ];
  // «La empresa» es una sección más; «Todas mis empresas» cuelga de ella.
  const sections: NavSection[] = [
    ...rail.rest,
    {
      ...rail.company,
      items: [...(founder ? globalItems : []), ...rail.company.items],
    },
  ].filter((section) => section.items.length > 0);
  const waitingCount = rail.waiting.reduce(
    (sum, item) => sum + (item.signal && item.signal !== 'pilot' ? counts[item.signal] : 0),
    0,
  );
  const waitingActive = rail.waiting.some((item) => matches(path, item.href));
  const [selection, setSelection] = useState<{ path: string; waiting: boolean } | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  useEffect(() => setSaved(readSavedSections()), []);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const current = selection?.path === path ? selection : null;
  const waitingOpen = !collapsed && (current ? current.waiting : waitingActive);
  const scope = onNavigate ? 'mobile' : 'desktop';

  const sectionOpen = (section: NavSection) =>
    !collapsed &&
    (saved[section.id] ??
      (section.id === 'today' || section.items.some((item) => matches(path, item.href))));
  function toggleSection(section: NavSection) {
    const next = { ...saved, [section.id]: !sectionOpen(section) };
    setSaved(next);
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
    } catch {}
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message);
      window.location.replace('/login');
    } catch {
      setSignOutError('No se pudo cerrar sesión. Inténtalo de nuevo.');
      setSigningOut(false);
    }
  }

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

  function badgeFor(item: NavItem) {
    if (!item.signal) return 0;
    return item.signal === 'pilot' ? signals.pilot : counts[item.signal];
  }

  /** Una fila de arriba: icono, palabra y, si hay, lo que espera. */
  function door(item: NavItem) {
    const active = matches(path, item.href);
    const Icon = item.icon;
    const badge = badgeFor(item);
    const { onClick } = onClickFor(item);
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        title={collapsed ? item.label : undefined}
        aria-label={
          collapsed ? (badge ? `${item.label}, ${badge} pendientes` : item.label) : undefined
        }
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
        {!collapsed && badge > 0 && (
          <span className="tabular rounded-pill bg-primary px-2 text-micro font-bold text-white">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {collapsed && badge > 0 && (
          <span className="tabular ml-0.5 text-micro font-bold text-primary">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </Link>
    );
  }

  /** Una fila dentro de «Te espera» o de una sección. */
  function row(item: NavItem) {
    const active = matches(path, item.href);
    const Icon = item.icon;
    const badge = badgeFor(item);
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

  /** «Te espera»: una fila con la suma que despliega las cuatro colas. */
  function waitingRow() {
    const Icon = WAITING_ICON;
    return (
      <div key="waiting">
        <button
          type="button"
          aria-expanded={waitingOpen}
          aria-controls={`sidebar-${scope}-waiting`}
          aria-label={
            collapsed
              ? `${WAITING_LABEL}${waitingCount ? `, ${waitingCount} pendientes` : ''}`
              : undefined
          }
          title={collapsed ? WAITING_LABEL : undefined}
          onClick={() => {
            if (collapsed) onExpand();
            setSelection({ path, waiting: !waitingOpen });
          }}
          className={clsx(
            'flex min-h-11 w-full items-center rounded-pill text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
            collapsed ? 'justify-center px-1' : 'gap-3 px-3.5',
            waitingActive
              ? 'font-bold text-primary-ink'
              : 'font-semibold text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
          )}
        >
          <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">{WAITING_LABEL}</span>
              {waitingCount > 0 && (
                <span className="tabular rounded-pill bg-primary px-2 text-micro font-bold text-white">
                  {waitingCount > 99 ? '99+' : waitingCount}
                </span>
              )}
              <ChevronDown
                className={clsx(
                  'h-4 w-4 text-rail-ink-faint transition-transform motion-reduce:transition-none',
                  waitingOpen && 'rotate-180',
                )}
              />
            </>
          )}
          {collapsed && waitingCount > 0 && (
            <span className="tabular ml-0.5 text-micro font-bold text-primary">
              {waitingCount > 9 ? '9+' : waitingCount}
            </span>
          )}
        </button>
        <div
          id={`sidebar-${scope}-waiting`}
          hidden={!waitingOpen}
          className="mb-1 ml-5 mt-1 space-y-0.5 border-l-2 border-rail-border pl-2"
        >
          {rail.waiting.map(row)}
        </div>
      </div>
    );
  }

  /** Una sección plegable. En el rail estrecho es un icono que ensancha el rail. */
  function sectionBlock(section: NavSection) {
    const open = sectionOpen(section);
    const hasActive = section.items.some((item) => matches(path, item.href));
    const Icon = section.items[0]?.icon ?? MoreHorizontal;
    if (collapsed) {
      return (
        <button
          key={section.id}
          type="button"
          onClick={onExpand}
          title={section.label}
          aria-label={section.label}
          className={clsx(
            'flex min-h-10 w-full items-center justify-center rounded-pill transition-colors hover:bg-rail-2 hover:text-rail-ink',
            hasActive ? 'text-primary-ink' : 'text-rail-ink-faint',
          )}
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
      );
    }
    return (
      <div key={section.id}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`sidebar-${scope}-${section.id}`}
          onClick={() => toggleSection(section)}
          className="flex min-h-8 w-full items-center gap-2 rounded-pill px-3 text-left text-micro font-bold uppercase tracking-field text-rail-ink-faint transition-colors hover:text-rail-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span className="flex-1">{section.label}</span>
          {!open && hasActive && (
            <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-primary" />
          )}
          <ChevronDown
            className={clsx(
              'h-3.5 w-3.5 transition-transform motion-reduce:transition-none',
              !open && '-rotate-90',
            )}
          />
        </button>
        <div id={`sidebar-${scope}-${section.id}`} hidden={!open} className="space-y-0.5 pb-1">
          {section.items.map(row)}
        </div>
      </div>
    );
  }

  /** La tarjeta de «Puesta en marcha»: sólo mientras falte. */
  function setupCard() {
    if (!rail.setup || !signals.setup) return null;
    const { ready, total } = signals.setup;
    const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
    const { onClick } = onClickFor(rail.setup);
    if (collapsed) {
      return (
        <Link
          href={hrefFor(rail.setup)}
          onClick={onClick}
          title={`Puesta en marcha: ${ready} de ${total}`}
          aria-label={`Puesta en marcha: ${ready} de ${total} pasos`}
          className="workspace-nav-link flex min-h-10 flex-col items-center justify-center rounded-pill text-primary hover:bg-rail-2"
        >
          <Settings className="h-[18px] w-[18px]" strokeWidth={2} />
          <span className="tabular text-micro font-bold">{`${ready}/${total}`}</span>
        </Link>
      );
    }
    return (
      <Link
        href={hrefFor(rail.setup)}
        onClick={onClick}
        className="block rounded-sm border border-rail-border bg-canvas p-3 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span className="flex items-center justify-between gap-2 text-sm font-bold text-rail-ink">
          Puesta en marcha
          <span className="tabular text-micro font-semibold text-rail-ink-muted">
            {ready} de {total}
          </span>
        </span>
        <span aria-hidden className="mt-2 block h-1.5 overflow-hidden rounded-pill bg-rail-2">
          <span className="block h-full rounded-pill bg-primary" style={{ width: `${pct}%` }} />
        </span>
        <span className="mt-2 block text-micro text-rail-ink-muted">Sigue con lo que falta</span>
      </Link>
    );
  }

  const topRows = rail.pinned.flatMap((item) =>
    item.href === WAITING_AFTER ? [door(item), waitingRow()] : [door(item)],
  );

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

        <div className="space-y-1">{topRows}</div>

        <div className="mt-3 space-y-1 border-t border-rail-border pt-3">
          {sections.map(sectionBlock)}
          {!collapsed && (
            <div className="space-y-0.5 pt-1">
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
          )}
        </div>
      </nav>
      <div className="shrink-0 space-y-2 border-t border-rail-border px-3 py-3">
        {setupCard()}
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
        <button
          type="button"
          disabled={signingOut}
          onClick={signOut}
          aria-label={collapsed ? 'Cerrar sesión' : undefined}
          title={collapsed ? 'Cerrar sesión' : undefined}
          className={clsx(
            'workspace-nav-link flex min-h-10 w-full items-center rounded-pill text-sm font-medium text-rail-ink-muted transition-colors hover:bg-rail-2 hover:text-rail-ink disabled:opacity-60',
            collapsed ? 'justify-center' : 'gap-2.5 px-3',
          )}
        >
          <LogOut className="h-[18px] w-[18px] shrink-0" strokeWidth={2} aria-hidden />
          {!collapsed && <span>{signingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}</span>}
        </button>
        {signOutError && (
          <p role="alert" className={clsx('text-xs text-rose', collapsed ? 'sr-only' : 'px-3')}>
            {signOutError}
          </p>
        )}
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
  signals = NO_SIGNALS,
  organization,
  modulesOff = NO_MODULES_OFF,
}: {
  role: Role;
  counts?: NavCounts;
  /** Hoy (decisiones del piloto) y progreso de la puesta en marcha. */
  signals?: ShellSignals;
  organization?: ActiveOrganization;
  /** Módulos que la empresa apagó (0186). Lo lee el shell, una vez. */
  modulesOff?: ModuleKey[];
}) {
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
          signals={signals}
          collapsed={small}
          onNavigate={onNavigate}
          organization={organization}
          onExpand={() => setPeek(true)}
          modulesOff={modulesOff}
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

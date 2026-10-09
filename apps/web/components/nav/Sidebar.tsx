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
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  SquarePen,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { CorporateSupervisionNotice } from './CorporateSupervisionNotice';
import { useMobileSidebar } from './MobileSidebarContext';
import { ThemeToggle } from './ThemeToggle';
import { CreateCompanyButton, WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * EL RAIL, REDISEÑADO: CALMO, DENSO Y SIN RUIDO.
 *
 * La estructura no cambia (ver `lib/nav-shape.ts`); cambia cómo se ve y cómo se
 * siente:
 *
 *   · CABECERA: el espacio de trabajo como bloque compacto (monograma, nombre,
 *     rol), «nuevo chat» al lado y una fila «Buscar… ⌘K» debajo.
 *   · BLOQUE FIJO: Chat (con sus últimos hilos), Hoy, «Te espera» (se despliega
 *     en el sitio y anima la altura), Vistas, Aplicaciones, Tablas y Cerebro.
 *     Filas de 32px; la activa lleva un fondo tenue, texto de tinta e icono en
 *     el color primario. Nada de barras gruesas a la izquierda.
 *   · SECCIONES: encabezados de 12px sin mayúsculas, con el chevron a la vista
 *     sólo al pasar el ratón (o si están cerradas). Cada una recuerda en
 *     `localStorage` (`sidebar_sections`) si estaba abierta.
 *   · PIE: la tarjeta de «Puesta en marcha» (sólo mientras falte) y la fila de la
 *     persona con su menú (Ajustes, Plan, Ayuda, tema, cerrar sesión).
 *   · CONTRAÍDO: 56px de iconos con insignias de punto; se ensancha con un roce.
 *
 * El cuerpo (`SidebarBody`) se exporta para que la página de pruebas visuales
 * (`/v/sidebar-showcase`) lo pinte en cualquier ancho sin montar el layout.
 */

const EMPTY: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };
const NO_MODULES_OFF: ModuleKey[] = [];
const NO_SIGNALS: ShellSignals = { pilot: 0, setup: null };
const SECTIONS_KEY = 'sidebar_sections';
const RECENT_LIMIT = 3;

export interface RecentChat {
  id: string;
  title: string;
}

export interface SidebarUser {
  name: string | null;
  email: string;
}

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

/** Los últimos hilos del usuario. Se pide una vez y, dentro del chat, al cambiar de hilo. */
function useRecentChats(enabled: boolean, path: string, override?: RecentChat[]) {
  const [items, setItems] = useState<RecentChat[]>(override ?? []);
  const key = path.startsWith('/chat') ? path : 'otro';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` sólo cambia al cambiar de hilo.
  useEffect(() => {
    if (override || !enabled) return;
    let alive = true;
    void fetch('/api/conversations')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as {
          conversations?: Array<{ id: string; title: string | null }>;
        };
      })
      .then((data) => {
        if (!alive) return;
        setItems(
          (data.conversations ?? [])
            .slice(0, RECENT_LIMIT)
            .map((c) => ({ id: c.id, title: c.title?.trim() || 'Chat sin título' })),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled, key, override]);
  return override ?? items;
}

/** Alto animado sin medir: la fila de la rejilla pasa de 0fr a 1fr. */
function Collapsible({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  return (
    <div
      id={id}
      data-closed={open ? undefined : 'true'}
      className={clsx(
        'grid transition-[grid-template-rows,opacity,visibility] duration-200 ease-out motion-reduce:transition-none',
        open ? 'visible grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="-mx-1 min-h-0 overflow-hidden px-1 py-0.5">{children}</div>
    </div>
  );
}

/** Contador pequeño y redondo. En una fila activa se pinta sobre la superficie. */
function Count({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={clsx(
        'tabular inline-flex h-5 min-w-5 items-center justify-center rounded-pill px-1.5 text-micro font-semibold leading-none',
        active ? 'bg-surface text-primary-ink' : 'bg-primary-soft text-primary-ink',
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

/** Progreso en un anillo. `currentColor` pinta el avance; el riel va tenue. */
function Ring({ pct, size = 36 }: { pct: number; size?: number }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0 -rotate-90 text-primary"
    >
      <title>Progreso</title>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        className="stroke-rail-border"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
      />
    </svg>
  );
}

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0';

export function SidebarBody({
  role,
  counts,
  signals,
  small,
  onNavigate,
  organization,
  onExpand,
  modulesOff,
  user,
  headerExtra,
  onToggleCollapsed,
  pinnedCollapsed = false,
  onWorkspaceOpenChange,
  pathOverride,
  recentOverride,
}: {
  /** Módulos que la empresa apagó (0186): sus pantallas no salen en el menú. */
  modulesOff: ModuleKey[];
  role: Role;
  counts: NavCounts;
  signals: ShellSignals;
  /** El rail estrecho de 56px: sólo iconos. */
  small: boolean;
  /** Presente sólo en el cajón del teléfono: cierra el cajón al navegar. */
  onNavigate?: () => void;
  organization?: ActiveOrganization;
  /** Ensancha el rail estrecho (al pulsar una sección). */
  onExpand: () => void;
  user?: SidebarUser;
  /** Lo que va al final de la cabecera (el botón de cerrar del cajón). */
  headerExtra?: ReactNode;
  /** Fija/suelta el rail contraído. Sin esto no hay botón. */
  onToggleCollapsed?: () => void;
  /** Para el rótulo del botón de arriba: el rail está fijado contraído. */
  pinnedCollapsed?: boolean;
  onWorkspaceOpenChange?: (open: boolean) => void;
  /** Sólo para la página de pruebas: finge la ruta abierta. */
  pathOverride?: string;
  /** Sólo para la página de pruebas: hilos inventados, sin red. */
  recentOverride?: RecentChat[];
}) {
  const livePath = usePathname();
  const path = pathOverride ?? livePath;
  const panel = usePanel();
  const commands = useCommandMenu();
  const admin = role === 'org_admin';
  const founder = organization?.kind === 'company' && organization.role === 'owner';
  const touch = Boolean(onNavigate);
  const rail = buildRail([], admin, modulesOff, signals.setup === null);
  const globalItems: NavItem[] = [
    { href: '/overview', label: 'Todas mis empresas', icon: LayoutDashboard },
  ];
  const rest: NavSection[] = rail.rest.filter((section) => section.items.length > 0);
  // «La empresa» es una sección más, con un filete encima; «Todas mis empresas» cuelga de ella.
  const company: NavSection | null =
    rail.company.items.length > 0 || founder
      ? { ...rail.company, items: [...(founder ? globalItems : []), ...rail.company.items] }
      : null;
  const sections: NavSection[] = company ? [...rest, company] : rest;
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
  const waitingOpen = !small && (current ? current.waiting : waitingActive);
  const scope = touch ? 'mobile' : 'desktop';
  const recent = useRecentChats(!small, path, recentOverride);
  const navRef = useRef<HTMLElement>(null);

  const rowH = touch ? 'h-10' : 'h-8';

  const sectionOpen = (section: NavSection) =>
    !small &&
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

  /** Flechas arriba/abajo, Inicio y Fin recorren las filas visibles del rail. */
  function onNavKeyDown(e: React.KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const nodes = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [],
    ).filter((el) => !el.closest('[data-closed="true"]'));
    if (nodes.length === 0) return;
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    let next = index;
    if (e.key === 'ArrowDown') next = index < 0 ? 0 : Math.min(nodes.length - 1, index + 1);
    else if (e.key === 'ArrowUp') next = index < 0 ? nodes.length - 1 : Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else next = nodes.length - 1;
    e.preventDefault();
    nodes[next]?.focus();
  }

  /** Una fila del bloque fijo: icono, palabra y, si hay, lo que espera. */
  function door(item: NavItem) {
    const active = matches(path, item.href);
    const Icon = item.icon;
    const badge = badgeFor(item);
    const { onClick } = onClickFor(item);
    const label = badge ? `${item.label}, ${badge} pendientes` : item.label;
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        data-nav
        title={small ? item.label : undefined}
        aria-label={small ? label : undefined}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={clsx(
          'group/row relative flex items-center rounded-sm font-medium transition-colors duration-150 motion-reduce:transition-none',
          FOCUS,
          small
            ? 'mx-auto h-9 w-9 justify-center'
            : clsx(rowH, 'w-full gap-2.5 px-2.5 text-[14px]'),
          active
            ? 'bg-primary-soft text-rail-ink'
            : 'text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <Icon
          className={clsx(
            'h-4 w-4 shrink-0 transition-colors',
            active ? 'text-primary' : 'text-rail-ink-faint group-hover/row:text-rail-ink-muted',
          )}
          strokeWidth={1.75}
        />
        {!small && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {!small && badge > 0 && <Count n={badge} active={active} />}
        {small && badge > 0 && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-pill bg-primary ring-2 ring-rail"
          />
        )}
      </Link>
    );
  }

  /** Un hilo reciente, sangrado bajo «Chat». */
  function recentRow(chat: RecentChat) {
    const href = `/chat/${chat.id}`;
    const active = path === href;
    return (
      <Link
        key={chat.id}
        href={organization ? workspaceHref(organization.id, href) : href}
        data-nav
        aria-current={active ? 'page' : undefined}
        onClick={() => onNavigate?.()}
        className={clsx(
          'flex items-center rounded-sm pl-2.5 pr-2 text-[13px] transition-colors duration-150 motion-reduce:transition-none',
          touch ? 'h-9' : 'h-7',
          FOCUS,
          active
            ? 'bg-rail-2 font-medium text-rail-ink'
            : 'text-rail-ink-faint hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      </Link>
    );
  }

  /** Las colas de «Te espera»: sangradas, con su cuenta a la derecha. */
  function queueRow(item: NavItem) {
    const active = matches(path, item.href);
    const badge = badgeFor(item);
    const { onClick } = onClickFor(item);
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        data-nav
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={clsx(
          'flex items-center gap-2 rounded-sm pl-2.5 pr-2 text-[13px] transition-colors duration-150 motion-reduce:transition-none',
          touch ? 'h-9' : 'h-7',
          FOCUS,
          active
            ? 'bg-primary-soft font-medium text-rail-ink'
            : 'text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {badge > 0 && <Count n={badge} active={active} />}
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
          data-nav
          aria-expanded={waitingOpen}
          aria-controls={`sidebar-${scope}-waiting`}
          aria-label={
            small
              ? `${WAITING_LABEL}${waitingCount ? `, ${waitingCount} pendientes` : ''}`
              : undefined
          }
          title={small ? WAITING_LABEL : undefined}
          onClick={() => {
            if (small) onExpand();
            setSelection({ path, waiting: !waitingOpen });
          }}
          className={clsx(
            'group/row relative flex items-center rounded-sm font-medium transition-colors duration-150 motion-reduce:transition-none',
            FOCUS,
            small
              ? 'mx-auto h-9 w-9 justify-center'
              : clsx(rowH, 'w-full gap-2.5 px-2.5 text-[14px]'),
            waitingActive && !waitingOpen
              ? 'bg-primary-soft text-rail-ink'
              : 'text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
          )}
        >
          <Icon
            className={clsx(
              'h-4 w-4 shrink-0 transition-colors',
              waitingActive
                ? 'text-primary'
                : 'text-rail-ink-faint group-hover/row:text-rail-ink-muted',
            )}
            strokeWidth={1.75}
          />
          {!small && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">{WAITING_LABEL}</span>
              {!waitingOpen && waitingCount > 0 && <Count n={waitingCount} />}
              <ChevronRight
                aria-hidden
                className={clsx(
                  'h-3.5 w-3.5 shrink-0 text-rail-ink-faint transition-transform duration-200 motion-reduce:transition-none',
                  waitingOpen && 'rotate-90',
                )}
              />
            </>
          )}
          {small && waitingCount > 0 && (
            <span
              aria-hidden
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-pill bg-primary ring-2 ring-rail"
            />
          )}
        </button>
        {!small && (
          <Collapsible open={waitingOpen} id={`sidebar-${scope}-waiting`}>
            <div className="ml-[18px] space-y-0.5 border-l border-rail-border pl-2">
              {rail.waiting.map(queueRow)}
            </div>
          </Collapsible>
        )}
      </div>
    );
  }

  /** Una fila dentro de una sección. */
  function row(item: NavItem) {
    const active = matches(path, item.href);
    const Icon = item.icon;
    const badge = badgeFor(item);
    const { wanted, onClick } = onClickFor(item);
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        data-nav
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={clsx(
          'group/row flex items-center gap-2.5 rounded-sm px-2.5 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none',
          touch ? 'h-10' : 'h-8',
          FOCUS,
          active
            ? 'bg-primary-soft text-rail-ink'
            : 'text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink',
        )}
      >
        <Icon
          className={clsx(
            'h-4 w-4 shrink-0 transition-colors',
            active ? 'text-primary' : 'text-rail-ink-faint group-hover/row:text-rail-ink-muted',
          )}
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {badge > 0 && <Count n={badge} active={active} />}
        {wanted && (
          <ArrowUpRight
            aria-hidden
            className="h-3 w-3 shrink-0 text-rail-ink-faint opacity-0 transition-opacity group-hover/row:opacity-100"
          />
        )}
      </Link>
    );
  }

  /** Una sección plegable. En el rail estrecho es un icono que ensancha el rail. */
  function sectionBlock(section: NavSection) {
    const open = sectionOpen(section);
    const hasActive = section.items.some((item) => matches(path, item.href));
    const Icon = section.items[0]?.icon ?? MoreHorizontal;
    if (small) {
      return (
        <button
          key={section.id}
          type="button"
          data-nav
          onClick={onExpand}
          title={section.label}
          aria-label={section.label}
          className={clsx(
            'mx-auto flex h-9 w-9 items-center justify-center rounded-sm transition-colors hover:bg-rail-2',
            FOCUS,
            hasActive ? 'text-primary' : 'text-rail-ink-faint hover:text-rail-ink-muted',
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </button>
      );
    }
    return (
      <div
        key={section.id}
        className={clsx(section.id === 'company' && 'mt-3 border-t border-rail-border pt-3')}
      >
        <button
          type="button"
          data-nav
          aria-expanded={open}
          aria-controls={`sidebar-${scope}-${section.id}`}
          onClick={() => toggleSection(section)}
          className={clsx(
            'group/sec flex w-full items-center gap-1.5 rounded-sm px-2.5 text-left text-micro font-medium text-rail-ink-faint transition-colors hover:text-rail-ink-muted',
            touch ? 'h-9' : 'h-7',
            FOCUS,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{section.label}</span>
          {!open && hasActive && (
            <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-primary" />
          )}
          <ChevronDown
            aria-hidden
            className={clsx(
              'h-3.5 w-3.5 shrink-0 transition-[transform,opacity] duration-200 motion-reduce:transition-none',
              open
                ? 'opacity-0 group-hover/sec:opacity-100 group-focus-visible/sec:opacity-100'
                : '-rotate-90 opacity-100',
            )}
          />
        </button>
        <Collapsible open={open} id={`sidebar-${scope}-${section.id}`}>
          <div className="space-y-0.5">{section.items.map(row)}</div>
        </Collapsible>
      </div>
    );
  }

  /** La tarjeta de «Puesta en marcha»: sólo mientras falte. */
  function setupCard() {
    if (!rail.setup || !signals.setup) return null;
    const { ready, total } = signals.setup;
    const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
    const { onClick } = onClickFor(rail.setup);
    if (small) {
      return (
        <Link
          href={hrefFor(rail.setup)}
          onClick={onClick}
          title={`Puesta en marcha: ${ready} de ${total}`}
          aria-label={`Puesta en marcha: ${ready} de ${total} pasos`}
          className={clsx(
            'mx-auto flex h-9 w-9 items-center justify-center rounded-sm transition-colors hover:bg-rail-2',
            FOCUS,
          )}
        >
          <Ring pct={pct} size={26} />
        </Link>
      );
    }
    return (
      <Link
        href={hrefFor(rail.setup)}
        onClick={onClick}
        className={clsx(
          'group/setup flex items-center gap-3 rounded-card border border-rail-border bg-canvas p-3 transition-colors hover:border-border-strong',
          FOCUS,
        )}
      >
        <span className="relative grid shrink-0 place-items-center">
          <Ring pct={pct} />
          <Settings
            aria-hidden
            className="absolute h-3.5 w-3.5 text-rail-ink-muted"
            strokeWidth={1.75}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-rail-ink">
            Puesta en marcha
          </span>
          <span className="tabular block truncate text-micro text-rail-ink-muted">
            {ready} de {total} pasos
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-rail-ink-faint transition-transform group-hover/setup:translate-x-0.5 motion-reduce:transition-none"
        />
      </Link>
    );
  }

  const label = user?.name?.trim() || user?.email || 'Tu cuenta';
  const initial = Array.from(label.trim())[0]?.toLocaleUpperCase('es') ?? '?';
  const footerLinks = rail.footer.filter((item) =>
    ['/settings', '/plan', '/ayuda'].includes(item.href),
  );

  /** El menú de la persona: lo que antes eran tres filas sueltas al pie. */
  function userMenu() {
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title={small ? label : undefined}
            aria-label={`Cuenta de ${label}`}
            className={clsx(
              'group/user flex items-center rounded-sm text-left transition-colors hover:bg-rail-2 data-[state=open]:bg-rail-2 motion-reduce:transition-none',
              FOCUS,
              small ? 'mx-auto h-9 w-9 justify-center' : 'min-w-0 flex-1 gap-2.5 p-1.5',
            )}
          >
            <span
              aria-hidden
              className={clsx(
                'grid shrink-0 place-items-center rounded-full bg-amber-soft font-semibold text-amber',
                small ? 'h-7 w-7 text-xs' : 'h-8 w-8 text-[13px]',
              )}
            >
              {initial}
            </span>
            {!small && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold leading-tight text-rail-ink">
                    {label}
                  </span>
                  {user?.name && (
                    <span className="block truncate text-micro leading-tight text-rail-ink-faint">
                      {user.email}
                    </span>
                  )}
                </span>
                <ChevronsUpDown
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 text-rail-ink-faint"
                  strokeWidth={1.75}
                />
              </>
            )}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side={small ? 'right' : 'top'}
            align={small ? 'end' : 'start'}
            sideOffset={8}
            className="z-[80] w-64 rounded-card border border-border bg-surface p-1.5 shadow-pop"
          >
            <div className="px-2.5 pb-2 pt-1.5">
              <p className="truncate text-[13px] font-semibold text-ink">{label}</p>
              {user?.name && <p className="truncate text-micro text-ink-faint">{user.email}</p>}
            </div>
            <div className="my-1 h-px bg-border" aria-hidden />
            {footerLinks.map((item) => {
              const Icon = item.icon;
              return (
                <DropdownMenu.Item key={item.href} asChild>
                  <Link
                    href={hrefFor(item)}
                    onClick={onClickFor(item).onClick}
                    className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] font-medium text-ink outline-none transition-colors data-[highlighted]:bg-surface-2"
                  >
                    <Icon className="h-4 w-4 text-ink-faint" strokeWidth={1.75} />
                    {item.label}
                  </Link>
                </DropdownMenu.Item>
              );
            })}
            <div className="my-1 h-px bg-border" aria-hidden />
            <div className="px-1 py-1">
              <p className="px-1.5 pb-1 text-micro font-medium text-ink-faint">Tema</p>
              <ThemeToggle />
            </div>
            <div className="my-1 h-px bg-border" aria-hidden />
            <DropdownMenu.Item
              disabled={signingOut}
              onSelect={(e) => {
                e.preventDefault();
                void signOut();
              }}
              className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] font-medium text-ink outline-none transition-colors data-[disabled]:opacity-60 data-[highlighted]:bg-surface-2"
            >
              <LogOut className="h-4 w-4 text-ink-faint" strokeWidth={1.75} aria-hidden />
              {signingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }

  const chatHref = organization ? workspaceHref(organization.id, '/chat') : '/chat';
  const iconBtn = clsx(
    'grid shrink-0 place-items-center rounded-sm text-rail-ink-muted transition-colors hover:bg-rail-2 hover:text-rail-ink motion-reduce:transition-none',
    FOCUS,
  );

  const topRows = rail.pinned.flatMap((item) => {
    const base = item.href === WAITING_AFTER ? [door(item), waitingRow()] : [door(item)];
    if (item.href === '/chat' && !small && recent.length > 0) {
      return [
        ...base,
        <div key="recent" className="ml-[18px] space-y-px border-l border-rail-border pl-2">
          {recent.map(recentRow)}
        </div>,
      ];
    }
    return base;
  });

  return (
    <>
      {/* CABECERA: el espacio, nuevo chat y la búsqueda. */}
      <div className={clsx('shrink-0', small ? 'space-y-1 px-2 pt-3' : 'px-3 pt-3')}>
        <div className={clsx(small ? 'space-y-1' : 'flex items-center gap-1')}>
          {organization ? (
            <div className={clsx(!small && 'min-w-0 flex-1')}>
              <WorkspaceSwitcher
                active={organization}
                collapsed={small}
                onOpenChange={onWorkspaceOpenChange}
              />
            </div>
          ) : (
            <Link
              href="/overview"
              onClick={onNavigate}
              aria-label="Cortex, abrir vista global"
              className={clsx('flex min-w-0 flex-1 items-center gap-2 rounded-sm p-1', FOCUS)}
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-primary text-white">
                <CortexSignature className="h-5 w-5" />
              </span>
              {!small && <span className="text-sm font-bold text-rail-ink">Cortex</span>}
            </Link>
          )}
          <Link
            href={chatHref}
            onClick={() => onNavigate?.()}
            title="Nuevo chat"
            aria-label="Nuevo chat"
            className={clsx(iconBtn, small ? 'mx-auto h-9 w-9' : touch ? 'h-10 w-10' : 'h-8 w-8')}
          >
            <SquarePen className="h-4 w-4" strokeWidth={1.75} />
          </Link>
          {small ? null : headerExtra}
        </div>
        <button
          type="button"
          onClick={() => {
            commands.setOpen(true);
            onNavigate?.();
          }}
          aria-label="Buscar en Cortex"
          aria-keyshortcuts="Meta+K Control+K"
          title={small ? 'Buscar (⌘K)' : undefined}
          className={clsx(
            'flex items-center text-[13px] text-rail-ink-faint transition-colors hover:text-rail-ink-muted motion-reduce:transition-none',
            FOCUS,
            small
              ? 'mx-auto h-9 w-9 justify-center rounded-sm hover:bg-rail-2'
              : clsx(
                  'mt-2 w-full gap-2 rounded-sm border border-rail-border bg-canvas px-2.5 hover:border-border-strong',
                  touch ? 'h-10' : 'h-8',
                ),
          )}
        >
          <Search className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {!small && (
            <>
              <span className="flex-1 text-left">Buscar…</span>
              <kbd className="font-sans text-micro font-medium">⌘K</kbd>
            </>
          )}
        </button>
      </div>

      <nav
        ref={navRef}
        aria-label="Navegación principal"
        onKeyDown={onNavKeyDown}
        className={clsx(
          'scroll-slim min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4 pt-3',
          small ? 'px-2' : 'px-3',
        )}
      >
        <div className="space-y-0.5">{topRows}</div>

        <div
          className={clsx('mt-4 space-y-1', small && 'space-y-1 border-t border-rail-border pt-3')}
        >
          {sections.map(sectionBlock)}
          {!small && (
            <div className="pt-2">
              <CreateCompanyButton />
            </div>
          )}
        </div>
      </nav>

      {/* PIE: puesta en marcha, la persona y fijar el rail. */}
      <div
        className={clsx(
          'shrink-0 space-y-2 border-t border-rail-border',
          small ? 'px-2 py-2' : 'px-3 py-3',
        )}
        style={touch ? { paddingBottom: 'max(12px, env(safe-area-inset-bottom))' } : undefined}
      >
        {setupCard()}
        <div className={clsx('flex items-center gap-1', small && 'flex-col')}>
          {userMenu()}
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={pinnedCollapsed ? 'Fijar el menú expandido' : 'Contraer el menú'}
              title={pinnedCollapsed ? 'Expandir el menú' : 'Contraer el menú'}
              className={clsx(iconBtn, small ? 'mx-auto h-9 w-9' : 'h-8 w-8')}
            >
              {small ? (
                <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          )}
        </div>
        {signOutError && (
          <p role="alert" className={clsx('text-xs text-rose', small ? 'sr-only' : 'px-1.5')}>
            {signOutError}
          </p>
        )}
        {!small && organization?.kind === 'company' && (
          <CorporateSupervisionNotice kind={organization.kind} />
        )}
      </div>
    </>
  );
}

export function Sidebar({
  role,
  counts = EMPTY,
  signals = NO_SIGNALS,
  organization,
  modulesOff = NO_MODULES_OFF,
  user,
}: {
  role: Role;
  counts?: NavCounts;
  /** Hoy (decisiones del piloto) y progreso de la puesta en marcha. */
  signals?: ShellSignals;
  organization?: ActiveOrganization;
  /** Módulos que la empresa apagó (0186). Lo lee el shell, una vez. */
  modulesOff?: ModuleKey[];
  /** Quién es, para la fila del pie. */
  user?: SidebarUser;
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
  const shared = { role, counts, signals, organization, modulesOff, user };
  return (
    <>
      <aside
        className={clsx(
          'relative hidden h-full shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none print:hidden md:flex',
          compact ? 'w-14' : 'w-[264px]',
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
            'workspace-rail flex h-full flex-col overflow-hidden border-r border-rail-border bg-rail transition-[width,box-shadow] duration-200 ease-out motion-reduce:transition-none',
            compact ? 'absolute inset-y-0 left-0 z-40' : 'w-full',
            compact && (expanded ? 'w-[264px] shadow-pop' : 'w-14'),
          )}
        >
          <SidebarBody
            {...shared}
            small={!expanded}
            onExpand={() => setPeek(true)}
            onToggleCollapsed={inChat ? undefined : toggle}
            pinnedCollapsed={collapsed}
            onWorkspaceOpenChange={setWorkspaceOpen}
          />
        </div>
      </aside>
      <Dialog.Root open={mobile.open} onOpenChange={mobile.setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sidebar-overlay fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm md:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="sidebar-drawer fixed inset-y-0 left-0 z-50 flex w-[min(320px,88vw)] flex-col rounded-r-card bg-rail shadow-pop md:hidden"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
          >
            <Dialog.Title className="sr-only">Menú de Cortex</Dialog.Title>
            <SidebarBody
              {...shared}
              small={false}
              onExpand={() => {}}
              onNavigate={() => mobile.setOpen(false)}
              headerExtra={
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Cerrar el menú"
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-sm text-rail-ink-muted transition-colors hover:bg-rail-2 hover:text-rail-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <X className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </Dialog.Close>
              }
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

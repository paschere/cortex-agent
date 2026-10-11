'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { authClient } from '@/lib/auth-client';
import {
  ACTIVITY,
  type NavItem,
  type NavSection,
  PILOT,
  WAITING_AFTER,
  WAITING_LABEL,
  buildRail,
  routeVisible,
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
  Check,
  ChevronDown,
  ChevronRight,
  Inbox,
  LayoutDashboard,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SquarePen,
  Star,
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
 * EL RAIL, ESTILO CUADERNO.
 *
 * La estructura de datos no cambia (ver `lib/nav-shape.ts`); cambia la pintura:
 *
 *   · El rail es el PAPEL (`bg-rail` = el lienzo) y el contenido va en una hoja
 *     blanca redondeada a su derecha (`.cortex-sheet`, ver `globals.css`).
 *   · CABECERA: el espacio de trabajo (monograma, nombre, rol) y la píldora
 *     blanca «Pídele algo a Cortex ⌘K», que abre la paleta.
 *   · ARRIBA: Hoy (con su estrella), Chat (con sus últimos hilos), Te espera
 *     (se despliega en el sitio con sus cuatro colas) y «Lo que hizo Cortex».
 *   · «MI EMPRESA»: una fila por área (Plata, Clientes, Operación, Equipo, Legal)
 *     con su letra en pastel; cada una despliega sus pantallas.
 *   · «MIS ESPACIOS»: Vistas, Tablas, Aplicaciones y Cerebro.
 *   · «MÁS»: el resto de secciones del producto, plegables como siempre.
 *   · PIE: la tarjeta de «Puesta en marcha» (sólo mientras falte) y la persona
 *     con su menú «…» (Ajustes, Plan, Ayuda, Cambiar de empresa, tema, salir).
 *   · PLEGADO: 68px de iconos y letras; se ensancha con un roce.
 *
 * Cada sección y cada grupo recuerda en `localStorage` (`sidebar_sections`) si
 * estaba abierto. El cuerpo (`SidebarBody`) se exporta para que la página de
 * pruebas visuales (`/v/sidebar-showcase`) lo pinte en cualquier ancho.
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

/** Las áreas de «Mi empresa»: su sección en `nav-shape`, su palabra, su letra y su pastel. */
type Tone = 'primary' | 'rose' | 'emerald' | 'amber' | 'sky';
const AREAS: Array<{ id: string; label: string; letter: string; tone: Tone }> = [
  { id: 'finance', label: 'Plata', letter: '$', tone: 'primary' },
  { id: 'work', label: 'Clientes', letter: 'C', tone: 'rose' },
  { id: 'operations', label: 'Operación', letter: 'O', tone: 'emerald' },
  { id: 'people', label: 'Equipo', letter: 'E', tone: 'amber' },
  { id: 'legal', label: 'Legal', letter: 'L', tone: 'sky' },
];
const TONE: Record<Tone, string> = {
  primary: 'bg-primary-soft text-primary-ink',
  rose: 'bg-rose-soft text-rose',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  sky: 'bg-sky-soft text-sky',
};
/** Orden de «Mis espacios». Lo que el rail fije y no esté aquí se agrega al final. */
const SPACES_ORDER = ['/views', '/trackers', '/apps', '/kb'];
const GROUP_PREFIX = 'group:';

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

/** Cuenta de una fila: cifra tenue, o píldora rosa cuando algo espera. */
function Count({ n, rose }: { n: number; rose?: boolean }) {
  return (
    <span
      className={clsx(
        'tabular text-[12px] font-bold leading-none',
        rose ? 'rounded-pill bg-rose-soft px-2 py-1 text-rose' : 'text-rail-ink-faint',
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}

/** La letra en pastel de un área. */
function Tile({ letter, tone, size = 20 }: { letter: string; tone: Tone; size?: 20 | 22 }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'grid shrink-0 place-items-center font-bold',
        size === 20
          ? 'h-5 w-5 rounded-[6px] text-[11px]'
          : 'h-[22px] w-[22px] rounded-[7px] text-[12px]',
        TONE[tone],
      )}
    >
      {letter}
    </span>
  );
}

/** Los pasos de la puesta en marcha, en segmentos: llenos los hechos. */
function Segments({ ready, total }: { ready: number; total: number }) {
  const n = Math.min(Math.max(total, 1), 12);
  const filled = total > 12 ? Math.round((ready / total) * n) : ready;
  return (
    <div className="flex gap-1" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: segmentos fijos, sin identidad propia.
          key={i}
          className={clsx('h-[5px] flex-1 rounded-[3px]', i < filled ? 'bg-primary' : 'bg-rail-2')}
        />
      ))}
    </div>
  );
}

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0';
/** La fila activa se levanta del papel: hoja blanca con filete. */
const ACTIVE_ROW = 'bg-surface font-semibold text-rail-ink shadow-card';
const IDLE_ROW = 'text-rail-ink-muted hover:bg-rail-2 hover:text-rail-ink';

function initialsOf(label: string) {
  const parts = label
    .trim()
    .split(/[\s@.]+/)
    .filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[1]] : [parts[0]];
  return (
    letters
      .map((w) => Array.from(w ?? '')[0] ?? '')
      .join('')
      .toLocaleUpperCase('es')
      .slice(0, 2) || '?'
  );
}

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
  /** El rail estrecho de 68px: sólo iconos. */
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
  // «Lo que hizo Cortex» sube al bloque de arriba: se quita de su sección para no repetirse.
  const showActivity = routeVisible(ACTIVITY.href, modulesOff);
  const rest: NavSection[] = rail.rest
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.href !== ACTIVITY.href),
    }))
    .filter((section) => section.items.length > 0);
  // «La empresa» es una sección más; «Todas mis empresas» cuelga de ella.
  const company: NavSection | null =
    rail.company.items.length > 0 || founder
      ? { ...rail.company, items: [...(founder ? globalItems : []), ...rail.company.items] }
      : null;
  const areas = AREAS.flatMap((area) => {
    const section = rest.find((s) => s.id === area.id);
    return section ? [{ ...area, section }] : [];
  });
  const areaIds = new Set(AREAS.map((a) => a.id));
  const more: NavSection[] = [
    ...rest.filter((s) => !areaIds.has(s.id)),
    ...(company ? [company] : []),
  ];
  const pinnedBy = new Map(rail.pinned.map((item) => [item.href, item]));
  const hoy = pinnedBy.get(PILOT.href);
  const chat = pinnedBy.get('/chat');
  const spaces = [
    ...SPACES_ORDER.flatMap((href) => pinnedBy.get(href) ?? []),
    ...rail.pinned.filter(
      (item) =>
        item.href !== PILOT.href && item.href !== '/chat' && !SPACES_ORDER.includes(item.href),
    ),
  ];
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
  const [switcherSignal, setSwitcherSignal] = useState(0);
  const current = selection?.path === path ? selection : null;
  const waitingOpen = !small && (current ? current.waiting : waitingActive);
  const scope = touch ? 'mobile' : 'desktop';
  const recent = useRecentChats(!small, path, recentOverride);
  const navRef = useRef<HTMLElement>(null);

  const rowH = touch ? 'h-11' : 'h-9';
  const subH = touch ? 'h-10' : 'h-8';

  const sectionOpen = (section: NavSection) =>
    !small &&
    (saved[section.id] ??
      (section.id === 'today' || section.items.some((item) => matches(path, item.href))));
  const groupOpen = (id: string) => !small && (saved[GROUP_PREFIX + id] ?? true);
  function persist(next: Record<string, boolean>) {
    setSaved(next);
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
    } catch {}
  }
  function toggleSection(section: NavSection) {
    persist({ ...saved, [section.id]: !sectionOpen(section) });
  }
  function toggleGroup(id: string) {
    persist({ ...saved, [GROUP_PREFIX + id]: !groupOpen(id) });
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

  /** El icono de una puerta: la estrella de Hoy, el índigo del chat, el verde de lo hecho. */
  function doorIcon(item: NavItem, active: boolean, size: string) {
    if (item.href === PILOT.href) {
      return (
        <Star
          className={clsx(size, 'shrink-0 fill-star text-star')}
          strokeWidth={1.25}
          aria-hidden
        />
      );
    }
    const Icon = item.href === ACTIVITY.href ? Check : item.icon;
    const color =
      item.href === '/chat'
        ? 'text-primary'
        : item.href === ACTIVITY.href
          ? 'text-emerald'
          : active
            ? 'text-rail-ink'
            : 'text-rail-ink-faint group-hover/row:text-rail-ink-muted';
    return <Icon className={clsx(size, 'shrink-0 transition-colors', color)} strokeWidth={1.75} />;
  }

  /** Una puerta del rail: icono, palabra y, si hay, lo que espera. */
  function door(item: NavItem) {
    const active = matches(path, item.href);
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
          'group/row relative flex min-w-0 items-center rounded-[10px] text-[14px] transition-colors duration-150 motion-reduce:transition-none',
          FOCUS,
          small
            ? clsx(
                'mx-auto h-10 w-10 justify-center rounded-[12px]',
                active && 'bg-surface shadow-card',
              )
            : clsx(
                rowH,
                'w-full gap-2.5 px-3',
                active ? ACTIVE_ROW : clsx('font-medium', IDLE_ROW),
              ),
        )}
      >
        {doorIcon(item, active, small ? 'h-[18px] w-[18px]' : 'h-4 w-4')}
        {!small && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {!small && badge > 0 && <Count n={badge} />}
      </Link>
    );
  }

  /** Chat: la puerta, «nuevo chat» al roce y los últimos hilos debajo. */
  function chatRows(item: NavItem) {
    const rows: ReactNode[] = [];
    rows.push(
      small ? (
        door(item)
      ) : (
        <div key={item.href} className="group/chat relative">
          {door(item)}
          <Link
            href={chatHref}
            onClick={() => onNavigate?.()}
            title="Nuevo chat"
            aria-label="Nuevo chat"
            className={clsx(
              'absolute right-1.5 top-1/2 grid -translate-y-1/2 place-items-center rounded-[8px] bg-rail text-rail-ink-muted opacity-0 transition-opacity hover:bg-rail-2 hover:text-rail-ink group-focus-within/chat:opacity-100 group-hover/chat:opacity-100 motion-reduce:transition-none',
              touch ? 'h-8 w-8 opacity-100' : 'h-6 w-6',
              FOCUS,
            )}
          >
            <SquarePen className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>
        </div>
      ),
    );
    if (!small && recent.length > 0) {
      rows.push(
        <div key="recent" className="flex flex-col pl-[38px]">
          {recent.map(recentRow)}
        </div>,
      );
    }
    return rows;
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
          'flex items-center rounded-[8px] px-2 text-[13px] transition-colors duration-150 motion-reduce:transition-none',
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
          'flex items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors duration-150 motion-reduce:transition-none',
          subH,
          FOCUS,
          active ? 'bg-rail-2 font-semibold text-rail-ink' : IDLE_ROW,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {badge > 0 && <Count n={badge} />}
      </Link>
    );
  }

  /** «Te espera»: una fila con la suma que despliega las cuatro colas. */
  function waitingRow() {
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
            'group/row relative flex items-center rounded-[10px] text-[14px] transition-colors duration-150 motion-reduce:transition-none',
            FOCUS,
            small
              ? 'mx-auto h-10 w-10 justify-center rounded-[12px]'
              : clsx(rowH, 'w-full gap-2.5 px-3 font-medium'),
            waitingActive && !waitingOpen && !small ? ACTIVE_ROW : IDLE_ROW,
          )}
        >
          <Inbox
            className={clsx('shrink-0 text-rose', small ? 'h-[18px] w-[18px]' : 'h-4 w-4')}
            strokeWidth={1.75}
          />
          {!small && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">{WAITING_LABEL}</span>
              {!waitingOpen && waitingCount > 0 && <Count n={waitingCount} rose />}
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
              className="tabular absolute right-0.5 top-1 grid h-[14px] min-w-[14px] place-items-center rounded-pill bg-rose px-1 text-[9px] font-bold leading-none text-white"
            >
              {waitingCount > 99 ? '99+' : waitingCount}
            </span>
          )}
        </button>
        {!small && (
          <Collapsible open={waitingOpen} id={`sidebar-${scope}-waiting`}>
            <div className="space-y-0.5 pl-[30px]">{rail.waiting.map(queueRow)}</div>
          </Collapsible>
        )}
      </div>
    );
  }

  /** Una pantalla dentro de un área o una sección. */
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
          'group/row flex items-center gap-2.5 rounded-[8px] px-2 text-[13px] transition-colors duration-150 motion-reduce:transition-none',
          subH,
          FOCUS,
          active ? 'bg-rail-2 font-semibold text-rail-ink' : IDLE_ROW,
        )}
      >
        <Icon
          className={clsx(
            'h-3.5 w-3.5 shrink-0 transition-colors',
            active ? 'text-rail-ink' : 'text-rail-ink-faint group-hover/row:text-rail-ink-muted',
          )}
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {badge > 0 && <Count n={badge} />}
        {wanted && (
          <ArrowUpRight
            aria-hidden
            className="h-3 w-3 shrink-0 text-rail-ink-faint opacity-0 transition-opacity group-hover/row:opacity-100"
          />
        )}
      </Link>
    );
  }

  /** Un espacio propio (Vistas, Tablas…): icono gris cálido y la palabra. */
  function spaceRow(item: NavItem) {
    const active = matches(path, item.href);
    const Icon = item.icon;
    const { wanted, onClick } = onClickFor(item);
    const badge = badgeFor(item);
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        data-nav
        title={small ? item.label : undefined}
        aria-label={small ? item.label : undefined}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={clsx(
          'group/row flex items-center rounded-[10px] text-[14px] transition-colors duration-150 motion-reduce:transition-none',
          FOCUS,
          small
            ? clsx(
                'mx-auto h-10 w-10 justify-center rounded-[12px]',
                active && 'bg-surface shadow-card',
              )
            : clsx(
                touch ? 'h-11' : 'h-[34px]',
                'gap-2.5 px-3',
                active ? ACTIVE_ROW : clsx('font-medium', IDLE_ROW),
              ),
        )}
      >
        <Icon
          className={clsx(
            'shrink-0 transition-colors',
            small ? 'h-[18px] w-[18px]' : 'h-4 w-4',
            active ? 'text-rail-ink' : 'text-rail-ink-faint group-hover/row:text-rail-ink-muted',
          )}
          strokeWidth={1.75}
        />
        {!small && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {!small && badge > 0 && <Count n={badge} />}
        {!small && wanted && (
          <ArrowUpRight
            aria-hidden
            className="h-3 w-3 shrink-0 text-rail-ink-faint opacity-0 transition-opacity group-hover/row:opacity-100"
          />
        )}
      </Link>
    );
  }

  /** Un área de «Mi empresa»: letra en pastel; se despliega con sus pantallas. */
  function areaBlock(area: (typeof areas)[number]) {
    const { section } = area;
    const open = sectionOpen(section);
    const hasActive = section.items.some((item) => matches(path, item.href));
    if (small) {
      return (
        <button
          key={section.id}
          type="button"
          data-nav
          onClick={onExpand}
          title={area.label}
          aria-label={area.label}
          className={clsx(
            'mx-auto grid h-10 w-10 place-items-center rounded-[12px] transition-colors hover:bg-rail-2',
            FOCUS,
            hasActive && 'bg-surface shadow-card',
          )}
        >
          <Tile letter={area.letter} tone={area.tone} size={22} />
        </button>
      );
    }
    return (
      <div key={section.id}>
        <button
          type="button"
          data-nav
          aria-expanded={open}
          aria-controls={`sidebar-${scope}-${section.id}`}
          onClick={() => toggleSection(section)}
          className={clsx(
            'group/row flex w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[14px] font-medium transition-colors duration-150 motion-reduce:transition-none',
            touch ? 'h-11' : 'h-[34px]',
            FOCUS,
            hasActive && !open ? ACTIVE_ROW : IDLE_ROW,
          )}
        >
          <Tile letter={area.letter} tone={area.tone} />
          <span className="min-w-0 flex-1 truncate">{area.label}</span>
          <ChevronRight
            aria-hidden
            className={clsx(
              'h-3.5 w-3.5 shrink-0 text-rail-ink-faint transition-transform duration-200 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </button>
        <Collapsible open={open} id={`sidebar-${scope}-${section.id}`}>
          <div className="space-y-0.5 pl-[30px]">{section.items.map(row)}</div>
        </Collapsible>
      </div>
    );
  }

  /** El encabezado de un grupo («Mi empresa», «Mis espacios», «Más»). */
  function groupHeader(id: string, label: string, open: boolean) {
    return (
      <button
        type="button"
        data-nav
        aria-expanded={open}
        aria-controls={`sidebar-${scope}-group-${id}`}
        onClick={() => toggleGroup(id)}
        className={clsx(
          'group/sec flex w-full items-center gap-1.5 rounded-[8px] px-3 text-left text-[12px] font-semibold text-rail-ink-faint transition-colors hover:text-rail-ink-muted',
          touch ? 'h-9' : 'h-7',
          FOCUS,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          aria-hidden
          className={clsx(
            'h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
            !open && '-rotate-90',
          )}
        />
      </button>
    );
  }

  /** Una sección plegable del resto del producto. En el rail estrecho es un icono. */
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
            'mx-auto grid h-10 w-10 place-items-center rounded-[12px] transition-colors hover:bg-rail-2',
            FOCUS,
            hasActive
              ? 'bg-surface text-rail-ink shadow-card'
              : 'text-rail-ink-faint hover:text-rail-ink-muted',
          )}
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      );
    }
    return (
      <div key={section.id}>
        <button
          type="button"
          data-nav
          aria-expanded={open}
          aria-controls={`sidebar-${scope}-${section.id}`}
          onClick={() => toggleSection(section)}
          className={clsx(
            'group/row flex w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[14px] font-medium transition-colors duration-150 motion-reduce:transition-none',
            touch ? 'h-11' : 'h-[34px]',
            FOCUS,
            hasActive && !open ? ACTIVE_ROW : IDLE_ROW,
          )}
        >
          <Icon className="h-4 w-4 shrink-0 text-rail-ink-faint" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">{section.label}</span>
          <ChevronRight
            aria-hidden
            className={clsx(
              'h-3.5 w-3.5 shrink-0 text-rail-ink-faint transition-transform duration-200 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </button>
        <Collapsible open={open} id={`sidebar-${scope}-${section.id}`}>
          <div className="space-y-0.5 pl-[30px]">{section.items.map(row)}</div>
        </Collapsible>
      </div>
    );
  }

  /** La tarjeta de «Puesta en marcha»: sólo mientras falte. */
  function setupCard() {
    if (!rail.setup || !signals.setup) return null;
    const { ready, total } = signals.setup;
    const { onClick } = onClickFor(rail.setup);
    if (small) {
      return (
        <Link
          href={hrefFor(rail.setup)}
          onClick={onClick}
          title={`Puesta en marcha: ${ready} de ${total}`}
          aria-label={`Puesta en marcha: ${ready} de ${total} pasos`}
          className={clsx(
            'mx-auto grid h-10 w-10 place-items-center rounded-[12px] bg-surface shadow-card',
            FOCUS,
          )}
        >
          <span className="tabular text-[11px] font-bold text-primary-ink">
            {ready}/{total}
          </span>
        </Link>
      );
    }
    return (
      <Link
        href={hrefFor(rail.setup)}
        onClick={onClick}
        className={clsx(
          'group/setup flex flex-col gap-2.5 rounded-[14px] bg-surface p-3.5 shadow-card transition-shadow motion-reduce:transition-none',
          FOCUS,
        )}
      >
        <span className="flex items-center gap-2.5">
          <span className="title-display min-w-0 flex-1 truncate !text-[17px] !leading-tight text-rail-ink md:!text-[17px]">
            Puesta en marcha
          </span>
          <span className="tabular shrink-0 text-[12px] text-rail-ink-faint">
            {ready} de {total}
          </span>
        </span>
        <Segments ready={ready} total={total} />
        <span className="text-[13px] font-semibold text-primary">
          Seguir con la puesta en marcha
          <span
            aria-hidden
            className="inline-block transition-transform group-hover/setup:translate-x-0.5"
          >
            {' '}
            →
          </span>
        </span>
      </Link>
    );
  }

  const label = user?.name?.trim() || user?.email || 'Tu cuenta';
  const initials = initialsOf(label);
  const footerLinks = rail.footer.filter((item) =>
    ['/settings', '/plan', '/ayuda'].includes(item.href),
  );
  const menuItem =
    'flex h-9 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-[14px] text-ink-muted outline-none transition-colors data-[highlighted]:bg-canvas data-[highlighted]:text-ink';

  /** El menú de la persona: ajustes, plan, ayuda, cambiar de empresa, tema y salir. */
  function userMenu() {
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title={small ? label : undefined}
            aria-label={`Cuenta de ${label}`}
            className={clsx(
              'group/user flex items-center rounded-[10px] text-left transition-colors hover:bg-rail-2 data-[state=open]:bg-rail-2 motion-reduce:transition-none',
              FOCUS,
              small ? 'mx-auto h-10 w-10 justify-center' : 'min-w-0 flex-1 gap-2.5 px-2.5 py-1.5',
            )}
          >
            <span
              aria-hidden
              className={clsx(
                'grid shrink-0 place-items-center rounded-full bg-highlight font-bold text-ink',
                small ? 'h-8 w-8 text-[12px]' : 'h-[30px] w-[30px] text-[12px]',
              )}
            >
              {initials}
            </span>
            {!small && (
              <>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-rail-ink">
                  {label}
                </span>
                <MoreHorizontal
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-rail-ink-faint"
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
            className="z-[80] w-64 rounded-[16px] bg-surface p-2 shadow-pop"
          >
            <div className="flex flex-col px-2.5 pb-3 pt-2.5">
              <p className="title-display truncate !text-[18px] !leading-tight text-ink md:!text-[18px]">
                {label}
              </p>
              {user?.name && <p className="truncate text-[13px] text-ink-faint">{user.email}</p>}
            </div>
            {footerLinks.map((item) => (
              <DropdownMenu.Item key={item.href} asChild>
                <Link href={hrefFor(item)} onClick={onClickFor(item).onClick} className={menuItem}>
                  {item.label}
                </Link>
              </DropdownMenu.Item>
            ))}
            {organization && (
              <DropdownMenu.Item
                onSelect={() => {
                  setTimeout(() => setSwitcherSignal((n) => n + 1), 60);
                }}
                className={menuItem}
              >
                Cambiar de empresa
              </DropdownMenu.Item>
            )}
            <div className="my-1.5 rounded-[12px] bg-canvas p-1.5">
              <ThemeToggle />
            </div>
            <DropdownMenu.Item
              disabled={signingOut}
              onSelect={(e) => {
                e.preventDefault();
                void signOut();
              }}
              className={clsx(menuItem, '!text-rose data-[disabled]:opacity-60')}
            >
              {signingOut ? 'Cerrando sesión…' : 'Cerrar sesión'}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }

  const chatHref = organization ? workspaceHref(organization.id, '/chat') : '/chat';
  const iconBtn = clsx(
    'grid shrink-0 place-items-center rounded-[10px] text-rail-ink-muted transition-colors hover:bg-rail-2 hover:text-rail-ink motion-reduce:transition-none',
    FOCUS,
  );

  const divider = <span aria-hidden className="mx-auto my-2 block h-px w-6 bg-rail-border" />;

  return (
    <>
      {/* CABECERA: el espacio y la píldora de «Pídele algo a Cortex». */}
      <div className={clsx('shrink-0', small ? 'space-y-2 px-2 pt-4' : 'px-3 pt-4')}>
        <div className={clsx(small ? 'space-y-1' : 'flex items-center gap-1')}>
          {organization ? (
            <div className={clsx(!small && 'min-w-0 flex-1')}>
              <WorkspaceSwitcher
                active={organization}
                collapsed={small}
                onOpenChange={onWorkspaceOpenChange}
                openSignal={switcherSignal}
              />
            </div>
          ) : (
            <Link
              href="/overview"
              onClick={onNavigate}
              aria-label="Cortex, abrir vista global"
              className={clsx('flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] p-1', FOCUS)}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-primary text-white">
                <CortexSignature className="h-5 w-5" />
              </span>
              {!small && <span className="text-sm font-bold text-rail-ink">Cortex</span>}
            </Link>
          )}
          {small ? null : headerExtra}
        </div>
        <button
          type="button"
          onClick={() => {
            commands.setOpen(true);
            onNavigate?.();
          }}
          aria-label="Pídele algo a Cortex o busca"
          aria-keyshortcuts="Meta+K Control+K"
          title={small ? 'Pídele algo a Cortex (⌘K)' : undefined}
          className={clsx(
            'flex items-center bg-surface text-[14px] text-rail-ink-faint shadow-card transition-colors hover:text-rail-ink-muted motion-reduce:transition-none',
            FOCUS,
            small
              ? 'mx-auto h-10 w-10 justify-center rounded-[12px]'
              : clsx('mt-3 w-full gap-2.5 rounded-[12px] px-3', touch ? 'h-11' : 'h-10'),
          )}
        >
          <Plus className="h-[15px] w-[15px] shrink-0 text-primary" strokeWidth={2} />
          {!small && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">Pídele algo a Cortex</span>
              <kbd className="rounded-[6px] bg-rail-2 px-1.5 py-0.5 font-sans text-[11px] font-semibold">
                ⌘K
              </kbd>
            </>
          )}
        </button>
      </div>

      <nav
        ref={navRef}
        aria-label="Navegación principal"
        onKeyDown={onNavKeyDown}
        className={clsx(
          'scroll-slim min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4',
          small ? 'px-2 pt-3' : 'px-3 pt-3',
        )}
      >
        <div className={clsx(small ? 'space-y-1.5' : 'space-y-0.5')}>
          {hoy && door(hoy)}
          {chat && chatRows(chat)}
          {waitingRow()}
          {showActivity && door(ACTIVITY)}
        </div>

        {small ? (
          <div className="space-y-1.5">
            {divider}
            {areas.map(areaBlock)}
            {spaces.length > 0 && divider}
            {spaces.map(spaceRow)}
            {more.length > 0 && divider}
            {more.map(sectionBlock)}
          </div>
        ) : (
          <>
            {areas.length > 0 && (
              <div className="mt-5">
                {groupHeader('empresa', 'Mi empresa', groupOpen('empresa'))}
                <Collapsible open={groupOpen('empresa')} id={`sidebar-${scope}-group-empresa`}>
                  <div className="space-y-0.5">{areas.map(areaBlock)}</div>
                </Collapsible>
              </div>
            )}
            {spaces.length > 0 && (
              <div className="mt-3">
                {groupHeader('espacios', 'Mis espacios', groupOpen('espacios'))}
                <Collapsible open={groupOpen('espacios')} id={`sidebar-${scope}-group-espacios`}>
                  <div className="space-y-0.5">{spaces.map(spaceRow)}</div>
                </Collapsible>
              </div>
            )}
            {more.length > 0 && (
              <div className="mt-3">
                {groupHeader('mas', 'Más', groupOpen('mas'))}
                <Collapsible open={groupOpen('mas')} id={`sidebar-${scope}-group-mas`}>
                  <div className="space-y-0.5">{more.map(sectionBlock)}</div>
                </Collapsible>
              </div>
            )}
            <div className="pt-3">
              <CreateCompanyButton />
            </div>
          </>
        )}
      </nav>

      {/* PIE: puesta en marcha, la persona y fijar el rail. */}
      <div
        className={clsx('shrink-0 space-y-2', small ? 'px-2 py-3' : 'px-3 pb-3 pt-1')}
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
              className={clsx(iconBtn, small ? 'mx-auto h-10 w-10' : 'h-8 w-8')}
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
          compact ? 'w-[68px]' : 'w-64',
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
            'workspace-rail flex h-full flex-col overflow-hidden bg-rail transition-[width,box-shadow] duration-200 ease-out motion-reduce:transition-none',
            compact ? 'absolute inset-y-0 left-0 z-40' : 'w-full',
            compact && (expanded ? 'w-64 rounded-r-[18px] shadow-pop' : 'w-[68px]'),
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
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] text-rail-ink-muted transition-colors hover:bg-rail-2 hover:text-rail-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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

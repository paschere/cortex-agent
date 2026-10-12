'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { clearCaptureData } from '@/lib/apps/capture-clear';
import { authClient } from '@/lib/auth-client';
import {
  type AreaRow,
  type DoorDef,
  type Favorite,
  type NavItem,
  type Tone,
  accountMenu,
  areaFor,
  buildSidebar,
  favoriteDefaults,
  iconForHref,
  primaryActive,
  pruneFavorites,
} from '@/lib/nav-shape';
import type { NavCounts, ShellSignals } from '@/lib/nav-signals';
import { recordVisit } from '@/lib/nav-usage';
import { panelForHref } from '@/lib/panels/shape';
import { waitingTotal } from '@/lib/waiting-shape';
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
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
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
import { publishFavoriteDefaults, useFavorites } from './favorites';

/**
 * EL RAIL, ESTILO CUADERNO («V2»: unas doce entradas).
 *
 * La estructura vive en `lib/nav-shape.ts` (`buildSidebar`); aquí sólo se pinta:
 *
 *   · CABECERA: el espacio de trabajo y la píldora «Buscar o pedir algo ⌘K».
 *   · ARRIBA: Hoy (estrella, con lo que espera tu decisión), Chat (con «nuevo
 *     chat» al roce), Aplicaciones, Vistas y Reportes.
 *   · «FAVORITOS»: lo que cada persona fija con la estrella (máx. 5), guardado
 *     por persona y empresa; vacío, parte de unos por defecto según el rol.
 *   · «MI EMPRESA»: Plata, Clientes y ventas, Operación, Equipo y Datos. Cada
 *     fila abre la primera pantalla del área, que enseña las demás como
 *     PESTAÑAS (`AreaTabs`, arriba de la página).
 *   · PIE: la tarjeta de «Puesta en marcha» (sólo mientras falte) y la persona,
 *     cuyo menú junta ajustes, conexiones, permisos, auditoría, plan, ayuda,
 *     cambiar de empresa, tema y salir.
 *   · PLEGADO: 68px de iconos y letras; se ensancha con un roce.
 *
 * Los grupos recuerdan en `localStorage` (`sidebar_sections`) si estaban
 * abiertos. El cuerpo (`SidebarBody`) se exporta para que la página de pruebas
 * visuales (`/v/sidebar-showcase`) lo pinte en cualquier ancho.
 */

const EMPTY: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };
const NO_MODULES_OFF: ModuleKey[] = [];
const NO_SIGNALS: ShellSignals = { pilot: 0, setup: null };
const SECTIONS_KEY = 'sidebar_sections';

export interface SidebarUser {
  name: string | null;
  email: string;
}

function matches(path: string, href: string) {
  if (href.includes('?')) return false;
  if (href === '/chat' && path.startsWith('/chat/global')) return false;
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

const TONE: Record<Tone, string> = {
  primary: 'bg-primary-soft text-primary-ink',
  rose: 'bg-rose-soft text-rose',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  sky: 'bg-sky-soft text-sky',
};
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
function Count({ n, rose, className }: { n: number; rose?: boolean; className?: string }) {
  return (
    <span
      className={clsx(
        'tabular text-[12px] font-bold leading-none',
        rose ? 'rounded-pill bg-rose-soft px-2 py-1 text-rose' : 'text-rail-ink-faint',
        className,
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
}) {
  const livePath = usePathname();
  const path = pathOverride ?? livePath;
  const panel = usePanel();
  const commands = useCommandMenu();
  const admin = role === 'org_admin';
  const founder = organization?.kind === 'company' && organization.role === 'owner';
  const touch = Boolean(onNavigate);
  const rail = buildSidebar({ admin, founder, modulesOff, setupDone: signals.setup === null });
  const account = accountMenu({ admin, founder, modulesOff });

  // Hoy cuenta lo que espera una decisión: lo del piloto y las cuatro colas de «Te espera».
  const hoyCount = signals.pilot + waitingTotal(counts);
  const countFor = (door: DoorDef): number => {
    if (door.href === '/piloto') return hoyCount;
    if (door.href === '/apps') return signals.apps ?? 0;
    if (door.href === '/views') return signals.views ?? 0;
    return 0;
  };

  const defaults = favoriteDefaults({
    admin,
    founder,
    modulesOff,
    shortcuts: signals.shortcuts,
  });
  const favs = useFavorites(user?.email ?? 'anon', organization?.id ?? 'global', defaults);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `defaults` se vuelve a calcular a cada pintado; sólo importa si cambió su contenido.
  useEffect(() => publishFavoriteDefaults(defaults), [JSON.stringify(defaults)]);
  const favorites = pruneFavorites(favs.list, modulesOff);

  const [saved, setSaved] = useState<Record<string, boolean>>({});
  useEffect(() => setSaved(readSavedSections()), []);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [switcherSignal, setSwitcherSignal] = useState(0);
  const navRef = useRef<HTMLElement>(null);
  const rowH = touch ? 'h-11' : 'h-9';

  const groupOpen = (id: string) => !small && (saved[GROUP_PREFIX + id] ?? true);
  function toggleGroup(id: string) {
    const next = { ...saved, [GROUP_PREFIX + id]: !groupOpen(id) };
    setSaved(next);
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
    } catch {}
  }

  async function signOut() {
    // Lo guardado en este teléfono (cola sin señal, copias de pantallas) no sobrevive a la sesión.
    if (!(await clearCaptureData({ ask: true }))) return;
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

  function hrefFor(item: { href: string }) {
    const global = item.href === '/overview';
    return organization && !global ? workspaceHref(organization.id, item.href) : item.href;
  }

  function onClickFor(item: { href: string }) {
    const global = item.href === '/overview';
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

  /** La estrella al borde de una fila: fija o suelta de «Favoritos». */
  function star(fav: Favorite, opts: { always?: boolean } = {}) {
    const on = favs.has(fav.href);
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={on ? `Quitar ${fav.label} de favoritos` : `Fijar ${fav.label} en favoritos`}
        title={on ? 'Quitar de favoritos' : 'Fijar en favoritos'}
        onClick={() => favs.toggle(fav)}
        className={clsx(
          'absolute right-1.5 top-1/2 grid -translate-y-1/2 place-items-center rounded-[8px] bg-rail text-rail-ink-faint transition-opacity hover:bg-rail-2 hover:text-rail-ink motion-reduce:transition-none',
          'group-focus-within/fav:opacity-100 group-hover/fav:opacity-100 focus-visible:opacity-100',
          touch ? 'h-8 w-8' : 'h-6 w-6',
          // En el teléfono no hay roce: sólo se ve donde ya es favorito.
          opts.always || (touch && on) ? 'opacity-100' : 'opacity-0',
          FOCUS,
        )}
      >
        <Star
          className={clsx('h-3.5 w-3.5', on && 'fill-star text-star')}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
    );
  }

  /** El icono de una puerta: la estrella amarilla de Hoy, el índigo del chat. */
  function doorIcon(item: NavItem, active: boolean, size: string) {
    if (item.href === '/piloto') {
      return (
        <Star
          className={clsx(size, 'shrink-0 fill-star text-star')}
          strokeWidth={1.25}
          aria-hidden
        />
      );
    }
    const Icon = item.icon;
    const color =
      item.href === '/chat'
        ? 'text-primary'
        : active
          ? 'text-rail-ink'
          : 'text-rail-ink-faint group-hover/row:text-rail-ink-muted';
    return <Icon className={clsx(size, 'shrink-0 transition-colors', color)} strokeWidth={1.75} />;
  }

  /** Una fila del rail: icono, palabra y, si hay, lo que espera. */
  function link(
    item: NavItem,
    opts: { active: boolean; count?: number; tile?: ReactNode; starred?: boolean },
  ) {
    const { active, count = 0 } = opts;
    const { onClick } = onClickFor(item);
    const label = count ? `${item.label}, ${count} pendientes` : item.label;
    const fav = { href: item.href, label: item.label };
    return (
      <div key={item.href} className="group/fav relative">
        <Link
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
          {opts.tile ?? doorIcon(item, active, small ? 'h-[18px] w-[18px]' : 'h-4 w-4')}
          {!small && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
          {!small && count > 0 && (
            <Count
              n={count}
              rose={item.href === '/piloto'}
              className="group-focus-within/fav:opacity-0 group-hover/fav:opacity-0"
            />
          )}
          {!small && onClickFor(item).wanted && (
            <ArrowUpRight
              aria-hidden
              className="h-3 w-3 shrink-0 text-rail-ink-faint opacity-0 transition-opacity group-hover/row:opacity-100"
            />
          )}
          {small && count > 0 && (
            <span
              aria-hidden
              className="tabular absolute right-0.5 top-1 grid h-[14px] min-w-[14px] place-items-center rounded-pill bg-rose px-1 text-[9px] font-bold leading-none text-white"
            >
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Link>
        {!small && star(fav, { always: opts.starred })}
      </div>
    );
  }

  /** Chat: la puerta y «nuevo chat» al roce. */
  function chatDoor(door: DoorDef) {
    const active = primaryActive(path, door);
    if (small) return link(door, { active });
    return (
      <div key={door.href} className="group/chat relative">
        {link(door, { active })}
        <Link
          href={chatHref}
          onClick={() => onNavigate?.()}
          title="Nuevo chat"
          aria-label="Nuevo chat"
          className={clsx(
            'absolute right-8 top-1/2 grid -translate-y-1/2 place-items-center rounded-[8px] bg-rail text-rail-ink-muted transition-opacity hover:bg-rail-2 hover:text-rail-ink group-focus-within/chat:opacity-100 group-hover/chat:opacity-100 motion-reduce:transition-none',
            touch ? 'h-8 w-8 opacity-100' : 'h-6 w-6 opacity-0',
            FOCUS,
          )}
        >
          <SquarePen className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Link>
      </div>
    );
  }

  /** Un favorito: su icono (o la letra de su área) y la palabra. */
  function favoriteRow(fav: Favorite) {
    const Icon = iconForHref(fav.href);
    const item: NavItem = { href: fav.href, label: fav.label, icon: Icon };
    return link(item, { active: matches(path, fav.href), starred: true });
  }

  /** Un área de «Mi empresa»: su letra en pastel; abre su primera pantalla. */
  function areaRowEl(row: AreaRow) {
    // Si una puerta de arriba ya enciende esta dirección (Cerebro, que también es
    // pestaña de «Datos»), el área no se enciende con ella: una sola fila activa.
    const active =
      areaFor(path)?.area.id === row.area.id && !rail.doors.some((d) => primaryActive(path, d));
    const item: NavItem = { href: row.href, label: row.area.label, icon: iconForHref(row.href) };
    return link(item, {
      active,
      tile: <Tile letter={row.area.letter} tone={row.area.tone} size={small ? 22 : 20} />,
    });
  }

  /** El encabezado de un grupo («Favoritos», «Mi empresa»). */
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
  const scope = touch ? 'mobile' : 'desktop';

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
  const menuItem =
    'flex h-9 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 text-[14px] text-ink-muted outline-none transition-colors data-[highlighted]:bg-canvas data-[highlighted]:text-ink data-[state=open]:bg-canvas';
  const menuBox = 'z-[80] w-64 rounded-[16px] bg-surface p-2 shadow-pop';

  /** Una entrada del menú de la cuenta, o un submenú si el grupo trae varias. */
  function accountEntry(group: (typeof account)[number]) {
    const [first] = group.items;
    if (group.items.length === 1 && first) {
      return (
        <DropdownMenu.Item key={group.id} asChild>
          <Link href={hrefFor(first)} onClick={onClickFor(first).onClick} className={menuItem}>
            {group.label}
          </Link>
        </DropdownMenu.Item>
      );
    }
    return (
      <DropdownMenu.Sub key={group.id}>
        <DropdownMenu.SubTrigger className={menuItem}>
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent sideOffset={6} alignOffset={-8} className={menuBox}>
            {group.items.map((item) => (
              <DropdownMenu.Item key={item.href} asChild>
                <Link href={hrefFor(item)} onClick={onClickFor(item).onClick} className={menuItem}>
                  {item.label}
                </Link>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    );
  }

  /** El menú de la persona: todo lo de configurar, cambiar de empresa, tema y salir. */
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
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-rail-ink">
                    {label}
                  </span>
                  <span className="block truncate text-[12px] text-rail-ink-faint">
                    Ajustes, conexiones, plan…
                  </span>
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
            collisionPadding={8}
            className={clsx(
              menuBox,
              'max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto',
            )}
          >
            <div className="flex flex-col px-2.5 pb-3 pt-2.5">
              <p className="title-display truncate !text-[18px] !leading-tight text-ink md:!text-[18px]">
                {label}
              </p>
              {user?.name && <p className="truncate text-[13px] text-ink-faint">{user.email}</p>}
            </div>
            {account.map(accountEntry)}
            <div className="my-1 h-px bg-border" />
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
            {rail.global && (
              <DropdownMenu.Item asChild>
                <Link
                  href={hrefFor(rail.global)}
                  onClick={onClickFor(rail.global).onClick}
                  className={menuItem}
                >
                  {rail.global.label}
                </Link>
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
      {/* CABECERA: el espacio y la píldora de búsqueda. */}
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
          aria-label="Buscar o pedir algo"
          aria-keyshortcuts="Meta+K Control+K"
          title={small ? 'Buscar o pedir algo (⌘K)' : undefined}
          className={clsx(
            'flex items-center bg-surface text-[14px] text-rail-ink-faint shadow-card transition-colors hover:text-rail-ink-muted motion-reduce:transition-none',
            FOCUS,
            small
              ? 'mx-auto h-10 w-10 justify-center rounded-[12px]'
              : clsx('mt-3 w-full gap-2.5 rounded-[12px] px-3', touch ? 'h-11' : 'h-10'),
          )}
        >
          <Search className="h-[15px] w-[15px] shrink-0 text-primary" strokeWidth={2} />
          {!small && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">Buscar o pedir algo</span>
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
          {rail.doors.map((door) =>
            door.href === '/chat'
              ? chatDoor(door)
              : link(door, { active: primaryActive(path, door), count: countFor(door) }),
          )}
        </div>

        {small ? (
          <div className="space-y-1.5">
            {favorites.length > 0 && divider}
            {favorites.map(favoriteRow)}
            {rail.areas.length > 0 && divider}
            {rail.areas.map(areaRowEl)}
          </div>
        ) : (
          <>
            {favorites.length > 0 && (
              <div className="mt-5">
                {groupHeader('favoritos', 'Favoritos', groupOpen('favoritos'))}
                <Collapsible open={groupOpen('favoritos')} id={`sidebar-${scope}-group-favoritos`}>
                  <div className="space-y-0.5">{favorites.map(favoriteRow)}</div>
                </Collapsible>
              </div>
            )}
            {rail.areas.length > 0 && (
              <div className="mt-4">
                {groupHeader('empresa', 'Mi empresa', groupOpen('empresa'))}
                <Collapsible open={groupOpen('empresa')} id={`sidebar-${scope}-group-empresa`}>
                  <div className="space-y-0.5">{rail.areas.map(areaRowEl)}</div>
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

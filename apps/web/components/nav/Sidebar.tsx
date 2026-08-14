'use client';

import { usePanel } from '@/components/panel/PanelHost';
import {
  ALL_ICON,
  ALL_LABEL,
  COMPANY_ICON,
  DEFAULT_QUICK,
  FOOTER,
  type NavItem,
  QUICK_CANDIDATES,
  WAITING_ICON,
  WAITING_LABEL,
  buildRail,
  waitingHref,
} from '@/lib/nav-shape';
import type { NavCounts } from '@/lib/nav-signals';
import {
  orderByUsage,
  pickQuick,
  readQuick,
  readUsage,
  recordVisit,
  writeQuick,
} from '@/lib/nav-usage';
import { type PanelId, panelForHref } from '@/lib/panels/shape';
import { waitingTotal } from '@/lib/waiting-shape';
import type { Role } from '@cortex/core';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { useMobileSidebar } from './MobileSidebarContext';

// CORTO ARRIBA, COMPLETO DEBAJO.
//
// Este archivo DIBUJA el rail; la lista de destinos y el porqué de cada grupo
// están en `lib/nav-shape.ts`, que es donde se puede probar sin un navegador.
//
// La forma es: tres filas que no se mueven nunca (Inicio, Chat, Te espera),
// cinco plazas que se ganan por uso, «Todo» con el resto dentro y «La empresa»
// aparte y plegada. Once filas donde había veintiocho, y ni un destino menos.
//
// LO QUE SE MANTIENE INTACTO, porque cada una costó una decisión: el rail se
// estrecha dentro de `/chat` y se asoma al pasar por encima sin mover la
// conversación; las filas con panel lo abren al lado en vez de navegar; los
// contadores; el cajón de móvil, con cada enlace cerrándolo; `adminOnly`; y el
// foco visible.

const COLLAPSE_KEY = 'sidebar_collapsed';

/**
 * Lo que está desplegado, recordado.
 *
 * Tres claves sueltas y no un objeto, por lo mismo que `sidebar_collapsed` es
 * una cadena: es una preferencia de esta persona en este navegador, no un dato
 * con estructura. Y sobre todo NO van en `nav_usage_v1` — ese objeto lo decae
 * `recordVisit` entero en cada escritura, así que un booleano metido ahí duraría
 * hasta el siguiente clic.
 */
const OPEN_KEY = {
  waiting: 'sidebar_waiting_open',
  all: 'sidebar_all_open',
  company: 'sidebar_company_open',
};

const NO_COUNTS: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };

const QUICK_HREFS = QUICK_CANDIDATES.map((item) => item.href);

/**
 * Un desplegable que se acuerda de cómo lo dejaste.
 *
 * Cerrado en el primer pintado, siempre, y la preferencia llega después de
 * hidratar: `localStorage` no existe en el servidor, así que leerlo durante el
 * render haría que el primer pintado del cliente no coincidiera con el HTML que
 * bajó. Se ve como un rail que da un salto.
 */
function useRemembered(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(localStorage.getItem(key) === 'true');
  }, [key]);
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Modo privado. Se despliega igual; sólo no se recuerda.
      }
      return next;
    });
  return [open, toggle];
}

function isActive(pathname: string, href: string): boolean {
  // Query-bearing entries are deliberately never matched: reading the query
  // would need useSearchParams, and matching on the path alone would light them
  // up at the same time as the entry for the bare path.
  if (href.includes('?')) return false;
  if (href === '/dashboard') return pathname === '/dashboard';
  // Integrations owns a child route that has a row of its own (WhatsApp), so
  // the parent matches exactly instead of by prefix. Prefix matching would light
  // two rows at once and make "where am I" unanswerable.
  if (href === '/integrations') return pathname === '/integrations';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** ¿Está la persona dentro de alguno de estos destinos? */
function isInside(pathname: string, items: NavItem[]): boolean {
  return items.some((item) => isActive(pathname, item.href));
}

/**
 * La forma de una fila, en un solo sitio.
 *
 * La comparten el enlace, la fila de buscar y los desplegables. Tres controles
 * distintos que tienen que verse como la misma columna: en cuanto las clases se
 * copian, una de ellas se queda con el `h-[30px]` viejo y el ritmo se rompe por
 * un píxel que nadie sabe de dónde sale.
 */
function rowClass(collapsed: boolean, active: boolean): string {
  return clsx(
    'group relative flex h-[30px] w-full items-center rounded-sm text-sm transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
    'motion-reduce:transition-none',
    collapsed ? 'justify-center' : 'gap-2.5 px-2.5',
    active
      ? 'bg-primary-soft font-semibold text-primary-ink'
      : 'font-medium text-ink-muted hover:bg-surface-2 hover:text-ink',
  );
}

/**
 * One destination, one line.
 *
 * THE ACTIVE ROW IS NOT A BLOCK OF COLOUR. It used to be saturated indigo with a
 * shadow, in a pill, which is the single most recognisable signature of an
 * untouched Tailwind theme — and it shouted, in a rail whose whole job is to
 * recede until asked. It is now the softest tint in the palette with the ink to
 * match, at the small radius the design system uses for everything that is not a
 * button. Unmistakable at a glance, silent otherwise.
 *
 * Rows change colour on hover and never move: a column of capsules flinching
 * under the cursor is noise.
 */
function NavRow({
  item,
  badge,
  collapsed,
  pathname,
  onNavigate,
  /**
   * El panel que esta fila abre en vez de navegar, si lo hay. Lo decide
   * `SidebarNav`, que es quien sabe dónde está la persona.
   */
  panel: wanted,
  /**
   * Se tiñe como activa aunque la ruta no sea la suya. Lo usa «Te espera»: con
   * las cuatro colas plegadas y la persona dentro de una de ellas, la fila padre
   * es la única que puede contestar «estás aquí». No toca `aria-current`, que
   * seguiría siendo mentira — la página no es la que este enlace abre.
   */
  groupActive = false,
  className,
}: {
  item: NavItem;
  badge: number;
  collapsed: boolean;
  pathname: string;
  onNavigate?: () => void;
  panel?: PanelId | null;
  groupActive?: boolean;
  className?: string;
}) {
  const Icon = item.icon;
  const { panelId: openPanel, open, available } = usePanel();
  // Sin proveedor encima no hay panel que abrir, y entonces la fila navega como
  // siempre. Comerse el clic con un `open` que no hace nada sería dejarla
  // muerta, que es peor que no tener panel.
  const panel = available ? (wanted ?? null) : null;
  // Un panel abierto también es «estás aquí». Se tiñe igual que una pantalla
  // activa, pero se anuncia distinto: `aria-current="page"` sería falso — la
  // página sigue siendo el chat.
  const showing = panel != null && openPanel === panel;
  const onPage = isActive(pathname, item.href);
  const active = onPage || showing || groupActive;

  return (
    <Link
      href={item.href}
      /**
       * SIGUE SIENDO UN ENLACE, Y ESO NO ES UN DETALLE.
       *
       * Un `<button>` habría sido más corto y habría roto la forma en que la
       * gente abre cosas: ⌘-clic, clic central, «abrir en una pestaña nueva»
       * del menú contextual. Todo eso necesita un `href` de verdad. Así que la
       * fila conserva el suyo y lo único que hace este manejador es
       * interceptar el clic SIMPLE cuando hay panel: cualquier modificador cae
       * por el `return` y el navegador hace lo de siempre. El clic central ni
       * siquiera llega aquí — dispara `auxclick`, no `click`.
       */
      onClick={(event) => {
        if (
          panel &&
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          open(panel);
        }
        onNavigate?.();
      }}
      aria-current={onPage ? 'page' : undefined}
      aria-expanded={panel ? showing : undefined}
      title={collapsed ? item.label : undefined}
      className={clsx(rowClass(collapsed, active), className)}
    >
      <span className="relative shrink-0">
        <Icon
          strokeWidth={1.75}
          className={clsx('h-4 w-4', active ? 'text-primary' : 'text-ink-faint')}
        />
        {collapsed && badge > 0 && (
          <span
            aria-hidden="true"
            className={clsx(
              'absolute -right-1.5 -top-1.5 min-w-[15px] rounded-full px-1 text-center text-micro font-bold leading-[15px] tabular-nums',
              active ? 'bg-primary text-white' : 'bg-ink-muted text-white',
            )}
          >
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {badge > 0 && (
            <>
              {/* No pill, no colour. A number is already the loudest thing that
                  can appear on a quiet row; putting an amber capsule around it
                  was the rail shouting about work it cannot describe. */}
              <span
                aria-hidden="true"
                className={clsx(
                  'shrink-0 text-micro tabular-nums',
                  active ? 'text-primary-ink' : 'text-ink-muted',
                )}
              >
                {badge > 99 ? '99+' : badge}
              </span>
              <span className="sr-only">, {badge} pendientes</span>
            </>
          )}
        </>
      )}
      {collapsed && badge > 0 && <span className="sr-only">{badge} pendientes</span>}
    </Link>
  );
}

/** El triángulo que abre un grupo. Gira; no rebota ni desaparece. */
function Chevron({
  open,
  label,
  controls,
  onToggle,
}: {
  open: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      className="shrink-0 rounded-full p-1 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
    >
      <ChevronRight
        strokeWidth={1.75}
        className={clsx(
          'h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none',
          open && 'rotate-90',
        )}
      />
    </button>
  );
}

/**
 * LA FILA QUE SUSTITUYE A CUATRO.
 *
 * `/approvals`, `/commitments`, `/actions` y `/errands` eran cuatro filas
 * haciendo la misma pregunta —«¿qué está parado esperándome?»— en un rail donde
 * la respuesta corta ya existía: la insignia es el TOTAL que
 * `waiting-shape.ts` ya suma para el aviso del chat, y el enlace lleva a la
 * primera cola que tenga algo dentro, en el orden de reloj que ese archivo
 * defiende.
 *
 * SON DOS CONTROLES Y ESO ES A PROPÓSITO. El enlace contesta «llévame a lo que
 * hay»; el triángulo contesta «¿pero qué hay?», y despliega las cuatro con su
 * cuenta cada una. Meter el triángulo dentro del enlace habría sido HTML
 * inválido (un botón dentro de un `<a>`) y, peor, habría hecho que la mitad
 * derecha de la fila hiciera algo distinto de la izquierda sin que se viera.
 *
 * Plegada, se dibuja como activa si estás dentro de cualquiera de las cuatro.
 * Nada se esconde: el rail sigue pudiendo decir dónde estás.
 */
function WaitingRow({
  counts,
  collapsed,
  pathname,
  items,
  open,
  onToggle,
  controls,
  onNavigate,
  panel,
}: {
  counts: NavCounts;
  collapsed: boolean;
  pathname: string;
  items: NavItem[];
  open: boolean;
  onToggle: () => void;
  controls: string;
  onNavigate?: (href: string) => void;
  panel: (href: string) => PanelId | null;
}) {
  const href = waitingHref(counts);
  const item = { href, label: WAITING_LABEL, icon: WAITING_ICON };
  // Plegada y estando dentro de una cola, la fila padre es quien dice «aquí».
  const inside = !open && isInside(pathname, items);

  return (
    <div className={clsx('flex items-center', collapsed ? 'justify-center' : 'gap-0.5')}>
      <NavRow
        item={item}
        badge={waitingTotal(counts)}
        collapsed={collapsed}
        pathname={pathname}
        onNavigate={() => onNavigate?.(href)}
        panel={panel(href)}
        groupActive={inside}
        className="min-w-0 flex-1"
      />
      {/* Contraído no hay 72px para dos controles, y no hace falta: lo único que
          hay que ver de reojo ahí es el total. El triángulo vuelve en cuanto el
          rail se ensancha, que en el chat es al acercar el ratón. */}
      {!collapsed && (
        <Chevron
          open={open}
          label={open ? 'Ocultar las cuatro colas' : 'Ver las cuatro colas'}
          controls={controls}
          onToggle={onToggle}
        />
      )}
    </div>
  );
}

/**
 * «Todo» y «La empresa»: una fila que no va a ninguna parte y abre aquí mismo.
 *
 * NO ES UN ENLACE Y NO PUEDE SERLO. Es la diferencia con la fila «Buscar» de
 * arriba, y es la que justifica que existan las dos: la paleta TE SACA de donde
 * estás a una pantalla que nombras escribiendo; esto ABRE DONDE ESTÁS lo que no
 * sabrías nombrar. Recordar contra reconocer. Por eso la paleta se queda con los
 * tres destinos que ni siquiera están en el rail y con los nombres viejos que la
 * gente teclea, y esto se queda con la lista para señalar con el dedo.
 */
function DisclosureRow({
  icon: Icon,
  label,
  count,
  collapsed,
  open,
  active,
  onToggle,
  controls,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  count?: number;
  collapsed: boolean;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      title={collapsed ? label : undefined}
      className={rowClass(collapsed, active)}
    >
      <Icon
        strokeWidth={1.75}
        className={clsx('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-ink-faint')}
      />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {count !== undefined && (
            <>
              {/* La cifra va en `ink-faint`, un paso más apagada que la de una
                  cola. En esta columna un número significa «cosas esperándote»,
                  y aquí significa «pantallas ahí dentro»: no puede leerse con el
                  mismo peso, y a un lector de pantalla se le dice cuál es. */}
              <span aria-hidden="true" className="shrink-0 text-micro tabular-nums text-ink-faint">
                {count}
              </span>
              <span className="sr-only">, {count} destinos</span>
            </>
          )}
          <ChevronRight
            aria-hidden="true"
            strokeWidth={1.75}
            className={clsx(
              'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </>
      )}
    </button>
  );
}

/**
 * The door to what the rail does not list.
 *
 * Shaped like every other row rather than like a search field. It was a fake
 * input with a border and its own height, which broke the rhythm of the column
 * to advertise a control that goes nowhere on its own. It keeps the shortcut
 * visible in the slot where the other rows keep their count.
 */
function SearchRow({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { setOpen } = useCommandMenu();
  // On mobile this sits inside the drawer and the palette opens over it. Without
  // closing the drawer the menu survives the navigation, because the layout does
  // not remount — the same reason every link here is wired to onNavigate.
  const open = () => {
    setOpen(true);
    onNavigate?.();
  };
  // Rendered as ⌘ and corrected after mount rather than guessed on the server:
  // the platform is not knowable while rendering, and a shortcut hint that names
  // the wrong key is worse than none. Post-mount, so no hydration mismatch.
  const [modKey, setModKey] = useState('⌘');
  useEffect(() => {
    if (!/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setModKey('Ctrl ');
  }, []);

  return (
    <button
      type="button"
      onClick={open}
      title={collapsed ? 'Buscar' : undefined}
      aria-label="Buscar o ir a una pantalla"
      aria-keyshortcuts="Meta+K Control+K"
      className={rowClass(collapsed, false)}
    >
      <Search strokeWidth={1.75} className="h-4 w-4 shrink-0 text-ink-faint" />
      {!collapsed && (
        <>
          <span className="flex-1 text-left">Buscar</span>
          {/* No aria-hidden needed: the button carries an explicit aria-label so
              nothing inside is announced, and aria-keyshortcuts is the honest
              way to tell a screen reader about ⌘K. */}
          <span className="shrink-0 font-mono text-micro text-ink-faint">{modKey}K</span>
        </>
      )}
    </button>
  );
}

/** The name of a block of destinations. Never a button — the group above folds. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-3 text-micro font-semibold uppercase tracking-field text-ink-faint">
      {children}
    </div>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={clsx('flex items-center gap-2', collapsed && 'justify-center')}>
      {/* App icon (Next metadata route) — the same mark as the browser tab. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.png" alt="Cortex" className="h-6 w-6 shrink-0" />
      {/* One line. The maker's line moved to the foot of the rail: it is a
          signature, and a signature does not belong at the top of a column
          whose first job is to get somebody to their work. */}
      {!collapsed && <span className="text-base font-semibold text-ink">Cortex</span>}
    </div>
  );
}

function SidebarNav({
  role,
  collapsed,
  counts,
  onNavigate,
}: {
  role?: Role;
  collapsed: boolean;
  counts: NavCounts;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const admin = role === 'org_admin';

  /**
   * Read once after mount, never during render.
   *
   * `localStorage` does not exist on the server, so reading it while rendering
   * would either throw or make the first client paint disagree with the HTML
   * that came down. Both show up as a rail that jumps. So the first paint is
   * always the designed order — las cinco plazas sembradas — and la personalizada
   * llega un tick después, que es también el orden honesto de los hechos: no se
   * sabe nada de esta persona hasta que su navegador lo dice.
   */
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [quick, setQuick] = useState<string[]>(DEFAULT_QUICK);
  useEffect(() => {
    const scores = readUsage();
    setUsage(scores);
    // Se reevalúa al navegar, que es justo después de que `recordVisit` haya
    // escrito. La pertenencia se guarda para que el que está arriba pueda
    // defenderse la próxima vez — sin memoria no hay histéresis.
    const next = pickQuick(QUICK_HREFS, scores, readQuick(), DEFAULT_QUICK);
    writeQuick(next);
    setQuick(next);
  }, [pathname]);

  const rail = buildRail(quick, admin);

  const ids = useId();
  const [waitingOpen, toggleWaiting] = useRemembered(OPEN_KEY.waiting);
  const [allOpen, toggleAll] = useRemembered(OPEN_KEY.all);
  const [companyOpen, toggleCompany] = useRemembered(OPEN_KEY.company);

  const visit = (href: string) => {
    recordVisit(href);
    onNavigate?.();
  };

  /**
   * LA PIEZA QUE HACE QUE EL RAIL DEJE DE SER UNA SALIDA.
   *
   * Estando en el chat, una fila con panel lo abre AL LADO en vez de navegar.
   * Es la diferencia entre preguntar «¿cuánto nos deben?» y perder la
   * conversación para verlo, o verlo con la conversación delante.
   *
   * Sólo en `/chat`, y esa condición es la mitad del diseño: en cualquier otra
   * pantalla el panel no tendría nada al lado que proteger, y una fila que a
   * veces navega y a veces no, sin una razón visible, es una fila en la que no
   * se puede confiar. Aquí la razón es visible: hay una conversación abierta.
   *
   * Fuera de la lista, nada cambia. Ningún destino desaparece: los cinco que
   * tienen panel siguen teniendo su pantalla completa, con su enlace «Ver todo»
   * en la cabecera del panel y su ⌘-clic en esta misma fila.
   */
  const inChat = pathname.startsWith('/chat');
  const panel = (href: string) => (inChat ? panelForHref(href) : null);

  const row = (item: NavItem) => (
    <NavRow
      key={item.href}
      item={item}
      badge={item.signal ? counts[item.signal] : 0}
      collapsed={collapsed}
      pathname={pathname}
      onNavigate={() => visit(item.href)}
      panel={panel(item.href)}
    />
  );

  // Contraído, un rail de 72px no tiene sitio para un encabezado, así que los
  // grupos se separan con la hairline que habría ido debajo de uno.
  const nested = collapsed ? '' : 'pl-3';

  return (
    <nav aria-label="Main" className="scroll-slim h-full overflow-y-auto px-3 pb-3">
      <SearchRow collapsed={collapsed} onNavigate={onNavigate} />

      <div className="flex flex-col gap-px pt-1">{rail.pinned.map(row)}</div>

      <div className="flex flex-col gap-px pt-3">
        <WaitingRow
          counts={counts}
          collapsed={collapsed}
          pathname={pathname}
          items={rail.waiting}
          open={waitingOpen}
          onToggle={toggleWaiting}
          controls={`${ids}-waiting`}
          onNavigate={visit}
          panel={panel}
        />
        <div id={`${ids}-waiting`} className={clsx('flex flex-col gap-px', nested)}>
          {waitingOpen && rail.waiting.map(row)}
        </div>
        {rail.quick.map(row)}
      </div>

      <div className="flex flex-col gap-px pt-3">
        <DisclosureRow
          icon={ALL_ICON}
          label={ALL_LABEL}
          count={rail.restCount}
          collapsed={collapsed}
          open={allOpen}
          active={!allOpen && rail.rest.some((s) => isInside(pathname, s.items))}
          onToggle={toggleAll}
          controls={`${ids}-all`}
        />
        <div id={`${ids}-all`} className={nested}>
          {allOpen &&
            rail.rest.map((section, i) => (
              <div key={section.id}>
                {collapsed ? (
                  i > 0 && <div className="mx-2 my-2 border-t border-border" />
                ) : (
                  <SectionLabel>{section.label}</SectionLabel>
                )}
                <div className={clsx('flex flex-col', collapsed ? 'gap-0.5' : 'gap-px')}>
                  {/* Dentro de «Todo» el orden sigue subiendo lo que se usa, que
                      es lo que este archivo ya hacía antes de que existiera el
                      bloque de arriba. Aquí no hay nada que aprender con las
                      manos: es una lista que se abre a propósito. */}
                  {orderByUsage(section.items, usage).map(row)}
                </div>
              </div>
            ))}
        </div>

        <DisclosureRow
          icon={COMPANY_ICON}
          label={rail.company.label}
          collapsed={collapsed}
          open={companyOpen}
          active={!companyOpen && isInside(pathname, rail.company.items)}
          onToggle={toggleCompany}
          controls={`${ids}-company`}
        />
        <div id={`${ids}-company`} className={clsx('flex flex-col gap-px', nested)}>
          {companyOpen && rail.company.items.map(row)}
        </div>
      </div>
    </nav>
  );
}

/**
 * The foot of the rail, OUTSIDE the scrolling area.
 *
 * The previous version kept these rows inside the scrolling <nav> with
 * `mt-auto` — fine while the list fitted, and the moment it did not, Ajustes
 * would have slid to the bottom of the scroll and vanished. The rail is short
 * now, but «Todo» desplegado la vuelve a alargar, así que sigue anclado.
 */
function SidebarFooter({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <div className="shrink-0 border-t border-border px-3 pb-3 pt-2">
      <div className="flex flex-col gap-px">
        {FOOTER.map((item) => (
          <NavRow
            key={item.href}
            item={item}
            badge={0}
            collapsed={collapsed}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      {!collapsed && (
        <div className="px-2.5 pt-2 text-micro text-ink-faint">
          Cortex <span className="text-border-strong">·</span> by Vertix
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  role,
  counts = NO_COUNTS,
}: {
  role?: Role;
  /** What is waiting on this person, counted by the layout that renders us. */
  counts?: NavCounts;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // The preference arrives after hydration, so the width animation stays off
  // until then — otherwise a restored collapsed rail slides shut on every load.
  const [hydrated, setHydrated] = useState(false);
  const { open, setOpen } = useMobileSidebar();
  const pathname = usePathname();

  /**
   * EN EL CHAT EL RAIL SE APARTA, Y SE ASOMA CUANDO LO BUSCAS.
   *
   * El chat es la superficie principal de este producto y 260px de menú al
   * lado de una conversación son 260px que no son la conversación. Así que
   * dentro de `/chat` el rail se queda en iconos con sus contadores —que es lo
   * único que hay que poder ver de reojo, «tres cosas te esperan»— y se
   * despliega al acercar el ratón.
   *
   * Y AL DESPLEGARSE FLOTA, NO EMPUJA. Es la diferencia con el rail de
   * ChatGPT, que al abrirse mueve el hilo entero hacia la derecha: estás
   * leyendo una respuesta, rozas el borde, y el texto se te va de sitio. Aquí
   * el ancho reservado no cambia nunca —el `<aside>` mide siempre 56px en el
   * chat— y lo que se expande es una capa por encima del lienzo. La
   * conversación no se mueve ni un píxel.
   *
   * El botón de contraer sigue existiendo fuera del chat, y la preferencia que
   * guarda se respeta ahí. Dentro del chat no manda: la decisión ya la tomó el
   * sitio donde estás.
   */
  const inChat = pathname.startsWith('/chat');
  const [peeking, setPeeking] = useState(false);
  // Fuera del chat manda la preferencia; dentro, el chat.
  const narrow = inChat ? true : collapsed;
  const expanded = inChat ? peeking : !collapsed;

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'true');
    setHydrated(true);
  }, []);

  // Salir del chat con el rail asomado lo dejaría abierto sobre otra pantalla.
  useEffect(() => {
    if (!inChat) setPeeking(false);
  }, [inChat]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  }

  const closeDrawer = () => setOpen(false);

  return (
    <>
      {/* Desktop. The rail is the lit plane and the canvas behind the content is
          the recessed one — the reverse of how this was built, where a rail at
          `surface-2` sat against a canvas five points away from it and read as a
          rendering artefact rather than as a different place. */}
      <aside
        onMouseEnter={inChat ? () => setPeeking(true) : undefined}
        onMouseLeave={inChat ? () => setPeeking(false) : undefined}
        // El ancho RESERVADO. En el chat no cambia nunca: es lo que hace que
        // asomarse no mueva la conversación. Fuera del chat sigue siendo el
        // rail de siempre, con su preferencia.
        className={clsx(
          'relative hidden shrink-0 md:flex',
          hydrated && !inChat && 'transition-[width] duration-200 motion-reduce:transition-none',
          inChat ? 'w-[56px]' : collapsed ? 'w-[72px]' : 'w-[260px]',
        )}
      >
        <div
          className={clsx(
            'flex h-full flex-col border-r border-border bg-surface',
            // En el chat, la capa que se expande va POR ENCIMA del lienzo. Fuera,
            // el rail ocupa su hueco y nada flota.
            inChat
              ? clsx(
                  'absolute inset-y-0 left-0 z-40',
                  hydrated &&
                    'transition-[width,box-shadow] duration-200 motion-reduce:transition-none',
                  peeking ? 'w-[260px] shadow-pop' : 'w-[56px]',
                )
              : 'w-full',
          )}
        >
          <div
            className={clsx(
              'flex h-14 shrink-0 items-center justify-between px-3',
              narrow && !expanded && 'justify-center px-0',
            )}
          >
            <Brand collapsed={narrow && !expanded} />
            {!narrow && !inChat && (
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label="Contraer el menú"
                className="rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              >
                <PanelLeftClose strokeWidth={1.75} className="h-4 w-4" />
              </button>
            )}
          </div>
          {collapsed && !inChat && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Expandir el menú"
              className="mx-auto mb-1 rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
            >
              <PanelLeftOpen strokeWidth={1.75} className="h-4 w-4" />
            </button>
          )}
          <div className="min-h-0 flex-1">
            <SidebarNav role={role} collapsed={!expanded} counts={counts} />
          </div>
          <SidebarFooter collapsed={!expanded} />
        </div>
      </aside>

      {/* Mobile: Radix Dialog drawer, always in the expanded layout. */}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm md:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[272px] flex-col border-r border-border bg-surface shadow-pop outline-none md:hidden">
            <div className="flex h-14 shrink-0 items-center justify-between px-3">
              <Dialog.Title asChild>
                <div>
                  <Brand collapsed={false} />
                </div>
              </Dialog.Title>
              <Dialog.Close
                aria-label="Cerrar el menú"
                className="rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
              >
                <X strokeWidth={1.75} className="h-4 w-4" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Menú de navegación</Dialog.Description>
            <div className="min-h-0 flex-1">
              {/* Closing is wired per link rather than delegated from the <nav>,
                  which is what the disclosure buttons used to break. */}
              <SidebarNav role={role} collapsed={false} counts={counts} onNavigate={closeDrawer} />
            </div>
            <SidebarFooter collapsed={false} onNavigate={closeDrawer} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

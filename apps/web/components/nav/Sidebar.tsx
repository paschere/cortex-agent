'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { MODULE } from '@/lib/browser-shape';
import type { NavCounts } from '@/lib/nav-signals';
import { orderByUsage, readUsage, recordVisit } from '@/lib/nav-usage';
import { type PanelId, panelForHref } from '@/lib/panels/shape';
import type { Role } from '@cortex/core';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  AlarmClock,
  BadgeCheck,
  BarChart3,
  BookOpen,
  Briefcase,
  Building2,
  Cable,
  CalendarClock,
  FileBarChart,
  Globe,
  Hammer,
  Inbox,
  LayoutDashboard,
  MessageCircle,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Radar,
  Receipt,
  ScrollText,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sprout,
  Target,
  Users,
  UsersRound,
  Wallet,
  Workflow,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { useMobileSidebar } from './MobileSidebarContext';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Draws a live count on the right. Every queue that has one is wired. */
  signal?: keyof NavCounts;
}

interface NavSection {
  id: string;
  /** `null` for the opening block: the day's work needs no heading over it. */
  label: string | null;
  items: NavItem[];
  adminOnly?: boolean;
}

// FLAT, AND QUIET.
//
// The version this replaces put a sentence under every destination and hid
// fifteen of them behind four disclosures. Both were mistakes of the same kind:
// they made the rail something to READ when a rail is something to SCAN. The
// prose was worse than useless because it was set to truncate in a 268px column,
// so half of every explanation was cut off — height paid for text that did not
// fit.
//
// So: one line per destination, no explanations, nothing folded away. What a
// screen is gets explained by the screen, which has a subtitle and the room to
// use it. What the rail owes somebody is the answer to "where is it" and "is
// there anything waiting", and those are a name and a number.
//
// THE ORDER IS FREQUENCY, NOT IMPORTANCE. Everything important is not everything
// daily, and the failure mode of this file is addition — every module that
// shipped this month arrived with a good argument for a top-level row. The first
// section is the only one that has to be defended: an entry belongs there only
// if somebody opens it without being sent by something else.
//
// EVERY DESTINATION LABEL IS THE WORD ITS OWN SCREEN USES. Untranslated on
// purpose: Chat and WhatsApp read the same in Spanish, Brain Knowledge is the
// product's name for the thing, and Conectar Claude names an external product.
//
// THE SECTION HEADINGS ARE THE EXCEPTION, AND THEY SPEAK IN THE FIRST PERSON.
// This product is sold as a manager for a company, not as a box of tools, and
// the rail is the first place that claim is either made or quietly dropped.
// «Automático», «Seguimiento», «Conexiones» are categories of software;
// «Lo que hago solo», «Cómo vamos», «De dónde saco todo» are the things a
// manager would say about their own week.
//
// The headings can carry that voice precisely BECAUSE they name no screen —
// they group. A destination has to keep saying what its own page says, or the
// rail starts sending people to a word they will not find when they arrive,
// which is the failure this file already fixed once.
const SECTIONS: NavSection[] = [
  {
    id: 'daily',
    label: null,
    items: [
      // First because it is where everybody already lands: `/` redirects here
      // after sign-in. Named for its role rather than by its H1, which is a
      // greeting ("Hola, Ana") and gives the rail no noun to use.
      { href: '/dashboard', label: 'Inicio', icon: LayoutDashboard },
      { href: '/chat', label: 'Chat', icon: MessageSquare },
      // Approvals and Acciones are both "waiting on your yes" and are NOT
      // merged, because the queues are not the same object: an approval is a
      // tool call parked mid-turn that expires and can be answered from a
      // Google Chat button; an action is a drafted email with a content hash
      // that keeps being watched after it is sent. Now that both carry a count,
      // the rail can say which has something in it without explaining either.
      { href: '/approvals', label: 'Aprobaciones', icon: Inbox, signal: 'approvals' },
      { href: '/commitments', label: 'Vencimientos', icon: CalendarClock, signal: 'commitments' },
      { href: '/actions', label: 'Acciones', icon: Send, signal: 'actions' },
      // The axis the rest of the product hangs off (migration 0075): a question
      // about a customer starts here and is followed into the mail, the meeting
      // or the deadline.
      { href: '/clients', label: 'Clientes', icon: Building2 },
      // Cartera. En la sección diaria y no en Seguimiento porque no es un
      // informe que se consulta al cerrar el mes: es la pregunta que alguien se
      // hace el martes por la mañana, «¿quién nos debe y desde cuándo».
      { href: '/payments', label: 'Cartera', icon: Wallet },
      { href: '/kb', label: 'Brain Knowledge', icon: BookOpen },
    ],
  },
  {
    // Four unrelated table families, not four views of one thing. Ordered by how
    // often somebody opens them rather than by how autonomous they are — the
    // escalation from "a flow you wrote down" to "an errand that asks you
    // questions" was an argument the old notes made, and the notes are gone.
    id: 'automation',
    label: 'Lo que hago solo',
    items: [
      { href: '/errands', label: 'Encargos', icon: Briefcase, signal: 'errands' },
      // The label comes from lib/browser-shape so the screen, the palette and
      // the tool catalogue cannot drift apart while the name is being settled.
      { href: '/browser', label: MODULE.label, icon: Globe },
      { href: '/schedules', label: 'Rutinas', icon: AlarmClock },
      { href: '/pipelines', label: 'Flujos', icon: Workflow },
      { href: '/orchestrator', label: 'Orquestador', icon: Network },
      { href: '/dev-work', label: 'Desarrollo', icon: Hammer },
    ],
  },
  {
    // Read, do not act. Everything here answers a question about a period.
    id: 'review',
    label: 'Cómo vamos',
    items: [
      // Primera de la sección porque es la única que responde «¿vamos bien?»
      // con un sí o un no. Las otras tres cuentan lo que pasó y dejan la
      // conclusión a quien lee.
      { href: '/goals', label: 'Metas', icon: Target },
      { href: '/reports', label: 'Informes', icon: FileBarChart },
      { href: '/prospects', label: 'Prospectos', icon: Radar },
      { href: '/learning', label: 'Aprendizaje', icon: Sprout },
    ],
  },
  {
    id: 'connections',
    label: 'De dónde saco todo',
    items: [
      { href: '/integrations', label: 'Integraciones', icon: Plug },
      { href: '/integrations/whatsapp', label: 'WhatsApp', icon: MessageCircle },
      { href: '/mcp-tokens', label: 'Conectar Claude', icon: Cable },
    ],
  },
  {
    id: 'admin',
    label: 'La empresa',
    adminOnly: true,
    items: [
      { href: '/admin/users', label: 'Personas', icon: Users },
      { href: '/admin/teams', label: 'Equipos', icon: UsersRound },
      { href: '/admin/usage', label: 'Uso', icon: BarChart3 },
      { href: '/admin/audit', label: 'Auditoría', icon: ScrollText },
      { href: '/admin/security', label: 'Seguridad', icon: ShieldCheck },
      // Lo que Cortex puede hacer sin preguntar. Vive junto a Seguridad porque
      // es la misma conversación vista desde el otro lado: una dice qué se le
      // impidió, la otra qué se le permitió de antemano.
      { href: '/admin/mandates', label: 'Sin preguntar', icon: BadgeCheck },
    ],
  },
];

// WHAT IS NOT IN THIS RAIL, AND HOW YOU GET THERE.
//
// Three destinations are reachable only from the palette (⌘K, or the Buscar row
// at the top of this rail, which exists so the palette is not a secret) and from
// a door on a screen somebody is already on:
//
//   /tools       → from Inicio ("Atajos") and from the palette.
//   /agents      → from /tools, which is where you go when a tool is blocked and
//                  the answer is which agent may call it.
//   /evaluation  → from /learning, via a header action. They are cause and
//                  measurement: one says what Cortex changed about itself, the
//                  other whether answers got better.
//
// /conversations used to hang off the thread list that lived in this rail. The
// threads moved into the chat's own header (see ThreadHistory), and the archive
// moved with them — it is Chat's archive, not Chat's sibling.
const FOOTER: NavItem[] = [
  // Beside Ajustes rather than inside Administración: what a workspace has
  // consumed and what it is about to run out of is not an administrator's
  // report, it is what anybody wondering "why did Cortex stop" needs to find.
  { href: '/plan', label: 'Plan y consumo', icon: Receipt },
  { href: '/settings', label: 'Ajustes', icon: Settings },
];

const COLLAPSE_KEY = 'sidebar_collapsed';

const NO_COUNTS: NavCounts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };

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
  collapsed,
  pathname,
  counts,
  onNavigate,
  /**
   * El panel que esta fila abre en vez de navegar, si lo hay. Lo decide
   * `SidebarNav`, que es quien sabe dónde está la persona.
   */
  panel: wanted,
}: {
  item: NavItem;
  collapsed: boolean;
  pathname: string;
  counts: NavCounts;
  onNavigate?: () => void;
  panel?: PanelId | null;
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
  const active = onPage || showing;
  const badge = item.signal ? counts[item.signal] : 0;

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
      className={clsx(
        'group relative flex h-[30px] items-center rounded-sm text-sm transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'motion-reduce:transition-none',
        collapsed ? 'justify-center' : 'gap-2.5 px-2.5',
        active
          ? 'bg-primary-soft font-semibold text-primary-ink'
          : 'font-medium text-ink-muted hover:bg-surface-2 hover:text-ink',
      )}
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
      className={clsx(
        'group flex h-[30px] w-full items-center rounded-sm text-sm font-medium text-ink-muted transition-colors duration-150',
        'hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'motion-reduce:transition-none',
        collapsed ? 'justify-center' : 'gap-2.5 px-2.5',
      )}
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

/** The name of a block of destinations. Never a button — nothing folds. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-[18px] text-micro font-semibold uppercase tracking-field text-ink-faint">
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
  const sections = SECTIONS.filter((s) => !s.adminOnly || role === 'org_admin');

  /**
   * Read once after mount, never during render.
   *
   * `localStorage` does not exist on the server, so reading it while rendering
   * would either throw or make the first client paint disagree with the HTML
   * that came down. Both show up as a rail that jumps. So the first paint is
   * always the designed order, and the personalised one arrives a tick later —
   * which is also the honest order of events: nothing is known about this
   * person until their browser says so.
   */
  const [usage, setUsage] = useState<Record<string, number>>({});
  useEffect(() => setUsage(readUsage()), [pathname]);

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

  return (
    <nav aria-label="Main" className="scroll-slim h-full overflow-y-auto px-3 pb-3">
      <SearchRow collapsed={collapsed} onNavigate={onNavigate} />

      {sections.map((section, i) => {
        // The daily block keeps its authored order, always. It is the part
        // people learn with their hands — Inicio, Chat, Aprobaciones, in that
        // order, every morning — and moving a target somebody is already
        // reaching for is exactly how an adaptive menu becomes a menu you have
        // to read again.
        const items = section.label ? orderByUsage(section.items, usage) : section.items;
        return (
          <div key={section.id}>
            {/* Collapsed, a 72px rail has no room for a heading, so the sections
                are separated by the hairline that would have sat under one. */}
            {collapsed
              ? i > 0 && <div className="mx-2 my-2 border-t border-border" />
              : section.label && <SectionLabel>{section.label}</SectionLabel>}
            <div className={clsx('flex flex-col', collapsed ? 'gap-0.5' : 'gap-px')}>
              {items.map((item) => (
                <NavRow
                  key={item.href}
                  item={item}
                  collapsed={collapsed}
                  pathname={pathname}
                  counts={counts}
                  onNavigate={() => visit(item.href)}
                  panel={inChat ? panelForHref(item.href) : null}
                />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The foot of the rail, OUTSIDE the scrolling area.
 *
 * With every destination visible there are twenty-four of them for an admin,
 * which is more than a laptop can show at once. The previous version kept these
 * rows inside the scrolling <nav> with `mt-auto` — fine while the list fitted,
 * and the moment it did not, Ajustes would have slid to the bottom of the scroll
 * and vanished. Pinning it is what makes the flat list affordable.
 */
function SidebarFooter({
  collapsed,
  counts,
  onNavigate,
}: {
  collapsed: boolean;
  counts: NavCounts;
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
            collapsed={collapsed}
            pathname={pathname}
            counts={counts}
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
          <SidebarFooter collapsed={!expanded} counts={counts} />
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
            <SidebarFooter collapsed={false} counts={counts} onNavigate={closeDrawer} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

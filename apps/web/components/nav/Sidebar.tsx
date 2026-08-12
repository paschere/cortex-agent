'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@cortex/core';
import { MODULE } from '@/lib/browser-shape';
import { clsx } from 'clsx';
import {
  AlarmClock,
  BarChart3,
  Building2,
  CalendarClock,
  BookOpen,
  Briefcase,
  Cable,
  ChevronRight,
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
  Trash2,
  Users,
  UsersRound,
  Workflow,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { useMobileSidebar } from './MobileSidebarContext';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Draws a live count next to the label. Only 'approvals' is wired up. */
  signal?: 'approvals';
  /**
   * One line under the label saying what this destination is.
   *
   * WHERE IT GOES, AND WHY IT IS NOT EVERYWHERE. A label labels; a note is for
   * when the label alone cannot tell a destination apart from the one beside
   * it. DAILY entries mostly go without one — nobody needs "Clientes" explained
   * on the fourth day. Everything inside a group gets one, because a group is
   * where somebody goes HUNTING, and hunting is exactly when four names for
   * "algo que corre solo" stop being distinguishable. The footer gets none: it
   * is chrome, not a place you search.
   */
  note?: string;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  adminOnly?: boolean;
}

// THREE TIERS, SORTED BY HOW OFTEN SOMEBODY REALLY OPENS THE THING.
//
// DAILY is where the work happens and it sits unlabelled under the brand, so
// the eye lands on it first. GROUPS are the weekly-or-when-something-happens
// destinations, closed until asked for. FOOTER is chrome. The split is not a
// matter of taste: a destination is DAILY only if a person would open it
// without being sent there by something else.
//
// HOW THIS WENT WRONG, SO IT DOES NOT AGAIN. The previous version of this list
// carried the comment "the handful people open every day" over TWELVE entries.
// Nobody did that on purpose — each module this month added its row with a good
// argument, one at a time, and nobody read the result end to end. The failure
// mode of this file is addition, so: an entry goes into DAILY only by taking
// another one out, and the argument has to be about FREQUENCY, not importance.
// Everything important is not everything daily.
//
// THE FREQUENCIES BELOW WERE JUDGED, NOT MEASURED. `audit_events` looks like it
// would answer this and does not: it records TOOL CALLS (`tool_id`), and there
// is no page-view or route event anywhere in the app, so no query over it can
// say which screens get opened. The evidence actually used, per entry, is the
// screen's own purpose and its inbound links — a destination that nothing links
// to and that answers a once-a-month question is not daily however good it is.
//
// EVERY LABEL IS SPANISH, and the rule that produced them still holds: the rail
// says the same word the page says. Each was re-checked against its screen's
// title. Untranslated on purpose: Chat and WhatsApp read the same in both,
// Brain Knowledge is the product's own name for the thing, and Conectar Claude
// names an external product.
const DAILY: NavItem[] = [
  // First because it is where everybody already lands: `/` redirects here after
  // sign-in. The label is NOT taken from the page, unusually, because the page
  // has no noun for itself — its H1 is a greeting ("Hola, Ana") over the eyebrow
  // "Espacio de trabajo". So the rail names it by its role, the place you land,
  // and the command palette was changed to say the same word. It used to say
  // "Resumen" here and "Panel" there for one screen that calls itself neither.
  { href: '/dashboard', label: 'Inicio', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  // THE ONE PAIR IN THIS TIER THAT NEEDS PROSE. Both are "espera tu sí" and the
  // rail cannot fix that by ordering them — /approvals even claims in its own
  // subtitle to be "todo lo que espera una decisión tuya, EN UNA SOLA FILA",
  // which /actions makes untrue. They are not merged because the queues are not
  // the same object: an approval is a tool call parked mid-turn that EXPIRES and
  // can be answered from a Google Chat button, an action is a drafted email with
  // a content hash that keeps being watched after it is sent ("enviada hace 9
  // días, nadie ha contestado"). Merging them would have to throw one of those
  // halves away. So both stay, adjacent, and the rail says which is which.
  {
    href: '/approvals',
    label: 'Aprobaciones',
    icon: Inbox,
    signal: 'approvals',
    note: 'Lo que Cortex quiere hacer y necesita tu permiso',
  },
  // Opened by whoever asks "¿qué hay para mandar hoy?". Kept in DAILY despite
  // being the quietest entry here, for a reason that is a bug report about the
  // rest of the app: NOTHING else in the product links to it and it has no
  // badge, so a draft waiting nine days is invisible the moment this row goes.
  // /approvals now carries a pointer to it, which is the real fix; until that
  // pointer is a count, this row is the only thing holding the queue up.
  { href: '/actions', label: 'Acciones', icon: Send, note: 'Lo que ya redactó y falta mandar' },
  // Daily by construction: the page recomputes every state against today in
  // Bogotá and exists to be opened first thing by people asking "¿qué se nos
  // vence?".
  { href: '/commitments', label: 'Vencimientos', icon: CalendarClock },
  // The axis the rest of the product hangs off (migration 0075). Placed high
  // because it is where a question about a customer STARTS — "¿qué tenemos de
  // Coltrans?" is answered here and then followed into the mail, the meeting or
  // the deadline.
  { href: '/clients', label: 'Clientes', icon: Building2 },
  // Promoted out of the old KNOWLEDGE group: once the rate calculator moved back
  // into the chat, that group held a single link, and "Knowledge › Brain
  // Knowledge" was a disclosure wrapped around one destination people open daily.
  { href: '/kb', label: 'Brain Knowledge', icon: BookOpen },
];

const GROUPS: NavGroup[] = [
  {
    // FOUR NAMES FOR "ALGO QUE CORRE SOLO", AND WHY ALL FOUR SURVIVE.
    //
    // They are four different things and the database agrees — four unrelated
    // table families, none a view over another. What the old rail did wrong was
    // present them as four equal nouns with nothing to choose between them.
    // They are not equal: there are two axes, not one list. WHAT gets done is a
    // flow somebody wrote down (Flujos), one Cortex plans for a single objective
    // (Orquestador), or one it plans, pauses to ask about, and comes back to
    // (Encargos). WHEN it happens is Rutinas, which is orthogonal — a routine
    // runs a tool, an agent turn, a flow OR a trámite. The notes carry that
    // escalation in order, which is why the order here is not alphabetical.
    id: 'automation',
    label: 'Trabajo automático',
    items: [
      {
        href: '/errands',
        label: 'Encargos',
        icon: Briefcase,
        note: 'Le pides algo largo; trabaja solo y te pregunta si se atasca',
      },
      // Every leg of every errand is also a row here, unmarked — orchestration_runs
      // has no back-pointer to the errand that commissioned it. So this is the raw
      // view of the same executions, and it sits BELOW Encargos rather than beside
      // it: an encargo is an orchestration with somebody minding it.
      {
        href: '/orchestrator',
        label: 'Orquestador',
        icon: Network,
        note: 'Un objetivo suelto, resuelto por varios subagentes a la vez',
      },
      // The page calls these Flujos; the table calls them pipelines. One name per
      // thing. It is a shelf of templates, not a runtime — running one happens in
      // the chat, from Claude, or inside a rutina.
      {
        href: '/pipelines',
        label: 'Flujos',
        icon: Workflow,
        note: 'Instructivos que escribes una vez y ejecutas donde quieras',
      },
      // The page calls these Rutinas; the nav used to call them Scheduled Jobs.
      // One name per thing. The note says "a una hora fija" because that is the
      // whole difference from the three above it — this one is a WHEN.
      {
        href: '/schedules',
        label: 'Rutinas',
        icon: AlarmClock,
        note: 'Cualquiera de los anteriores, a una hora fija, sin que estés',
      },
      // Trámites (migration 0087). Under Trabajo automático rather than
      // Conexiones because a learned trámite is not a system Cortex is wired
      // into — it is work somebody used to do by hand and now does not.
      // The label comes from lib/browser-shape so the screen, the menu and the
      // tool catalogue cannot drift apart while the name is being settled.
      {
        href: '/browser',
        label: MODULE.label,
        icon: Globe,
        note: 'Vueltas en portales ajenos que aprendió viéndote hacerlas',
      },
      {
        href: '/dev-work',
        label: 'Desarrollo',
        icon: Hammer,
        note: 'Cambios que Cortex hace en tu propio software',
      },
    ],
  },
  {
    // Read, do not act. Everything here answers a question about a period —
    // a month, a week, "desde el cambio del jueves" — which is exactly what
    // kept them out of DAILY however often somebody happens to glance at them.
    id: 'review',
    label: 'Seguimiento',
    items: [
      // Out of DAILY because the shelf is grouped by month for a reason: these
      // are asked for as "pásame el de julio", not consulted every morning.
      {
        href: '/reports',
        label: 'Informes',
        icon: FileBarChart,
        note: 'Guardados por mes, congelados tal como se calcularon',
      },
      // Out of DAILY because the sweep that fills it runs WEEKLY (~15 rows), and
      // the rows that need a decision today already surface in Aprobaciones as
      // "Prospectos nuevos" — the same growth_signals table, filtered to `new`.
      // The note says so, because two screens over the same rows is precisely
      // the thing a newcomer cannot work out from a name.
      {
        href: '/prospects',
        label: 'Prospectos',
        icon: Radar,
        note: 'El tablero completo; los nuevos también salen en Aprobaciones',
      },
      // What Cortex changed about its own memory, with the evidence and an undo.
      // Out of DAILY: nothing arrives here on a schedule, you come after a change.
      // It is also the only door to Evaluación, which is not in the rail at all —
      // see the header action added to the Aprendizaje screen.
      {
        href: '/learning',
        label: 'Aprendizaje',
        icon: Sprout,
        note: 'Qué se ajustó solo, con qué evidencia, y qué esperas decidir',
      },
    ],
  },
  {
    // A pair, deliberately adjacent: one page is Cortex reaching out to other
    // systems, the other is an AI client reaching in. They used to read as
    // duplicates when they sat in different groups under similar names, and the
    // notes now carry that direction rather than leaving it to adjacency.
    id: 'connections',
    label: 'Conexiones',
    items: [
      {
        href: '/integrations',
        label: 'Integraciones',
        icon: Plug,
        note: 'A qué sistemas llega Cortex en tu nombre',
      },
      {
        href: '/mcp-tokens',
        label: 'Conectar Claude',
        icon: Cable,
        note: 'Usar Cortex desde Claude u otro cliente de IA',
      },
      // The screen moved to match where the nav already pointed: pairing a
      // phone is a connection, not a document, so it sits under Integrations
      // with the other systems Cortex is wired into. /kb/whatsapp redirects.
      {
        href: '/integrations/whatsapp',
        label: 'WhatsApp',
        icon: MessageCircle,
        note: 'El número de la empresa y de quién es cada teléfono',
      },
    ],
  },
  {
    id: 'admin',
    label: 'Administración',
    adminOnly: true,
    items: [
      // The page title is "Personas"; the rail used to say "Usuarios". One name
      // per thing, and the page's word wins.
      {
        href: '/admin/users',
        label: 'Personas',
        icon: Users,
        note: 'Quién está en la organización y quién sigue activo',
      },
      {
        href: '/admin/teams',
        label: 'Equipos',
        icon: UsersRound,
        note: 'Estar en un equipo es lo que da acceso a las herramientas',
      },
      // Uso and Auditoría read the same audit_events table and are the easiest
      // pair here to mix up, so the notes split them by grain: totals vs rows.
      {
        href: '/admin/usage',
        label: 'Uso',
        icon: BarChart3,
        note: 'Cuánta actividad hubo, por día y por herramienta',
      },
      {
        href: '/admin/audit',
        label: 'Auditoría',
        icon: ScrollText,
        note: 'Cada llamada, una por una, con quién la pidió y qué pasó',
      },
      {
        href: '/admin/security',
        label: 'Seguridad',
        icon: ShieldCheck,
        note: 'Qué se le impidió hacer al agente, y con qué regla',
      },
    ],
  },
];

// WHAT IS NO LONGER IN THIS RAIL, AND HOW YOU GET THERE.
//
// Four destinations came out. None of them is unreachable, and none of them was
// removed for being unimportant — they came out because a rail that lists
// everything ranks nothing. Every one is in the command palette (⌘K, and the
// "Buscar" row at the top of this rail, which exists so the palette is not a
// secret), and every one also has a door on a screen somebody is already on:
//
//   /conversations  → the "Todas las conversaciones" row under Chat, below the
//                     recent threads. It is Chat's archive, not Chat's sibling:
//                     the same rows the thread list shows, plus the ones that
//                     arrived from Google Chat, Claude and routines.
//   /tools          → from Inicio ("Atajos") and from the palette.
//   /agents         → from /tools, which is where you go when a tool is blocked
//                     and the answer is which agent may call it.
//   /evaluation     → from /learning, which now carries a header action to it.
//                     They are cause and measurement: one says what Cortex
//                     changed about itself, the other whether answers got
//                     better. It is also the most specialised screen in the
//                     product — the runs happen in `pnpm test` and on somebody's
//                     terminal, the page has no button that starts one, and
//                     docs/operations/answer-quality.md says in its own words
//                     that it is for whoever changes the code.
//
// Chrome rather than workflow, so it is pinned to the bottom instead of
// competing for a slot in a group. No notes here on purpose: the footer is not
// somewhere you hunt.
const FOOTER: NavItem[] = [
  // Beside Settings rather than inside the admin group: what a workspace has
  // consumed and what it is about to run out of is not an administrator's
  // report, it is the thing anybody wondering "why did Cortex stop" needs to
  // find without asking.
  { href: '/plan', label: 'Plan y consumo', icon: Receipt },
  { href: '/settings', label: 'Ajustes', icon: Settings },
];

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
  // Query-bearing entries are deliberately never matched: reading the query
  // would need useSearchParams, and matching on the path alone would light them
  // up at the same time as the entry for the bare path.
  if (href.includes('?')) return false;
  if (href === '/dashboard') return pathname === '/dashboard';
  // Integrations owns a child route that has a nav entry of its own (WhatsApp),
  // so the parent matches exactly instead of by prefix. Prefix matching would
  // light up two rows at once and make "where am I" unanswerable.
  if (href === '/integrations') return pathname === '/integrations';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ApprovalBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={clsx(
          'ml-auto shrink-0 rounded-pill px-2 py-0.5 text-[10.5px] font-bold tabular-nums',
          active ? 'bg-white/20 text-white' : 'bg-amber-soft text-amber',
        )}
      >
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">, {count} esperando tu decisión</span>
    </>
  );
}

/**
 * One destination, drawn as a capsule. The active row is the only saturated
 * block of indigo anywhere in the chrome — that single exception is what makes
 * "where am I" answerable from the corner of the eye. It is both filled and
 * lifted, so it reads as the one thing standing proud of the recessed rail.
 *
 * Rows change colour on hover but never move: a list of capsules all flinching
 * under the cursor is noise, and the lift is reserved for the things a person
 * actually presses.
 *
 * A row with a `note` is two lines. The icon stops being vertically centred and
 * aligns to the LABEL instead — centred against both lines it drifts into the
 * gap and stops reading as the label's icon. Collapsed, notes are dropped
 * entirely: a 72px rail has no room for prose, and the tooltip carries the name.
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
  const note = !collapsed && item.note ? item.note : null;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className={clsx(
        'group relative flex rounded-pill transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'motion-reduce:transition-none',
        collapsed ? 'items-center justify-center px-0 py-2.5' : 'gap-2.5 px-3',
        note ? 'items-start py-2' : 'items-center',
        !collapsed && !note && (primary ? 'py-[9px]' : 'py-[7px]'),
        active
          ? 'bg-primary font-semibold text-white shadow-card'
          : clsx(
              'hover:bg-surface hover:text-ink',
              primary ? 'font-medium text-ink' : 'font-medium text-ink-muted',
            ),
        primary ? 'text-[13.5px]' : 'text-[12.5px]',
      )}
    >
      <span className={clsx('relative shrink-0', note && 'mt-[1px]')}>
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
              'absolute -right-1.5 -top-1.5 min-w-[15px] rounded-full px-1 text-center text-[9.5px] font-bold leading-[15px] tabular-nums',
              active ? 'bg-white text-primary' : 'bg-amber text-white',
            )}
          >
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate">{item.label}</span>
            {badge > 0 && <ApprovalBadge count={badge} active={active} />}
          </span>
          {note && (
            // Not .field-label: this is a sentence about the destination, not a
            // name for a value, and the tracking that suits a label makes prose
            // at 11px harder to read rather than easier.
            <span
              className={clsx(
                'mt-0.5 block truncate text-[11px] font-normal leading-snug',
                active ? 'text-white/75' : 'text-ink-faint',
              )}
            >
              {note}
            </span>
          )}
        </span>
      )}
      {collapsed && badge > 0 && (
        <span className="sr-only">{badge} esperando tu decisión</span>
      )}
    </Link>
  );
}

/**
 * THE DOOR TO EVERYTHING THIS RAIL NO LONGER SHOWS.
 *
 * Shortening the rail is only honest if the destinations that came off it are
 * still findable, and ⌘K on its own does not make anything findable — it was in
 * the product before this change and only worked on /chat, which is the same as
 * not existing. So the palette gets a row, at the top, above the work: a visible
 * control that says the shortcut out loud.
 *
 * It is a button styled as a field rather than a nav capsule, because it does
 * not go anywhere on its own. That is also why it sits ABOVE the daily list and
 * not inside it — it is the way to the rest of the product, not part of the day.
 */
function SearchTrigger({ collapsed }: { collapsed: boolean }) {
  const { setOpen } = useCommandMenu();
  // Rendered as ⌘ and corrected after mount rather than guessed on the server:
  // the platform is not knowable while rendering, and a shortcut hint that names
  // the wrong key is worse than none. Post-mount, so no hydration mismatch.
  const [modKey, setModKey] = useState('⌘');
  useEffect(() => {
    const ua = navigator.userAgent;
    if (!/Mac|iPhone|iPad|iPod/.test(ua)) setModKey('Ctrl ');
  }, []);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Buscar"
        aria-label="Buscar o ir a una pantalla"
        aria-keyshortcuts="Meta+K Control+K"
        className="group flex items-center justify-center rounded-pill py-2.5 text-ink-faint transition-colors duration-150 hover:bg-surface hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <Search className="h-[18px] w-[18px]" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Buscar o ir a una pantalla"
      aria-keyshortcuts="Meta+K Control+K"
      className="group flex items-center gap-2.5 rounded-pill border border-border bg-surface px-3 py-[7px] text-[12.5px] text-ink-faint transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
    >
      <Search className="h-4 w-4 shrink-0 group-hover:text-primary" />
      <span>Buscar o ir a…</span>
      <kbd
        aria-hidden="true"
        className="ml-auto shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-faint"
      >
        {modKey}K
      </kbd>
    </button>
  );
}

/** Open threads, hung off Chat on a hairline stem — they are chats, so they nest. */
function ThreadList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 60_000,
  });

  // Four, not five. The archive row below costs a line, and this stem hangs off
  // the second entry in a list that has to stay inside half a screen — the fifth
  // thread is the cheapest thing on the rail to give up for it.
  const recent = conversations.slice(0, 4);
  const archiveActive = isActive(pathname, '/conversations');

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('¿Borrar esta conversación? No se puede deshacer.')) return;
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
              title={c.title ?? 'Sin título'}
              className={clsx(
                'block truncate rounded-pill py-1.5 pl-2.5 pr-7 text-[12.5px] transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                'motion-reduce:transition-none',
                active
                  ? 'bg-primary-soft font-semibold text-primary-ink'
                  : 'text-ink-muted hover:bg-surface hover:text-ink',
              )}
            >
              {c.title?.trim() || 'Sin título'}
            </Link>
            <button
              type="button"
              onClick={(e) => handleDelete(e, c.id)}
              aria-label={`Borrar la conversación ${c.title?.trim() || 'Sin título'}`}
              className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-faint opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-rose-soft hover:text-rose focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose/40 group-hover/conv:opacity-100 motion-reduce:transition-none"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {/*
        Conversaciones used to be a top-level entry beside Chat, which put the
        archive at the same rank as the thing it archives. It hangs here instead,
        at the foot of the threads it extends.

        IT RENDERS EVEN WITH NO THREADS ABOVE IT, deliberately. This list drops
        MCP sessions (see app/api/conversations/route.ts) and the routine
        deliveries and Google Chat threads only show up over there, so "no recent
        chats" does not mean "no conversations" — somebody who only ever talks to
        Cortex from Claude would otherwise have no door to their own history.
      */}
      <Link
        href="/conversations"
        onClick={onNavigate}
        aria-current={archiveActive ? 'page' : undefined}
        className={clsx(
          'block truncate rounded-pill py-1.5 pl-2.5 pr-2 text-[12px] transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          'motion-reduce:transition-none',
          archiveActive
            ? 'bg-primary-soft font-semibold text-primary-ink'
            : 'text-ink-faint hover:bg-surface hover:text-ink',
        )}
      >
        Todas las conversaciones
      </Link>
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
        className="flex w-full items-center gap-1.5 rounded-pill px-3 py-1.5 text-[11px] font-semibold tracking-[0.02em] text-ink-faint transition-colors duration-150 hover:bg-surface hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
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
          {/*
            The wordmark stays plain — weight and a touch of tracking, no
            gradient. The maker's line below takes the field-label treatment: it
            names the thing above it and should recede while doing so.
          */}
          <div className="text-[15px] font-bold tracking-[0.01em] text-ink">Cortex</div>
          <div className="field-label">by Vertix</div>
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
      <div className={clsx('flex flex-col', collapsed ? 'gap-px' : 'mb-1.5')}>
        <SearchTrigger collapsed={collapsed} />
      </div>

      <div className="flex flex-col gap-px">
        {DAILY.map((item) => (
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
        // icon list, separated by a hairline where a label would have gone.
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
          canvas so the one indigo active row is the only thing that lifts. */}
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
              className="rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
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
            className="mx-auto mb-2 rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
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
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-border bg-surface-2 shadow-pop outline-none md:hidden">
            <div className="flex shrink-0 items-center justify-between px-3 py-4">
              <Dialog.Title asChild>
                <div>
                  <Brand collapsed={false} />
                </div>
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close menu"
                className="rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
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

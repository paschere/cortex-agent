import { AlarmClock, Bot, MessageSquareText, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Where a conversation actually came from.
 *
 * The `chat_surface` enum is only ('web','desktop','mcp') — it predates both
 * Google Chat and routines and widening it would need a migration. So the
 * stored `surface` alone cannot tell these apart and we reconstruct the real
 * origin from the markers each writer leaves:
 *   - Google Chat threads  → surface 'mcp' + external_key 'gchat:…'
 *     (see getOrCreateConversation in app/api/chat-app/google/turn.ts)
 *   - Claude / MCP clients → surface 'mcp' + external_key 'mcp:…'
 *   - Routine deliveries   → surface 'web' + title prefixed with ROUTINE_MARK
 *     (see the deliver-conversation step in inngest/functions/schedule-run.ts)
 */
export type ConversationSurface = 'web' | 'mcp' | 'google_chat' | 'routine';

/** Prefix schedule-run stamps on the title of a routine's delivery thread. */
const ROUTINE_MARK = '⏱';
const GCHAT_KEY_PREFIX = 'gchat:';

export interface SurfaceRow {
  surface: string | null;
  external_key?: string | null;
  title?: string | null;
}

export function conversationSurface(row: SurfaceRow): ConversationSurface {
  if (row.external_key?.startsWith(GCHAT_KEY_PREFIX)) return 'google_chat';
  if (row.surface === 'mcp') return 'mcp';
  if (row.title?.trimStart().startsWith(ROUTINE_MARK)) return 'routine';
  return 'web';
}

export interface SurfaceMeta {
  label: string;
  /** Longer form for headers and tooltips. */
  description: string;
  icon: LucideIcon;
}

/**
 * Where a conversation came from is an origin, not a state — so none of these
 * carry a status colour. Green would claim "in force" and amber "needs
 * attention", neither of which is true of a Google Chat thread. The icon and
 * the word do the telling; the chip stays in ink.
 */
export const SURFACE_META: Record<ConversationSurface, SurfaceMeta> = {
  web: {
    label: 'Chat web',
    description: 'Empezada desde el chat de esta aplicación',
    icon: MessagesSquare,
  },
  mcp: {
    label: 'Claude',
    description: 'Una sesión desde Claude u otro cliente MCP',
    icon: Bot,
  },
  google_chat: {
    label: 'Google Chat',
    description: 'Un hilo con la aplicación de Cortex en Google Chat',
    icon: MessageSquareText,
  },
  routine: {
    label: 'Rutina',
    description: 'La entregó una rutina programada',
    icon: AlarmClock,
  },
};

/** Segments of the /conversations filter, in display order. */
export const SURFACE_FILTERS = [
  { value: '', label: 'Chats' },
  { value: 'web', label: 'Chat web' },
  { value: 'routine', label: 'Rutinas' },
  { value: 'mcp', label: 'Claude' },
  { value: 'google_chat', label: 'Google Chat' },
  { value: 'all', label: 'Todas' },
] as const;

export type SurfaceFilter = (typeof SURFACE_FILTERS)[number]['value'];

export function parseSurfaceFilter(value: string | undefined): SurfaceFilter {
  const match = SURFACE_FILTERS.find((f) => f.value === value);
  return match ? match.value : '';
}

/**
 * The stored `surface` value a filter can be pushed down to the database as.
 * `null` means "no server-side narrowing possible" — the derived subtypes
 * (routine vs web, Claude vs Google Chat) still need the in-memory pass below.
 */
export function storedSurfaceFor(
  filter: SurfaceFilter,
): { op: 'eq' | 'neq'; value: string } | null {
  switch (filter) {
    case 'web':
    case 'routine':
      return { op: 'eq', value: 'web' };
    case 'mcp':
    case 'google_chat':
      return { op: 'eq', value: 'mcp' };
    case '':
      // Default view hides MCP-backed sessions: they are activity records, not
      // chats you would resume.
      return { op: 'neq', value: 'mcp' };
    default:
      return null;
  }
}

export function matchesSurfaceFilter(filter: SurfaceFilter, derived: ConversationSurface): boolean {
  if (filter === 'all') return true;
  if (filter === '') return derived !== 'mcp' && derived !== 'google_chat';
  return filter === derived;
}

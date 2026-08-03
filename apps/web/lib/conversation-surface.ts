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
  /** Chip classes — soft background + matching ink. */
  chip: string;
}

export const SURFACE_META: Record<ConversationSurface, SurfaceMeta> = {
  web: {
    label: 'Web chat',
    description: 'Started from the chat in this app',
    icon: MessagesSquare,
    chip: 'bg-primary-soft text-primary-ink',
  },
  mcp: {
    label: 'Claude',
    description: 'A Claude / MCP client session',
    icon: Bot,
    chip: 'bg-sky-soft text-sky',
  },
  google_chat: {
    label: 'Google Chat',
    description: 'A thread with the Cortex Chat app',
    icon: MessageSquareText,
    chip: 'bg-emerald-soft text-emerald',
  },
  routine: {
    label: 'Routine',
    description: 'Delivered by a scheduled routine',
    icon: AlarmClock,
    chip: 'bg-amber-soft text-amber',
  },
};

/** Segments of the /conversations filter, in display order. */
export const SURFACE_FILTERS = [
  { value: '', label: 'Chats' },
  { value: 'web', label: 'Web chat' },
  { value: 'routine', label: 'Routines' },
  { value: 'mcp', label: 'Claude' },
  { value: 'google_chat', label: 'Google Chat' },
  { value: 'all', label: 'All' },
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

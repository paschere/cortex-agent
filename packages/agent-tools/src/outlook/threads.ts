import {
  type GraphMessage,
  MESSAGE_SELECT,
  addressesOf,
  formatRecipient,
  formatRecipients,
  graphFetch,
  odataQuote,
  searchTerm,
} from '../msgraph/client';
import type { ToolContext } from '../types';

/**
 * Turning Outlook messages into the THREADS the Google tools speak.
 *
 * Gmail has a first-class thread resource: `GET /threads?q=…` returns
 * conversations and the tool is a straight pass-through. Graph has no such
 * endpoint — it returns messages, each stamped with the `conversationId` it
 * belongs to. So the grouping that Gmail does on its side happens here, once,
 * and `outlook.search` / `outlook.list_threads` / `outlook.read_thread` return
 * exactly the shapes `gmail.*` return.
 *
 * That is the whole design rule for this family: somebody who knows the Google
 * tools should not have to learn anything. Same tool names, same fields, same
 * nullability — only the id in `threads[].id` is a Graph conversation id rather
 * than a Gmail thread id, and neither was ever meant to be read by a human.
 */

export interface ThreadRow {
  id: string;
  snippet: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
}

export interface GraphMessageList {
  value?: GraphMessage[];
}

/** The moment a message happened — sent time for a draft, received otherwise. */
export function messageMoment(m: GraphMessage): string | null {
  return m.receivedDateTime ?? m.sentDateTime ?? null;
}

function momentMs(m: GraphMessage): number {
  const at = messageMoment(m);
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Messages → one row per conversation, newest conversation first.
 *
 * The row describes the MOST RECENT message in the conversation, which is what
 * a person means by "what is this thread about" and what Gmail's own thread
 * snippet shows. Ordering is done here rather than with `$orderby` because
 * Graph refuses to combine `$search` with `$orderby` at all, and a list that
 * silently changes order depending on which argument was passed would be worse
 * than one that is always sorted the same way.
 */
export function groupByConversation(messages: GraphMessage[], limit: number): ThreadRow[] {
  const byConversation = new Map<string, GraphMessage[]>();
  for (const m of messages) {
    // A message with no conversationId is its own thread; falling back to the
    // message id keeps it visible instead of dropping it into a shared bucket.
    const key = m.conversationId?.trim() || m.id;
    const bucket = byConversation.get(key);
    if (bucket) bucket.push(m);
    else byConversation.set(key, [m]);
  }

  const rows: Array<{ row: ThreadRow; at: number }> = [];
  for (const [id, group] of byConversation) {
    const sorted = [...group].sort((a, b) => momentMs(a) - momentMs(b));
    const latest = sorted[sorted.length - 1];
    if (!latest) continue;
    rows.push({
      at: momentMs(latest),
      row: {
        id,
        snippet: (latest.bodyPreview ?? '').trim(),
        from: formatRecipient(latest.from ?? latest.sender),
        to: formatRecipients(latest.toRecipients),
        subject: latest.subject ?? null,
        date: messageMoment(latest),
      },
    });
  }

  return rows
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((r) => r.row);
}

/**
 * How many MESSAGES to pull to be reasonably sure of finding N conversations.
 *
 * A busy thread is a dozen messages, so asking Graph for exactly `maxResults`
 * messages routinely yields two or three threads. Over-fetching by 6× with a
 * hard ceiling is the cheap fix; Graph caps `$top` at 1000 for messages and
 * anything near that is a page nobody reads.
 */
export function messageBudget(maxThreads: number): number {
  return Math.min(Math.max(maxThreads * 6, 25), 150);
}

/**
 * Run a mail query and return the raw messages.
 *
 * `$search` and `$filter` cannot be combined on the message collection — Graph
 * answers 400 — so the caller picks one and this only ever sends one.
 */
export async function fetchMessages(
  ctx: ToolContext,
  opts: { search?: string; filter?: string; top: number; orderBy?: string },
): Promise<GraphMessage[]> {
  const params = new URLSearchParams({ $select: MESSAGE_SELECT, $top: String(opts.top) });
  if (opts.search) {
    // KQL, and Graph wants the whole expression inside one pair of quotes.
    params.set('$search', `"${searchTerm(opts.search)}"`);
  } else {
    if (opts.filter) params.set('$filter', opts.filter);
    // Only legal without $search.
    params.set('$orderby', opts.orderBy ?? 'receivedDateTime desc');
  }
  const r = await graphFetch<GraphMessageList>(ctx, `/me/messages?${params.toString()}`);
  return r?.value ?? [];
}

/**
 * Every message in one conversation, oldest first.
 *
 * Sorted here rather than with `$orderby`: Outlook requires the filtered
 * property to lead the sort when both are present, so
 * `$filter=conversationId eq …&$orderby=receivedDateTime` is a 400 waiting to
 * happen. The message count in a thread is small; sorting it in memory costs
 * nothing and cannot fail.
 */
export async function fetchConversation(
  ctx: ToolContext,
  conversationId: string,
  opts: { withBody?: boolean; top?: number } = {},
): Promise<GraphMessage[]> {
  const select = opts.withBody ? `${MESSAGE_SELECT},body` : MESSAGE_SELECT;
  const params = new URLSearchParams({
    $select: select,
    $filter: `conversationId eq ${odataQuote(conversationId)}`,
    $top: String(Math.min(opts.top ?? 50, 100)),
  });
  const r = await graphFetch<GraphMessageList>(ctx, `/me/messages?${params.toString()}`, {
    // Outlook stores HTML; asking for text is the Graph equivalent of Gmail's
    // walk down to the text/plain part.
    prefer: opts.withBody ? ['outlook.body-content-type="text"'] : undefined,
  });
  return (r?.value ?? []).sort((a, b) => momentMs(a) - momentMs(b));
}

/** Every address that appears anywhere in a thread, lowercased and deduped. */
export function threadParticipants(messages: GraphMessage[]): string[] {
  const seen = new Set<string>();
  for (const m of messages) {
    for (const a of addressesOf(m.from ?? m.sender, m.toRecipients, m.ccRecipients)) {
      seen.add(a);
    }
  }
  return [...seen];
}

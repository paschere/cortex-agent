import { gmailFetch } from '../gmail/client';
import type { ToolContext } from '../types';
import {
  type Address,
  type MailHeader,
  classifyBulk,
  displayName,
  headerValue,
  parseAddress,
  parseAddressList,
} from './filters';

/**
 * Collecting the window of mail the digest reasons over.
 *
 * Everything here stays inside Zippy: the raw headers, snippets and addresses
 * are pulled with the user's own Gmail token, normalized, and handed to the
 * server-side model. Only the distilled digest ever leaves this module.
 */

export const GMAIL_PERMALINK_PREFIX = 'https://mail.google.com/mail/u/0/#inbox/';

export interface DigestThread {
  threadId: string;
  subject: string;
  /** Everyone on the thread except the user, in first-seen order. */
  participants: string[];
  lastFrom: string;
  lastFromEmail: string | null;
  lastMessageAt: string;
  ageHours: number;
  messageCount: number;
  unread: boolean;
  /** True when the user sent the last message → the ball is on the other side. */
  userIsLastSender: boolean;
  waitingOn: 'you' | 'them';
  snippet: string;
  permalink: string;
}

export interface ExcludedThread {
  threadId: string;
  subject: string;
  from: string;
  reason: string;
}

export interface GatherResult {
  threads: DigestThread[];
  excluded: ExcludedThread[];
  /** Threads Gmail returned for the window, before any filtering. */
  scanned: number;
  /** The Gmail query that defined the window — reported so the scope is auditable. */
  query: string;
  userEmail: string;
}

interface GmailMessage {
  id?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: MailHeader[] };
}

interface GmailThreadDetail {
  id: string;
  snippet?: string;
  messages?: GmailMessage[];
}

const METADATA_HEADERS = [
  'Subject',
  'From',
  'To',
  'Cc',
  'Date',
  'Reply-To',
  'List-Unsubscribe',
  'List-Id',
  'Precedence',
  'Auto-Submitted',
  'X-Campaign-Id',
  'X-Mailer-Campaign',
]
  .map((h) => `metadataHeaders=${encodeURIComponent(h)}`)
  .join('&');

/** The user's own address — the anchor for "who is waiting on whom". */
export async function resolveUserEmail(ctx: ToolContext): Promise<string> {
  try {
    const profile = await gmailFetch<{ emailAddress?: string }>(ctx, '/profile');
    if (profile.emailAddress) return profile.emailAddress.toLowerCase();
  } catch {
    // fall through to the app's own record
  }
  const { data } = await ctx.db.from('users').select('email').eq('id', ctx.userId).maybeSingle();
  const email = (data?.email as string | undefined) ?? '';
  return email.toLowerCase();
}

/** Run `worker` over `items` with a small concurrency cap. */
async function pooled<T, R>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      out[i] = await worker(item);
    }
  });
  await Promise.all(runners);
  return out;
}

export interface GatherOptions {
  hours: number;
  maxThreads: number;
  /** Restrict to threads Gmail still considers unread. */
  unreadOnly: boolean;
}

/**
 * Pull the recent window of the caller's mail and split it into "real
 * correspondence" and "bulk, and here is exactly why".
 */
export async function gatherThreads(ctx: ToolContext, opts: GatherOptions): Promise<GatherResult> {
  const now = Date.now();
  const since = Math.floor((now - opts.hours * 3_600_000) / 1000);
  const query = [
    'in:inbox',
    `after:${since}`,
    '-in:chats',
    opts.unreadOnly ? 'is:unread' : '',
    '-category:promotions',
    '-category:social',
    '-category:forums',
  ]
    .filter(Boolean)
    .join(' ');

  const [userEmail, list] = await Promise.all([
    resolveUserEmail(ctx),
    gmailFetch<{ threads?: Array<{ id: string }> }>(
      ctx,
      `/threads?q=${encodeURIComponent(query)}&maxResults=${opts.maxThreads}`,
    ),
  ]);

  const ids = (list.threads ?? []).map((t) => t.id).slice(0, opts.maxThreads);

  const details = await pooled(ids, 6, async (id) => {
    try {
      return await gmailFetch<GmailThreadDetail>(
        ctx,
        `/threads/${id}?format=metadata&${METADATA_HEADERS}`,
      );
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message, id }, 'inbox: thread fetch failed');
      return null;
    }
  });

  const threads: DigestThread[] = [];
  const excluded: ExcludedThread[] = [];

  for (const detail of details) {
    if (!detail?.messages?.length) continue;
    const messages = [...detail.messages].sort(
      (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
    );
    const last = messages[messages.length - 1];
    const first = messages[0];
    if (!last || !first) continue;

    const lastHeaders = last.payload?.headers ?? [];
    const subject =
      headerValue(first.payload?.headers ?? [], 'Subject') ??
      headerValue(lastHeaders, 'Subject') ??
      '(no subject)';
    const lastFrom = parseAddress(headerValue(lastHeaders, 'From') ?? '');
    const labelIds = messages.flatMap((m) => m.labelIds ?? []);

    // Bulk is judged on the LAST message: a newsletter that someone forwarded
    // into a real conversation should stay, and a thread that turned into an
    // automated notification should go.
    const verdict = classifyBulk({ headers: lastHeaders, labelIds, from: lastFrom });
    if (verdict.bulk) {
      excluded.push({
        threadId: detail.id,
        subject,
        from: displayName(lastFrom),
        reason: verdict.reason ?? 'it looks like bulk mail',
      });
      continue;
    }

    const lastMs =
      Number(last.internalDate ?? 0) || Date.parse(headerValue(lastHeaders, 'Date') ?? '');
    const lastMessageAt = new Date(
      Number.isFinite(lastMs) && lastMs > 0 ? lastMs : now,
    ).toISOString();
    const ageHours = Math.max(
      0,
      Math.round(((now - Date.parse(lastMessageAt)) / 3_600_000) * 10) / 10,
    );

    const userIsLastSender = lastFrom?.email === userEmail;

    // Everyone who has appeared on the thread, minus the user.
    const seen = new Map<string, Address>();
    for (const m of messages) {
      const h = m.payload?.headers ?? [];
      for (const a of [
        ...parseAddressList(headerValue(h, 'From')),
        ...parseAddressList(headerValue(h, 'To')),
        ...parseAddressList(headerValue(h, 'Cc')),
      ]) {
        if (a.email === userEmail) continue;
        if (!seen.has(a.email)) seen.set(a.email, a);
      }
    }

    threads.push({
      threadId: detail.id,
      subject,
      participants: [...seen.values()].map(displayName).slice(0, 8),
      lastFrom: userIsLastSender ? 'you' : displayName(lastFrom),
      lastFromEmail: lastFrom?.email ?? null,
      lastMessageAt,
      ageHours,
      messageCount: messages.length,
      unread: labelIds.includes('UNREAD'),
      userIsLastSender,
      waitingOn: userIsLastSender ? 'them' : 'you',
      snippet: (last.snippet ?? detail.snippet ?? '').replace(/\s+/g, ' ').slice(0, 400),
      permalink: `${GMAIL_PERMALINK_PREFIX}${detail.id}`,
    });
  }

  // Awaiting the user first, oldest first inside each group — the person who
  // has been waiting longest is the one about to get annoyed.
  threads.sort((a, b) => {
    if (a.waitingOn !== b.waitingOn) return a.waitingOn === 'you' ? -1 : 1;
    return b.ageHours - a.ageHours;
  });

  return { threads, excluded, scanned: ids.length, query, userEmail };
}

import { z } from 'zod';
import { cortexProcess } from '../cortex/process';
import { registerTool, runTool } from '../index';
import { summarizeExclusions } from './filters';
import { type DigestThread, gatherThreads } from './gather';
import { loadDigestPreferences } from './preferences';
import { humanAge, renderDigestHtml, renderDigestMarkdown } from './render';

/**
 * `inbox.priorities` — the caller's own mail, ranked by who is waiting.
 *
 * The point of this tool is what it does NOT do: mail bodies and snippets never
 * reach the model that called it. The window is pulled with the user's own
 * Gmail token, normalized here, and handed to `cortex.process` — Cortex's
 * server-side model — which returns a written digest. The calling model sees
 * that digest plus thread metadata (subject, who, how long), and nothing else.
 * Same trick as `kb.context`: compose through `runTool` so the audit trail,
 * rate limits and security gates still apply to every hop.
 *
 * Read-only, one mailbox — the caller's. There is no parameter for reading
 * somebody else's mail, and there never should be.
 */

const MAX_SOURCE_THREADS = 60;

const ItemSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  from: z.string(),
  participants: z.array(z.string()),
  waitingOn: z.enum(['you', 'them']),
  ageHours: z.number(),
  ageLabel: z.string(),
  messageCount: z.number(),
  unread: z.boolean(),
  lastMessageAt: z.string(),
  permalink: z.string(),
});

const FilteredSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  from: z.string(),
  reason: z.string(),
});

function toItem(t: DigestThread) {
  return {
    threadId: t.threadId,
    subject: t.subject,
    from: t.lastFrom,
    participants: t.participants,
    waitingOn: t.waitingOn,
    ageHours: t.ageHours,
    ageLabel: humanAge(t.ageHours),
    messageCount: t.messageCount,
    unread: t.unread,
    lastMessageAt: t.lastMessageAt,
    permalink: t.permalink,
  };
}

/** The compact, de-duplicated brief the server-side model reasons over. */
function buildSourceText(threads: DigestThread[]): string {
  return threads
    .slice(0, MAX_SOURCE_THREADS)
    .map((t, i) =>
      [
        `[${i + 1}] SUBJECT: ${t.subject}`,
        `    WITH: ${t.participants.join(', ') || 'unknown'}`,
        `    LAST MESSAGE: ${t.lastFrom}, ${humanAge(t.ageHours)} ago (${t.messageCount} message${t.messageCount === 1 ? '' : 's'} in the thread)`,
        `    STATUS: ${t.waitingOn === 'you' ? 'awaiting YOUR reply' : 'you replied last — awaiting the other side'}${t.unread ? ', unread' : ''}`,
        `    EXCERPT: ${t.snippet || '(no preview available)'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function buildInstruction(focus: string | null, windowHours: number): string {
  return [
    "You are writing one person's daily email digest, for that person only.",
    `The source below is every real conversation in their mailbox from the last ${windowHours} hours, already stripped of newsletters and bulk mail.`,
    '',
    'Write it in ENGLISH, in plain business language. No jargon, no tool names, no ids, no bullet-point padding.',
    'Use ONLY what is in the source. Never invent a name, a commitment, a date or an amount. If an excerpt is too thin to tell what the thread is about, say what is visible and stop.',
    '',
    'Produce exactly these four sections, as markdown, with no preamble:',
    '',
    '## Needs you today',
    'The conversations awaiting THEIR reply, most urgent first. Rank by who is waiting and how long they have waited — an external client waiting two days outranks a colleague waiting two hours. One line each: who is waiting, what they need, how long it has been. If nothing is waiting, say so in one line.',
    '',
    '## Waiting on others',
    'What they are blocked on: threads where they already replied and someone else owes them. One line each, naming who owes what. If nothing, say so in one line.',
    '',
    '## FYI',
    'Everything else worth knowing, one line each, at most five lines. Skip this section entirely if there is nothing.',
    '',
    '## Suggested next actions',
    'Three to five concrete actions for today, each starting with a verb and naming the person or thread. No generic advice.',
    focus
      ? `\nThe person described what matters to them as: "${focus}". Rank and phrase everything through that lens, and drop what it tells you to ignore.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** "Monday, 14 July" in the user's own zone. */
function dateLabel(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(new Date());
  }
}

export const inboxPriorities = registerTool({
  id: 'inbox.priorities',
  description:
    "Read the caller's OWN recent email and return a prioritized digest of it: what is waiting on them, what they are waiting on from other people, what is merely worth knowing, and the concrete next actions. Newsletters, campaigns and automated mail are filtered out, and the tool reports exactly what it left out and why, so the filtering can be checked. PRIVACY: this reads only the mailbox of the person making the request — there is no way to point it at anyone else — it is read-only, and the message content is summarized on Cortex's own servers so the raw mail never enters this conversation. The digest it returns is personal correspondence: use it to answer the person who asked, and never forward, post or send it anywhere they did not explicitly ask for.",
  inputSchema: z.object({
    hours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .default(24)
      .describe('How far back to look, in hours. Default 24, maximum one week.'),
    maxThreads: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(40)
      .describe('Cap on how many conversations to read.'),
    unreadOnly: z
      .boolean()
      .default(false)
      .describe(
        'Only unread conversations. Off by default — a read thread can still need a reply.',
      ),
    focus: z
      .string()
      .max(600)
      .optional()
      .describe(
        'What matters to this person, e.g. "clients first, ignore internal newsletters". Overrides their saved preference.',
      ),
  }),
  outputSchema: z.object({
    windowHours: z.number(),
    generatedAt: z.string(),
    scanned: z.number(),
    considered: z.number(),
    needsYouCount: z.number(),
    waitingOnOthersCount: z.number(),
    items: z.array(ItemSchema),
    filtered: z.array(FilteredSchema),
    filteredNote: z.string(),
    focus: z.string().nullable(),
    query: z.string(),
    markdown: z.string(),
    emailHtml: z.string(),
    subject: z.string(),
  }),
  requiredScopes: [
    {
      provider: 'google',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
  ],
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    const hours = input.hours ?? 24;
    const maxThreads = input.maxThreads ?? 40;
    const prefs = await loadDigestPreferences(ctx.db, ctx.userId);
    const focus = input.focus?.trim() || prefs.digestFocus;

    const gathered = await gatherThreads(ctx, {
      hours,
      maxThreads,
      unreadOnly: input.unreadOnly ?? false,
    });

    const needsYou = gathered.threads.filter((t) => t.waitingOn === 'you');
    const waitingOnOthers = gathered.threads.filter((t) => t.waitingOn === 'them');
    const excludedNote = summarizeExclusions(gathered.excluded.map((e) => e.reason));
    const label = dateLabel(prefs.timezone);

    let summaryMarkdown: string;
    if (gathered.threads.length === 0) {
      summaryMarkdown = [
        '## Needs you today',
        `Nothing. No real conversation arrived in the last ${hours} hours.`,
        '',
        '## Waiting on others',
        'Nothing outstanding.',
      ].join('\n');
    } else {
      // The mail goes to Cortex's own model, not to the caller's context.
      const processed = await runTool(
        cortexProcess,
        {
          instruction: buildInstruction(focus, hours),
          content: buildSourceText(gathered.threads),
          maxOutputChars: 6000,
        },
        ctx,
      );
      summaryMarkdown = processed.result.trim();
    }

    const renderInput = {
      dateLabel: label,
      summaryMarkdown,
      needsYou,
      waitingOnOthers,
      windowHours: hours,
      scanned: gathered.scanned,
      excludedNote,
      focus,
    };

    return {
      windowHours: hours,
      generatedAt: new Date().toISOString(),
      scanned: gathered.scanned,
      considered: gathered.threads.length,
      needsYouCount: needsYou.length,
      waitingOnOthersCount: waitingOnOthers.length,
      items: gathered.threads.map(toItem),
      filtered: gathered.excluded,
      filteredNote: excludedNote,
      focus,
      query: gathered.query,
      markdown: renderDigestMarkdown(renderInput),
      emailHtml: renderDigestHtml(renderInput),
      subject: `Your inbox digest — ${label}${needsYou.length > 0 ? ` (${needsYou.length} waiting on you)` : ''}`,
    };
  },
});

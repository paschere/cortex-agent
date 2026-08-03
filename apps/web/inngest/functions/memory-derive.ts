import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { google } from '@ai-sdk/google';
import {
  type AuditSignalRow,
  type MemoryCandidate,
  behaviouralCandidates,
  listMemories,
  rememberMemory,
  usableCandidates,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { generateText } from 'ai';

/**
 * The derived path: overnight, Cortex looks at how each person actually worked
 * and proposes things it could remember about them.
 *
 * NOTHING HERE IS WRITTEN AS FACT. Every candidate lands as a `suggested` row
 * the person accepts or rejects at /settings/memory. That approval step is the
 * point, not friction to be optimised away later: a wrongly-learned belief is
 * nearly impossible for a user to debug from outside — the symptom is "why does
 * Cortex keep assuming X?" with no visible cause — while accepting a correct one
 * costs a single click. Each suggestion carries the conversation it came from,
 * so the decision is informed rather than a coin flip.
 *
 * TWO SIGNALS, ONE OF WHICH NEEDS NO MODEL. `audit_events` records tool_id,
 * status and created_at per call, so which tools somebody uses, the hours they
 * work and what keeps failing for them are counting problems — computed in
 * `behaviouralCandidates`, deterministically, with the count shown to the
 * person as the evidence. Only the language signal (preferences, vocabulary,
 * standing instructions, said out loud in a conversation) goes near an LLM,
 * because only that one is actually inference. Note `input_hash` is a hash:
 * tool arguments are not minable from audit at all.
 *
 * SHAPE. Cron dispatcher + per-user event, mirroring schedule-dispatch.ts and
 * schedule-run.ts exactly — one function decides who is due and fans out, one
 * does the work for a single person so a failure is isolated to them and Inngest
 * retries only that person. It is not a second scheduler: `scheduled_jobs` stays
 * the only place a USER can schedule anything.
 */

/** 02:00 in Bogotá, where most of the team is — well clear of the working day. */
const DERIVE_CRON = '0 7 * * *';

/** How far back a first run looks. Later runs start from the high-water mark. */
const FIRST_RUN_WINDOW_DAYS = 7;
/** Behaviour needs a longer lens than language: a habit is not a week old. */
const BEHAVIOUR_WINDOW_DAYS = 30;

/**
 * At most five new suggestions a night. A queue nobody can face is a queue
 * nobody empties, and an unattended job is very good at producing one. (0051
 * caps the pending total at twelve on top of this.)
 */
const MAX_SUGGESTIONS_PER_RUN = 5;

/** Below this there is nothing to learn from, and a model call would be noise. */
const MIN_MESSAGES = 6;

const DAY_MS = 86_400_000;

interface RecentMessage {
  conversationId: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const memoryDeriveDispatch = inngest.createFunction(
  { id: 'memory-derive-dispatch' },
  { cron: DERIVE_CRON },
  async ({ step }) => {
    const userIds = await step.run('find-active-people', async () => {
      const db = getSupabaseServiceClient();
      const since = new Date(Date.now() - DAY_MS).toISOString();
      // Somebody who did nothing yesterday has nothing new to learn from, and
      // the point of scanning audit (rather than every user row) is that a
      // workspace of dormant accounts costs nothing to skip.
      const { data, error } = await db
        .from('audit_events')
        .select('user_id')
        .gte('created_at', since)
        .limit(5000);
      if (error) throw new Error(`Failed to scan recent activity: ${error.message}`);
      return [...new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))];
    });

    if (userIds.length > 0) {
      await step.sendEvent(
        'derive-per-user',
        userIds.map((userId) => ({ name: 'memory/derive.user' as const, data: { userId } })),
      );
    }
    return { dispatched: userIds.length };
  },
);

// ---------------------------------------------------------------------------
// One person
// ---------------------------------------------------------------------------

export const memoryDeriveUser = inngest.createFunction(
  { id: 'memory-derive-user', concurrency: { limit: 5 } },
  { event: 'memory/derive.user' },
  async ({ event, step }) => {
    const userId = event.data.userId as string;
    if (!userId) return { skipped: 'no user id' };

    const proposed = await step.run('propose', async () => {
      const db = getSupabaseServiceClient();

      const { data: prefs } = await db
        .from('user_preferences')
        .select('timezone, memories_derived_at')
        .eq('user_id', userId)
        .maybeSingle();
      const timezone = (prefs?.timezone as string | null) ?? 'America/Bogota';
      const highWater = prefs?.memories_derived_at as string | null;
      const languageSince = new Date(
        Math.max(
          Date.now() - FIRST_RUN_WINDOW_DAYS * DAY_MS,
          highWater ? new Date(highWater).getTime() : 0,
        ),
      ).toISOString();

      const existing = await listMemories(db, userId);
      // Every status, so a rejected sentence is never proposed twice and an
      // archived one is not re-offered as a discovery.
      const known = existing.map((m) => m.content);
      if (existing.filter((m) => m.status === 'suggested').length >= MAX_SUGGESTIONS_PER_RUN) {
        return { candidates: 0, written: 0, reason: 'queue already full' };
      }

      const [audit, recent] = await Promise.all([
        loadAuditSignals(userId),
        loadRecentMessages(userId, languageSince),
      ]);

      const candidates: MemoryCandidate[] = [
        ...behaviouralCandidates(audit, timezone),
        ...(await languageCandidates(recent)),
      ];

      const usable = usableCandidates(candidates, known, MAX_SUGGESTIONS_PER_RUN);
      let written = 0;
      for (const candidate of usable) {
        const id = await rememberMemory(db, {
          userId,
          content: candidate.content,
          kind: candidate.kind,
          source: candidate.source,
          status: 'suggested',
          conversationId: candidate.conversationId ?? null,
          note: candidate.note,
        });
        if (id) written += 1;
      }

      await db
        .from('user_preferences')
        .upsert(
          { user_id: userId, memories_derived_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        )
        .then(undefined, () => undefined);

      return { candidates: candidates.length, written };
    });

    return proposed;
  },
);

// ---------------------------------------------------------------------------
// Reading the person's own history
// ---------------------------------------------------------------------------

async function loadAuditSignals(userId: string): Promise<AuditSignalRow[]> {
  const db = getSupabaseServiceClient();
  const since = new Date(Date.now() - BEHAVIOUR_WINDOW_DAYS * DAY_MS).toISOString();
  const { data, error } = await db
    .from('audit_events')
    .select('tool_id, status, created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3000);
  if (error) return [];
  return (data ?? []) as AuditSignalRow[];
}

/**
 * The person's own words, and only theirs.
 *
 * Conversations are looked up by user_id first and messages are read only from
 * those — so a Google Chat space, where several people share a room, still
 * yields one person's turns, because each sender gets their own conversation
 * row keyed to them. Assistant turns are excluded on purpose: learning from
 * Cortex's own output is how a model's assumptions become a person's stored
 * "facts".
 */
async function loadRecentMessages(userId: string, since: string): Promise<RecentMessage[]> {
  const db = getSupabaseServiceClient();
  const { data: convs, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(25);
  if (convErr || !convs || convs.length === 0) return [];

  const ids = (convs as Array<{ id: string }>).map((c) => c.id);
  const { data, error } = await db
    .from('messages')
    .select('conversation_id, content')
    .in('conversation_id', ids)
    .eq('role', 'user')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return [];
  return ((data ?? []) as Array<{ conversation_id: string; content: string }>)
    .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
    .map((m) => ({ conversationId: m.conversation_id, content: m.content.trim().slice(0, 800) }));
}

// ---------------------------------------------------------------------------
// The one part that needs a model
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are reading one person's recent messages to Cortex, Zipdev's agent. Propose things Cortex could REMEMBER about this person so it stops needing to be told them again.

A good memory is:
- true beyond the conversation it came from — a standing rule, a preference, what one of their words means, or stable context about them and their work;
- written as ONE short sentence in the third person, under 200 characters, in the language they use;
- something that would change how Cortex answers even when the topic is different.

Do NOT propose:
- anything about a single task, deal, candidate or day ("wants the Acme proposal by Friday") — that is not durable;
- company-wide facts everyone already knows or should ("Zipdev is nearshore", "our standard margin is 35%") — those belong in the shared Knowledge Base, not in one person's memory;
- anything sensitive: passwords, keys, tokens, pay or salary figures, email addresses, phone numbers, ID numbers;
- anything you inferred from Cortex's own replies rather than from what the person said;
- guesses. If the messages do not clearly show it, leave it out.

Return STRICT JSON, nothing else:
{"memories":[{"content":"...","kind":"instruction|preference|vocabulary|fact","quote":"the short phrase they actually wrote that shows it"}]}

Return {"memories":[]} if nothing qualifies. Fewer, certain memories beat more, likely ones.`;

interface ExtractedMemory {
  content?: unknown;
  kind?: unknown;
  quote?: unknown;
}

function parseExtraction(raw: string): ExtractedMemory[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { memories?: unknown };
    return Array.isArray(parsed.memories) ? (parsed.memories as ExtractedMemory[]) : [];
  } catch {
    return [];
  }
}

const KINDS = new Set(['instruction', 'preference', 'vocabulary', 'fact']);

async function languageCandidates(messages: RecentMessage[]): Promise<MemoryCandidate[]> {
  if (messages.length < MIN_MESSAGES) return [];

  // Oldest first so the model reads the week the way it happened.
  const ordered = [...messages].reverse();
  const transcript = ordered.map((m, i) => `[${i + 1}] ${m.content}`).join('\n');

  let text = '';
  try {
    const result = await generateText({
      model: google('gemini-3.1-flash-lite'),
      system: EXTRACTION_PROMPT,
      prompt: transcript.slice(0, 24_000),
      maxTokens: 800,
    });
    text = result.text;
  } catch (err) {
    logger.error('memory-derive: extraction failed', { error: (err as Error).message });
    return [];
  }

  return parseExtraction(text).flatMap((raw): MemoryCandidate[] => {
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!content) return [];
    const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind) ? raw.kind : 'fact';
    const quote = typeof raw.quote === 'string' ? raw.quote.trim().slice(0, 300) : '';

    // The evidence link is only worth showing if the quote can be traced back
    // to a real message; an unmatched quote is the model's paraphrase and would
    // send the person to a conversation that does not contain it.
    const origin = quote
      ? ordered.find((m) => m.content.toLowerCase().includes(quote.toLowerCase().slice(0, 40)))
      : undefined;

    return [
      {
        content,
        kind: kind as MemoryCandidate['kind'],
        source: 'derived',
        note: quote ? `You wrote: "${quote}"` : 'Noticed across your recent conversations.',
        conversationId: origin?.conversationId ?? null,
      },
    ];
  });
}

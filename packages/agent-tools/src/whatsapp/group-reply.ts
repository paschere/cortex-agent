import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type GroupContextMessage,
  type GroupReplyScope,
  type MentionSignals,
  detectMention,
  renderGroupContext,
  stripMention,
} from './mentions';

/**
 * Answering a mention in a group, from the decision to the delivery.
 *
 * THE ORDER OF THE GATES IS THE DESIGN, so it is stated once here and the code
 * below does exactly this and nothing else:
 *
 *   1. Is answering switched on for this group?      no → silence
 *   2. Was Cortex actually mentioned?                no → silence
 *   3. Claim the mention (one row, unique index)     taken → silence
 *   4. Under the per-hour ceiling for this group?    no → silence
 *   5. Is the sender a linked Cortex person?         no → one fixed line, NO TOOLS
 *   6. Run the turn, narrowed to the group's scope
 *   7. Deliver: the public half in the group, anything withheld privately
 *
 * Gates 1–4 cost one indexed read and one insert and reach nothing else. Gate 5
 * is the one that must never be reordered: no model runs and no tool is offered
 * until a real person has been resolved, so an outsider in a group cannot spend
 * a RUNT lookup, a Brain Knowledge read or a token by tapping a name.
 *
 * The turn itself is INJECTED (`deps.runTurn`) rather than imported. The agent
 * engine lives in the web app — it needs the model, the system-prompt builder
 * and the approval staging — and pulling that in here would invert the
 * dependency. Injecting it also means the gate order above is testable without
 * a model, which is the property that matters: the tests assert that `runTurn`
 * is NOT called, which is a much stronger claim than asserting a reply is empty.
 */

export type GroupReplyOutcome =
  | 'ignored'
  | 'duplicate'
  | 'rate_limited'
  | 'unlinked'
  | 'answered'
  | 'withheld'
  | 'failed';

export interface GroupReplyResult {
  outcome: GroupReplyOutcome;
  /** What to post in the group, or null for silence. */
  reply: string | null;
  /** What to deliver to the asker privately, and to whom. */
  privateReply: { text: string; userId: string; phone: string } | null;
  /** Why the substance was kept out of the room, when it was. */
  withheldReason: string | null;
  /** For the log. Never contains anything anybody wrote. */
  note: string;
}

export interface GroupTurnRequest {
  organizationId: string;
  userId: string;
  senderName: string | null;
  groupJid: string;
  groupSubject: string | null;
  conversationKey: string;
  userText: string;
  /** The recent conversation, rendered. Ephemeral: never stored. */
  contextBlock: string;
  scope: GroupReplyScope;
  /** The only Brain Knowledge spaces this turn may retrieve from. */
  kbSpaceIds: string[] | null;
}

export interface GroupTurnResult {
  publicText: string;
  privateText: string | null;
  withheldReason: string | null;
}

export interface GroupReplyDeps {
  organizationId: string;
  db: SupabaseClient;
  logger: Logger;
  runTurn: (req: GroupTurnRequest) => Promise<GroupTurnResult>;
  /** Supplied rather than read, so the rate-limit window is testable. */
  nowMs?: number;
}

export interface GroupReplyRow {
  jid: string;
  subject: string | null;
  reply_enabled: boolean;
  reply_scope: string;
  reply_space_id: string | null;
  reply_limit_per_hour: number;
}

export interface GroupMentionInput {
  groupJid: string;
  messageId: string;
  senderJid: string | null;
  senderName: string | null;
  text: string;
  mentionedJids: string[];
  quotedAuthorJid: string | null;
  /** Every way WhatsApp writes this account. */
  selfJids: string[];
  recent: GroupContextMessage[];
}

/** A linked person, resolved by the caller before this runs. */
export interface ResolvedSender {
  userId: string;
  phone: string;
  displayName: string | null;
}

const SILENT = (outcome: GroupReplyOutcome, note: string): GroupReplyResult => ({
  outcome,
  reply: null,
  privateReply: null,
  withheldReason: null,
  note,
});

/** How long an unrecognised number's refusal stands before it is repeated. */
const REFUSAL_COOLDOWN_MS = 24 * 3_600_000;

/**
 * Take ownership of this mention, or discover somebody already has.
 *
 * The insert is the claim: the unique index on (workspace, group, message) does
 * the deciding, so two overlapping deliveries of the same message cannot both
 * win. Claimed BEFORE the answer is composed rather than recorded after it,
 * because a turn takes seconds and WhatsApp re-delivers inside that window —
 * recording afterwards would answer twice and only then notice.
 */
async function claimMention(
  db: SupabaseClient,
  input: { groupJid: string; messageId: string; senderJid: string | null; nowMs: number },
): Promise<string | null> {
  const { data, error } = await db
    .from('whatsapp_group_replies')
    .insert({
      group_jid: input.groupJid,
      message_id: input.messageId,
      sender_jid: input.senderJid,
      outcome: 'claimed',
      // Written rather than left to the column default, so the rate-limit
      // window is measured against the same clock the rest of this file reasons
      // with. A window whose edges come from the database and whose centre
      // comes from the caller is a window that cannot be tested.
      created_at: new Date(input.nowMs).toISOString(),
    })
    .select('id')
    .single();

  // A unique-violation is the expected outcome for a re-delivery, not a fault.
  if (error || !data) return null;
  return data.id as string;
}

type SettledOutcome = 'answered' | 'withheld' | 'unlinked' | 'ignored' | 'rate_limited' | 'failed';

async function settle(
  db: SupabaseClient,
  id: string,
  patch: { outcome: SettledOutcome; userId?: string | null; withheldReason?: string | null },
): Promise<void> {
  await db
    .from('whatsapp_group_replies')
    .update({
      outcome: patch.outcome,
      ...(patch.userId !== undefined ? { user_id: patch.userId } : {}),
      ...(patch.withheldReason !== undefined ? { withheld_reason: patch.withheldReason } : {}),
    })
    .eq('id', id)
    .then(undefined, () => undefined);
}

/**
 * How often Cortex has spoken in this group in the last hour.
 *
 * Counts rows that actually produced a message — `answered`, `withheld` and the
 * one-line refusal — and not the claims that ended in silence. Counting silence
 * against the ceiling would let a burst of mentions from an unlinked number
 * mute Cortex for everybody else in the room, which is a denial of service any
 * stranger in the group could trigger.
 */
async function spokenInLastHour(
  db: SupabaseClient,
  groupJid: string,
  nowMs: number,
): Promise<number> {
  const since = new Date(nowMs - 3_600_000).toISOString();
  const { data } = await db
    .from('whatsapp_group_replies')
    .select('id, outcome, created_at')
    .eq('group_jid', groupJid)
    .gte('created_at', since);

  return ((data ?? []) as Array<{ outcome: string }>).filter((r) =>
    ['answered', 'withheld', 'unlinked'].includes(r.outcome),
  ).length;
}

/** Has this number already been told, recently, that Cortex does not know it? */
async function refusedRecently(
  db: SupabaseClient,
  groupJid: string,
  senderJid: string | null,
  nowMs: number,
): Promise<boolean> {
  if (!senderJid) return true;
  const since = new Date(nowMs - REFUSAL_COOLDOWN_MS).toISOString();
  const { data } = await db
    .from('whatsapp_group_replies')
    .select('id, outcome, sender_jid, created_at')
    .eq('group_jid', groupJid)
    .gte('created_at', since);

  return ((data ?? []) as Array<{ outcome: string; sender_jid: string | null }>).some(
    (r) => r.outcome === 'unlinked' && r.sender_jid === senderJid,
  );
}

/**
 * Decide, and if the answer is yes, produce it.
 *
 * @param resolveSender resolves the sender's number to a Cortex person, or null.
 *   Injected because that lookup has to run unscoped (it is what determines the
 *   workspace) and this function only ever holds a scoped handle.
 */
export async function handleGroupMention(
  deps: GroupReplyDeps,
  group: GroupReplyRow,
  input: GroupMentionInput,
  resolveSender: () => Promise<ResolvedSender | null>,
  scopeOf: (raw: string) => GroupReplyScope,
  unknownReply: string,
): Promise<GroupReplyResult> {
  const nowMs = deps.nowMs ?? Date.now();

  // 1. Is answering switched on here? Note this is `reply_enabled` and has
  //    nothing to do with `archive_enabled` — a group can do either, both or
  //    neither (migration 0072).
  if (!group.reply_enabled) return SILENT('ignored', 'answering is not switched on for this group');

  // 2. Was Cortex actually spoken to? Re-checked here even though the bridge
  //    already checked, because "only when mentioned" is the promise this
  //    feature is sold on and it should not rest on one process being correct.
  const signals: MentionSignals = {
    mentionedJids: input.mentionedJids,
    quotedAuthorJid: input.quotedAuthorJid,
    text: input.text,
  };
  const mention = detectMention(signals, input.selfJids);
  if (!mention) return SILENT('ignored', 'not addressed to Cortex');

  // 3. One answer per mention, ever.
  const claimId = await claimMention(deps.db, {
    groupJid: input.groupJid,
    messageId: input.messageId,
    senderJid: input.senderJid,
    nowMs,
  });
  if (!claimId) return SILENT('duplicate', 'this mention was already handled');

  // 4. Noise ceiling. Silent rather than announced: "estoy limitado" is itself
  //    another message in a group that has just had too many.
  const spoken = await spokenInLastHour(deps.db, input.groupJid, nowMs);
  if (spoken >= Math.max(1, group.reply_limit_per_hour)) {
    await settle(deps.db, claimId, { outcome: 'rate_limited' });
    deps.logger.warn(
      { group: input.groupJid, spoken },
      'whatsapp: group reply ceiling reached; staying quiet',
    );
    return SILENT('rate_limited', 'the per-hour ceiling for this group has been reached');
  }

  // 5. THE IDENTITY GATE. Nothing above this line ran a model or offered a
  //    tool, and nothing below it does either unless this resolves.
  const sender = await resolveSender();
  if (!sender) {
    // Asked BEFORE this claim is marked `unlinked`, or the row written a line
    // later would be the very evidence that this person had already been told,
    // and the refusal would never be said at all.
    const alreadyTold = await refusedRecently(deps.db, input.groupJid, input.senderJid, nowMs);
    // `unlinked` only when a line is actually said; a silent repeat is
    // `ignored`. The difference is what keeps the per-hour ceiling counting
    // messages rather than mentions — see `spokenInLastHour`.
    await settle(deps.db, claimId, {
      outcome: alreadyTold ? 'ignored' : 'unlinked',
      userId: null,
    });
    deps.logger.warn(
      { group: input.groupJid },
      'whatsapp: an unlinked number mentioned Cortex in a group; nothing was run',
    );
    return {
      outcome: 'unlinked',
      // Said once a day per person. A fixed string: no model, no tool, no read.
      reply: alreadyTold ? null : unknownReply,
      privateReply: null,
      withheldReason: null,
      note: 'the sender is not linked to a Cortex person, so no tool was offered',
    };
  }

  // 6. The turn, narrowed to what this group is allowed to reach.
  const scope = scopeOf(group.reply_scope);
  // The retrieval ceiling, per scope. Note `plain` is `[]` and NOT null: the
  // turn engine runs a retrieval prepend of its own before any tool is offered,
  // so "offer no tools" would not by itself stop Brain Knowledge — including
  // the asker's private notes — reaching the prompt and being paraphrased into
  // a room with a client in it. `[]` is what actually closes that.
  //
  //   plain      no space at all
  //   knowledge  exactly the one company space chosen for this group, and
  //              nothing if none was chosen — an unset restriction must never
  //              degrade into no restriction
  //   internal   unrestricted, which is the point of the scope and is why it is
  //              only for rooms with no outsiders in them
  const kbSpaceIds: string[] | null =
    scope === 'internal'
      ? null
      : scope === 'knowledge' && group.reply_space_id
        ? [group.reply_space_id]
        : [];

  try {
    const turn = await deps.runTurn({
      organizationId: deps.organizationId,
      userId: sender.userId,
      senderName: sender.displayName ?? input.senderName,
      groupJid: input.groupJid,
      groupSubject: group.subject,
      // Per person, not per group: two people mentioning Cortex in the same room
      // do not share a thread, so one person's earlier exchange is never
      // replayed into another's turn. The room's shared context comes from the
      // ephemeral block instead, which everyone present could already read.
      conversationKey: `whatsapp-group:${input.groupJid}:${sender.phone}`,
      userText: stripMention(input.text, input.selfJids) || 'Resume lo que está pasando aquí.',
      contextBlock: renderGroupContext(input.recent, {
        nowMs,
        groupSubject: group.subject,
      }),
      scope,
      kbSpaceIds,
    });

    const withheld = turn.withheldReason;
    await settle(deps.db, claimId, {
      outcome: withheld ? 'withheld' : 'answered',
      userId: sender.userId,
      withheldReason: withheld,
    });

    return {
      outcome: withheld ? 'withheld' : 'answered',
      reply: turn.publicText,
      privateReply: turn.privateText
        ? { text: turn.privateText, userId: sender.userId, phone: sender.phone }
        : null,
      withheldReason: withheld,
      note: withheld
        ? `the substance was kept out of the room (${withheld}) and sent to the person who asked`
        : 'answered in the group',
    };
  } catch (err) {
    await settle(deps.db, claimId, { outcome: 'failed', userId: sender.userId });
    deps.logger.error(
      { group: input.groupJid, err: (err as Error).message },
      'whatsapp: group turn failed',
    );
    // Silence rather than an apology. In a 1:1 an apology is right — the person
    // is waiting. In a group it is one more message nobody wanted, and the
    // person can simply ask again.
    return SILENT('failed', (err as Error).message);
  }
}

/**
 * Whether a message from a group should be staged for archiving.
 *
 * Exported and used by the ingest route so the rule is testable rather than
 * embedded in an HTTP handler. It exists mostly to state the thing that is easy
 * to get wrong now that groups have two switches: `reply_enabled` grants
 * NOTHING here. A group where Cortex answers but archiving is off must store
 * nothing at all — not a message, not a stub, nothing.
 */
export function shouldStageMessage(
  group: {
    archive_enabled?: boolean | null;
    space_id?: string | null;
    enabled_by?: string | null;
    archive_from?: string | null;
  } | null,
  sentAtMs: number,
): boolean {
  if (!group) return false;
  if (!group.archive_enabled) return false;
  // A group with archiving on but no destination or nobody answerable for it is
  // not archivable; writing the rows anyway would leave messages that can never
  // become a document.
  if (!group.space_id || !group.enabled_by) return false;
  if (!Number.isFinite(sentAtMs)) return false;
  if (group.archive_from) {
    const from = Date.parse(group.archive_from);
    if (Number.isFinite(from) && sentAtMs < from) return false;
  }
  return true;
}

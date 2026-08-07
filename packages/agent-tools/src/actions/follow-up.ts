import { FOLLOW_UP_WINDOW_MS } from './shape';

/**
 * Closing the loop.
 *
 * An action that was sent and then never looked at again is the failure this
 * module exists to prevent. The cobro is not the point; the client paying is.
 * So an executed action stays `awaiting` until something answers it, and three
 * things can:
 *
 *   somebody replied on the thread        → replied
 *   the thing it was about got closed     → resolved   (the commitment was met)
 *   the window passed in silence          → no_reply
 *
 * The last one is not a failure state, it is a FINDING. "Se mandó el cobro y
 * nadie contestó en diez días" is the single most actionable sentence this
 * feature can produce, and it only exists if silence is recorded rather than
 * left as an empty column.
 *
 * Everything here is pure. The Gmail read and the database writes live in the
 * sweep (apps/web/inngest/functions/actions-sweep.ts); what counts as an answer
 * is decided here, where it can be tested.
 */

export interface ThreadMessage {
  from: string | null;
  date: string | null;
}

export interface ReplyVerdict {
  replied: boolean;
  /** Who answered and when, in one line, for the outcome note. */
  note: string | null;
}

/**
 * Extract the bare address from a From header.
 *
 * `"Ana Gómez" <ana@coltrans.co>` → `ana@coltrans.co`. Compared case-insensitively
 * because Gmail is inconsistent about it and a case difference here would file
 * our own sent message as the client's reply.
 */
export function addressOf(header: string | null): string | null {
  if (!header) return null;
  const angled = header.match(/<([^>]+)>/);
  const raw = (angled?.[1] ?? header).trim().toLowerCase();
  return raw.includes('@') ? raw : null;
}

/**
 * Did anybody other than us write on this thread after we sent?
 *
 * BOTH conditions matter, and each one alone gets it wrong. Without the clock,
 * the client's original email — the one being answered — counts as a reply, so
 * every `reply_to_client` action closes itself the moment it is sent. Without
 * the sender check, our own message counts, so every action closes itself
 * immediately regardless.
 *
 * A message with an unparseable date is treated as NOT a reply. The cost of
 * that mistake is a loop that stays open one sweep longer; the cost of the
 * opposite is telling somebody a client answered when they did not.
 */
export function findReply(
  messages: ThreadMessage[],
  opts: { executedAt: Date; ourAddresses: string[] },
): ReplyVerdict {
  const ours = new Set(opts.ourAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const after = opts.executedAt.getTime();

  for (const m of messages) {
    const from = addressOf(m.from);
    if (!from || ours.has(from)) continue;
    const at = m.date ? Date.parse(m.date) : Number.NaN;
    if (Number.isNaN(at) || at <= after) continue;
    return {
      replied: true,
      note: `Respondió ${from} el ${new Date(at).toISOString().slice(0, 10)}.`,
    };
  }
  return { replied: false, note: null };
}

/**
 * Has an unanswered action been unanswered long enough to be worth saying so?
 */
export function silenceIsFinal(executedAt: string | null, now: Date = new Date()): boolean {
  if (!executedAt) return false;
  const at = Date.parse(executedAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at >= FOLLOW_UP_WINDOW_MS;
}

/**
 * The line a person reads when an action closed itself.
 *
 * Spanish, and it names the outcome rather than the mechanism: nobody wants to
 * know that a sweep matched a From header.
 */
export function outcomeNoteForResolution(kind: 'commitment_met' | 'commitment_dropped'): string {
  return kind === 'commitment_met'
    ? 'El compromiso quedó cumplido, así que esta acción ya no está pendiente.'
    : 'El compromiso se descartó, así que esta acción ya no está pendiente.';
}

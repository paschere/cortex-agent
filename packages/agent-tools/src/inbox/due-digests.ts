import { z } from 'zod';
import { registerTool } from '../index';
import { PREFERENCE_COLUMNS, rowToPreferences } from './preferences';
import { hasDigestToday, isWithinWindow, localMinutesOfDay, parseHHMM } from './window';

/**
 * `inbox.due_digests` — who is waiting for their digest right now.
 *
 * The half-hourly routine cannot answer this on its own: the delivery time is
 * per-person and expressed in that person's own zone, and "already sent today"
 * is also a per-person, per-zone question. Doing it here keeps the routine's
 * instruction to two sentences and keeps the time arithmetic in tested code
 * instead of in a prompt.
 *
 * It deliberately returns as little as it can — an id, a first name and a local
 * time. No email addresses, no preferences, no mail. Everything the delivery
 * needs is re-read from that person's own row when the digest is built.
 */

export const inboxDueDigests = registerTool({
  id: 'inbox.due_digests',
  description:
    'List the people whose daily inbox digest is due right now: those who turned the digest on themselves, whose chosen local delivery time falls inside the current window, and who have not already received one today. Use it at the start of the daily digest routine, then deliver to each person it returns. It returns only names and internal references — no mail, no addresses, no settings.',
  inputSchema: z.object({
    windowMinutes: z
      .number()
      .int()
      .min(5)
      .max(180)
      .default(30)
      .describe('How wide the "due now" window is. Match it to how often the routine runs.'),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  outputSchema: z.object({
    due: z.array(
      z.object({
        userId: z.string(),
        name: z.string(),
        localTime: z.string(),
        timezone: z.string(),
      }),
    ),
    enabledTotal: z.number(),
    checkedAt: z.string(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const now = new Date();
    const windowMinutes = input.windowMinutes ?? 30;

    const { data, error } = await ctx.db
      .from('user_preferences')
      .select(PREFERENCE_COLUMNS)
      .eq('inbox_digest_enabled', true)
      .limit(input.limit ?? 100);
    if (error) throw new Error(`Could not read digest preferences: ${error.message}`);

    const enabled = (data ?? []).map((row) =>
      rowToPreferences(
        (row as Record<string, unknown>).user_id as string,
        row as Record<string, unknown>,
      ),
    );

    const candidates = enabled.filter((p) => {
      const target = parseHHMM(p.time);
      const local = localMinutesOfDay(p.timezone, now);
      if (target === null || local === null) {
        ctx.logger.warn(
          { userId: p.userId, time: p.time, timezone: p.timezone },
          'inbox.due_digests: unusable time or timezone',
        );
        return false;
      }
      return isWithinWindow(target, local, windowMinutes);
    });

    // Names are for the routine's own report; the ids are what delivery needs.
    const names = new Map<string, string>();
    if (candidates.length > 0) {
      const { data: users } = await ctx.db
        .from('users')
        .select('id, name, email')
        .in(
          'id',
          candidates.map((c) => c.userId),
        );
      for (const u of users ?? []) {
        const row = u as { id: string; name: string | null; email: string | null };
        names.set(row.id, row.name ?? row.email?.split('@')[0] ?? 'a teammate');
      }
    }

    const due: Array<{ userId: string; name: string; localTime: string; timezone: string }> = [];
    for (const p of candidates) {
      if (await hasDigestToday(ctx.db, p.userId, p.timezone, now)) continue;
      due.push({
        userId: p.userId,
        name: names.get(p.userId) ?? 'a teammate',
        localTime: p.time,
        timezone: p.timezone,
      });
    }

    return {
      due,
      enabledTotal: enabled.length,
      checkedAt: now.toISOString(),
      markdown:
        due.length === 0
          ? `No digests are due in this window (${enabled.length} ${enabled.length === 1 ? 'person has' : 'people have'} the digest turned on).`
          : `${due.length} digest${due.length === 1 ? '' : 's'} due now: ${due
              .map((d) => `${d.name} (${d.localTime} ${d.timezone})`)
              .join(', ')}.`,
    };
  },
});

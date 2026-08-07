import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';

/**
 * The retention sweep for captured turn contexts (migration 0080).
 *
 * TWO PASSES, AND THE FIRST IS THE ONE THAT MATTERS. After fourteen days the
 * quoted material is stripped from a row — fragment excerpts, memory text, the
 * retrieval summary — in place, leaving every number behind. After ninety days
 * the row goes. The reasoning for both windows lives in
 * `packages/agent-tools/src/turn-context/policy.ts`, next to the constants that
 * set the deadlines, and each row carries its own two dates so a change to that
 * policy cannot retroactively re-date history.
 *
 * WHY REDACTION IS A WRITE AND NOT A READ FILTER. What is in these rows is
 * material out of Brain Knowledge, some of it from somebody's personal space.
 * Hiding it at read time would leave a diagnostics table quietly holding
 * passages from people's private notes for months. "We stopped keeping it" is
 * only a true sentence when the bytes are gone.
 *
 * UNSCOPED, AND ONLY HERE. The sweep spans every workspace and there is no
 * session behind a cron to scope it to. It reaches Postgres through a database
 * function that takes no tenant argument, touches no tenant-visible data and
 * returns two counts — which is what `maintenance` means in RPC_TENANCY.
 *
 * 03:40 in Bogotá: after the nightly memory derivation, well clear of anyone
 * working, and off the hour so it does not pile onto every other cron.
 */
const PURGE_CRON = '40 8 * * *';

export const turnContextPurge = inngest.createFunction(
  { id: 'turn-context-purge' },
  [{ event: 'turn-context/purge' }, { cron: PURGE_CRON }],
  async ({ step }) => {
    return await step.run('sweep', async () => {
      const db = getSupabaseServiceClient();
      const { data, error } = await db.rpc('turn_context_purge');
      if (error) {
        // Thrown rather than swallowed: unlike the capture itself, a sweep that
        // silently stops running is a retention promise silently broken, and
        // Inngest retrying it (and eventually shouting) is the correct outcome.
        throw new Error(`turn_context_purge failed: ${error.message}`);
      }
      const row = (Array.isArray(data) ? data[0] : data) as
        | { redacted: number; deleted: number }
        | undefined;
      const result = {
        redacted: Number(row?.redacted ?? 0),
        deleted: Number(row?.deleted ?? 0),
      };
      logger.info('turn context retention sweep', result);
      return result;
    });
  },
);

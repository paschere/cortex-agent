import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  MEET_READONLY_SCOPE,
  type MeetingImportContext,
  type ToolContext,
  createIntegrationsClient,
  importMeetingTranscript,
  listConferenceRecords,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * Meetings become memory on their own.
 *
 * Nobody remembers to file the call where the important thing was said — that
 * is precisely the call that gets lost. So this sweeps recent Google Meet
 * conferences every half hour and imports the ones that produced a transcript
 * and are not in Brain Knowledge yet.
 *
 * WHOSE GOOGLE ACCOUNT, AND WHY IT HAS TO BE PER USER. `drive-sync` resolves
 * this from `gdrive_sync_state.owner_user_id`: a synced folder has an owner, and
 * the sweep runs as them. There is no equivalent owner for a meeting, and there
 * is no org-wide way to ask Google for one either — `conferenceRecords.list`
 * returns only the conferences the CALLING account took part in. A service
 * account would come back empty. So the sweep is per connected user, running as
 * them, seeing exactly what they can see. That is not a workaround; it is the
 * same boundary the interactive tool has, applied on a timer.
 *
 * WHEN TWO PEOPLE WERE ON THE SAME CALL, both sweeps find the same conference
 * record. The unique index in 0059 means the second one updates the first one's
 * document instead of making a copy, and `importMeetingTranscript` refuses to
 * touch it at all if it landed in a space the second person cannot write to.
 * First importer wins, and nothing leaks either way.
 *
 * FAILURE IS PER MEETING. One user's revoked Google token, one meeting whose
 * transcript Google is still writing, one embedding outage — none of them may
 * stop the rest of the sweep. Every user is its own `step.run` (so Inngest
 * retries and reports them separately) and every meeting inside it is caught
 * individually.
 */

/**
 * Two days, swept every thirty minutes. Meet can take several minutes to finish
 * writing a transcript after a call ends and occasionally much longer, so a
 * window that only covered the last half hour would permanently miss exactly the
 * meetings that were slowest to transcribe. Re-seeing the same meeting ~96 times
 * costs one indexed lookup each after the first import — see the unique index in
 * migration 0059.
 */
const LOOKBACK_HOURS = 48;

/**
 * A ceiling on new imports per user per run. A first run for someone with a busy
 * calendar could otherwise try to embed a hundred meetings in one step and hit
 * the function timeout; the leftovers are simply picked up thirty minutes later.
 */
const MAX_IMPORTS_PER_USER = 12;

interface UserSweepResult {
  userId: string;
  considered: number;
  imported: number;
  skipped: number;
  failed: number;
}

export const meetingImportSweep = inngest.createFunction(
  { id: 'meeting-import-sweep' },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    // Only accounts that actually granted the Meet scope. Asking Google on
    // behalf of someone who never granted it earns a 403 per user per run and
    // teaches the log to cry wolf.
    const userIds = await step.run('load-connected-users', async () => {
      const db = getSupabaseServiceClient();
      const { data, error } = await db
        .from('integrations')
        .select('user_id, scopes')
        .eq('provider', 'google')
        .contains('scopes', [MEET_READONLY_SCOPE]);
      if (error) throw new Error(`Failed to load Google integrations: ${error.message}`);
      return [...new Set((data ?? []).map((row) => row.user_id as string))];
    });

    const results: UserSweepResult[] = [];

    for (const userId of userIds) {
      const result = await step
        .run(`sweep-${userId}`, async () => sweepUser(userId))
        .catch((err: unknown) => {
          // Swallowed on purpose: one user's expired token must not abort the
          // batch, and Inngest has already recorded the step's own failure.
          logger.error('meeting-import: user sweep failed', {
            userId,
            error: (err as Error).message,
          });
          return { userId, considered: 0, imported: 0, skipped: 0, failed: 1 };
        });
      results.push(result);
    }

    return {
      ok: true,
      users: results.length,
      imported: results.reduce((sum, r) => sum + r.imported, 0),
      results,
    };
  },
);

async function sweepUser(userId: string): Promise<UserSweepResult> {
  const db = getSupabaseServiceClient();
  const integrations = createIntegrationsClient(db, userId, logger);
  const ctx: MeetingImportContext = { userId, db, integrations, logger };

  const startAfter = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000);
  const records = await listConferenceRecords(ctx as ToolContext, {
    startAfter,
    pageSize: 50,
  });

  const summary: UserSweepResult = {
    userId,
    considered: records.length,
    imported: 0,
    skipped: 0,
    failed: 0,
  };
  if (records.length === 0) return summary;

  // One round trip instead of one per meeting. 'failed' rows are deliberately
  // NOT in the skip set — a meeting that broke on an embedding outage should be
  // retried, and re-importing it is an update, not a duplicate.
  const { data: alreadyDone } = await db
    .from('meeting_imports')
    .select('conference_record')
    .in(
      'conference_record',
      records.map((r) => r.name),
    )
    .eq('status', 'ready');
  const done = new Set((alreadyDone ?? []).map((row) => row.conference_record as string));

  for (const record of records) {
    if (done.has(record.name)) {
      summary.skipped += 1;
      continue;
    }
    if (summary.imported >= MAX_IMPORTS_PER_USER) break;

    try {
      // No space is named, so it lands in this person's own private space —
      // the deliberate default, argued in import-transcript.ts. An unattended
      // job is the last place that should be widening who can read a client
      // call. The calendar title lookup is left ON: it is best-effort and a
      // meeting called "Acme — pricing" is worth far more later than
      // "Meet abc-defg-hij".
      const result = await importMeetingTranscript(ctx, { conferenceRecord: record.name });

      if (result.outcome === 'imported' || result.outcome === 'updated') {
        summary.imported += 1;
      } else if (result.outcome === 'failed') {
        summary.failed += 1;
        logger.warn('meeting-import: meeting could not be stored', {
          userId,
          conferenceRecord: record.name,
          note: result.note,
        });
      } else if (result.outcome === 'unauthorized') {
        // Every remaining meeting for this user would fail the same way.
        logger.warn('meeting-import: Google refused, stopping this user', { userId });
        break;
      } else {
        // 'unavailable' (no transcript yet) and 'unchanged' are both normal.
        summary.skipped += 1;
      }
    } catch (err) {
      // importMeetingTranscript returns its failures rather than throwing, so
      // reaching here means something genuinely unexpected. Still per meeting.
      summary.failed += 1;
      logger.error('meeting-import: unexpected failure on one meeting', {
        userId,
        conferenceRecord: record.name,
        error: (err as Error).message,
      });
    }
  }

  return summary;
}

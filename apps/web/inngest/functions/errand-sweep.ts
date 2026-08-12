import { EVENT_ERRAND_ADVANCE } from '@/lib/errands/contract';
import { inngest } from '@/lib/inngest';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { ERRAND_STALE_MS } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * THE BACKSTOP. Nothing stays "trabajando" for ever, and nothing waits on a
 * step that nobody is going to take.
 *
 * The errand worker is event-driven, and between two steps of an errand there
 * is no process at all — which is what makes an errand survive days, deploys
 * and crashes. The price of that design is that if an event is ever lost, or
 * if the thing an errand was waiting for finishes while nobody is watching,
 * the errand just sits there. Nothing errors; nothing happens. That is exactly
 * the silence this feature exists to remove, so the system watches itself.
 *
 * THREE JOBS, all of which end in the same content-free `errand/advance`:
 *
 *   NUDGE      Any live errand that has not been looked at recently. Covers
 *              the normal case — a leg finished and no worker was awake to
 *              notice — and every lost-event case at once. The nudge is safe
 *              to send at any moment because the worker re-derives everything;
 *              an errand with nothing to do simply does nothing.
 *
 *   WAKE       A monitor whose next look has come due. This is the mechanism
 *              behind "vigila esto y avísame": there is no timer anywhere, only
 *              a column with an instant in it and a cron that reads it.
 *
 *   ABANDON    An errand that has been silent far past anything a healthy one
 *              can manage. Closed as `failed`, with a sentence saying so. A
 *              row that claims to be working over a machine that is not is the
 *              exact lie the orchestrator's own sweep exists to remove, one
 *              level up.
 *
 * WHY THIS HOLDS A RAW, UNSCOPED CLIENT. "Which errands anywhere in the install
 * need a look" is a question about the whole install; there is no workspace to
 * scope it to and no session behind a cron. Isolation happens one step later:
 * the raw handle only ever runs SELECTs, and every write goes through a handle
 * pinned to the errand's own workspace — which is also why organization_id is
 * read here.
 */

/**
 * Every minute. The nudge threshold is one minute, so a leg that finishes is
 * picked up within about two — short enough that a person watching the screen
 * sees the next stage start, and long enough that a healthy errand is nudged a
 * dozen times over a forty-minute leg rather than hundreds.
 */
const CRON = '* * * * *';

/**
 * Silence after which a live errand gets a look.
 *
 * A QUEUED errand is exempt from this and is picked up on the very next pass,
 * with no silence requirement at all. It has never been touched, so there is
 * nothing to wait for, and it is the case that matters most now that an errand
 * can be started by talking: the tool has no way to send an Inngest event
 * (packages/agent-tools does not depend on Inngest, deliberately — it is a
 * library), so the sweep IS how a chat-commissioned errand starts. Making it
 * wait a minute to have been silent for a minute would have doubled the delay
 * between «investígame esto» and anything happening.
 */
const NUDGE_AFTER_MS = 60_000;

/**
 * Silence after which an errand is written off. Two hours is roughly five
 * times the orchestrator's own stale threshold plus its sweep interval, so
 * every self-healing path below this one has had many chances to fire. An
 * errand reaching it means something outside the errand is broken.
 */
const ABANDON_AFTER_MS = 2 * 60 * 60_000;

/** Errands touched per pass. A ceiling, not a limit anyone expects to reach. */
const MAX_PER_PASS = 200;

interface Candidate {
  id: string;
  organizationId: string;
  userId: string | null;
  silentMs: number;
}

export const errandSweep = inngest.createFunction(
  { id: 'errand-sweep' },
  { cron: CRON },
  async ({ step }) => {
    const now = Date.now();

    const found = await step.run('scan', async () => {
      const raw = getSupabaseServiceClient();

      const [fresh, live, due] = await Promise.all([
        // Never started. Picked up immediately — see NUDGE_AFTER_MS.
        raw
          .from('errands')
          .select('id, organization_id, user_id, last_heartbeat_at')
          .eq('state', 'queued')
          .order('created_at', { ascending: true })
          .limit(MAX_PER_PASS),
        raw
          .from('errands')
          .select('id, organization_id, user_id, last_heartbeat_at')
          .in('state', ['queued', 'working', 'blocked'])
          .lt('last_heartbeat_at', new Date(now - NUDGE_AFTER_MS).toISOString())
          .order('last_heartbeat_at', { ascending: true })
          .limit(MAX_PER_PASS),
        raw
          .from('errands')
          .select('id, organization_id, user_id, last_heartbeat_at')
          .eq('state', 'watching')
          .lt('next_check_at', new Date(now).toISOString())
          .order('next_check_at', { ascending: true })
          .limit(MAX_PER_PASS),
      ]);

      if (fresh.error) throw new Error(`Could not scan queued errands: ${fresh.error.message}`);
      if (live.error) throw new Error(`Could not scan live errands: ${live.error.message}`);
      if (due.error) throw new Error(`Could not scan due monitors: ${due.error.message}`);

      const seen = new Set<string>();
      const candidates: Candidate[] = [];
      for (const row of [
        ...(fresh.data ?? []),
        ...(live.data ?? []),
        ...(due.data ?? []),
      ] as Record<string, unknown>[]) {
        const id = row.id as string;
        const organizationId = (row.organization_id as string | null) ?? '';
        if (!id || !organizationId || seen.has(id)) continue;
        seen.add(id);
        const beat = new Date((row.last_heartbeat_at as string) ?? 0).getTime();
        candidates.push({
          id,
          organizationId,
          userId: (row.user_id as string | null) ?? null,
          silentMs: Number.isFinite(beat) ? now - beat : Number.POSITIVE_INFINITY,
        });
      }
      return candidates;
    });

    // ── Abandon first, so an errand past saving is not also nudged ─────────
    const abandoned = await step.run('abandon-lost-errands', async () => {
      const lost = found.filter((c) => c.silentMs > ABANDON_AFTER_MS);
      const closed: string[] = [];
      for (const candidate of lost) {
        try {
          const db = getOrgScopedClient(candidate.organizationId);
          // The freshness guard is repeated in the UPDATE rather than trusted
          // from the scan: minutes can pass in between, and an errand that
          // moved in that window is alive and must not be closed.
          const { data } = await db
            .from('errands')
            .update({
              state: 'failed',
              finished_at: new Date().toISOString(),
              closing_note:
                '**Este encargo dejó de dar señales.**\n\nLlevaba más de dos horas sin avanzar ni ' +
                'reportar nada, así que lo damos por perdido en vez de dejarlo diciendo que ' +
                'trabaja. No falló por sí solo y nadie lo detuvo: lo más probable es que se haya ' +
                'caído la infraestructura que lo movía. Lo que alcanzó a reunir quedó guardado ' +
                'abajo. Vuelve a encargarlo cuando quieras.',
              current_run_id: null,
              claimed_at: null,
              last_heartbeat_at: new Date().toISOString(),
            })
            .eq('id', candidate.id)
            .in('state', ['queued', 'working', 'blocked', 'watching'])
            .lt('last_heartbeat_at', new Date(now - ABANDON_AFTER_MS).toISOString())
            .select('id');
          if ((data ?? []).length > 0) {
            closed.push(candidate.id);
            await db
              .from('errand_questions')
              .update({ state: 'withdrawn' })
              .eq('errand_id', candidate.id)
              .eq('state', 'open');
          }
        } catch (err) {
          // One workspace's problem must not stop the sweep for the rest.
          logger.error('errand-sweep: could not close a lost errand', {
            errandId: candidate.id,
            error: (err as Error).message,
          });
        }
      }
      return closed;
    });

    const abandonedSet = new Set(abandoned);
    const toNudge = found.filter((c) => !abandonedSet.has(c.id));

    if (toNudge.length > 0) {
      await step.sendEvent(
        'nudge',
        toNudge.map((candidate) => ({
          name: EVENT_ERRAND_ADVANCE,
          data: {
            errandId: candidate.id,
            organizationId: candidate.organizationId,
            userId: candidate.userId,
            because: 'sweep',
          },
        })),
      );
    }

    if (abandoned.length > 0) {
      logger.info(
        `errand-sweep: wrote off ${abandoned.length} errand(s) past ${ERRAND_STALE_MS}ms`,
      );
    }

    return { scanned: found.length, nudged: toNudge.length, abandoned: abandoned.length };
  },
);

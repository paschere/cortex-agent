/**
 * THE ORCHESTRATOR CONTRACT: what the HTTP surface and the executor agree on.
 *
 * The POST that launches a run no longer executes it. It writes the row and
 * sends `orchestrator/run.started`; everything after that happens in
 * inngest/functions/orchestrator-run.ts, in durable steps that survive the
 * redeploy and the five-minute function ceiling that used to kill runs
 * silently.
 *
 * ── Events ────────────────────────────────────────────────────────────────
 *
 *   orchestrator/run.started    THE EXECUTOR'S INPUT. Sent once the
 *                               orchestration_runs row exists. Carries the
 *                               WORKSPACE AND THE PERSON, because a background
 *                               function has no session to ask — the same shape
 *                               schedule-dispatch uses, and the reason a run id
 *                               from another workspace simply finds nothing to
 *                               claim.
 *
 *   orchestrator/run.cancelled  Sent by the cancel endpoint AFTER it has
 *                               written `cancelled` to the row. The executor
 *                               declares `cancelOn` for it, so a run stops at
 *                               its next step boundary instead of only between
 *                               waves. The row is still the authority; the
 *                               event only makes the stop land sooner.
 *
 * Nothing here imports server-only: the route, the executor and the tests all
 * read these names from one place.
 */

/** Sent by POST /api/orchestrator; consumed by orchestrator-run. */
export const EVENT_RUN_STARTED = 'orchestrator/run.started' as const;

/** Sent by POST /api/orchestrator/[id]/cancel; cancels the running function. */
export const EVENT_RUN_CANCELLED = 'orchestrator/run.cancelled' as const;

export interface OrchestratorRunStartedEvent {
  runId: string;
  /** The workspace every database handle in the run is pinned to. */
  organizationId: string;
  /** Whose grants and tool denials the sub-agents inherit. */
  userId: string;
  objective: string;
  /** Sub-agents in flight at once. Clamped by the executor. */
  concurrency: number;
}

export interface OrchestratorRunCancelledEvent {
  runId: string;
  organizationId: string;
}

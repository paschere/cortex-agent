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
 *   orchestrator/run.cancelled  YA NO EXISTE. Era el complemento del `cancelOn`
 *                               de Inngest, y pg-boss no tiene cancelación por
 *                               evento. La fila siempre fue la autoridad: el
 *                               endpoint de cancelar escribe `cancelled` y el
 *                               executor la relee entre fases y antes de
 *                               arrancar cada sub-agente (executor.ts).
 *
 * Nothing here imports server-only: the route, the executor and the tests all
 * read these names from one place.
 */

/** Sent by POST /api/orchestrator; consumed by orchestrator-run. */
export const EVENT_RUN_STARTED = 'orchestrator/run.started' as const;

export interface OrchestratorRunStartedEvent {
  runId: string;
  /** The workspace every database handle in the run is pinned to. */
  organizationId: string;
  /** Whose grants and tool denials the sub-agents inherit. */
  userId: string;
  objective: string;
  /** Sub-agents in flight at once. Clamped by the executor. */
  concurrency: number;
  /**
   * Optional narrowing of the catalogue this run may draw from, as tool-id
   * patterns. Intersected with the agent's grants and the team deny-list, so
   * it can only ever SUBTRACT — a caller cannot use it to grant itself a tool.
   *
   * Absent for a run launched from /orchestrator, which is a person asking for
   * work with their own permissions. Present for an errand
   * (packages/agent-tools/src/errands/boundary.ts), which is unattended and may only read: the
   * allow-list it passes contains nothing that can send, buy or book, so the
   * sub-agents are never handed such a tool in the first place.
   */
  toolAllowlist?: string[];
}

export interface OrchestratorRunCancelledEvent {
  runId: string;
  organizationId: string;
}

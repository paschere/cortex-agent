/**
 * THE DEV-TASK CONTRACT.
 *
 * This file is the interface between the three halves of "Cortex does its own
 * development work":
 *
 *   intake    (this module's owner) Linear webhook → dev_tasks row → queue
 *   executor  consumes `dev/task.queued`, writes code, opens the PR
 *   oversight reads dev_tasks / dev_task_events for the UI
 *
 * The executor should import the types from here rather than re-deriving them.
 * Full prose: docs/operations/cortex-dev-tasks.md
 *
 * ── Events ────────────────────────────────────────────────────────────────
 *
 *   dev/task.intake   internal to intake. Emitted by the webhook route the
 *                     moment a delivery is claimed, so the HTTP request can
 *                     return. DO NOT consume this — the task row does not
 *                     exist yet.
 *
 *   dev/task.queued   THE EXECUTOR'S INPUT. Emitted once a dev_tasks row
 *                     exists, its repository is resolved and allowlisted, and
 *                     Linear has been told Cortex picked the issue up.
 *
 *   dev/task.status   THE EXECUTOR'S OUTPUT. Emit this for every state change;
 *                     intake persists it to dev_tasks and posts the matching
 *                     comment on the Linear issue. The executor never needs a
 *                     Linear client, and there is exactly one place that
 *                     writes task state.
 *
 * ── Rules for the executor ────────────────────────────────────────────────
 *
 *  - Do NOT write to dev_tasks directly. Emit `dev/task.status`.
 *  - `repository.allowPullRequests === false` means work the issue and report,
 *    but do not open a PR. The allowlist is the authority, not the issue text.
 *  - Terminal statuses are `done`, `failed`, `cancelled`. `needs_review` means
 *    a PR is open and a human is expected; it is NOT terminal.
 *  - A task arrives at most once per attempt. If you retry internally, bump
 *    `attempt` so the count in the UI stays honest.
 */

/** Emitted by the webhook route; consumed by dev-task-intake. Internal. */
export const EVENT_TASK_INTAKE = 'dev/task.intake' as const;
/** Emitted by dev-task-intake; consumed by the executor. */
export const EVENT_TASK_QUEUED = 'dev/task.queued' as const;
/** Emitted by the executor; consumed by dev-task-status. */
export const EVENT_TASK_STATUS = 'dev/task.status' as const;

export type DevTaskSource = 'linear';

export type DevTaskStatus = 'queued' | 'running' | 'needs_review' | 'done' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: readonly DevTaskStatus[] = ['done', 'failed', 'cancelled'];

export const DEV_TASK_STATUSES: readonly DevTaskStatus[] = [
  'queued',
  'running',
  'needs_review',
  'done',
  'failed',
  'cancelled',
];

export function isDevTaskStatus(value: unknown): value is DevTaskStatus {
  return typeof value === 'string' && (DEV_TASK_STATUSES as readonly string[]).includes(value);
}

/** The issue as it looked when the trigger fired. */
export interface DevTaskIssue {
  /** Linear's issue UUID — the executor should treat this as opaque. */
  id: string;
  /** Human identifier, e.g. "ENG-142". Good for branch names. */
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  teamKey: string | null;
  projectId: string | null;
}

export interface DevTaskRequester {
  name: string | null;
  email: string | null;
  externalId: string | null;
}

/** A repo from the allowlist. */
export interface DevTaskRepository {
  id: string;
  /**
   * The workspace that registered this repository. It is the workspace the
   * whole delivery is processed in: a Linear webhook arrives with no session,
   * so the repo it resolves to is the only thing that says whose work this is.
   */
  organizationId: string;
  key: string;
  provider: 'github';
  cloneUrl: string;
  defaultBranch: string;
  allowPullRequests: boolean;
}

/** `dev/task.intake` — internal. */
export interface DevTaskIntakeEvent {
  /** dev_task_events.id — the claim this intake belongs to. */
  deliveryId: string;
  source: DevTaskSource;
  action: string;
  /** Which trigger fired, for the acknowledgment wording and for debugging. */
  via: 'assignee' | 'label';
  issue: DevTaskIssue;
  requester: DevTaskRequester;
  /** Repo the issue named explicitly, and where it said it. */
  repoHint: { key: string; from: 'description' | 'label' } | null;
}

/** `dev/task.queued` — the executor's input. */
export interface DevTaskQueuedEvent {
  taskId: string;
  source: DevTaskSource;
  attempt: number;
  maxAttempts: number;
  repository: DevTaskRepository;
  issue: DevTaskIssue;
  requester: DevTaskRequester;
}

/** `dev/task.status` — the executor's output. */
export interface DevTaskStatusEvent {
  taskId: string;
  status: DevTaskStatus;
  /** Branch the work landed on. Persisted the first time it is seen. */
  branchName?: string;
  prUrl?: string;
  /** One short paragraph for the human, in English. Posted to Linear. */
  summary?: string;
  /** Present when status is `failed`. Posted to Linear. */
  error?: string;
  attempt?: number;
}

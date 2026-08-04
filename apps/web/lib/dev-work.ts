/**
 * Cortex's autonomous development runs — the shape the oversight layer reads.
 *
 * ── ASSUMED SCHEMA ────────────────────────────────────────────────────────
 * When this was written, `dev_tasks` and `dev_repositories` did not exist in
 * infra/supabase/migrations/ yet. The Linear-intake agent owns those tables;
 * the execution agent owns everything that writes to a row while a run is in
 * flight. Nothing here creates or migrates them — this file is written against
 * the shape described in the brief:
 *
 *   dev_tasks
 *     id                  uuid pk
 *     title               text        what was asked, one line
 *     request             text        the fuller ask (issue body), nullable
 *     linear_issue_key    text        "ZIP-482"
 *     linear_issue_url    text
 *     repository_id       uuid  -> dev_repositories(id)
 *     requested_by        uuid  -> users(id), nullable (Linear user may not map)
 *     requested_by_name   text        fallback display name
 *     status              text        queued | running | needs_review | done
 *                                     | failed | cancelled
 *     branch              text
 *     pr_url              text
 *     pr_number           int
 *     summary             text        plain-language "what changed" (markdown)
 *     failure_reason      text        ONE SENTENCE, human, no stack trace
 *     error_detail        text        the technical detail, shown secondary
 *     checks              jsonb       [{ name, status, url }]
 *     cost_usd            numeric     nullable — only if the executor records it
 *     created_at / started_at / finished_at   timestamptz
 *     cancel_requested_at timestamptz  ← the stop signal (see below)
 *     cancel_requested_by uuid -> users(id)
 *     notified_state      text         ← notification de-dupe claim
 *
 *   dev_repositories
 *     id, name, full_name, description, default_branch,
 *     enabled boolean, created_at, added_by uuid -> users(id)
 *
 * Column names live in `DEV_TASK_COLUMNS` / `DEV_REPO_COLUMNS` and the two
 * mappers below — nothing else in the oversight layer spells a column name, so
 * reconciling with the real migration is a one-file edit.
 *
 * Every read is defensive: a missing table surfaces as a "not set up yet"
 * notice, never a crashed page.
 *
 * ── THE STOP CONTRACT ─────────────────────────────────────────────────────
 * Cancellation is a durable flag on the row, not a signal on a wire: the human
 * pressing Stop and the sandbox honouring it are minutes and one process
 * apart. A queued run is cancelled outright (nothing is running to interrupt).
 * A running one gets `cancel_requested_at` + `cancel_requested_by` set, and the
 * executor is expected to check that between steps and finish the row as
 * `cancelled`. Status is deliberately NOT rewritten for a running task: the
 * executor owns the lifecycle column while it holds the run.
 *
 * Pure module — no `server-only`, no I/O. Client components import it too.
 */

import { type StatusTone, chipClass } from './status-chip';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type DevTaskStatus = 'queued' | 'running' | 'needs_review' | 'done' | 'failed' | 'cancelled';

const KNOWN_STATUSES = new Set<string>([
  'queued',
  'running',
  'needs_review',
  'done',
  'failed',
  'cancelled',
]);

export type DevTaskTone = StatusTone;

/** The shared status shape, so a dev run is stamped like every other run. */
export const DEV_TONE_CHIP: Record<DevTaskTone, string> = {
  neutral: chipClass('neutral'),
  primary: chipClass('primary'),
  amber: chipClass('amber'),
  emerald: chipClass('emerald'),
  rose: chipClass('rose'),
};

export interface DevTaskStatusMeta {
  /** Pill text. Plain English — a recruiter should read it without a glossary. */
  label: string;
  /** One sentence saying what is true right now. */
  blurb: string;
  tone: DevTaskTone;
  chip: string;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface DevTaskCheck {
  name: string;
  status: 'passed' | 'failed' | 'pending' | 'skipped';
  url?: string | null;
}

export interface DevTask {
  id: string;
  title: string;
  request: string | null;
  issueKey: string | null;
  issueUrl: string | null;
  repositoryId: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  status: DevTaskStatus;
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  summary: string | null;
  failureReason: string | null;
  errorDetail: string | null;
  checks: DevTaskCheck[];
  costUsd: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
}

export interface DevRepository {
  id: string;
  name: string;
  fullName: string | null;
  description: string | null;
  defaultBranch: string | null;
  enabled: boolean;
  createdAt: string | null;
  addedBy: string | null;
}

export const DEV_TASK_COLUMNS = [
  'id',
  'title',
  'request',
  'linear_issue_key',
  'linear_issue_url',
  'repository_id',
  'requested_by',
  'requested_by_name',
  'status',
  'branch',
  'pr_url',
  'pr_number',
  'summary',
  'failure_reason',
  'error_detail',
  'checks',
  'cost_usd',
  'created_at',
  'started_at',
  'finished_at',
  'cancel_requested_at',
  'cancel_requested_by',
].join(', ');

export const DEV_REPO_COLUMNS =
  'id, name, full_name, description, default_branch, enabled, created_at, added_by';

function str(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Check lists arrive as free-form jsonb; keep only entries we can render. */
function parseChecks(value: unknown): DevTaskCheck[] {
  if (!Array.isArray(value)) return [];
  const out: DevTaskCheck[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = str(row.name) ?? str(row.check) ?? str(row.id);
    if (!name) continue;
    const raw = (str(row.status) ?? str(row.conclusion) ?? 'pending').toLowerCase();
    const status: DevTaskCheck['status'] =
      raw === 'passed' || raw === 'pass' || raw === 'success' || raw === 'ok'
        ? 'passed'
        : raw === 'failed' || raw === 'failure' || raw === 'error'
          ? 'failed'
          : raw === 'skipped' || raw === 'neutral'
            ? 'skipped'
            : 'pending';
    out.push({ name, status, url: str(row.url) });
  }
  return out;
}

export function toDevTask(row: Record<string, unknown>): DevTask {
  const rawStatus = (str(row.status) ?? 'queued').toLowerCase();
  return {
    id: String(row.id),
    title: str(row.title) ?? 'Untitled request',
    request: str(row.request),
    issueKey: str(row.linear_issue_key),
    issueUrl: str(row.linear_issue_url),
    repositoryId: str(row.repository_id),
    requestedBy: str(row.requested_by),
    requestedByName: str(row.requested_by_name),
    // An unrecognised status is treated as in-flight rather than silently
    // dropped: the worst outcome here is showing something as live that isn't,
    // and that is far safer than hiding a run from the person watching.
    status: (KNOWN_STATUSES.has(rawStatus) ? rawStatus : 'running') as DevTaskStatus,
    branch: str(row.branch),
    prUrl: str(row.pr_url),
    prNumber: num(row.pr_number),
    summary: str(row.summary),
    failureReason: str(row.failure_reason),
    errorDetail: str(row.error_detail),
    checks: parseChecks(row.checks),
    costUsd: num(row.cost_usd),
    createdAt: str(row.created_at) ?? new Date(0).toISOString(),
    startedAt: str(row.started_at),
    finishedAt: str(row.finished_at),
    cancelRequestedAt: str(row.cancel_requested_at),
    cancelRequestedBy: str(row.cancel_requested_by),
  };
}

export function toDevRepository(row: Record<string, unknown>): DevRepository {
  return {
    id: String(row.id),
    name: str(row.name) ?? str(row.full_name) ?? 'Unnamed repository',
    fullName: str(row.full_name),
    description: str(row.description),
    defaultBranch: str(row.default_branch),
    enabled: row.enabled !== false,
    createdAt: str(row.created_at),
    addedBy: str(row.added_by),
  };
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/** A run a person can still pull the brake on. */
export function isStoppable(task: Pick<DevTask, 'status'>): boolean {
  return task.status === 'queued' || task.status === 'running';
}

/** Somebody pressed Stop and the run has not finished yet. */
export function isStopping(task: Pick<DevTask, 'status' | 'cancelRequestedAt'>): boolean {
  return Boolean(task.cancelRequestedAt) && isStoppable(task);
}

/** In-flight: counts toward "Cortex is busy", excluded from history totals. */
export function isLive(task: Pick<DevTask, 'status'>): boolean {
  return task.status === 'queued' || task.status === 'running';
}

/**
 * A stop that the executor has not acted on after this long is worth saying out
 * loud — silence is exactly what the person pressing the button is afraid of.
 */
export const STOP_GRACE_MS = 5 * 60_000;

export function stopIsOverdue(
  task: Pick<DevTask, 'status' | 'cancelRequestedAt'>,
  now = Date.now(),
): boolean {
  if (!isStopping(task)) return false;
  const asked = new Date(task.cancelRequestedAt as string).getTime();
  return Number.isFinite(asked) && now - asked > STOP_GRACE_MS;
}

export function describeStatus(
  task: Pick<DevTask, 'status' | 'cancelRequestedAt'>,
): DevTaskStatusMeta {
  if (isStopping(task)) {
    return {
      label: 'Deteniendo',
      blurb: 'Alguien le pidió a Cortex que se detenga. Termina el paso en el que va y para.',
      tone: 'rose',
      chip: DEV_TONE_CHIP.rose,
    };
  }
  const meta: Record<DevTaskStatus, Omit<DevTaskStatusMeta, 'chip'>> = {
    queued: {
      label: 'En cola',
      blurb: 'Esperando su turno. Todavía no se ha tocado nada.',
      tone: 'neutral',
    },
    running: {
      label: 'Trabajando',
      blurb: 'Cortex está en esto ahora mismo: leyendo el código y haciendo cambios.',
      tone: 'primary',
    },
    needs_review: {
      label: 'Te espera',
      blurb: 'Cortex hizo su parte y no sigue hasta que una persona revise.',
      tone: 'amber',
    },
    done: {
      label: 'Listo',
      blurb: 'Terminado y entregado.',
      tone: 'emerald',
    },
    failed: {
      label: 'Falló',
      blurb: 'Cortex no pudo terminar este trabajo.',
      tone: 'rose',
    },
    cancelled: {
      label: 'Detenido',
      blurb: 'Una persona lo detuvo antes de que terminara.',
      tone: 'neutral',
    },
  };
  const base = meta[task.status];
  return { ...base, chip: DEV_TONE_CHIP[base.tone] };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** How long the run took, or has been going. Null when it never started. */
export function taskElapsedMs(
  task: Pick<DevTask, 'startedAt' | 'finishedAt'>,
  now = Date.now(),
): number | null {
  if (!task.startedAt) return null;
  const start = new Date(task.startedAt).getTime();
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  const ms = end - start;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** "40s", "6m 12s", "1h 4m" — never milliseconds, nobody counts those. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${Math.max(secs, 1)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return secs % 60 > 0 ? `${mins}m ${secs % 60}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return mins % 60 > 0 ? `${hours}h ${mins % 60}m` : `${hours}h`;
}

/** Money only when the executor actually recorded it — never a fake $0.00. */
export function formatCost(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd === 0) return '$0';
  return usd < 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 100 ? 2 : 0)}`;
}

/** "owner/repository" if we have it, otherwise the bare name. */
export function repoLabel(repo: DevRepository | undefined | null): string | null {
  if (!repo) return null;
  return repo.fullName ?? repo.name;
}

/**
 * True when a Supabase error means "these tables don't exist yet" rather than
 * "something broke". Lets the page invite the person to wait instead of
 * showing them a database error they can do nothing about.
 */
export function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST200') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('schema cache');
}

import { createHash } from 'node:crypto';

/**
 * What counts as "Cortex, take this one".
 *
 * Linear fires a webhook for every keystroke-level change on an issue. Almost
 * all of it is noise, and the cost of a false positive here is not a wasted
 * request — it is an autonomous agent cloning a repository and opening a pull
 * request nobody asked for. So the trigger is deliberately narrow and, for
 * updates, EDGE-TRIGGERED: the assignment (or label) must have just changed in
 * this very event. An issue that has been assigned to Cortex for a week does not
 * re-fire every time somebody edits its description.
 *
 * Which signal fires it is configurable — `LINEAR_TRIGGER_MODE`:
 *
 *   assignee  (default)  the issue is assigned to Cortex's own Linear account
 *   label                the issue carries `LINEAR_TRIGGER_LABEL` (default "cortex")
 *   either               whichever happens first
 *
 * The default is `assignee`, and that is the recommended setting. Assignment is
 * a single-owner, deliberate act with a person's name on it, it is what the
 * rest of the company already means by "this is yours", and Linear shows it in
 * the issue header where a human cannot miss it. Labels get sprayed on in bulk,
 * applied by Linear automations and templates, and copied when an issue is
 * duplicated — every one of those is a way to start unattended work by
 * accident. Label mode exists for teams that want Cortex to work an issue that
 * stays assigned to a human, which is a real workflow, just not the safe
 * default.
 */

export type TriggerMode = 'assignee' | 'label' | 'either';

export interface TriggerConfig {
  mode: TriggerMode;
  /** Linear user UUID of Cortex's own account. */
  cortexUserId: string | null;
  /** Fallback identity check when only the email is known. */
  cortexUserEmail: string | null;
  /** Lowercased label name that fires the trigger in label/either mode. */
  label: string;
}

export const DEFAULT_TRIGGER_LABEL = 'cortex';

export function triggerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TriggerConfig {
  const raw = (env.LINEAR_TRIGGER_MODE ?? 'assignee').trim().toLowerCase();
  const mode: TriggerMode = raw === 'label' || raw === 'either' ? raw : 'assignee';
  return {
    mode,
    cortexUserId: env.LINEAR_CORTEX_USER_ID?.trim() || null,
    cortexUserEmail: env.LINEAR_CORTEX_USER_EMAIL?.trim().toLowerCase() || null,
    label: (env.LINEAR_TRIGGER_LABEL ?? DEFAULT_TRIGGER_LABEL).trim().toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface LinearActor {
  id?: string;
  name?: string;
  email?: string;
}

export interface LinearIssueData {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  assigneeId?: string | null;
  assignee?: LinearActor | null;
  creatorId?: string | null;
  creator?: LinearActor | null;
  labelIds?: string[];
  labels?: Array<{ id?: string; name?: string }>;
  teamId?: string;
  team?: { id?: string; key?: string; name?: string };
  projectId?: string | null;
  project?: { id?: string; name?: string } | null;
  state?: { id?: string; name?: string; type?: string };
}

export interface LinearWebhookBody {
  action?: string;
  type?: string;
  createdAt?: string;
  webhookTimestamp?: number;
  webhookId?: string;
  organizationId?: string;
  url?: string;
  data?: LinearIssueData;
  /** Present on updates: the previous values of the fields that changed. */
  updatedFrom?: Record<string, unknown>;
  /** Present on some payloads: who performed the action. */
  actor?: LinearActor;
}

/**
 * Idempotency key for one delivery.
 *
 * A digest of the exact bytes Linear sent. Retries resend the byte-identical
 * body — same key, and the unique constraint on `dev_task_events` rejects the
 * second one. Two genuinely different events on the same issue differ in at
 * least `webhookTimestamp`, so they get different keys and are judged on their
 * own merits (and then caught by the one-open-task-per-issue index if a run is
 * already live).
 */
export function linearEventKey(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

export type TriggerDecision =
  | { accepted: true; via: 'assignee' | 'label' }
  | { accepted: false; reason: string };

/** Linear state types that mean the issue is over; never pick those up. */
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled', 'cancelled']);

function labelNames(data: LinearIssueData): string[] {
  return (data.labels ?? [])
    .map((l) => l.name?.trim().toLowerCase())
    .filter((n): n is string => Boolean(n));
}

function assigneeMatches(data: LinearIssueData, config: TriggerConfig): boolean {
  if (config.cortexUserId) {
    const id = data.assigneeId ?? data.assignee?.id ?? null;
    if (id && id === config.cortexUserId) return true;
  }
  if (config.cortexUserEmail) {
    const email = data.assignee?.email?.trim().toLowerCase();
    if (email && email === config.cortexUserEmail) return true;
  }
  return false;
}

function labelMatches(data: LinearIssueData, config: TriggerConfig): boolean {
  return labelNames(data).includes(config.label);
}

/**
 * On an update, `updatedFrom` names the fields that changed. Requiring the
 * trigger field to appear there is what makes this edge-triggered rather than
 * level-triggered — without it, every later edit to an assigned issue would
 * look like a fresh pickup.
 */
function changedInThisEvent(body: LinearWebhookBody, field: string): boolean {
  if (body.action === 'create') return true;
  const from = body.updatedFrom;
  return Boolean(from && Object.hasOwn(from, field));
}

export function evaluateTrigger(body: LinearWebhookBody, config: TriggerConfig): TriggerDecision {
  if (body.type !== 'Issue')
    return { accepted: false, reason: `not an issue (${body.type ?? '?'})` };
  if (body.action !== 'create' && body.action !== 'update') {
    return { accepted: false, reason: `action ${body.action ?? '?'} is not actionable` };
  }

  const data = body.data;
  if (!data?.id) return { accepted: false, reason: 'payload has no issue id' };

  const stateType = data.state?.type?.toLowerCase();
  if (stateType && CLOSED_STATE_TYPES.has(stateType)) {
    return { accepted: false, reason: `issue is ${stateType}` };
  }

  const wantsAssignee = config.mode === 'assignee' || config.mode === 'either';
  const wantsLabel = config.mode === 'label' || config.mode === 'either';

  if (
    wantsAssignee &&
    !config.cortexUserId &&
    !config.cortexUserEmail &&
    config.mode === 'assignee'
  ) {
    // Refusing to fire beats guessing. With no configured identity, "assigned to
    // Cortex" has no meaning and every assignment would look like a match.
    return { accepted: false, reason: 'assignee trigger is not configured' };
  }

  if (wantsAssignee && assigneeMatches(data, config) && changedInThisEvent(body, 'assigneeId')) {
    return { accepted: true, via: 'assignee' };
  }
  if (wantsLabel && labelMatches(data, config) && changedInThisEvent(body, 'labelIds')) {
    return { accepted: true, via: 'label' };
  }

  return { accepted: false, reason: `no ${config.mode} trigger in this event` };
}

// ---------------------------------------------------------------------------
// Repository hints carried by the issue
// ---------------------------------------------------------------------------

/**
 * A `Repo:` line in the issue description — the highest-precedence way to say
 * which codebase an issue belongs to, because a human typed it on purpose.
 *
 * Accepts the shapes people actually write in Linear: `Repo: payroll`,
 * `**Repo:** payroll`, `- repo = payroll`, `Repository: cortex-agent`. Only the
 * FIRST match counts; a second line disagreeing with the first is ambiguity,
 * and ambiguity is resolved by asking, not by picking.
 */
const REPO_DIRECTIVE_RE =
  /^[\s>*_-]*(?:repo|repository)\s*\**\s*[:=]\s*\**\s*([a-z0-9._/-]+)\s*\**\s*$/i;

export function parseRepoDirective(description: string | null | undefined): string | null {
  if (!description) return null;
  for (const line of description.split(/\r?\n/)) {
    const m = REPO_DIRECTIVE_RE.exec(line.trim());
    if (m?.[1]) {
      // `owner/name` is accepted for readability; the allowlist is keyed on the
      // repo name alone.
      const value = m[1].toLowerCase();
      const key = value.includes('/') ? (value.split('/').pop() ?? value) : value;
      return key.replace(/\.git$/, '') || null;
    }
  }
  return null;
}

/** A `repo:<key>` Linear label — the same instruction, expressed as a label. */
export function parseRepoLabel(data: LinearIssueData): string | null {
  for (const name of labelNames(data)) {
    if (name.startsWith('repo:')) {
      const key = name.slice('repo:'.length).trim();
      if (key) return key;
    }
  }
  return null;
}

# Cortex picks up its own development work

Someone assigns a Linear issue to Cortex; Cortex takes it, does the work, and
opens a pull request — in this repo or another one.

This note covers the **intake half**: how a Linear issue becomes a tracked,
queued unit of work, and the contract the executor consumes. It does not cover
how the code gets written.

---

## The path an issue takes

```
Linear issue assigned to Cortex
        │  HMAC-signed webhook
        ▼
POST /api/webhooks/linear         verify → replay check → trigger → claim → enqueue
        │  dev/task.intake        (returns 202 in a few ms; no real work here)
        ▼
inngest: dev-task-intake          resolve repo → INSERT dev_tasks → comment on Linear
        │  dev/task.queued        ← THE EXECUTOR'S INPUT
        ▼
   ( executor )                   clone, work, open PR
        │  dev/task.status        ← THE EXECUTOR'S OUTPUT
        ▼
inngest: dev-task-status          UPDATE dev_tasks → comment on Linear
```

Source of truth for the types: `apps/web/lib/dev-tasks/contract.ts`.

---

## Schema (migration `0046_dev_tasks.sql`)

### `dev_repositories` — the allowlist

Cortex can only work in a repo somebody registered here. There is no "any repo
whose name I recognise" path.

| column                                   | meaning                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `key`                                    | short handle used everywhere a human names a repo (`payroll`). Lowercase.                                             |
| `clone_url`, `default_branch`            | what the executor needs to start                                                                                      |
| `allow_pull_requests`                    | a **second, separate grant**. Registering a repo lets Cortex work in it; this decides whether it may open a PR there. |
| `is_active`                              | soft off-switch                                                                                                       |
| `linear_team_keys`, `linear_project_ids` | team/project → repo mapping (see below). Ship empty.                                                                  |

Seeded with `cortex-agent`, `matcher` and `payroll`. Adding a fourth is
one `INSERT`; nothing in the code knows those three names.

### `dev_tasks` — one unit of work

`source`, `external_id` / `external_identifier` / `external_url`, `title`,
`description`, `repository_id` + `repository_key`, `requester_*`, `status`,
`attempt_count` / `max_attempts`, and the executor's write-back fields
`branch_name`, `pr_url`, `summary`, `error`. `trigger_context` (jsonb) snapshots
what the pickup decision was made on.

Status: `queued → running → needs_review → done`, or `failed` / `cancelled`.
`needs_review` means a PR is open and a human is expected — it is **not**
terminal.

### `dev_task_events` — the delivery ledger

One row per inbound delivery we acted on, with `unique (source, event_key)`.
This is where retry-idempotency is enforced. Outcome is `accepted`, `ignored`
(a task was already open) or `rejected` (no repository).

---

## The trigger

**Configured by `LINEAR_TRIGGER_MODE`:**

| mode                   | fires when                                                                       |
| ---------------------- | -------------------------------------------------------------------------------- |
| `assignee` _(default)_ | the issue is assigned to `LINEAR_CORTEX_USER_ID` (or `LINEAR_CORTEX_USER_EMAIL`) |
| `label`                | the issue carries `LINEAR_TRIGGER_LABEL` (default `cortex`)                      |
| `either`               | whichever happens first                                                          |

**We chose `assignee` as the default.** Assignment is a single-owner, deliberate
act with a person's name on it; it is what the company already means by "this is
yours", and Linear shows it in the issue header where nobody can miss it. Labels
get sprayed on in bulk, applied by Linear automations and issue templates, and
copied when an issue is duplicated — every one of those is a way to start
unattended work by accident. `label` mode exists for teams that want Cortex to
work an issue that stays assigned to a human; that is a real workflow, just not
the safe default.

Three further guards, all in `apps/web/app/api/webhooks/linear/trigger.ts`:

- **Edge-triggered, not level-triggered.** On an `update`, the trigger field must
  appear in Linear's `updatedFrom` — i.e. the assignment (or label) changed _in
  this event_. Otherwise every later edit to an assigned issue would look like a
  fresh pickup.
- **Closed issues are ignored** (`state.type` of `completed` / `canceled`).
- **An unconfigured trigger never fires.** With no Cortex identity set, "assigned
  to Cortex" has no meaning, so nothing is accepted.

If you set `LINEAR_CORTEX_USER_ID`, get it from `linear.list_users` or the API —
it is the Linear user UUID, not the display name.

---

## Which repository?

An issue does not say. Guessing is the one failure mode with no cheap recovery,
so the rule is deterministic and **refuses rather than guesses**. Precedence,
highest first (`apps/web/lib/dev-tasks/repository-rule.ts`):

1. `Repo: <key>` on its own line in the issue description. Also accepted:
   `**Repo:** payroll`, `- repo = payroll`, `Repository: cortex-agent`,
   `Repo: your-org/payroll`. First match wins.
2. A `repo:<key>` Linear label.
3. The issue's Linear **project**, if a repo lists that project id in
   `linear_project_ids`.
4. The issue's Linear **team key**, via `linear_team_keys`.
5. Otherwise → **rejected**, with a comment on the issue asking the human to say
   which repo and listing the ones Cortex is allowed to work in.

A key that is not on the allowlist is a rejection, not a fall-through to a lower
tier. A team mapped to two repos is a rejection too — ambiguity is a
configuration bug and picking one hides it.

To wire a team up:

```sql
update public.dev_repositories
   set linear_team_keys = array['ENG']
 where key = 'cortex-agent';
```

---

## Idempotency and replay

Four independent defences, three of them in the database:

1. **Signature.** HMAC-SHA256 over the raw body against `LINEAR_WEBHOOK_SECRET`,
   compared in constant time, checked before the body is parsed. No secret
   configured → everything is rejected, in every environment (there is no
   local-dev bypass; this endpoint starts unattended code execution).
2. **Replay window.** The signed `webhookTimestamp` must be within 60s (±60s of
   skew). Checked _after_ the signature, so it cannot be rewritten.
3. **Delivery claim.** `dev_task_events` has `unique (source, event_key)` where
   `event_key` is a SHA-256 of the exact bytes Linear sent. Every delivery
   INSERTs its claim first — the check _is_ the insert, because a
   read-then-insert still double-fires under concurrent retries. The loser gets
   `23505` and is answered `200` with no work done. If the enqueue afterwards
   fails, the claim is **released** so Linear's retry can succeed instead of
   being swallowed.
4. **One open task per issue.** Partial unique index
   `dev_tasks_one_open_per_issue` on `(source, external_id)` where status is
   `queued`/`running`/`needs_review`. Un-assign-and-reassign, or relabel
   mid-run, cannot start a second agent on the same branch. Terminal rows are
   excluded, so an issue _can_ legitimately be picked up again after a failed or
   cancelled attempt.

Tests: `apps/web/app/api/webhooks/linear/verify.test.ts` and
`apps/web/lib/dev-tasks/claim.test.ts` (which also asserts both constraints are
still in migration 0046 — the code rule is only as good as the schema behind
it).

---

## The Inngest contract

### `dev/task.queued` — what the executor consumes

```ts
interface DevTaskQueuedEvent {
  taskId: string; // dev_tasks.id
  source: "linear";
  attempt: number;
  maxAttempts: number;
  repository: {
    id: string;
    key: string; // 'payroll'
    provider: "github";
    cloneUrl: string;
    defaultBranch: string;
    allowPullRequests: boolean;
  };
  issue: {
    id: string; // Linear issue UUID, opaque
    identifier: string; // 'ENG-142' — good for branch names
    title: string;
    description: string | null;
    url: string | null;
    teamKey: string | null;
    projectId: string | null;
  };
  requester: {
    name: string | null;
    email: string | null;
    externalId: string | null;
  };
}
```

Emitted only once a `dev_tasks` row exists, the repository is resolved and
allowlisted, and Linear has been told Cortex picked the issue up.

### `dev/task.status` — what the executor emits

```ts
interface DevTaskStatusEvent {
  taskId: string;
  status: "running" | "needs_review" | "done" | "failed" | "cancelled";
  branchName?: string;
  prUrl?: string;
  summary?: string; // one short paragraph, English — posted to Linear
  error?: string; // when status is 'failed' — posted to Linear
  attempt?: number;
}
```

`dev-task-status` persists it and posts the matching comment on the issue.

### Rules for the executor

- **Do not write to `dev_tasks` directly.** Emit `dev/task.status`. One writer,
  one place that decides what the human sees.
- **Do not talk to Linear.** You need no Linear credentials; the comment is our
  side of the contract.
- `repository.allowPullRequests === false` → do the work, report back, **do not
  open a PR**. The allowlist is the authority, not the issue text.
- Late reports against a task that is already terminal are dropped, so a
  cancelled task stays cancelled.

`dev/task.intake` also exists. It is **internal to intake** — emitted by the
webhook route before the task row exists. Do not consume it.

---

## Setup

1. Run migration `0046`.
2. In Linear: Settings → API → Webhooks → new webhook at
   `<APP_BASE_URL>/api/webhooks/linear`, subscribed to **Issues**. Copy the
   signing secret.
3. Set `LINEAR_WEBHOOK_SECRET`, `LINEAR_CORTEX_USER_ID` (and optionally
   `LINEAR_TRIGGER_MODE`, `LINEAR_TRIGGER_LABEL`, `CORTEX_LINEAR_ACTOR_EMAIL`).
4. Make sure at least one Cortex account has connected Linear — that is whose
   token the acknowledgement comments are posted with. Name it explicitly with
   `CORTEX_LINEAR_ACTOR_EMAIL`; otherwise the oldest connection is used and the
   audit trail attributes the comments to whoever that is.
5. Map teams to repos if you want tier-3/4 resolution, or tell people to write
   `Repo:` in the description.

`/api/webhooks` is in `middleware.ts`'s `PUBLIC_PATHS` — Linear has no session
cookie, and the route authenticates itself.

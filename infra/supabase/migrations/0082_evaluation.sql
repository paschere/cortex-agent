-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- In one day this deployment changed the conversational model, the embedding
-- engine and the relevance thresholds -- three changes that touch the quality
-- of every answer -- and verified all three by checking that the code compiled.
-- A miscalibrated floor then discarded the only document that answered the
-- question, and it was found by the product owner with a screenshot.
--
-- The evaluation itself is code and fixtures, not rows: it runs offline, in
-- `pnpm test`, against cosines committed to the repository, and it passes or
-- fails like any other test. What code cannot answer is the other question --
-- has this number been sliding for a month, and what changed on the day it
-- started -- because a test run only ever knows about today. These two tables
-- are that history, and they are what the /evaluation screen draws.
--
-- ---------------------------------------------------------------------------
-- WHY TWO TABLES AND NOT ONE JSONB COLUMN
-- ---------------------------------------------------------------------------
-- A run is a handful of ratios plus the identity that makes it comparable; the
-- per-case detail is thirty-odd rows saying which question failed and why. The
-- list screen reads only the first. Folding the second into a jsonb column on
-- the run would have worked and would have turned "which cases have been
-- failing all month" into a full scan of documents.
--
-- `evaluation_case_results` carries NO organization_id. It inherits its tenant
-- from `run_id`, the same shape `kb_chunks` has under `kb_documents`, and
-- `createOrgScopedClient` refuses any read of it that does not constrain the
-- run. A second copy of the workspace id on a child row is a second thing that
-- can disagree with the first.
--
-- ---------------------------------------------------------------------------
-- WHY THE COMPARABILITY FIELDS ARE COLUMNS AND NOT BURIED IN JSON
-- ---------------------------------------------------------------------------
-- `suite_digest`, `embedding_model`, `strong_match` and `weak_floor` decide
-- whether two rows may be subtracted from each other at all. Two runs with
-- different digests answered different questions, and the difference of their
-- scores is not a smaller improvement, it is not a number. Those fields are
-- columns because the screen filters and groups by them; the score bundles
-- stay jsonb because nothing queries inside them and their shape is owned by
-- `evaluation/types.ts`, which will grow a metric before this table changes.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT STORED
-- ---------------------------------------------------------------------------
-- The corpus and the questions. They live in git, where a diff shows who
-- changed them; `suite_digest` is how a row points at a version of them. A copy
-- here would be a second source of truth that drifts silently and makes the
-- digest a lie.
--
-- No per-fragment cosines either. Those are in the committed measurement, one
-- file per embedding model, readable by a person. A row that duplicated them
-- would be large, would go stale the moment the model changed, and would tempt
-- somebody to grade against the database instead of against the fixture.

-- ===========================================================================
-- 1. One run
-- ===========================================================================

create table if not exists public.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,

  started_at timestamptz not null default now(),

  -- Which tier ran. `offline` replays the committed measurement and costs
  -- nothing; `live` re-embeds against the provider; `answers` also generates
  -- and judges. Text plus a check rather than an enum: adding a value to an
  -- enum and using it in the same transaction is one of the ways a migration
  -- passes typecheck, tests and build and then fails on the way into production.
  tier text not null check (tier in ('offline', 'live', 'answers')),

  suite_id text not null,
  -- Hash over the corpus bytes, every question, its group and its gold
  -- documents. Two rows whose digests differ did not take the same test.
  suite_digest text not null,

  -- The configuration under test. Every one of these is a thing somebody
  -- changes on a Tuesday afternoon, and the point of the row is to say which
  -- one moved on the day the number did.
  embedding_model text not null,
  strong_match numeric(5, 4) not null,
  weak_floor numeric(5, 4) not null,
  -- False when nobody has run the corpus against this embedding model, so the
  -- whole run was graded against provisional cuts. See kb/relevance.ts.
  calibration_measured boolean not null default false,
  chat_model text,
  judge_model text,
  answer_prompt_digest text,
  judge_prompt_digest text,

  -- "medición del 2026-08-07" or "API en vivo, 2026-08-07". Prose because the
  -- only consumer is a person deciding whether to believe the row.
  vector_source text not null,

  -- The score bundles, shaped by evaluation/store.ts. Two numbers each, never
  -- one: `grounding` over the questions the corpus answers and `restraint` over
  -- the ones it does not. A system that answers everything scores 1.00 and 0.00,
  -- and an average would put it level with an honest mediocre one.
  retrieval jsonb not null,
  selection jsonb not null,
  -- Null unless the `answers` tier ran. Carries the judge's own calibration
  -- alongside the scores, because a score from an untrusted judge must never be
  -- readable without the fact that it is untrusted.
  answers jsonb,

  cost_usd numeric(10, 4) not null default 0,
  elapsed_ms integer not null default 0,

  -- Everything a reader has to know before believing the numbers above: a stale
  -- fixture, a drifted tool description, unmeasured thresholds, a judge that
  -- failed its probes.
  warnings jsonb not null default '[]'::jsonb
);

comment on table public.evaluation_runs is
  'One run of the answer-quality suite: the headline scores plus everything that decides whether this row may be compared with another one. The suite itself -- the corpus and the questions -- lives in git, and `suite_digest` is how a row names the version it took. Rows whose digests differ answered different questions and their scores must never be subtracted from each other.';

comment on column public.evaluation_runs.suite_digest is
  'sha256 over the corpus bytes, every question, its group and its gold documents, truncated to 16 hex characters. The comparability key: a mismatch means somebody edited the suite between two runs, and the delta would be measuring their edit rather than the change under test.';

comment on column public.evaluation_runs.calibration_measured is
  'False when the relevance thresholds in force during this run were never measured against the embedding model that produced its scores. Every number in the row is then provisional, and the screen says so rather than printing it plain.';

comment on column public.evaluation_runs.answers is
  'Null unless the answers tier ran. Holds grounding, restraint AND the judge''s own calibration -- leniency, severity, trusted -- because a judge that waved a deliberately wrong answer through has produced a number that means nothing, and the number must not be readable apart from that fact.';

-- The list screen: this workspace's runs, newest first.
create index if not exists evaluation_runs_org_idx
  on public.evaluation_runs (organization_id, started_at desc);

-- "How has this configuration moved" -- the trend for one suite version on one
-- embedding model, which is the only trend that means anything.
create index if not exists evaluation_runs_comparable_idx
  on public.evaluation_runs (organization_id, suite_digest, embedding_model, started_at desc);

-- ===========================================================================
-- 2. Which question failed, and why
-- ===========================================================================

create table if not exists public.evaluation_case_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.evaluation_runs (id) on delete cascade,

  layer text not null check (layer in ('retrieval', 'selection', 'answer')),
  case_id text not null,
  -- 'answered' | 'absent' | 'unrelated' for graded questions, 'tool' for the
  -- selection-only cases. Not a check constraint: the suite is expected to grow
  -- a group before this table is willing to change, and a schema that has to be
  -- migrated to add a question is a schema that stops questions being added.
  case_group text not null,
  query text not null,
  passed boolean not null,

  -- Per layer: ranks and cosines for retrieval, the family and its score for
  -- selection, the answer text with every literal and rubric check for answers.
  detail jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

comment on table public.evaluation_case_results is
  'One question, one layer, one run. No organization_id: the tenant is inherited from `run_id`, so every read must constrain the run -- which createOrgScopedClient enforces, and which is the same shape kb_chunks has under kb_documents. Registered as `derived` in tenancy/tables.ts.';

comment on column public.evaluation_case_results.detail is
  'Whatever makes the pass or fail diagnosable without re-running: the rank and cosine of the correct document, whether it was retrieved and then discarded by the floor, which tool family failed to reach the model, or the answer text with each check beside it.';

-- Every read is "this run, in order". The run id leads because the table is
-- derived and no read is allowed without it.
create index if not exists evaluation_case_results_run_idx
  on public.evaluation_case_results (run_id, layer, case_id);

-- "Which question has been failing all month", across runs. Partial on failures
-- because the passing rows are the overwhelming majority and nobody looks them
-- up by case.
create index if not exists evaluation_case_results_failures_idx
  on public.evaluation_case_results (case_id, created_at desc)
  where passed = false;

-- ===========================================================================
-- 3. Access
-- ===========================================================================
-- Deny-all plus service_role, matching 0077 and 0079. The tenant boundary is
-- createOrgScopedClient, not a policy keyed off auth.uid(); see the 0064 header
-- for why an auth.uid() policy would be theatre in this schema.
--
-- No update verb on either table. A run is a measurement taken at a moment: if
-- it was wrong, the answer is another run, not an edit. Delete exists only so a
-- workspace can be removed.

alter table public.evaluation_runs enable row level security;
revoke all on table public.evaluation_runs from public, anon, authenticated;
grant select, insert, delete on table public.evaluation_runs to service_role;

alter table public.evaluation_case_results enable row level security;
revoke all on table public.evaluation_case_results from public, anon, authenticated;
grant select, insert, delete on table public.evaluation_case_results to service_role;

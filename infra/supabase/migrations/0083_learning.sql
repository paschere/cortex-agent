-- Using Cortex makes it better: the loop that closes on a bad answer.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- Today a bad answer is corrected in somebody's head and nowhere else. They
-- rephrase the question, get something usable on the second try, and move on.
-- Tomorrow the same question produces the same first answer. Everything needed
-- to have known better was already written down and then thrown away:
-- `turn_contexts` (0080) holds which fragments were pasted above the question
-- and what they scored, `document_field_corrections` (0076) holds every value a
-- human corrected the extractor on, and `commitments` (0069) holds every
-- extracted deadline a human had to fix. Nobody reads any of it back.
--
-- These three tables read it back. One holds what was OBSERVED, one holds what
-- was CHANGED as a result, and one holds what a human has to decide.
--
-- ---------------------------------------------------------------------------
-- WHY THREE TABLES AND NOT ONE WITH A STATUS COLUMN
-- ---------------------------------------------------------------------------
-- Because the line between "Cortex may do this on its own" and "a person must
-- decide this" is the most important thing in the whole module, and a line
-- drawn with an enum value is a line one careless `where` clause away from not
-- existing. So it is drawn in the schema instead:
--
--   learning_adjustments  can only ever express AN ORDER. Its rows say "within
--                         its relevance band, put this fragment first" or "put
--                         it last". There is no column in it that can hold a
--                         claim about the world. The code that applies learning
--                         to a retrieval reads this table and no other, so it
--                         is not possible — not merely forbidden — for an
--                         un-reviewed conclusion to change what Cortex answers.
--
--   learning_proposals    can only ever express PROSE FOR A HUMAN. It has no
--                         effect on retrieval at all; nothing reads it except
--                         the screen. This is where anything that would change
--                         what the system believes to be TRUE ends up: "this
--                         document says 3.200.000 and four people have corrected
--                         it to 3.450.000", "nobody has ever answered this
--                         question and it gets asked twice a week".
--
-- The reasoning for the line itself: an ordering mistake is self-correcting and
-- cheap. The material is all still there, the next signal can move it back, and
-- the worst case is that a true passage is quoted second instead of first. A
-- truth mistake is neither. Once a document has been rewritten the original is
-- gone, every future answer repeats the new value with full confidence, and the
-- symptom — "Cortex keeps saying the wrong rate" — has no visible cause. The
-- same asymmetry is what makes poisoning survivable: somebody who could
-- manufacture usage signal at will can, at absolute worst, reorder passages
-- that had ALREADY cleared the relevance floor on their own merits. They cannot
-- make Cortex assert anything.
--
-- ---------------------------------------------------------------------------
-- WHAT AN ADJUSTMENT CANNOT DO, BY CONSTRUCTION
-- ---------------------------------------------------------------------------
-- It cannot move a fragment across a relevance band. `kb/relevance.ts` stays
-- the sole authority on what is strong, what is weak and what is below the
-- floor; learning only decides the order WITHIN one of those groups. A demoted
-- fragment that is the only strong match is still the only strong match and is
-- still prepended. A preferred fragment that scored below the floor stays
-- dropped forever, however many people liked it.
--
-- There is deliberately no numeric weight anywhere in this table. A tunable
-- score bias is a knob nobody can reason about — "+0,04" means nothing on a
-- blended rank whose own comment says its magnitude is meaningless — and it is
-- the shape that quietly grows until it can overrule the thresholds. Three
-- tiers, stated in words, is the whole vocabulary: first, normal, last.
--
-- ---------------------------------------------------------------------------
-- NOTHING IS PERMANENT
-- ---------------------------------------------------------------------------
-- Every adjustment carries `expires_at`. If the evidence stops being produced,
-- the adjustment dies on its own and retrieval returns to the plain scores. A
-- store of corrections that only ever accumulates is a store that cannot notice
-- it was wrong, and the failure mode this module has to avoid above all others
-- is degrading silently. Undoing one is a single row: `status = 'revoked'`,
-- with who did it and why, and it stops applying on the next turn.

-- ---------------------------------------------------------------------------
-- 1. What was observed
-- ---------------------------------------------------------------------------
-- Append-only. One row per thing that happened, attributed to the fragment it
-- happened to, with enough of the "why" to be readable on screen months later.
--
-- NOBODY IS ASKED TO RATE ANYTHING. Every kind below is a by-product of work
-- somebody was doing anyway. A thumbs-up widget collects opinions from the two
-- people who like clicking widgets; these collect behaviour from everyone.
--
--   reformulated          The same person asked essentially the same question
--                         again within minutes. The first answer did not land.
--                         Negative, against the fragments that were prepended
--                         on the first attempt.
--   abandoned             The conversation ended on a turn whose retrieval said
--                         "thin" or "nothing", after it had been going. Weak,
--                         because leaving is also what people do when they got
--                         what they wanted.
--   moved_on              The next question was about something else entirely.
--                         The counterweight, and it is not optional: a loop
--                         that can only ever demote drifts to demoting
--                         everything, and the drift is invisible.
--   fragment_copied       Somebody selected a passage out of a retrieval and
--                         copied it. Hard to fake accidentally and unambiguous.
--   extraction_corrected  A human changed the due date Cortex read out of a
--                         document (0069). Gold: it is a person telling us, in
--                         the course of their own work, that the passage did
--                         not say what we thought.
--   extraction_rejected   A human threw the extracted commitment out entirely.
--   extraction_confirmed  A human vouched for it unchanged. Positive, and it
--                         has to be collected for the same reason `moved_on`
--                         does — otherwise the only documents with any evidence
--                         are the ones somebody complained about.
--   field_corrected       A human corrected an extracted field (0076).
create table if not exists public.learning_signals (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,

  kind text not null check (kind in (
    'reformulated',
    'abandoned',
    'moved_on',
    'fragment_copied',
    'extraction_corrected',
    'extraction_rejected',
    'extraction_confirmed',
    'field_corrected'
  )),
  -- -1 is evidence against, +1 evidence for. Kept as its own column rather than
  -- derived from `kind` in application code, so a reader of the table can add
  -- the column up without knowing the vocabulary.
  polarity smallint not null check (polarity in (-1, 1)),
  -- 1 for a hint, 3 for somebody's deliberate correction. Three values, not a
  -- scale: see the header on why this module has no tunable numbers.
  weight smallint not null check (weight between 1 and 3),

  -- What it is about. A fragment is (document, index) rather than a chunk id,
  -- for the same reason turn-context uses that pair: it is the identity that
  -- survives on both sides of a retrieval, and re-indexing does not invalidate
  -- the whole history.
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  chunk_index int not null default -1 check (chunk_index >= -1),

  -- Who produced it. Nullable because a person can leave the company and their
  -- observations should not leave with them — but see `learning_adjustments`:
  -- the count of DISTINCT actors is a gate, so this is read as well as stored.
  actor_user_id uuid references public.users(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  turn_context_id uuid references public.turn_contexts(id) on delete set null,

  -- The sentence shown on screen next to this row, plus whatever the derivation
  -- wants to keep (the two questions that were compared, the value that was
  -- corrected and the value it was corrected to). Never quoted material from a
  -- space: this table has no redaction sweep, so it must never hold any.
  detail jsonb not null default '{}'::jsonb,

  -- Makes the derivation idempotent. The nightly pass re-reads the same window
  -- of turns every night; without this it would count Tuesday's reformulation
  -- again on Wednesday, and again on Thursday, until an adjustment appeared out
  -- of one person's single bad afternoon.
  dedupe_key text not null,

  -- When the thing happened, which is not when the row was written.
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- Signals age out at 180 days. The window that gates an adjustment is 90, so
  -- this leaves the screen able to show "here is what the evidence looked like
  -- before this was applied" for a full cycle afterwards.
  purge_at timestamptz not null
);

comment on table public.learning_signals is
  'Append-only record of things that happened which say something about a Brain Knowledge fragment: a question immediately rephrased, a passage copied, an extracted date a human had to fix. Collected from work people were doing anyway — nobody is asked to rate an answer. Attributed to (document_id, chunk_index) because that pair survives re-indexing.';

comment on column public.learning_signals.dedupe_key is
  'Makes re-derivation idempotent. The nightly pass re-reads an overlapping window of turns; without a unique key on this, the same Tuesday would be counted every night until it crossed a threshold on its own.';

create unique index if not exists learning_signals_dedupe_idx
  on public.learning_signals (organization_id, dedupe_key);

-- "Everything known about this fragment, most recent first" — the read the
-- derivation and the screen both make.
create index if not exists learning_signals_fragment_idx
  on public.learning_signals (organization_id, document_id, chunk_index, observed_at desc);

-- "What has Cortex been learning lately", for the feed on the page.
create index if not exists learning_signals_recent_idx
  on public.learning_signals (organization_id, observed_at desc);

create index if not exists learning_signals_purge_idx
  on public.learning_signals (purge_at);

-- ---------------------------------------------------------------------------
-- 2. What changed as a result
-- ---------------------------------------------------------------------------
-- The only table in this migration that anything on the answering path reads.
-- Everything it can say is an ORDER, and the order is applied strictly inside
-- one relevance band. See the header.
--
--   prefer_fragment   Within its band, this fragment goes first.
--   demote_fragment   Within its band, this fragment goes last, and is the
--                     first to fall off when the fragment limit bites.
--   stale_document    Every fragment of this document goes last within its
--                     band, and the screen says the material looks out of date.
--                     It does NOT edit the document, does not set validity
--                     dates and does not hide anything: `kb/freshness.ts` owns
--                     what a document's dates mean, and this is an observation
--                     ABOUT a document, not a claim written onto it.
create table if not exists public.learning_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,

  kind text not null check (kind in ('prefer_fragment', 'demote_fragment', 'stale_document')),

  document_id uuid not null references public.kb_documents(id) on delete cascade,
  -- -1 means "the document as a whole", which only `stale_document` may say.
  chunk_index int not null default -1 check (chunk_index >= -1),

  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),

  -- Why this exists, frozen at the moment it was created: the signal counts by
  -- kind, how many distinct people, over how many days, the first and last
  -- observation. Frozen rather than joined, for the same reason turn-context
  -- freezes its scores — signals purge at 180 days and an adjustment that could
  -- no longer say why it exists is an adjustment nobody can judge.
  evidence jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  -- Not optional, and not far away. An adjustment that stops being re-evidenced
  -- dies, retrieval goes back to the plain scores, and the next pass re-creates
  -- it if the behaviour is still there. This is the module's main defence
  -- against degrading without anybody noticing.
  expires_at timestamptz not null,

  -- The undo. One row, one write, effective on the next turn.
  revoked_at timestamptz,
  -- Null with a revoked_at set means the system revoked it — the evidence
  -- turned around, or the fragment stopped existing.
  revoked_by uuid references public.users(id) on delete set null,
  revoked_reason text,

  -- Only a whole-document verdict may address the whole document, and only a
  -- fragment verdict may address a fragment. Enforced here because the applier
  -- branches on it, and a row that satisfied neither branch would be an
  -- adjustment that silently does nothing.
  constraint learning_adjustments_document_scope
    check (kind <> 'stale_document' or chunk_index = -1),
  constraint learning_adjustments_fragment_scope
    check (kind = 'stale_document' or chunk_index >= 0),
  constraint learning_adjustments_revoked_shape
    check (status <> 'revoked' or revoked_at is not null)
);

comment on table public.learning_adjustments is
  'What Cortex changed about itself, and the only such table anything on the answering path reads. Every row is an ORDER — put this fragment first, or last, within its relevance band — never a claim. Learning cannot move a fragment across the relevance floor; kb/relevance.ts remains the sole authority on that. Each row expires, and revoking one is a single write that takes effect on the next turn.';

comment on column public.learning_adjustments.evidence is
  'The counts this adjustment was created from, frozen. Signals purge at 180 days; an adjustment that could no longer show its own evidence would be one nobody could judge or undo with confidence.';

-- One live verdict per fragment. Prevents "prefer" and "demote" being active on
-- the same fragment at once, which is the state a naive derivation would reach
-- the first time evidence turned around.
create unique index if not exists learning_adjustments_one_active_idx
  on public.learning_adjustments (organization_id, document_id, chunk_index)
  where status = 'active';

-- The read on the answering path: every live adjustment for this workspace.
-- Small by design (an adjustment needs real evidence), so this is one indexed
-- sweep and it is cached in process for a few seconds on top.
create index if not exists learning_adjustments_active_idx
  on public.learning_adjustments (organization_id, status, expires_at);

-- The history panel: what has been undone, and what expired on its own.
create index if not exists learning_adjustments_recent_idx
  on public.learning_adjustments (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. What a human has to decide
-- ---------------------------------------------------------------------------
-- Nothing on the answering path reads this table. It exists so that the
-- conclusions Cortex is NOT allowed to act on still get said out loud, with
-- their evidence attached, instead of being silently discarded because they
-- were too dangerous to apply.
--
--   contradicted_value   The extractor keeps reading a value out of a document
--                        and people keep correcting it to the same other value.
--                        The document probably says something that is no longer
--                        true. Fixing that is editing the corpus, which is the
--                        one thing this module may never do on its own.
--   badly_cut_fragment   A fragment keeps landing just below the floor on turns
--                        where its immediate neighbour was prepended — the
--                        classic symptom of a chunk boundary through the middle
--                        of the answer. The fix is re-indexing the document,
--                        which rewrites the embeddings and is not reversible by
--                        flipping a column, so it is proposed and not applied.
--                        (Note the ordering adjustments in § 2 genuinely cannot
--                        help here: a fragment below the floor stays below it.)
--   unanswered_question  People keep asking something Brain Knowledge holds
--                        nothing about. There is no retrieval fix at all — the
--                        answer has to be written down by somebody who knows it.
create table if not exists public.learning_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,

  kind text not null check (kind in (
    'contradicted_value',
    'badly_cut_fragment',
    'unanswered_question'
  )),

  -- Null for `unanswered_question`, which is by definition about a gap and has
  -- no document to point at.
  document_id uuid references public.kb_documents(id) on delete cascade,
  chunk_index int,

  -- Written in Colombian Spanish at derivation time, because the person reading
  -- this has to be able to act on it without a translation layer, and because a
  -- sentence assembled on screen from codes drifts away from the codes.
  headline text not null check (length(btrim(headline)) between 1 and 200),
  detail text not null check (length(btrim(detail)) between 1 and 2000),

  evidence jsonb not null default '{}'::jsonb,

  status text not null default 'open' check (status in ('open', 'accepted', 'dismissed')),
  decided_at timestamptz,
  decided_by uuid references public.users(id) on delete set null,
  decided_note text,

  -- Same job as on signals: the pass runs nightly and must not produce the same
  -- proposal again every night. A dismissed proposal therefore stays dismissed
  -- until its evidence changes enough to change its key.
  dedupe_key text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint learning_proposals_decided_shape
    check (status = 'open' or decided_at is not null)
);

comment on table public.learning_proposals is
  'Conclusions Cortex reached but is not allowed to act on, said out loud with their evidence instead of discarded. Nothing on the answering path reads this table. Everything that would change what the system believes to be true — a value the corpus states wrongly, a chunk boundary that needs re-indexing, a question nobody has ever written an answer to — lands here and waits for a person.';

create unique index if not exists learning_proposals_dedupe_idx
  on public.learning_proposals (organization_id, dedupe_key);

create index if not exists learning_proposals_open_idx
  on public.learning_proposals (organization_id, status, created_at desc);

-- Las sugerencias de seguimiento dejan de ser un cálculo y pasan a ser un dato.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- Follow-ups were generated on every VIEW. Opening yesterday's conversation
-- spent a model call re-deriving three questions from an answer that has not
-- changed since yesterday and never will. Three consequences, and the third is
-- the one people actually complained about:
--
--   1. Paid twice for the same thing. The cost of the feature scaled with how
--      often somebody re-reads a thread, which is the one number a product
--      wants to grow.
--   2. They moved. The same answer showed different questions each time it was
--      looked at, so the strip read as decoration rather than as something the
--      product knows. A suggestion that changes when you blink is one nobody
--      trusts enough to click.
--   3. They cost money on old turns. Scrolling up a long thread asked a model
--      what to suggest after an answer from last week.
--
-- An answer is immutable once written. Anything derived from it and from
-- nothing else is therefore a property OF that answer, not a computation to
-- repeat. So it is stored on the message row.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN ON `messages` AND NOT A TABLE
-- ---------------------------------------------------------------------------
-- Exactly one list per assistant message, always wanted at the same moment the
-- message itself is wanted, and meaningless without it. A `chat_followups`
-- table would give the same data a foreign key, a tenancy registration, a
-- cascade rule and — the part that matters — a SECOND QUERY (or a join) on the
-- one page load this change exists to make cheaper. On the column, the
-- suggestions arrive inside the transcript read the chat page already runs, so
-- reopening a conversation costs zero additional round trips.
--
-- It also inherits, for free and without anybody having to remember:
--   * tenancy — `messages` is already registered as a tenant table, and the
--     org-scoped client filters every read and write of this column with it;
--   * lifetime — deleting a conversation deletes its messages and takes the
--     suggestions with them. There is no orphan state to sweep.
--
-- ---------------------------------------------------------------------------
-- NULL AND {} ARE DIFFERENT ANSWERS, AND THAT IS THE WHOLE RETRY POLICY
-- ---------------------------------------------------------------------------
--   NULL  Nobody has tried yet. The next time this message is the newest one
--         on screen, it is generated — once.
--   {}    Somebody tried and there was nothing worth asking. A settled result,
--         never retried.
--
-- Collapsing the two would force a choice between never generating and
-- generating on every open, which are the two failures this migration exists
-- to avoid. Keeping them apart is what lets "no suggestions" be a REAL answer
-- that costs nothing to re-read.
--
-- A failed generation — a timeout, a rate limit, a model that returned nothing
-- the specificity filter would keep — writes {}. It is deliberately NOT
-- retried. The filter in apps/web/lib/followup-filter.ts already fails toward
-- fewer chips, so the honest reading of a failure is "this answer has no good
-- second question", which is a normal outcome for most answers. Retrying would
-- put the per-open cost straight back, in exchange for a second guess at
-- something the strip is designed to omit gracefully.
--
-- text[] and not jsonb: this is a list of short questions and can never
-- usefully be anything else. The array type says so, and makes it impossible to
-- park an object here later without a migration that has to argue for it.

alter table public.messages
  add column if not exists followups text[];

-- Three is what the strip renders and what the route slices to. The constraint
-- is here so a row written by hand, by a backfill or by a future caller cannot
-- put a fourth one on somebody's screen. `array_length` of an empty array is
-- null in Postgres, which is why the null branch has to come first -- it covers
-- both "never generated" and "generated, nothing to say".
alter table public.messages
  drop constraint if exists messages_followups_len;

alter table public.messages
  add constraint messages_followups_len
  check (followups is null or coalesce(array_length(followups, 1), 0) <= 3);

comment on column public.messages.followups is
  'Up to three follow-up questions derived from this assistant answer, generated exactly once and stored. NULL means nobody has generated them yet; {} means somebody did and there was nothing specific enough to keep -- a settled result that is never retried. Only ever set on assistant rows, and only ever read for the newest answer in a conversation.';

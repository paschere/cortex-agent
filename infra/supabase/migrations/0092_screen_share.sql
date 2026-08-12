-- Cortex mira la pantalla que le compartes, y lo único que queda escrito es que miró.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FEATURE STORES, WHICH IS ALMOST NOTHING
-- ---------------------------------------------------------------------------
-- A person shares one browser tab and asks questions about what is on it. Each
-- question carries ONE frame of that tab, taken at the instant they pressed
-- send. The frame goes into the request, is read by the model, and is garbage
-- when the response returns: it is never written to Postgres, to object storage
-- or to disk, there is no queue and no job that carries it, and there is no row
-- anywhere in this schema that can hold an image.
--
-- That is the same guarantee migration 0087's trámite recorder makes and for
-- the same reason (see the note at the top of browser/extract.ts): the cheapest
-- way not to leak a copy of somebody's screen is not to have one. A history of
-- screenshots of an employee's browser is a liability nobody asked for, it
-- would have to be defended, audited and eventually deleted by a sweeper that
-- will one day not run, and no feature here needs it.
--
-- ---------------------------------------------------------------------------
-- SO WHY STORE ANYTHING AT ALL
-- ---------------------------------------------------------------------------
-- Because a conversation has to still make sense next month. Read back cold,
-- "¿qué significa este error?" followed by a precise answer about a DIAN screen
-- is a transcript of half a conversation: the reader cannot tell what Cortex
-- was looking at, or that it was looking at anything, and the answer reads as
-- if it were invented. One timestamp fixes that completely.
--
-- It is also the only honest way to tell somebody their screen was read. A
-- record of that which the person cannot see is not a record, it is a log — so
-- the column is rendered under the question in the chat and in the archived
-- transcript, never only here.
--
-- WHAT IT IS NOT: it is not consent, not a licence and not an audit trail for
-- anybody but the person themselves. Nothing derived from the image survives.
--
-- ---------------------------------------------------------------------------
-- HOW LONG: exactly as long as the conversation, and not one day more
-- ---------------------------------------------------------------------------
-- There is no `purge_at` here, unlike chat_charts and chat_attachments in
-- migration 0088, and the difference is deliberate. Those two hold CONTENT — a
-- resolved document, the text of somebody's contract — so they expire on their
-- own clock because holding content longer than it is useful is the risk. This
-- holds a timestamp and an integer about a message. Expiring it on its own
-- clock would produce the worst of both worlds: an old conversation that has
-- silently lost the one line explaining where its answers came from, while the
-- questions and answers themselves stay. So it lives and dies with the message,
-- which is what deleting a conversation already does.
--
-- ---------------------------------------------------------------------------
-- COLUMNS ON `messages`, NOT A `screen_glances` TABLE
-- ---------------------------------------------------------------------------
-- The identical argument migration 0090 made for `followups`, and it holds
-- harder here: exactly one glance per user message, always wanted at the moment
-- the message is wanted, meaningless without it. A table would buy a foreign
-- key, a tenancy registration, a cascade rule and a second query on the one
-- page load — the transcript read — that this data exists to annotate. On the
-- row it arrives inside the read the chat page already runs, and it inherits
-- tenancy (`messages` is a registered tenant table) and lifetime (deleting a
-- conversation deletes its messages) without anybody having to remember either.

alter table public.messages
  add column if not exists screen_glance_at timestamptz;

-- ---------------------------------------------------------------------------
-- WHY THE TOKEN COUNT IS HERE AND NOT DERIVED LATER
-- ---------------------------------------------------------------------------
-- An image costs the model `width × height / 750` input tokens — a function of
-- the frame's dimensions and of nothing else, not of what was on the screen.
-- Those dimensions come from the person's own display and are gone the instant
-- the frame is, so the cost of the glance is either written down now or it can
-- never be known. It is written down as TOKENS rather than as pesos because a
-- price changes and a token count does not: the money is arithmetic over this
-- number at whatever the rate was.
--
-- What it is for: answering "what does this feature actually cost us" with a
-- query instead of an estimate —
--
--   select count(*), sum(screen_glance_tokens), avg(screen_glance_tokens)
--     from public.messages where screen_glance_at is not null;
--
-- and, joined to `turn_latencies` on the answer that followed, the real
-- with-image versus without-image comparison on the same workspace's traffic.
-- Without the column that comparison is a guess about somebody else's monitors.

alter table public.messages
  add column if not exists screen_glance_tokens integer;

-- The two are one fact and cannot disagree: a glance with no cost, or a cost
-- with no glance, is a row that would make the query above quietly wrong.
alter table public.messages
  drop constraint if exists messages_screen_glance_shape;

alter table public.messages
  add constraint messages_screen_glance_shape
  check (
    (screen_glance_at is null and screen_glance_tokens is null)
    or (screen_glance_at is not null and screen_glance_tokens > 0)
  );

comment on column public.messages.screen_glance_at is
  'When Cortex took one frame of the tab this person was sharing, in order to answer THIS question. NULL on every other message, which is almost all of them. The image itself is never stored anywhere — see the note at the top of migration 0092 — so this timestamp and the token count beside it are the entire footprint of a screen question. It is rendered under the question in the chat and in the archived transcript: a record of somebody''s screen being read that they cannot see would not be a record.';

comment on column public.messages.screen_glance_tokens is
  'Input tokens the frame cost the model, which is width × height / 750 and depends on the frame''s size alone. Stored because the dimensions come from the person''s display and vanish with the image, so this is the only moment the cost of the glance can be known. Tokens rather than money: rates change, counts do not.';

-- Every query this column exists for begins "the messages that carried a
-- glance", and those are a rounding error of the table. Partial, so it costs
-- the ordinary chat write nothing at all.
create index if not exists messages_screen_glance_idx
  on public.messages (screen_glance_at desc)
  where screen_glance_at is not null;

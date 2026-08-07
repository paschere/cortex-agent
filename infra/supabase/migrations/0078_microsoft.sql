-- Microsoft 365 as a first-class Cortex integration: Outlook mail and calendar
-- through Microsoft Graph, at the same level of capability as Google.
--
-- WHY THIS EXISTS. Cortex reads Gmail, Google Calendar, Drive and Sheets, and
-- until now a company on Microsoft 365 could connect nothing at all — no
-- correspondence, no agenda, no meetings. That is most of what Cortex is. A
-- Colombian postal-and-customs logistics operator running Outlook is the first
-- customer to hit it, and the whole "read my mail and my calendar" half of
-- their plan is blocked on this file.
--
-- DELEGATED PERMISSIONS, NOT APPLICATION PERMISSIONS. This is the decision the
-- rest of the integration is shaped around, so it is recorded here rather than
-- only in the docs.
--
--   Microsoft offers two ways to reach a mailbox. APPLICATION permissions
--   (`Mail.Read` as an app role) let a daemon read EVERY mailbox in the
--   tenant, once an administrator consents, with no user in the loop and no
--   way for an individual to opt out or revoke. DELEGATED permissions issue a
--   token that acts as one specific person, reaches only what that person can
--   already reach, and dies when they leave, change their password, or an
--   administrator revokes it.
--
--   We use delegated, exclusively. Not because application permissions are
--   harder — they are easier, there is no per-user connect flow to build — but
--   because "Cortex can read every mailbox in the company because an admin
--   clicked once" is the single sentence that ends a security review, and it
--   should. A vendor holding tenant-wide mail access is a breach of the entire
--   company rather than of one account, and nobody inside the company can see
--   whose mail was read.
--
--   The concrete consequence for this schema: tokens are per USER, in the
--   existing `public.integrations` table, one row per person, encrypted with
--   TOKEN_ENCRYPTION_KEY exactly like Google's. There is no tenant-wide
--   credential table in this migration, and there should never be one.
--
-- TENANCY. The one new table carries `organization_id` and is classified
-- `tenant()` in packages/agent-tools/src/tenancy/tables.ts, per migration 0064.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. The provider
-- ===========================================================================
-- `public.integrations.provider` is an enum. ADD VALUE cannot be USED in the
-- same transaction that adds it, so nothing below this line mentions
-- 'microsoft' as a literal — the same constraint migration 0024 hit when it
-- added 'github' and 'linear'.
alter type integration_provider add value if not exists 'microsoft';

comment on column public.integrations.provider is
  'Which system this OAuth grant is for. Every value is a PER-USER, delegated grant: the token acts as the person who authorised it and reaches only what they can already reach. There is deliberately no tenant-wide credential here for Microsoft — see migration 0078 § 1.';

-- ===========================================================================
-- 2. The mail archive ledger
-- ===========================================================================
-- One row per Outlook conversation that was folded into Brain Knowledge.
--
-- WHAT IT IS FOR, IN ORDER OF IMPORTANCE.
--
--   IDEMPOTENCY. A thread grows. Somebody replies twice on Tuesday and the same
--   conversation is archived again on Wednesday. Without a ledger that is three
--   documents saying nearly the same thing, and Brain Knowledge answers a
--   question by quoting whichever one it found. The unique index on (workspace,
--   conversation) is what makes re-archiving REFRESH the document it already
--   owns. `sha256` is the second half of that: identical text does not spend
--   the embedding calls at all. This is the same mechanism as
--   `whatsapp_ingest_windows` (0068 § 5) and `meeting_imports` (0059), because
--   it is the same problem.
--
--   PROVENANCE. Which mailbox, which conversation, which messages, who
--   archived it and when. A document retrieved months later can be traced back
--   to the exact correspondence without going through Graph.
--
--   ATTRIBUTION. `client_id` links the thread to the client it is with. It is
--   NULLABLE and it is null far more often than not, on purpose — see below.
--
-- WHAT IS DELIBERATELY NOT HERE. There is no "archive my whole mailbox" switch
-- and no row is written for internal correspondence. A thread is archivable
-- only when somebody outside the company's own email domains is on it; a mail
-- between two colleagues is that person's private correspondence and is never
-- read into a shared space. That rule lives in
-- packages/agent-tools/src/outlook/ingest-thread.ts, which explains why it is
-- the same line WhatsApp draws between a group and a direct message.
create table if not exists public.microsoft_mail_ingests (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      text not null references public.ba_organization(id) on delete cascade,
  -- Who archived it. Their Microsoft grant is what fetched the messages and
  -- their permission is what the space write was checked against, so an
  -- archived thread always has somebody answerable for it.
  user_id              uuid references public.users(id) on delete set null,
  -- Graph's own `conversationId`. Stable across replies, which is what makes it
  -- the right idempotency key.
  conversation_id      text not null,
  -- RFC 5322 Message-ID of the first message. Kept because it is the one
  -- identifier that survives leaving Microsoft: a thread re-found in another
  -- mail system is the same thread.
  internet_message_id  text,
  subject              text,
  -- Where it landed. Chosen by the person archiving and checked with
  -- assertCanWriteToSpace, which refuses a company-wide space to non-admins —
  -- so publishing a client's correspondence to everyone stays an explicit act.
  space_id             uuid references public.kb_collections(id) on delete set null,
  document_id          uuid references public.kb_documents(id) on delete set null,
  -- The outside domain this correspondence is with, when there is exactly one
  -- corporate domain on the thread. Null for a thread spanning several
  -- companies, or one that is only with free mailboxes.
  counterpart_domain   text,
  message_count        integer not null default 0,
  first_message_at     timestamptz,
  last_message_at      timestamptz,
  -- Hash of the assembled document text. Equal means nothing changed, which
  -- means nothing is re-embedded.
  sha256               text,
  status               text not null default 'ready'
    check (status in ('ready', 'failed')),
  -- One sentence somebody can act on, never a stack trace.
  error                text,
  ingested_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- THE INDEX THAT MAKES RE-ARCHIVING FREE. Also the ON CONFLICT target the
-- ingest upserts against.
create unique index if not exists microsoft_mail_ingests_org_conversation_idx
  on public.microsoft_mail_ingests (organization_id, conversation_id);

create index if not exists microsoft_mail_ingests_org_client_idx
  on public.microsoft_mail_ingests (organization_id, client_id)
  where client_id is not null;

create index if not exists microsoft_mail_ingests_org_recent_idx
  on public.microsoft_mail_ingests (organization_id, last_message_at desc);

comment on table public.microsoft_mail_ingests is
  'One row per Outlook conversation folded into Brain Knowledge. Unique on (organization_id, conversation_id) so a thread that grows refreshes its document instead of forking a second one; sha256 is what stops an unchanged thread from being re-embedded. Rows exist only for correspondence with people OUTSIDE the company — internal mail is never archived.';

-- ===========================================================================
-- 3. The client link
-- ===========================================================================
-- `client_id` is added separately, and its foreign key is added only if
-- `public.clients` exists.
--
-- WHY THE GUARD. `public.clients` is created by migration 0075, on a different
-- branch, landing in the same release. 0078 runs after it and the constraint
-- will be created in every real deployment — but a migration that hard-fails on
-- a database where the other branch has not been applied is a migration that
-- blocks a rollback, and this one has no reason to. The column exists either
-- way; only the referential guarantee waits.
--
-- HOW IT IS FILLED, AND WHY IT IS USUALLY EMPTY. The sender's domain is the
-- strongest signal there is for "which client is this" — far stronger than the
-- subject line or anything in the body. But the archive does not interpret it
-- itself: it looks the domain up in `public.client_domains`, 0075's register of
-- "this domain belongs to this client", where every row is signed by the person
-- who vouched for it and a domain resolves to at most one client per workspace.
--
-- There is deliberately NO fallback to matching the domain against client
-- NAMES. `coltrans.com` resembles "Colombiana de Transportes" and also
-- "Colombia Transportadora", and 0075's own header states the rule this defers
-- to: a link that was not earned is worse than no link at all. A wrong
-- attribution ends up in a report somebody acts on; a missing one is closed by
-- registering the domain once, which then fixes every future thread from that
-- sender. So this column stays null unless a human already answered the
-- question, and nothing in the product assumes the table has any rows at all.
alter table public.microsoft_mail_ingests
  add column if not exists client_id uuid;

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'clients'
  ) and not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'microsoft_mail_ingests'
      and constraint_name = 'microsoft_mail_ingests_client_id_fkey'
  ) then
    alter table public.microsoft_mail_ingests
      add constraint microsoft_mail_ingests_client_id_fkey
      foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;

comment on column public.microsoft_mail_ingests.client_id is
  'The client this correspondence is with, resolved from the sender''s domain through public.client_domains — a human''s statement, never a name-similarity guess. Nullable and usually null; a wrong attribution ends up in a report, a missing one is closed by registering the domain once. See migration 0078 § 3.';

-- ===========================================================================
-- 4. What Brain Knowledge sees
-- ===========================================================================
-- An archived thread is an ordinary `kb_documents` row with `source = 'outlook'`
-- and `media_kind = 'text'`.
--
-- `media_kind` deliberately does NOT gain a fifth value the way 'whatsapp' did
-- in 0068 § 7. There are no bytes here and nothing for the transcription worker
-- to do — it branches on 'audio' alone — so a new kind would buy nothing, and
-- widening a shared check constraint from this migration would silently
-- overwrite whatever a parallel branch added to it. Provenance is carried by
-- `source`, which is what the brain graph and every citation renderer already
-- read. The chunks still carry `{speaker, startMs, endMs}` in their metadata,
-- exactly like a Meet call or a WhatsApp window, so "who wrote this and how far
-- into the exchange" works on mail for free.
create index if not exists kb_documents_outlook_idx
  on public.kb_documents (collection_id, recorded_at desc)
  where source = 'outlook';

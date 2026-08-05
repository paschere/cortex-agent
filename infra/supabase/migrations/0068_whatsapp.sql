-- WhatsApp as a Cortex surface: company groups become memory, and a person can
-- talk to the agent by direct message.
--
-- WHY THIS EXISTS. In a Colombian operation half the working day happens in
-- WhatsApp groups — a dispatch being coordinated, a client raising an incident,
-- a warehouse reporting a shortage. None of it survives the scroll. Google Meet
-- calls already become documents (0059); this does the same for the other
-- conversation the company actually has.
--
-- WHAT IS DELIBERATELY NOT HERE. There is no "archive everything" switch. A
-- group is archived only after somebody opens Cortex, picks that group, and
-- names the Brain Knowledge space it lands in. See § 3 for why the space is
-- mandatory rather than defaulted.
--
-- HOW IT REACHES THE DATABASE. WhatsApp has no API for this; the connection is
-- a WebSocket held open by Baileys, which cannot live on Vercel. A small
-- persistent service (services/whatsapp, deployed on Railway) holds the socket
-- and talks to Cortex over HTTP. Everything below is written by Cortex routes,
-- never by the bridge directly, so every write goes through the scoped client
-- and lands in the right workspace.
--
-- TENANCY. Every table here carries `organization_id` and is classified
-- `tenant()` in packages/agent-tools/src/tenancy/tables.ts, per migration 0064.
-- One WhatsApp connection belongs to exactly one workspace.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. The connection
-- ===========================================================================
-- One row per workspace: the Baileys session, its pairing state, and what the
-- bridge last reported.
--
-- THE CREDENTIALS LIVE IN POSTGRES, NOT ON DISK. Baileys' own
-- `useMultiFileAuthState` writes a directory of JSON files. On Railway the
-- container filesystem is ephemeral between deploys, so a disk-backed session
-- means re-scanning the QR code every single time the service ships — which is
-- the classic Baileys frustration and the reason most self-hosted bridges are
-- abandoned after a week. Keeping `creds` here (and the signal keys in § 2)
-- means a deploy, a crash and a region move are all invisible: the service
-- boots, reads its identity back, and reconnects.
create table if not exists public.whatsapp_sessions (
  organization_id      text primary key references public.ba_organization(id) on delete cascade,
  -- Baileys `AuthenticationCreds`, serialised with its own BufferJSON reviver
  -- so the Buffers inside survive the round trip. This is the WhatsApp identity
  -- of the paired device: treat it as a credential, because it is one.
  creds                jsonb,
  -- 'disconnected' — no socket. 'pairing' — waiting for somebody to scan the QR.
  -- 'connected'    — online. 'logged_out' — WhatsApp revoked the device and the
  -- credentials are dead; the service must NOT retry, a human must re-pair.
  status               text not null default 'disconnected'
    check (status in ('disconnected', 'pairing', 'connected', 'logged_out')),
  -- The number the session is bound to, as WhatsApp reports it. Shown in the UI
  -- so an operator can tell at a glance that this is the dedicated line and not
  -- somebody's personal phone.
  phone_number         text,
  -- The current pairing QR, already rendered as a `data:image/png;base64,…` by
  -- the bridge. Storing the rendered image rather than the raw string keeps the
  -- browser free of a QR-encoding dependency, and the value is short-lived by
  -- construction: WhatsApp rotates the code every ~20 seconds.
  pairing_qr           text,
  pairing_qr_expires_at timestamptz,
  last_connected_at    timestamptz,
  last_seen_at         timestamptz,
  -- One sentence an operator can act on, never a stack trace.
  last_error           text,
  -- Off by default. Reading groups and answering DMs are separate decisions,
  -- and answering is the one that emits signals WhatsApp can see.
  dm_enabled           boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.whatsapp_sessions is
  'One WhatsApp connection per workspace. `creds` is the paired device identity — a credential. Persisted here rather than on disk because Railway''s filesystem is ephemeral and a disk-backed Baileys session means re-scanning the QR on every deploy.';

-- ===========================================================================
-- 2. The signal key store
-- ===========================================================================
-- Baileys keeps a second, much larger half of its auth state: pre-keys, sender
-- keys, session records and app-state sync keys. It reads and writes them
-- constantly, by (type, id), and never lists them — which is exactly the shape
-- of a key-value table and exactly the wrong shape for a jsonb blob, because a
-- blob would be rewritten in full on every message.
create table if not exists public.whatsapp_session_keys (
  organization_id text not null references public.ba_organization(id) on delete cascade,
  -- 'pre-key' | 'session' | 'sender-key' | 'app-state-sync-key' | …
  key_type        text not null,
  key_id          text not null,
  value           jsonb not null,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, key_type, key_id)
);

comment on table public.whatsapp_session_keys is
  'Baileys'' signal key store (pre-keys, sessions, sender keys, app-state sync keys), one row per key. A key-value table rather than a column on whatsapp_sessions: these are written on almost every message, and a jsonb blob would be rewritten whole each time.';

-- ===========================================================================
-- 3. Which groups are archived, and where they land
-- ===========================================================================
-- The catalogue of every group the paired account is in, plus the decision for
-- each one. A row existing means "we can see this group"; `archive_enabled`
-- means "somebody chose to remember it".
--
-- `space_id` IS NOT NULL AND HAS NO DEFAULT, AND THAT IS THE POINT.
--
-- `import-transcript.ts` files a Meet call into the IMPORTER'S OWN private
-- space by default, and the argument there is asymmetry: a transcript that
-- should have been shared is one drag away, a transcript that should have
-- stayed private and was published cannot be un-read.
--
-- The same argument applies here and lands somewhere different, because the
-- facts are different. A Meet import has an importer — a person, in the room,
-- whose Google credentials fetched it. A WhatsApp group archive has no such
-- person: it runs unattended off a shared connection, forever, for a
-- conversation that a dozen people (several of them clients and suppliers) are
-- still having. There is no private space that is the natural home for it, and
-- picking the operator's would file the company's dispatch coordination into
-- one employee's notes.
--
-- So instead of a default there is a REQUIREMENT: naming the space is part of
-- switching a group on, the person switching it on must pass
-- `assertCanWriteToSpace` for that space, and that function already refuses a
-- company-wide space to anyone who is not an org admin. Publishing a client
-- group to the whole company therefore takes an explicit act, by someone with
-- the authority, group by group. Nothing is archived by accident and nothing
-- lands anywhere nobody chose.
create table if not exists public.whatsapp_groups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  -- "1203630xxxxxxxxxx@g.us" — WhatsApp's own id for the group.
  jid              text not null,
  subject          text,
  participant_count integer,
  archive_enabled  boolean not null default false,
  -- Where the conversation documents go. Null only while the group is off.
  space_id         uuid references public.kb_collections(id) on delete set null,
  enabled_by       uuid references public.users(id) on delete set null,
  enabled_at       timestamptz,
  -- Never archives anything sent before this instant. Set when the group is
  -- switched on, so turning archiving on does not retroactively swallow two
  -- years of a conversation nobody consented to archiving.
  archive_from     timestamptz,
  last_message_at  timestamptz,
  last_ingested_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists whatsapp_groups_org_jid_idx
  on public.whatsapp_groups (organization_id, jid);
create index if not exists whatsapp_groups_org_enabled_idx
  on public.whatsapp_groups (organization_id, archive_enabled);

comment on column public.whatsapp_groups.space_id is
  'The Brain Knowledge space this group''s conversations are filed in. Required to switch archiving on and checked with assertCanWriteToSpace, which refuses a company-wide space to non-admins. There is deliberately no default — see migration 0068 § 3.';
comment on column public.whatsapp_groups.archive_from is
  'Archiving starts here and never reaches behind it. Switching a group on must not retroactively ingest years of conversation that nobody was told about.';

-- ===========================================================================
-- 4. The staged messages
-- ===========================================================================
-- Raw messages, held between arriving and becoming a document.
--
-- WHY THEY ARE STAGED AT ALL. A message is not a document — see § 5. Grouping
-- messages into a conversation needs to see what came after, which means the
-- text has to wait somewhere. This is that somewhere: cheap rows, written in
-- batches by the bridge, folded into documents on a timer.
--
-- Rows for a group that is not `archive_enabled` are NEVER WRITTEN. The check
-- happens in the ingest route before the insert, so an un-enabled group leaves
-- no trace in this database at all — not a dropped row, not an orphan, nothing.
create table if not exists public.whatsapp_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  text not null references public.ba_organization(id) on delete cascade,
  group_jid        text not null,
  -- WhatsApp's own message id. The unique index below on (workspace, group,
  -- message) is what makes a re-delivered batch free: Baileys re-emits messages
  -- after a reconnect and during history sync, routinely.
  message_id       text not null,
  sender_jid       text,
  -- The push name everyone in the group already sees. This — never the phone
  -- number — is what goes into the indexed document text; see § 5.
  sender_name      text,
  sent_at          timestamptz not null,
  body             text,
  kind             text not null default 'text'
    check (kind in ('text', 'voice', 'image', 'video', 'document', 'location', 'contact', 'other')),
  media_mime       text,
  media_filename   text,
  -- Deepgram's text for a voice note. The note itself is not kept: the words
  -- are what can be searched and cited, the audio is bytes we would be storing
  -- on behalf of people who never uploaded anything.
  transcript       text,
  transcript_error text,
  -- Set for an attachment that became its own Brain Knowledge document.
  attachment_document_id uuid references public.kb_documents(id) on delete set null,
  -- Which conversation window this ended up in. Null means "not folded into a
  -- document yet", and that is what the flush pass looks for.
  window_key       text,
  document_id      uuid references public.kb_documents(id) on delete set null,
  created_at       timestamptz not null default now()
);

create unique index if not exists whatsapp_messages_org_group_msg_idx
  on public.whatsapp_messages (organization_id, group_jid, message_id);
-- The flush pass's query: "this group's messages, in order, from a point in
-- time". Everything else is a lookup by the unique index above.
create index if not exists whatsapp_messages_org_group_time_idx
  on public.whatsapp_messages (organization_id, group_jid, sent_at);
create index if not exists whatsapp_messages_pending_idx
  on public.whatsapp_messages (organization_id, group_jid)
  where document_id is null;

comment on table public.whatsapp_messages is
  'Group messages waiting to be folded into a conversation document. Only ever written for a group with archive_enabled = true. Voice notes are stored as their Deepgram transcript, not as audio.';

-- ===========================================================================
-- 5. The ledger — one row per conversation window
-- ===========================================================================
-- THE DESIGN DECISION THIS TABLE ENCODES: how many messages make a document.
--
-- Per message. Unusable. "listo", "ok", "ya salió" are not documents; each
-- would cost an embedding and retrieve as an anonymous fragment.
--
-- Per day. A busy dispatch group does 800 messages a day covering six unrelated
-- incidents. The document is too big to be a unit of meaning and a hit inside it
-- cites "Tuesday", which is not an answer to anything.
--
-- Per thread. WhatsApp has no threads. Replies quote, most messages do not, and
-- the quote graph in a real group is a scattering of disconnected pairs.
--
-- Per conversation window — what this is. A window opens with a message and
-- closes after IDLE_GAP minutes of silence (45 by default), with a hard ceiling
-- and a day boundary in the workspace's timezone so a group that never goes
-- quiet still produces bounded documents. This matches how a WhatsApp group
-- actually behaves: a burst around an event, then nothing. The window IS the
-- event. Months later, "qué pasó con el despacho de Acme el martes" retrieves a
-- document that is exactly that conversation, with a header naming the group,
-- the date and who took part, and chunks carrying who said what and when.
--
-- IDEMPOTENCE. The unique index below is the mechanism, and the ingest code
-- leans on it the same way `importMeetingTranscript` leans on 0059's: an
-- already-ingested window reuses its document row, replaces its chunks, and
-- when the sha256 is unchanged does not spend the embedding calls at all.
create table if not exists public.whatsapp_ingest_windows (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  group_jid       text not null,
  -- The window's start, to the minute, in ISO-8601 UTC. Stable under
  -- re-planning: the same messages always yield the same boundaries.
  window_key      text not null,
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  message_count   integer not null default 0,
  participants    text[] not null default '{}',
  document_id     uuid references public.kb_documents(id) on delete set null,
  sha256          text,
  status          text not null default 'ready' check (status in ('ready', 'failed')),
  error           text,
  ingested_at     timestamptz not null default now()
);

create unique index if not exists whatsapp_ingest_windows_org_group_key_idx
  on public.whatsapp_ingest_windows (organization_id, group_jid, window_key);
-- The overlap lookup that keeps re-planning from duplicating: a late-arriving
-- message can shift a window's start, and the new window is matched to the old
-- ledger row by time range rather than by key.
create index if not exists whatsapp_ingest_windows_org_group_range_idx
  on public.whatsapp_ingest_windows (organization_id, group_jid, window_start, window_end);

-- ===========================================================================
-- 6. Which number is which person
-- ===========================================================================
-- The direct-message half. A DM runs a real Cortex turn with real tools, so it
-- must run as a real person — their integrations, their team permissions, their
-- name in the audit log. A number with no row here gets a short refusal and the
-- attempt is recorded in `security_events`; nothing runs.
--
-- Shaped after `google_chat_links` (0045) and carrying the same limitation for
-- the same reason: the primary key is the phone number, so one number reaches
-- exactly one workspace. That is a product limitation of a surface with no
-- workspace switcher, not an isolation hole — the link resolves to a single
-- `users` row and everything downstream is scoped to that row's workspace.
create table if not exists public.whatsapp_links (
  -- E.164 without the '+', which is how WhatsApp writes a JID user part.
  phone_e164      text primary key,
  organization_id text not null references public.ba_organization(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  display_name    text,
  -- The chat with this person, for proactive delivery later.
  dm_jid          text,
  last_seen_at    timestamptz,
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists whatsapp_links_org_idx on public.whatsapp_links (organization_id);
create index if not exists whatsapp_links_user_idx on public.whatsapp_links (user_id);

comment on table public.whatsapp_links is
  'Maps a WhatsApp number to a Cortex directory row so a DM can run with that person''s identity and permissions. An unlinked number is refused, logged, and never given tools. The primary key is the number, so one number reaches one workspace — same trade-off as google_chat_links.';

-- ===========================================================================
-- 7. Brain Knowledge learns the new kind of document
-- ===========================================================================
-- 0058 constrained `media_kind` to ('text','audio') and 0059 added 'meeting'.
-- A WhatsApp conversation is the third thing of that shape: words with authors
-- and times, already transcribed, with nothing for the audio worker to do. It
-- writes the same provenance columns (`recorded_at`, `duration_seconds`,
-- `speakers`) and is chunked by the same `chunkTranscript`, so every citation
-- renderer and speaker filter built for recordings works on it unchanged.
alter table public.kb_documents drop constraint if exists kb_documents_media_kind_check;
alter table public.kb_documents
  add constraint kb_documents_media_kind_check
  check (media_kind in ('text', 'audio', 'meeting', 'whatsapp'));

comment on column public.kb_documents.media_kind is
  'What the bytes are and therefore what has to be done with them. text: parse it. audio: transcribe it, then chunk by speaking turn. meeting: Google already transcribed it. whatsapp: a window of group conversation, already text, chunked by speaking turn like the other two. Only "audio" reaches the transcription worker.';

create index if not exists kb_documents_whatsapp_idx
  on public.kb_documents (collection_id, recorded_at desc)
  where media_kind = 'whatsapp';

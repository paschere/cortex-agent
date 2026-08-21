-- Live calls, kept.
--
-- WHAT WAS WRONG. When Cortex joined a Google Meet, the transcript lived in
-- the meet-bot's memory and was deleted ~30 seconds after the call ended. The
-- product copy already promised the opposite: "cuando termine, guardo el
-- transcript". Native Google transcripts (0059) are a different door — they
-- only exist if someone turned Meet transcription on, and a guest bot never
-- gets that record. So the calls Cortex actually listened to vanished.
--
-- WHAT THIS ADDS. `live_calls` is the Calls page's archive: one row per sitting
-- Cortex was in, with the people, the lines (who said what) and a pointer to
-- the Brain Knowledge document so later questions ("qué acordamos ayer") hit
-- the same search as every other meeting. The unique key is (workspace,
-- session_id) so a retry from the bot updates the same row instead of doubling
-- it. The conversation text lives HERE for the UI (speaker-attributed JSON)
-- and ALSO as a normal kb_documents row for search; deleting the KB document
-- must not erase the record that the call happened, hence `set null`.

create table if not exists public.live_calls (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null
                     references public.ba_organization(id) on delete cascade,
  -- Whose "join this call" started it. `set null` so deleting a person does
  -- not delete the workspace's record of the conversation.
  user_id          uuid        references public.users(id) on delete set null,

  -- The meet-bot session id (`m_…`). Unique per workspace: one sitting, one row.
  session_id       text        not null,
  meet_url         text        not null,
  meet_code        text,
  title            text,
  bot_name         text,

  started_at       timestamptz not null,
  ended_at         timestamptz,
  -- 'ended'  — Cortex left, or was removed, after being in the call.
  -- 'failed' — never got in, but something was said (or we still want the row).
  status           text        not null
                     check (status in ('ended', 'failed')),
  detail           text,

  participants     jsonb       not null default '[]',
  transcript       jsonb       not null default '[]',

  document_id      uuid        references public.kb_documents(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, session_id)
);

create index if not exists live_calls_org_started_idx
  on public.live_calls (organization_id, started_at desc);

create index if not exists live_calls_org_code_idx
  on public.live_calls (organization_id, meet_code, started_at desc)
  where meet_code is not null;

comment on table public.live_calls is
  'Calls Cortex joined live and kept after they ended. The JSON transcript is what the Llamadas screen replays; document_id is the Brain Knowledge copy used for search.';
comment on column public.live_calls.session_id is
  'Meet-bot session id. Unique with organization_id so a retry updates the sitting instead of duplicating it.';
comment on column public.live_calls.transcript is
  'Final lines as {text, speaker, at}[], in order. Speaker comes from Meet''s mosaic, not from Google''s own transcript API.';

alter table public.live_calls enable row level security;

-- Persistent definitions for refreshing private Feed captures. Captures remain
-- short-lived chat_attachments; this table remembers where the next one comes
-- from without copying connector credentials.
create table public.feed_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  actor_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('file','text','url','google_sheet','api')),
  name text not null check (length(name) between 1 and 240),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config)='object'),
  config_hash text not null check (length(config_hash)=64),
  latest_attachment_id uuid references public.chat_attachments(id) on delete set null,
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  status text not null default 'ready' check (status in ('ready','refreshing','ok','error','disabled')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,actor_id,kind,config_hash)
);
alter table public.feed_sources enable row level security;
revoke all on public.feed_sources from public, anon, authenticated;
grant select,insert,update,delete on public.feed_sources to service_role;

alter table public.chat_attachments drop constraint if exists chat_attachments_feed_kind_check;
alter table public.chat_attachments add constraint chat_attachments_feed_kind_check
  check (feed_kind in ('file','url','text','api'));
alter table public.chat_attachments add column feed_source_id uuid
  references public.feed_sources(id) on delete set null;
create index chat_attachments_feed_source_idx on public.chat_attachments(feed_source_id,created_at desc)
  where feed_source_id is not null;


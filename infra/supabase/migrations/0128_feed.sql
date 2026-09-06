-- Feed reuses temporary attachments and their existing seven-day byte/text purge.
-- A source can be consulted before it belongs to a conversation. It never enters
-- kb_documents unless its owner explicitly promotes it.
alter table public.chat_attachments alter column conversation_id drop not null;
alter table public.chat_attachments
  add column feed_kind text check (feed_kind in ('file', 'url', 'text')),
  add column source_url text,
  add column feed_tables jsonb,
  add column feed_truncated boolean not null default false;
alter table public.chat_attachments add constraint attachments_require_origin
  check (conversation_id is not null or (feed_kind is not null and disposition = 'turn'));
create index chat_attachments_feed_idx
  on public.chat_attachments (organization_id, created_by, created_at desc)
  where feed_kind is not null;

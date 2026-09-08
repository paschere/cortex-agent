-- Exact deduplication is private to one uploader and company. Existing snapshots
-- remain intact, including conversations and explicitly promoted knowledge.
alter table public.chat_attachments add column feed_content_hash text
  check (feed_content_hash ~ '^[a-f0-9]{64}$');
create unique index chat_attachments_feed_content_identity
  on public.chat_attachments(organization_id, created_by, feed_content_hash)
  where feed_kind is not null and feed_content_hash is not null;

-- Expired snapshots are no longer reusable. Release only their identity slot;
-- preserve their contents for the existing retention/purge mechanism.
create function public.feed_release_expired_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.feed_kind is not null and new.feed_content_hash is not null then
    update public.chat_attachments set feed_content_hash = null
      where organization_id = new.organization_id and created_by = new.created_by
        and feed_content_hash = new.feed_content_hash and purge_at <= now();
  end if;
  return new;
end;
$$;
create trigger feed_release_expired_identity before insert on public.chat_attachments
  for each row execute function public.feed_release_expired_identity();

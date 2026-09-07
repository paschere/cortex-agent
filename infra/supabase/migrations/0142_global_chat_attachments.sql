-- Identity-owned, temporary text for global chat. Never enters Brain Knowledge.
create table public.global_chat_attachments (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references public.ba_user(id) on delete cascade,
  conversation_id uuid not null references public.global_conversations(id) on delete cascade,
  source_workspace_ids text[] not null,
  filename text not null check (length(filename) between 1 and 240),
  mime text not null check (mime in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown')),
  byte_size bigint not null check (byte_size between 1 and 4194304),
  sha256 text not null check (length(sha256)=64),
  extracted_text text not null check (length(btrim(extracted_text)) > 0 and length(extracted_text) <= 24000),
  truncated boolean not null default false,
  created_at timestamptz not null default now(),
  purge_at timestamptz not null default (now()+interval '7 days'),
  check (cardinality(source_workspace_ids) <= 30)
);
create index global_chat_attachments_conversation_idx
  on public.global_chat_attachments(account_id,conversation_id,created_at desc);
alter table public.global_chat_attachments enable row level security;
revoke all on public.global_chat_attachments from public,anon,authenticated;
grant select,insert,delete on public.global_chat_attachments to service_role;

create function public.global_chat_attachment_guard()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.conversation_id::text));
  if not exists(select 1 from public.global_conversations c where c.id=new.conversation_id
    and c.account_id=new.account_id and c.workspace_ids=new.source_workspace_ids)
    or exists(select 1 from unnest(new.source_workspace_ids) s(id) where not exists(
      select 1 from public.ba_member m where m."userId"=new.account_id and m."organizationId"=s.id)) then
    raise exception 'Attachment scope must match its identity-owned conversation.';
  end if;
  delete from public.global_chat_attachments where purge_at<=now();
  if (select count(*) from public.global_chat_attachments where conversation_id=new.conversation_id)>=2 then
    raise exception 'Esta conversación alcanzó el límite de 2 adjuntos.';
  end if;
  return new;
end $$;
create trigger global_chat_attachment_guard_trg before insert on public.global_chat_attachments
for each row execute function public.global_chat_attachment_guard();

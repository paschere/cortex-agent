-- Nothing could be remembered. Every single call to cortex.remember failed.
--
-- WHAT BROKE, AND WHEN. Migration 0051 wrote `user_memory_remember()`, the one
-- door through which a memory is written — the chat tool, the nightly
-- derivation job and the settings page all go through it and there is no other
-- INSERT into public.user_memories anywhere in the product. It listed the
-- columns it fills explicitly, which is right.
--
-- Migration 0064 then gave user_memories an `organization_id` and made it NOT
-- NULL, like it did for thirty other tables. It backfilled the existing rows
-- and moved on. It never revisited the writer, so from that migration onward
-- the INSERT omitted a column that had become mandatory and Postgres refused
-- every write with 23502. The read path kept working perfectly — the three
-- SELECT functions do not name the column — so memories already stored were
-- still injected into every prompt and the feature looked alive. It could only
-- forget.
--
-- WHY NOTHING CAUGHT IT. The failure lives in the gap the repo's checks do not
-- cover: typecheck, the unit tests and the production build never execute SQL,
-- and the test double in packages/agent-tools/src/memory/isolation.test.ts
-- reimplements these functions in TypeScript, so it proves the isolation rule
-- and says nothing about the columns. `db:reset` is what would have caught it,
-- and only after 0064 was written.
--
-- THE RULE THIS RESTORES. The workspace is never an argument here. It is read
-- off the directory row, which belongs to exactly one workspace (0064 § 3), so
-- a caller cannot file a memory anywhere but where the person it is about
-- lives — the same property every other function in 0051 has, extended to the
-- column 0064 added. Only the INSERT is touched; everything else is 0051's
-- body, unchanged.

create or replace function public.user_memory_remember(
  p_user_id uuid,
  p_content text,
  p_kind memory_kind default 'fact',
  p_source memory_source default 'explicit',
  p_status memory_status default 'active',
  p_conversation_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_content text := btrim(p_content);
  v_conversation uuid;
  v_existing_status memory_status;
  v_organization text;
begin
  if p_user_id is null or char_length(v_content) < 3 then
    return null;
  end if;

  -- Fails closed, like every other guard in 0051: a user id that names nobody
  -- writes nothing rather than landing in the fallback workspace.
  select u.organization_id into v_organization
  from public.users u
  where u.id = p_user_id;

  if v_organization is null then
    return null;
  end if;

  -- Citing a conversation is citing evidence, and evidence the person cannot
  -- open is worse than none. It also must not become a way to learn that
  -- somebody else's conversation exists, so a foreign id is dropped rather
  -- than rejected.
  select c.id into v_conversation
  from public.conversations c
  where c.id = p_conversation_id and c.user_id = p_user_id;

  select m.status into v_existing_status
  from public.user_memories m
  where m.user_id = p_user_id and lower(btrim(m.content)) = lower(v_content);

  -- A suggestion must never overwrite something already settled. Re-proposing
  -- what the person rejected is how an approval step becomes a nag.
  if v_existing_status is not null and p_status = 'suggested' then
    return null;
  end if;

  if v_existing_status is null and p_status = 'suggested' then
    if (
      select count(*) from public.user_memories m
      where m.user_id = p_user_id and m.status = 'suggested'
    ) >= public.user_memory_suggestion_limit() then
      return null;
    end if;
  end if;

  insert into public.user_memories (
    user_id, organization_id, content, kind, status, source,
    source_conversation_id, source_note
  )
  values (
    p_user_id, v_organization, v_content, p_kind, p_status, p_source,
    v_conversation, p_note
  )
  on conflict (user_id, lower(btrim(content))) do update
    set kind = excluded.kind,
        -- Saying it again brings an archived or already-active memory back;
        -- it never silently downgrades one.
        status = excluded.status,
        source = excluded.source,
        source_conversation_id = coalesce(excluded.source_conversation_id,
                                          user_memories.source_conversation_id),
        source_note = coalesce(excluded.source_note, user_memories.source_note),
        updated_at = now()
        -- organization_id is deliberately NOT in this list. The conflict target
        -- is (user_id, content) and a user id names one workspace, so the row
        -- being updated is already in the right one; assigning it here would be
        -- the single statement shape that can move a row between tenants, which
        -- is exactly what apps/web's scoped client refuses to emit.
  returning id into v_id;

  -- Only an ACTIVE memory occupies a prompt slot, so only an active write can
  -- push somebody else out. A pending suggestion costs nothing until accepted.
  if p_status = 'active' then
    perform public.user_memory_enforce_cap(p_user_id, v_id);
  end if;
  return v_id;
end;
$$;

-- `create or replace` keeps the privileges 0051 granted, since the signature is
-- unchanged. Restated anyway: this function is service-role only, and a silent
-- privilege drift here is a PostgREST endpoint the world can call.
revoke all on function public.user_memory_remember(uuid, text, memory_kind, memory_source, memory_status, uuid, text) from public, anon, authenticated;
grant execute on function public.user_memory_remember(uuid, text, memory_kind, memory_source, memory_status, uuid, text) to service_role;

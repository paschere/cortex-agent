-- Knowledge Base spaces.
--
-- WHAT THIS IS. A "space" is not a new object. `kb_collections` already stored
-- exactly this — a named bucket of documents with a visibility (scope) and an
-- owner (scope_id) — it just had no product surface, four visibilities nobody
-- could explain, and no identity beyond a name. This migration keeps the table
-- and the rows and turns that latent concept into the real one:
--
--   scope = 'global'  -> a global space. Everyone in the org sees it. Only an
--                        org admin can create one.
--   scope = 'user'    -> a personal space. Exactly one person sees it, and only
--                        their own Zippy turns retrieve from it.
--
-- The other two scopes go away as product concepts (see the folding below).
-- No second table, no `space_id` alongside `collection_id`: one concept, one
-- home, renamed at the product layer. The physical column names stay so that
-- Drive sync, the ingestion job and the MCP resource layer keep working.
--
-- THE POINT OF ALL THIS is the last section: retrieval stops taking a caller-
-- supplied list of buckets and starts deriving the visible set from the user
-- id, inside the database. A personal note cannot reach someone else's answer
-- because no function exists any more that would return it.

-- ---------------------------------------------------------------------------
-- 1. A space gets an identity
-- ---------------------------------------------------------------------------
-- `name` alone cannot answer "whose is this, what is it for, is it still
-- alive". The page shows all three, and "who owns it" has to survive the owner
-- being deleted, hence `set null` rather than a cascade.
alter table public.kb_collections
  add column if not exists description text,
  add column if not exists created_by uuid references public.users(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

-- Written only by the folding steps below, and only for rows that used to be a
-- team or conversation bucket. It is the undo trail: it says what a row was
-- before this migration touched it, so the conversion is reversible by hand.
alter table public.kb_collections
  add column if not exists legacy_scope kb_scope,
  add column if not exists legacy_scope_id uuid;

comment on table public.kb_collections is
  'Spaces. A named bucket of Knowledge Base documents with exactly one visibility: global (everyone) or user (one person). The product calls these "spaces"; the table keeps its original name so ingestion, Drive sync and MCP keep resolving.';
comment on column public.kb_collections.scope is
  'global = visible to the whole org, scope_id is null. user = personal, scope_id is the one person who can see it. No other value is accepted.';
comment on column public.kb_collections.scope_id is
  'The owner of a personal space. Null for global spaces.';
comment on column public.kb_collections.created_by is
  'Who made this space. For a personal space this equals scope_id; for a global one it is the admin who published it, which is what the page shows under "who owns it".';
comment on column public.kb_collections.legacy_scope is
  'Set only on rows converted away from the retired team/conversation scopes. Null on everything else. Kept so the conversion can be reversed.';

-- ---------------------------------------------------------------------------
-- 2. Fold conversation buckets into their owner's personal space
-- ---------------------------------------------------------------------------
-- A conversation-scoped bucket was a per-chat scratchpad. Its documents belong
-- to the person who had the conversation, so they move into that person's
-- personal space: a NARROWING of visibility (from "anyone resolving that
-- conversation id" to "one named person"), never a widening. Documents are
-- moved rather than the bucket relabelled, so nobody ends up with forty
-- one-document spaces called "Conversation Documents".

-- 2a. Everyone who owns a conversation bucket needs a personal space to receive
--     its documents. `conversations.user_id` is not null, so the owner is known
--     whenever the conversation still exists; if it was deleted, fall back to
--     whoever uploaded the first document.
insert into public.kb_collections (scope, scope_id, name, created_by)
select distinct 'user'::kb_scope, owners.id, 'My notes', owners.id
from (
  select coalesce(
           (select cv.user_id from public.conversations cv where cv.id = c.scope_id),
           (select d.uploaded_by
              from public.kb_documents d
             where d.collection_id = c.id and d.uploaded_by is not null
             order by d.created_at
             limit 1)
         ) as id
  from public.kb_collections c
  where c.scope = 'conversation'
) owners
where owners.id is not null
  and not exists (
    select 1 from public.kb_collections p
    where p.scope = 'user' and p.scope_id = owners.id
  );

-- 2b. Move the documents into the owner's oldest personal space.
update public.kb_documents d
set collection_id = target.personal_id
from (
  select c.id as bucket_id,
         (select p.id
            from public.kb_collections p
           where p.scope = 'user'
             and p.scope_id = coalesce(
                   (select cv.user_id from public.conversations cv where cv.id = c.scope_id),
                   (select d2.uploaded_by
                      from public.kb_documents d2
                     where d2.collection_id = c.id and d2.uploaded_by is not null
                     order by d2.created_at
                     limit 1)
                 )
           order by p.created_at, p.id
           limit 1) as personal_id
  from public.kb_collections c
  where c.scope = 'conversation'
) target
where d.collection_id = target.bucket_id
  and target.personal_id is not null;

-- 2c. The buckets are now empty of anything with a known owner. Deleting them
--     cascades away only documents whose conversation AND uploader are both
--     gone — orphaned scratch notes nobody can be shown without guessing.
delete from public.kb_collections where scope = 'conversation';

-- ---------------------------------------------------------------------------
-- 3. Convert team buckets into global spaces
-- ---------------------------------------------------------------------------
-- This is the one visibility WIDENING in the migration and it is deliberate.
-- A team bucket held company material — playbooks, rubrics, client notes —
-- filed under a team for convenience, never under a person for privacy. Every
-- account here is on the company domain, so "the recruiting team" and "Zipdev"
-- differ in convenience, not in confidentiality. The alternative was stranding
-- the documents in a scope with no UI, which is worse. `legacy_scope` records
-- the original team so a specific bucket can be pulled back out by hand.
update public.kb_collections c
set scope = 'global',
    scope_id = null,
    legacy_scope = 'team',
    legacy_scope_id = c.scope_id,
    name = coalesce((select t.name from public.teams t where t.id = c.scope_id), c.name)
where c.scope = 'team';

-- ---------------------------------------------------------------------------
-- 4. Names people can read
-- ---------------------------------------------------------------------------
-- "Global Documents" and "My Documents" were generated names from a code path,
-- not names anyone chose. "General" is the space existing documents land in and
-- the one uploads default to when nothing else is picked.
update public.kb_collections set name = 'General'  where scope = 'global' and name = 'Global Documents';
update public.kb_collections set name = 'My notes' where scope = 'user'   and name = 'My Documents';

-- Backfill ownership on personal spaces: the owner is the creator by definition.
update public.kb_collections set created_by = scope_id where scope = 'user' and created_by is null;

-- Guarantee the landing space exists even on a workspace that never had a
-- global bucket, so "upload a document" always has a sensible default target.
insert into public.kb_collections (scope, scope_id, name, description)
select 'global'::kb_scope, null, 'General',
       'Everything the whole company should be able to ask Zippy about.'
where not exists (
  select 1 from public.kb_collections where scope = 'global' and lower(name) = 'general'
);

-- ---------------------------------------------------------------------------
-- 5. One space per name per owner
-- ---------------------------------------------------------------------------
-- Two spaces called "Rates" in the same place is a filing mistake, not a
-- feature: the picker shows the same word twice and nobody can tell which one
-- a document went to. Merge duplicates into the oldest before enforcing it —
-- creating the index first would abort the migration on any workspace that
-- already has a pair.
update public.kb_documents d
set collection_id = dup.keep_id
from (
  select id,
         first_value(id) over (
           partition by scope, scope_id, lower(name) order by created_at, id
         ) as keep_id
  from public.kb_collections
) dup
where d.collection_id = dup.id and dup.id <> dup.keep_id;

delete from public.kb_collections c
using (
  select id,
         first_value(id) over (
           partition by scope, scope_id, lower(name) order by created_at, id
         ) as keep_id
  from public.kb_collections
) dup
where c.id = dup.id and dup.id <> dup.keep_id;

-- The all-zero uuid stands in for "no owner" so global names collide with each
-- other and with nothing else; a plain multi-column index would let unlimited
-- duplicate global names through, since null <> null.
create unique index if not exists kb_collections_owner_name_idx
  on public.kb_collections (
    scope,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );

-- ---------------------------------------------------------------------------
-- 6. Only the two visibilities exist from here on
-- ---------------------------------------------------------------------------
-- The enum keeps its four labels — dropping a value from a Postgres enum in
-- use is a table rewrite for no gain — but the check makes a third kind of
-- space unrepresentable. A retrieval rule that only reasons about two cases is
-- only safe if a third case cannot be inserted behind its back.
alter table public.kb_collections drop constraint if exists kb_collections_check;
alter table public.kb_collections drop constraint if exists kb_collections_scope_check;
alter table public.kb_collections
  add constraint kb_collections_scope_check check (
    (scope = 'global' and scope_id is null)
    or (scope = 'user' and scope_id is not null)
  );

-- The page sorts personal spaces by owner and lists a person's own first.
create index if not exists kb_collections_owner_idx
  on public.kb_collections (scope_id) where scope = 'user';

-- ---------------------------------------------------------------------------
-- 7. Retrieval scoping — the boundary
-- ---------------------------------------------------------------------------
-- Everything above is filing. This is the part that makes the filing mean
-- something.
--
-- The old `kb_hybrid_search(p_collection_ids, ...)` took the list of buckets to
-- search AS AN ARGUMENT. Every caller therefore had to work out visibility for
-- itself, and each one got it slightly differently: the web search route
-- accepted a `collection_ids` array straight from the browser, the documents
-- route filtered by nothing at all, and the tool trusted whatever scopes the
-- model asked for. Any new caller would have had to remember, and one that
-- forgot leaked one person's notes into another person's answer with no error.
--
-- So the argument is gone. `kb_search_scoped` takes the USER and derives the
-- searchable set inside the database. `p_space_ids` is a filter applied on top
-- of that set — it can only ever narrow it, never add to it — so "search only
-- my Rates space" works and "search Ana's personal space" returns nothing, no
-- matter who is asking or from which surface.

create or replace function public.kb_visible_space_ids(p_user_id uuid)
returns table (space_id uuid)
language sql
stable
as $$
  select c.id
  from public.kb_collections c
  where p_user_id is not null
    and (
      c.scope = 'global'
      or (c.scope = 'user' and c.scope_id = p_user_id)
    )
$$;

comment on function public.kb_visible_space_ids(uuid) is
  'The only definition of "which spaces may this person retrieve from": every global space, plus their own personal spaces. Note there is no admin branch — an org admin can PUBLISH a global space but cannot read anyone''s personal one, because reading someone''s notes was never part of administering the workspace. A null user id yields nothing, so a caller that loses track of who it is fails closed.';

create or replace function public.kb_search_scoped(
  p_user_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_limit int default 8,
  p_space_ids uuid[] default null
)
returns table (
  document_id uuid,
  document_title text,
  space_id uuid,
  space_name text,
  space_scope kb_scope,
  chunk_index int,
  content text,
  score double precision
)
language sql
stable
as $$
  with targets as (
    -- The intersection is the whole guarantee: p_space_ids filters this set,
    -- it does not define it.
    select v.space_id as id
    from public.kb_visible_space_ids(p_user_id) v
    where p_space_ids is null or v.space_id = any(p_space_ids)
  ),
  vec as (
    select ch.document_id as doc_id, ch.chunk_index as idx, ch.content as body,
           1 - (ch.embedding <=> p_query_embedding) as vec_score
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    where d.collection_id in (select id from targets)
    order by ch.embedding <=> p_query_embedding
    limit p_limit * 4
  ),
  fts as (
    select ch.document_id as doc_id, ch.chunk_index as idx, ch.content as body,
           ts_rank(to_tsvector('simple', ch.content),
                   plainto_tsquery('simple', p_query_text)) as fts_score
    from public.kb_chunks ch
    join public.kb_documents d on d.id = ch.document_id
    where d.collection_id in (select id from targets)
      and to_tsvector('simple', ch.content) @@ plainto_tsquery('simple', p_query_text)
    order by fts_score desc
    limit p_limit * 4
  ),
  combined as (
    -- Same 0.7 semantic / 0.3 keyword blend as the function this replaces, so
    -- result ordering does not shift under people on the day spaces ship.
    select coalesce(v.doc_id, f.doc_id) as doc_id,
           coalesce(v.idx, f.idx) as idx,
           coalesce(v.body, f.body) as body,
           coalesce(v.vec_score, 0) * 0.7 + coalesce(f.fts_score, 0) * 0.3 as blended
    from vec v
    full outer join fts f on v.doc_id = f.doc_id and v.idx = f.idx
  )
  select cb.doc_id,
         d.title,
         s.id,
         s.name,
         s.scope,
         cb.idx,
         cb.body,
         cb.blended
  from combined cb
  join public.kb_documents d on d.id = cb.doc_id
  join public.kb_collections s on s.id = d.collection_id
  order by cb.blended desc
  limit p_limit;
$$;

comment on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) is
  'Hybrid Knowledge Base search restricted to what p_user_id may see. p_space_ids narrows the result to a subset of those spaces and can never widen it. This is the only search entry point: the unscoped kb_hybrid_search is dropped below so no caller can accidentally reach past the boundary.';

-- The unscoped function is removed, not deprecated. Leaving it in place would
-- leave the leak one autocomplete away, and a dropped function fails loudly at
-- the first call instead of quietly returning too much.
drop function if exists public.kb_hybrid_search(uuid[], vector, text, int);

-- PostgREST publishes every function in `public` under /rpc/. Both of these
-- take the user id as a plain argument, so anything holding an anon or
-- authenticated key could otherwise ask them for someone else's notes. The app
-- reaches them with the service role only.
revoke all on function public.kb_visible_space_ids(uuid) from public, anon, authenticated;
revoke all on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) from public, anon, authenticated;
grant execute on function public.kb_visible_space_ids(uuid) to service_role;
grant execute on function public.kb_search_scoped(uuid, vector, text, int, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 8. The tool is called kb.list_spaces now
-- ---------------------------------------------------------------------------
-- Tool ids show up in the /tools catalogue and in Zippy's own reasoning, and
-- "collections" is a word this product no longer uses anywhere a person can
-- see. Agents pin their tools by id, so the rename has to follow the rows.
update public.agents
set allowed_tool_ids = array_replace(allowed_tool_ids, 'kb.list_collections', 'kb.list_spaces')
where 'kb.list_collections' = any(allowed_tool_ids);

update public.team_tool_permissions
set tool_pattern = 'kb.list_spaces'
where tool_pattern = 'kb.list_collections'
  and not exists (
    select 1 from public.team_tool_permissions p2
    where p2.team_id = team_tool_permissions.team_id
      and p2.tool_pattern = 'kb.list_spaces'
  );

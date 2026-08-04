-- Tool selection stops being a hand-written list of regexes and starts being a
-- similarity search. This table is where the tool vectors live.
--
-- WHY THIS EXISTS AT ALL. Past ~40 function declarations the model picks tools
-- measurably worse, so the catalogue has to be narrowed per turn. Until now the
-- narrowing was a regex per family in apps/web/app/api/chat/route.ts, and the
-- list was never complete: `vehicles` shipped registered and granted but
-- matched no pattern, so it was filtered out of every single request and the
-- model answered — truthfully, from where it stood — that it had no access to
-- the RUNT. `meetings`, `inbox`, `chat` and `security` were in the same state.
-- Worse, /integrations lets any user connect their own MCP server: those tools
-- appear between one turn and the next and there is no regex anyone could have
-- written for them in advance. They were invisible by construction.
--
-- The replacement compares the request against what each tool SAYS IT DOES.
-- A family that did not exist when this migration ran is handled by the same
-- code path as one that did, because there is no list for it to be missing
-- from. That is the entire point; everything below is bookkeeping for it.
--
-- WHY A TABLE AND NOT JUST MEMORY. The vector for `vehicles.lookup_plate` is
-- the same for every user, every request and every instance. Embedding it at
-- each lambda cold start would turn a one-off 40ms into a tax paid forever, and
-- a cold start is exactly the moment a turn can least afford an extra second.
-- The process still keeps an in-memory copy — the table is read once per
-- instance per unfamiliar tool, in parallel with the query embedding, so a warm
-- turn touches neither Postgres nor Voyage for this.
--
-- WHY THE HASH COLUMN IS LOAD-BEARING. Descriptions are prompt engineering:
-- they are edited constantly and they ship with the code. `text_hash` is a
-- digest of the exact text that was embedded, which makes "is this vector still
-- true" answerable without a deploy marker, without a version column, and
-- correctly when two releases run side by side — instances only ever disagree
-- about rows whose text genuinely differs.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
-- `tool_key` is the registry id for a built-in tool (`vehicles.lookup_plate`)
-- and `mcp:<server_uuid>:<tool_name>` for a tool proxied from a user's own MCP
-- server. One namespace, because ranking treats them identically and the
-- alternative — two tables joined at read time — buys nothing.
--
-- No foreign key to user_mcp_servers, deliberately. A vector is derived data
-- about a string; it is not owned by the row that happened to produce the
-- string, and cascading a delete into it would only mean re-embedding the
-- moment the same server is reconnected. Orphans are a few kilobytes and are
-- swept by the statement at the bottom.

create table if not exists public.tool_embeddings (
  tool_key   text primary key,
  -- Denormalised from the key so a human can see at a glance what is indexed,
  -- and so orphaned MCP rows are greppable. Never read by the ranking code.
  family     text not null,
  -- Digest of the embedded text (id + family + description), not of the
  -- description alone: the id and family are folded in before embedding
  -- precisely so a two-word description still has something to match on.
  text_hash  text not null,
  -- voyage-3-large at output_dimension 1024, input_type "document" — the same
  -- space kb_chunks.embedding lives in (migration 0057). The QUERY side uses
  -- input_type "query"; Voyage is trained asymmetrically and mixing the two
  -- degrades ranking silently. See packages/agent-tools/src/kb/embedder.ts.
  embedding  vector(1024) not null,
  updated_at timestamptz not null default now()
);

comment on table public.tool_embeddings is
  'One row per tool the agent can offer, holding the embedding of its description. Read by packages/agent-tools/src/tool-selection to decide which tools a turn gets. Safe to truncate: every row is derived and is rebuilt in the background within a turn or two of being missing.';

comment on column public.tool_embeddings.text_hash is
  'Digest of the exact text that was embedded. A mismatch means the description changed and the vector is stale; the app re-embeds in the background and the tool is sent to the model unconditionally in the meantime.';

-- ---------------------------------------------------------------------------
-- No vector index, and that is not an oversight
-- ---------------------------------------------------------------------------
-- kb_chunks gets an HNSW index because it is a corpus growing without bound and
-- is queried with ORDER BY <=> LIMIT n. This table is neither. It holds one row
-- per tool — a few hundred, and only ever as many as the product has tools —
-- and it is never queried by similarity in Postgres at all. The app fetches the
-- candidate rows by primary key, caches them in the process, and scores them in
-- TypeScript: a few hundred 1024-dim dot products is well under a millisecond,
-- and doing it locally is what lets a warm instance rank tools with no database
-- round-trip whatsoever. An HNSW graph here would be pure write amplification
-- on a table whose rows are rewritten every time someone edits a description.
--
-- A btree on `family` would be equally pointless at this row count.

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Deny-all RLS with the app reaching it through the service role, matching
-- every other machine-owned table in this schema (kb_chunks, 0008). There is no
-- per-user read path: tool descriptions are not user data, and the scoping that
-- matters — which tools a person may call — happens before ranking, in the
-- agent grant and the team deny-list, not here.

alter table public.tool_embeddings enable row level security;

revoke all on table public.tool_embeddings from public, anon, authenticated;
grant select, insert, update, delete on table public.tool_embeddings to service_role;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
-- Rows for MCP tools whose server was removed, or for families retired from the
-- code, stop being refreshed and simply sit there. They cost nothing at read
-- time (lookups are by key), so this is idempotent tidying rather than a job:
-- anything untouched for a quarter is either gone or will re-embed on its next
-- use at a cost of one background call.

delete from public.tool_embeddings
where updated_at < now() - interval '90 days';

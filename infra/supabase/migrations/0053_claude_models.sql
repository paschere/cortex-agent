-- Generation moves from Gemini to Claude.
--
-- Only the GENERATING model changes. Embeddings stay on Gemini: Anthropic ships
-- no embedding endpoint, and the pgvector indexes in 0007 are built for the 768
-- dimensions gemini-embedding-001 returns — repointing the embedder would mean
-- re-embedding every kb_chunk. See packages/agent-tools/src/model.ts.

update public.agents
   set default_model = 'claude-opus-5'
 where default_model like 'gemini-%';

-- New agents default to Claude too. The old column default still named a
-- Gemini model (migration 0002), so any row inserted without an explicit
-- default_model would have silently reintroduced a provider we no longer call.
alter table public.agents
  alter column default_model set default 'claude-opus-5';

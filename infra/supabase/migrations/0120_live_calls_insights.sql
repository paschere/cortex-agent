-- Live calls: what Cortex made of them, and whether they belong in the Brain.
--
-- WHAT WAS WRONG. Every call Cortex sat in was filed into Brain Knowledge the
-- moment it ended — a two-minute "can you hear me" sitting got the same
-- treatment as a one-hour negotiation. The Brain is the company's memory;
-- filling it with noise makes every later search worse.
--
-- WHAT THIS ADDS. When a call ends, Cortex reads the transcript once and keeps
-- the reading here: a title worth showing, a summary, the decisions, the
-- commitments and next steps (`insights`), and a verdict on whether the call
-- is worth remembering (`brain_status` + `brain_reason`). The verdict is
-- Cortex's by default and a person's when they override it from the Calls
-- page: `brain_decided_by` says which, so the screen can say "Cortex la
-- guardó porque…" or "La sacaste tú".
--
--   brain_status: 'pending'  — not analysed yet (the bot just hung up)
--                 'kept'     — filed in Brain Knowledge (document_id set)
--                 'skipped'  — deliberately left out

alter table public.live_calls
  add column if not exists insights         jsonb,
  add column if not exists analyzed_at      timestamptz,
  add column if not exists brain_status     text not null default 'pending'
    check (brain_status in ('pending', 'kept', 'skipped')),
  add column if not exists brain_reason     text,
  add column if not exists brain_decided_by text
    check (brain_decided_by is null or brain_decided_by in ('cortex', 'person')),
  add column if not exists brain_space_id   uuid
    references public.kb_collections(id) on delete set null;

-- Rows filed before this migration were all kept automatically.
update public.live_calls
   set brain_status = 'kept', brain_decided_by = 'cortex',
       brain_reason = 'Guardada automáticamente (antes de que Cortex decidiera por llamada).'
 where document_id is not null and brain_status = 'pending';

comment on column public.live_calls.insights is
  'Cortex''s reading of the call: {title, summary, highlights[], decisions[], commitments[{who,what,when}], nextSteps[], openQuestions[], worthKeeping, reason}.';
comment on column public.live_calls.brain_status is
  'pending = not analysed yet; kept = filed in Brain Knowledge; skipped = deliberately left out.';

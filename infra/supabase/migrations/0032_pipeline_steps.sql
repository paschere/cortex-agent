-- Pipelines v2: structured steps (the deck's visual language — purple nodes
-- for Cortex work, YOU nodes for human checkpoints) and a run log.
--
-- steps: [{title, detail, tools: [tool ids], checkpoint: bool}]
--   checkpoint=true → the model must present findings and WAIT for the user's
--   decision before continuing (rendered as a YOU node in the UI).
-- intro: optional context paragraph shown before step 1.
-- emoji: card flair in the /pipelines gallery.
alter table public.pipelines
  add column if not exists steps jsonb not null default '[]',
  add column if not exists intro text not null default '',
  add column if not exists emoji text not null default '⚡';

-- Run log: who ran what with which args, when. Status is best-effort (the
-- executing model reports completion via pipeline.finish_run when it's done).
create table if not exists public.pipeline_runs (
  id          uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.pipelines(id) on delete cascade,
  run_by      uuid references public.users(id) on delete set null,
  args        jsonb not null default '{}',
  status      text not null default 'started',   -- started | completed | abandoned
  summary     text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists pipeline_runs_pipeline_idx
  on public.pipeline_runs(pipeline_id, started_at desc);

alter table public.pipeline_runs enable row level security;
-- Service-role only, as everywhere else.

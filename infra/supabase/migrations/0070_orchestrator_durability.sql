-- Orchestrator durability: a run can no longer say "running" about a process
-- that died.
--
-- WHAT WAS WRONG. A run was executed by `after()` inside the POST that started
-- it, so it lived and died with one Vercel invocation: it was cut off at
-- `maxDuration`, and it evaporated on every redeploy. Neither ending had anyone
-- left to write the terminal row, and nothing looked for the wreckage — so the
-- console showed "Ejecutando" over a dead run, for ever. Execution now happens
-- in Inngest (apps/web/inngest/functions/orchestrator-run.ts), whose steps are
-- durable, but durable is not immortal: this migration adds the state a sweep
-- needs to notice a run that stopped signalling, whatever killed it.
--
-- THREE THINGS ARRIVE HERE.
--
--   last_heartbeat_at  The last moment the run was observably alive. Written by
--                      every event the run appends (throttled, see
--                      lib/orchestrator/lifecycle.ts) and at every step
--                      boundary. Silence on this column is the ONLY evidence
--                      that a run died, because a process that dies cannot
--                      report that it did.
--
--   claimed_at         Single-flight. The executor claims a run with a
--                      conditional UPDATE guarded on `claimed_at is null`, so a
--                      replayed event or a second worker finds nothing to take.
--
--   status 'interrupted'
--                      The honest fourth ending. `failed` means the run tried
--                      and could not; `cancelled` means a person stopped it;
--                      `interrupted` means nobody knows how it ended because it
--                      stopped talking. Folding this into `failed` would blame
--                      the work for an infrastructure death, and folding it into
--                      `cancelled` would blame the person.

-- ---------------------------------------------------------------------------
-- 1. Liveness columns
-- ---------------------------------------------------------------------------

alter table public.orchestration_runs
  add column if not exists last_heartbeat_at timestamptz not null default now(),
  add column if not exists claimed_at        timestamptz;

comment on column public.orchestration_runs.last_heartbeat_at is
  'Last moment this run was observably alive. Advanced by the executor at every step boundary and (throttled to ~30s) by every event it appends. The sweep in inngest/functions/orchestrator-sweep.ts closes runs that have been silent past lib/orchestrator/liveness.ts STALE_AFTER_MS.';

comment on column public.orchestration_runs.claimed_at is
  'When the executor took this run. Set by a conditional UPDATE guarded on `claimed_at is null`, so no run can be started twice by a replayed event or a second worker.';

-- Existing rows were just defaulted to now(), which would tell the sweep that a
-- run abandoned four hours ago is alive. The last thing we actually know about
-- each of them is when it started, or failing that when it was created.
update public.orchestration_runs
   set last_heartbeat_at = coalesce(started_at, created_at);

-- ---------------------------------------------------------------------------
-- 2. The fourth ending
-- ---------------------------------------------------------------------------

alter table public.orchestration_runs drop constraint if exists orchestration_runs_status_check;
alter table public.orchestration_runs
  add constraint orchestration_runs_status_check
  check (status in ('planning', 'running', 'completed', 'failed', 'cancelled', 'interrupted'));

-- The sweep's only query: live runs ordered by how long they have been quiet.
-- Partial, because the answer is never about the thousands of finished rows.
create index if not exists orchestration_runs_silence_idx
  on public.orchestration_runs (last_heartbeat_at)
  where status in ('planning', 'running');

-- ---------------------------------------------------------------------------
-- 3. Close the runs that are already hanging
-- ---------------------------------------------------------------------------
--
-- The sweep would reach these on its own within five minutes of deploy — the
-- backfill above makes them stale by its threshold. They are closed here anyway
-- so the fix is complete the moment the migration lands, rather than the moment
-- the first cron fires, and so the truth does not depend on Inngest having
-- synced correctly.
--
-- The prose matches INTERRUPTED_SUMMARY / INTERRUPTED_TASK_ERROR /
-- SKIPPED_TASK_ERROR in apps/web/lib/orchestrator/liveness.ts. Keep them in step.

create temporary table stale_runs as
  select id
    from public.orchestration_runs
   where status in ('planning', 'running')
     -- 15 minutes: the threshold argued for in lib/orchestrator/liveness.ts.
     and last_heartbeat_at < now() - interval '15 minutes';

update public.orchestration_runs
   set status = 'interrupted',
       finished_at = coalesce(finished_at, now()),
       summary = coalesce(
         summary,
         E'**Esta ejecución se interrumpió.**\n\n' ||
         E'Dejó de dar señales de vida y no escribió su informe final, así que la damos por ' ||
         E'muerta. No falló por sí sola y nadie la detuvo: lo más probable es que el proceso ' ||
         E'que la ejecutaba se haya caído o lo haya reemplazado un despliegue. Lo que ' ||
         E'alcanzaron a producir los subagentes de arriba se conservó. Vuelve a lanzar el ' ||
         E'objetivo cuando quieras.'
       )
 where id in (select id from stale_runs);

-- A sub-agent that was mid-task when the process died did not fail at its work;
-- it was cut off. `failed` is the closest honest task status and the message
-- says which of the two it was.
update public.orchestration_tasks
   set status = 'failed',
       error = coalesce(error, 'Este subagente iba trabajando cuando la ejecución se interrumpió. No alcanzó a entregar su resultado.'),
       finished_at = coalesce(finished_at, now())
 where run_id in (select id from stale_runs)
   and status = 'running';

update public.orchestration_tasks
   set status = 'skipped',
       error = coalesce(error, 'La ejecución se interrumpió antes de que a este subagente le llegara el turno.'),
       finished_at = coalesce(finished_at, now())
 where run_id in (select id from stale_runs)
   and status = 'pending';

-- The console is driven by the event log, so a run closed behind its back has
-- to say so there too: an open console gets these on its next poll, and a
-- reload replays them.
insert into public.orchestration_events (run_id, task_id, kind, payload)
select r.id,
       null::uuid,
       'error',
       jsonb_build_object(
         'message',
         'Esta ejecución dejó de dar señales y se dio por interrumpida.'
       )
  from public.orchestration_runs r
 where r.id in (select id from stale_runs);

insert into public.orchestration_events (run_id, task_id, kind, payload)
select r.id,
       null::uuid,
       'run_done',
       jsonb_build_object('status', 'interrupted', 'summary', r.summary, 'totalTokens', r.total_tokens)
  from public.orchestration_runs r
 where r.id in (select id from stale_runs);

drop table stale_runs;

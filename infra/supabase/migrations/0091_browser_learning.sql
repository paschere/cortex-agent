-- Un trámite puede estar cerrado con llave sin estar roto.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- The most likely way a learned trámite fails is the one the module could not
-- express. Somebody teaches an errand on a portal they are already signed in
-- to -- which is everybody, because signing in is not part of the errand and
-- nobody thinks to record it. The recording therefore starts INSIDE a session.
-- Cortex replays it from a clean browser, lands on the login form, and the
-- first step finds nothing.
--
-- Everything downstream then read that correctly and concluded the wrong thing:
--
--   * `classify.ts` saw "debe iniciar sesión" on the page and filed it as
--     `legitimate` -- the portal answered and said no. Which is true of the
--     words and false of the situation: nothing was refused. We arrived at a
--     door with no key.
--   * The person was told the portal had rejected the trámite, which is not
--     something they can act on, and the run row said `legitimate`, which is
--     the code for "do not touch this flow, the data was wrong".
--   * With the login guard removed from the picture it would have been worse:
--     rules 9 and 10 would have shouted `site-changed`, handed a model a login
--     form, and had it rewrite a perfectly good errand to fill in a username
--     box at step four.
--
-- None of those is a failure of the errand. All of them are ONE UNANSWERED
-- QUESTION -- which account should Cortex use -- and a question has an answer,
-- given once, by a person who was standing right there when the recording was
-- made.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS ADDS, AND WHY IT IS TWO SMALL THINGS
-- ---------------------------------------------------------------------------
-- 1. `failure_kind` gains `needs-login`. It is a fourth kind rather than a flag
--    on the existing three because the whole point of that column is that its
--    value decides what happens next, and this one decides something none of
--    the others do: do not retry (unlike `transient`), do not tell the person
--    the portal said no (unlike `legitimate`), and above all do not let a model
--    near the flow (unlike `site-changed`). Folding it into `legitimate` would
--    make the histogram lie about the single most common way this module fails.
--
-- 2. `browser_flows.login_required`. Memory, so that the SECOND run does not
--    drive a browser to the same locked door before asking the same question.
--    Set by the verification pass the moment it happens -- which is while the
--    person who taught the errand is still on the review screen and still
--    remembers which account they used.
--
-- WHY NOT A NEW `status`. Tempting, and wrong. `status` answers "can this be
-- trusted to run unattended", and its three values (propuesto / probado / roto)
-- are read by the screen, by the agent's tool filter and by anybody deciding
-- whether to schedule something. A flow waiting for a credential is not a
-- fourth answer to that question: an unproven one is still propuesto and a
-- proven one whose session lapsed is still probado. Adding a value would also
-- change a check constraint that three surfaces already switch on, to say
-- something that belongs on a different axis. So it is its own boolean, and
-- `status` keeps meaning exactly what it meant.
--
-- ---------------------------------------------------------------------------
-- WHY THE CONSTRAINT IS DROPPED AND REBUILT
-- ---------------------------------------------------------------------------
-- 0087 wrote the check inline, so Postgres named it `<table>_<column>_check`.
-- A column check cannot be extended in place; it is dropped and recreated. The
-- drop is `if exists` so this migration is safe to re-run, and the new one is
-- named explicitly so the next person does not have to guess again.

alter table public.browser_flow_runs
  drop constraint if exists browser_flow_runs_failure_kind_check;

alter table public.browser_flow_runs
  add constraint browser_flow_runs_failure_kind_check
  check (failure_kind in ('transient', 'legitimate', 'site-changed', 'needs-login'));

comment on column public.browser_flow_runs.failure_kind is
  'Por qué falló, y por lo tanto qué se hace: transient = reintentar, '
  'legitimate = el portal respondió que no, site-changed = el modelo puede '
  'intentar repararlo, needs-login = no falló, falta la credencial. Sólo '
  'site-changed autoriza a un modelo a tocar el flujo.';

alter table public.browser_flows
  add column if not exists login_required boolean not null default false;

comment on column public.browser_flows.login_required is
  'El sitio exige una sesión que este trámite no sabe crear solo. Lo pone la '
  'pasada de verificación cuando un run cae en una pantalla de acceso y el '
  'flujo no tiene ningún paso de ingreso. Con esto puesto y sin credencial '
  'vinculada, ejecutar no abre navegador: pregunta.';

-- The flows that are already in this state, so the fix reaches them without
-- anybody having to run each one to find out. Deliberately narrow: only flows
-- whose last error was the login-page verdict, and only when they carry no
-- credential of their own. A flow with a credential that failed is a different
-- problem and is left alone.
update public.browser_flows
   set login_required = true
 where credential_id is null
   and last_error is not null
   and (
     last_error ilike '%inicio de sesión%'
     or last_error ilike '%iniciar sesión%'
     or last_error ilike '%la sesión se venció%'
   );

-- ---------------------------------------------------------------------------
-- Y EL PAPEL: un trámite que descarga algo vuelve con el archivo.
-- ---------------------------------------------------------------------------
-- Most of these errands end in a file -- a certificate, a paz y salvo, a bank
-- statement. Until now the flow reached the results page and stopped there,
-- which is sending somebody to do an errand and having them come back without
-- the paper.
--
-- The file is filed as an ORDINARY `kb_documents` row, in the personal space of
-- whoever ran the trámite, and handed to the same ingestion an upload goes
-- through. That is the whole implementation: it is parsed, chunked, embedded
-- and run through the structured extraction of migration 0076 by machinery that
-- has never heard of trámites and does not need to.
--
-- All this adds is the provenance, and the reason it needs its own enum value
-- rather than passing as `upload` is that nobody uploaded it. "Where did this
-- certificate come from" is the first question anybody asks of a document no
-- human fetched, and the answer has to be in the row rather than inferred from
-- a title. The rest of the provenance -- which portal, which trámite, which
-- run, when -- goes in `metadata.tramite`, which needs no schema.
--
-- Added here and USED from application code in a later transaction, which is
-- the constraint migration 0081 already ran into: Postgres will not let a new
-- enum value be used in the transaction that created it.
alter type document_source add value if not exists 'tramite';

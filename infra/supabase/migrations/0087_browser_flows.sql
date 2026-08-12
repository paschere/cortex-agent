-- Doing paperwork on other people's websites, taught once and repeated for free.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- Cortex can answer. It cannot go to a portal, log in, fill a form and come
-- back with the certificate. Half of what an administrator in Bogota does all
-- day is exactly that: RUNT, SIMIT, the DIAN, the chamber of commerce, a
-- customer's supplier portal. `packages/agent-tools/src/vehicles/client.ts`
-- already proves the value and also proves the cost -- it talks to a scraper
-- somebody wrote by hand for two sites, and a third site means writing a third
-- scraper.
--
-- This is the general version, and the shape of it is the whole idea: a person
-- performs the errand ONCE while Cortex watches, and from the second time on
-- Cortex repeats it with NO LANGUAGE MODEL IN THE LOOP. An agent that reasons
-- about every click is slow, expensive and non-deterministic. A flow that
-- replays a path it already knows is none of those things: it is a few seconds
-- of Playwright, it costs nothing, and it produces the same result every time.
-- `docs/operations/browser.md` carries the measured comparison.
--
-- ---------------------------------------------------------------------------
-- HOW IT IS TAUGHT: THE PERSON'S OWN BROWSER, NOT OURS
-- ---------------------------------------------------------------------------
-- Teaching is a screen share of ONE TAB. The person presses "Ensename", picks
-- the tab they were going to use anyway, does the errand in their own browser
-- with the sessions they already have open, and stops. Cortex reads the
-- recording and PROPOSES a flow.
--
-- The alternative -- a browser Cortex drives, instrumented to capture DOM
-- events -- produces cleaner data and would never be used. Nobody opens a
-- special browser to teach a tool; they do the errand the way they always do
-- it. A capture mechanism that requires changing tools has a quality of zero,
-- because it runs zero times.
--
-- And the recording is enough, because of what the locators are made of.
-- Playwright resolves elements by VISIBLE TEXT, accessible role and field
-- label -- getByRole, getByLabel, getByText -- and those are exactly the things
-- a picture of the page shows: the words on the button, the label beside the
-- field, the heading on the page. A structural CSS path could not be read off a
-- video, but a structural CSS path is also the selector that breaks first when
-- a portal is restyled. Reading the page the way a person reads it produces
-- locators that outlive redesigns.
--
-- WHAT THE RECORDING CANNOT SEE is stated here because the module has to be
-- honest about it rather than paper over it. A shared tab gives pixels, not
-- events: there is no click stream, no keydown, no DOM. Everything is inferred
-- from what changed on screen between frames. `docs/operations/browser.md` § 6
-- lists the step kinds that survive that and the ones that do not.
--
-- ---------------------------------------------------------------------------
-- A FLOW FROM A RECORDING IS A HYPOTHESIS
-- ---------------------------------------------------------------------------
-- It is never trusted on the model's word. The moment a flow is extracted it is
-- REPLAYED against the real site with the same inputs the person used, and only
-- a clean end-to-end replay marks it `ready`. A flow that did not reproduce is
-- saved `draft` with the failing step named. The screen says which is which in
-- those words -- probado / propuesto -- because the difference is everything on
-- the day somebody schedules one to run unattended at 3am.
--
-- ---------------------------------------------------------------------------
-- WHAT IS KEPT FROM THE RECORDING: NOTHING
-- ---------------------------------------------------------------------------
-- There is no video column here, and no frame table, because no video and no
-- frame is ever written to this database. The browser samples key frames
-- locally, posts them to one endpoint that passes them straight to the model,
-- and the response is a step list. The images are never persisted, never
-- queued and never reach object storage; when the request ends they are gone.
--
-- That is a stronger answer than a retention window, and it is available
-- because extraction is a single synchronous call. A screen recording of
-- somebody's working day is a liability nobody asked us to hold, and the
-- cheapest way not to leak it is not to have it. All that survives is
-- `recording_frames` -- a count -- and the extraction cost, so the teaching
-- step can be audited and priced without keeping the pictures.
--
-- Typed text is a separate hazard and gets its own defence. A password field
-- renders as dots, so the camera does not see the characters -- but a visible
-- credential field, a revealed password or a password manager overlay can put
-- one on screen. So anything the extractor reads out of a field whose label
-- looks like a credential is discarded and rewritten as
-- `value.kind = 'secret'` before the proposal is ever returned
-- (browser/redact.ts). The characters are dropped, not masked.
--
-- ---------------------------------------------------------------------------
-- WHY SIX TABLES
-- ---------------------------------------------------------------------------
--   1  browser_credentials     the login, encrypted, stored apart from the flow
--   2  browser_flows           the errand: where it starts, what it does, HOW
--   3  browser_flow_versions   every edition of the steps, including repairs
--   4  browser_flow_grants     who is allowed to run one that carries a login
--   5  browser_flow_runs       one row per execution, with time and cost on it
--   6  browser_flow_run_steps  what it actually did, step by step, for audit
--
-- The split that matters most is 1 from 2. A credential is not part of a
-- procedure: the same DIAN login is used by four different errands, it rotates
-- on its own schedule, and -- decisively -- a flow is exported, copied and read
-- on a screen while a credential must never be any of those things. Keeping
-- them in one table would mean every read of "what does this flow do" carries
-- the password along for the ride, and one careless `select *` would put it in
-- a log. They are joined by an id and nothing else.
--
-- 3 exists because of repair. When a portal changes and the model works out the
-- new selector, that finding has to become the flow's next version rather than
-- a patch applied to one run -- otherwise the same repair is paid for again
-- tomorrow. An append-only version table also means a repair that turns out to
-- be wrong can be read, blamed and rolled back, which a jsonb column overwritten
-- in place cannot.
--
-- ---------------------------------------------------------------------------
-- WHAT A STEP IS, AND WHY IT IS NOT A COORDINATE
-- ---------------------------------------------------------------------------
-- The recorder stores ACTIONS WITH RANKED SELECTORS, never pixels:
--
--   {
--     "action": "fill",
--     "label":  "Numero de placa",
--     "targets": [
--       { "kind": "testid", "value": "placa-input",           "score": 100 },
--       { "kind": "label",  "value": "Numero de placa",       "score": 80  },
--       { "kind": "name",   "value": "txtPlaca",              "score": 70  },
--       { "kind": "css",    "value": "#form > div:nth-child(2) input", "score": 10 }
--     ],
--     "value":  { "kind": "template", "text": "{{placa}}" },
--     "landmarks": ["Consulta de vehiculos", "Registro Unico Nacional"]
--   }
--
-- Several targets, ordered, because that is what makes a flow survive a
-- redesign without anybody being called. Replay tries them in order and takes
-- the first that resolves to exactly one element. When target 1 fails and
-- target 3 works, that is DRIFT: the step is rewritten with the working target
-- promoted, no model is consulted, and the flow keeps working. Only when EVERY
-- target fails does anything more expensive happen.
--
-- `value.kind` is the answer to "what changes between two runs":
--
--   literal    the same text every time (a dropdown choice, a fixed date range)
--   template   carries {{name}} holes filled from the run's inputs -- the plate,
--              the NIT, the month. This is what makes a recording a PROCEDURE
--              rather than a recording of one particular errand.
--   secret     names a field of the bound credential. Never a variable, never a
--              literal, and never written into `steps` -- the step holds the
--              FIELD NAME, and the value is fetched from browser_credentials at
--              execution time and never returned anywhere.
--
-- `landmarks` are page-level texts observed at record time. They are how a
-- failure is classified: see the note on § 5.
--
-- ---------------------------------------------------------------------------
-- READING VERSUS WRITING ON SOMEBODY ELSE'S SITE
-- ---------------------------------------------------------------------------
-- `effect` is not a label, it is the approval boundary. A flow that downloads a
-- certificate is a read: worst case it is a wasted minute. A flow that files a
-- return, accepts a quote or sends a form to a government body is a write, and
-- it acts with the company's identity on a system nobody here controls. Writes
-- go through the same approval card as any other consequential tool call, and
-- the column is `not null` with a check so a flow cannot exist without somebody
-- having decided which it is.
--
-- ===========================================================================
-- 1. Credentials
-- ===========================================================================

create table if not exists public.browser_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,

  -- What a person calls it: "DIAN - representante legal".
  label text not null,
  -- The origin it belongs to, normalised to scheme://host. A flow may only bind
  -- a credential whose host matches its own start_url, so a login for one
  -- portal cannot be replayed into another one by editing a flow.
  host text not null,

  -- The NAMES of the fields inside the blob -- 'usuario', 'clave', 'nit'. Held
  -- in the clear on purpose: the teaching screen has to offer them when binding
  -- a step, and a name is not a secret. The values never leave § 1 unencrypted.
  field_names text[] not null default '{}',

  -- AES-256-GCM over a JSON object, packed iv|tag|ciphertext and base64'd by
  -- packages/core/src/crypto.ts -- the same routine and the same
  -- TOKEN_ENCRYPTION_KEY that protects the OAuth tokens in `integrations`.
  -- Bytes, not readable text, so a database dump is not a password list.
  secret_encrypted text not null,

  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Written on every run that uses it. The one honest answer to "is this login
  -- still in use or can we delete it".
  last_used_at timestamptz
);

comment on table public.browser_credentials is
  'A login for a third-party portal, encrypted at rest with TOKEN_ENCRYPTION_KEY. Separate from browser_flows because a credential is shared across errands, rotates on its own schedule, and -- unlike a flow -- must never be exported, rendered or logged. Only the field NAMES are readable; the values are decrypted inside the run and are never returned by any API route.';

comment on column public.browser_credentials.host is
  'scheme://host this login belongs to. A flow may only bind a credential whose host equals its own, so a stored password cannot be aimed at a different site by editing the flow.';

comment on column public.browser_credentials.secret_encrypted is
  'iv|tag|ciphertext, base64. Decrypted only in the execution path, only to be handed to the browser service for one run. Never selected by a list endpoint.';

create unique index if not exists browser_credentials_label_idx
  on public.browser_credentials (organization_id, lower(label));

create index if not exists browser_credentials_host_idx
  on public.browser_credentials (organization_id, host);

-- ===========================================================================
-- 2. Flows
-- ===========================================================================

create table if not exists public.browser_flows (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,

  -- Stable machine name, used by the agent tool: 'certificado-tradicion'.
  slug text not null,
  name text not null,
  description text not null default '',

  start_url text not null,
  -- Derived from start_url on write. Kept as a column so the credential-host
  -- check is a plain comparison rather than string surgery in six places.
  host text not null,

  -- The approval boundary. See the header note.
  effect text not null check (effect in ('read', 'write')),

  -- draft   PROPUESTO. Read out of a recording and never yet reproduced. Shown,
  --         editable, runnable by hand -- and NOT offered to the agent, and not
  --         schedulable, because nobody has seen it work.
  -- ready   PROBADO. Replayed end to end against the real site at least once.
  -- broken  replay failed in a way repair could not fix, or repair thrashed.
  --         Stays visible on the screen with its reason -- a flow that quietly
  --         disappears is how a library rots without anybody noticing.
  status text not null default 'draft' check (status in ('draft', 'ready', 'broken')),

  -- Where the steps came from. `recording` means a model read them off a screen
  -- share and they are therefore a guess until verified_at is set; `manual`
  -- means a person wrote or edited them on the screen.
  source text not null default 'recording' check (source in ('recording', 'manual')),

  -- When a replay of exactly these steps last finished the whole errand, and
  -- which run proved it. Cleared on every edit and on every repair, because a
  -- proof is about a specific step list and stops being one the moment the list
  -- changes. This pair, not `status` alone, is what the screen reads to say
  -- "probado el 11 ago" instead of just "probado".
  verified_at timestamptz,
  verified_run_id uuid,

  -- Teaching cost and scale, kept so the one-off expense of learning an errand
  -- can be weighed against the runs it saves. The frames themselves are NOT
  -- kept -- see the header. This is a count and a number of dollars.
  recording_frames integer not null default 0,
  extraction_cost_usd numeric(12, 6) not null default 0,

  credential_id uuid references public.browser_credentials (id) on delete set null,

  -- [{ name, label, example, required }] -- the holes in the templates.
  variables jsonb not null default '[]'::jsonb,
  -- The step list. Shape documented in the header.
  steps jsonb not null default '[]'::jsonb,
  version integer not null default 1,

  -- Repair governance. A flow that has been repaired three times inside a day
  -- is not drifting, it is being rewritten by a model against a page nobody
  -- checked, so the fourth attempt marks it broken and asks for a human.
  repairs_in_window integer not null default 0,
  repair_window_started_at timestamptz,

  last_run_at timestamptz,
  last_run_status text,
  last_error text,

  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.browser_flows is
  'One learned errand on a third-party website. `steps` holds actions with RANKED SELECTORS -- role and accessible name, label, form field name, test id -- never coordinates, because a flow learned from coordinates breaks the day a button moves. `effect` decides whether running it needs an approval.';

comment on column public.browser_flows.steps is
  'Ordered actions. Each carries several candidate selectors best-first, a value that is literal / template / secret, and the page landmarks seen while recording. Replay walks the candidates; the landmarks are what tell a changed site apart from a failed errand.';

comment on column public.browser_flows.variables is
  'The parts that differ between two runs -- the plate, the NIT, the month -- named, so a recording of one errand becomes a procedure for all of them. A recording with no variables can only ever repeat itself, which is worth nothing.';

comment on column public.browser_flows.status is
  'draft is PROPUESTO -- read off a recording, never yet reproduced, and therefore a hypothesis: usable by hand, invisible to the agent, not schedulable. ready is PROBADO. broken is deliberately loud and deliberately persistent, because the failure mode this whole module has to survive is a library of errands that silently stopped working six months ago.';

comment on column public.browser_flows.verified_at is
  'Null until a replay of exactly these steps completed the whole errand. Cleared by every edit and every repair -- a proof belongs to one step list and expires when the list changes.';

comment on column public.browser_flows.recording_frames is
  'How many key frames the extractor was given. The frames are not stored anywhere; this is the only trace the teaching session leaves, and it exists so the cost beside it can be read in proportion.';

create unique index if not exists browser_flows_slug_idx
  on public.browser_flows (organization_id, slug);

create index if not exists browser_flows_listing_idx
  on public.browser_flows (organization_id, status, updated_at desc);

create index if not exists browser_flows_credential_idx
  on public.browser_flows (credential_id)
  where credential_id is not null;

-- ===========================================================================
-- 3. Versions
-- ===========================================================================

create table if not exists public.browser_flow_versions (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.browser_flows (id) on delete cascade,

  version integer not null,
  steps jsonb not null,
  variables jsonb not null default '[]'::jsonb,

  -- recorded  read out of a screen share. Version 1, always a hypothesis.
  -- refined   the first verification replay failed, the model was shown the
  --           live page and corrected the step it got wrong. This is the
  --           extraction still finishing, not a repair.
  -- repaired  a flow that used to work stopped, the site had changed, and the
  --           model found the element again -- and the whole flow then
  --           completed end to end. Nothing is written unless it did.
  -- drifted   a lower-ranked selector matched and got promoted. No model.
  -- edited    somebody changed it by hand on the screen
  reason text not null check (
    reason in ('recorded', 'refined', 'repaired', 'drifted', 'edited')
  ),
  -- Which step changed, for `repaired` and `drifted`. Null for a whole-flow write.
  changed_step integer,
  -- One sentence for a person reading the history.
  note text not null default '',

  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.browser_flow_versions is
  'Every edition of a flow''s steps, append-only. Repair writes here rather than editing browser_flows.steps in place, so a repair that turns out to be wrong can be read, attributed and rolled back. No organization_id: the tenant is the parent flow, and every read constrains flow_id -- registered as `derived` in tenancy/tables.ts.';

comment on column public.browser_flow_versions.reason is
  'drifted is the cheap case and by far the common one: a selector further down the list matched, so the order was rewritten and no model was consulted. repaired is the expensive case and is only ever recorded after the repaired flow finished the whole errand.';

create unique index if not exists browser_flow_versions_unique_idx
  on public.browser_flow_versions (flow_id, version);

create index if not exists browser_flow_versions_history_idx
  on public.browser_flow_versions (flow_id, created_at desc);

-- ===========================================================================
-- 4. Who may run a flow that carries a login
-- ===========================================================================
--
-- A flow with a credential attached is a loaded weapon: running it means acting
-- as the company inside somebody else's system, and the person running it never
-- sees or needs the password. "Anyone who knows its name" is therefore the
-- wrong answer, and so is "anyone in the workspace".
--
-- The rule the code enforces (browser/access.ts):
--
--   * no credential          anyone in the workspace may run it
--   * credential, no grants  org admins only. A flow that was bound to a login
--                            and never shared is private to administration,
--                            which is the safe reading of somebody attaching a
--                            password and then going home.
--   * credential + grants    admins, plus exactly who is named here
--
-- Grants name a person or a role, not a team, because the question being
-- answered is "may THIS human act as the company on the DIAN", and routing that
-- through group membership puts the answer one careless team edit away.

create table if not exists public.browser_flow_grants (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.browser_flows (id) on delete cascade,

  subject_type text not null check (subject_type in ('user', 'role')),
  -- Exactly one of these is set; the check below enforces it.
  user_id uuid references public.users(id) on delete cascade,
  role text,

  granted_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint browser_flow_grants_subject_check check (
    (subject_type = 'user' and user_id is not null and role is null)
    or (subject_type = 'role' and role is not null and user_id is null)
  )
);

comment on table public.browser_flow_grants is
  'Who may run a flow that carries a company credential. Absence of rows is NOT "everyone" -- it means administrators only, because a login attached and never shared should not become available to the whole workspace by default. Derived from browser_flows; every read constrains flow_id.';

create unique index if not exists browser_flow_grants_user_idx
  on public.browser_flow_grants (flow_id, user_id)
  where user_id is not null;

create unique index if not exists browser_flow_grants_role_idx
  on public.browser_flow_grants (flow_id, role)
  where role is not null;

-- ===========================================================================
-- 5. Runs
-- ===========================================================================
--
-- THE COLUMNS THAT CARRY THE ARGUMENT. `mode`, `duration_ms` and `model_cost_usd`
-- exist so the claim this module is built on -- learned execution is faster and
-- free -- is a query rather than a slogan. A replay row has model_calls = 0 by
-- construction: the replay path imports no provider client at all.
--
-- HOW A CHANGED SITE IS TOLD APART FROM A FAILED ERRAND, which is the decision
-- that determines whether the library is still alive in six months. Confusing
-- the two is how a good flow gets corrupted: a model asked to "fix" a step
-- against an error page will happily invent a selector for the error page.
-- `failure_kind` records which way the call went, in this order:
--
--   transient      5xx, a navigation timeout, the site plainly down. Retry.
--                  NEVER repair -- there is nothing wrong with the flow, and
--                  rewriting it against an outage is how a working flow dies.
--   legitimate     the page rendered and said no in a way we recognise: plate
--                  not found, wrong password, session expired, validation
--                  refused. The errand failed; the flow is fine. No repair.
--   site-changed   the page is healthy, no refusal anywhere on it, and the
--                  element is gone under every stored selector -- or the page's
--                  recorded landmarks are mostly missing, meaning this is not
--                  the page we learned. Only this calls the model.
--
-- Recorded per run rather than inferred later, because the evidence that
-- justified the decision (status code, landmark hit rate, the refusal text) is
-- gone the moment the browser closes.

create table if not exists public.browser_flow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  flow_id uuid not null references public.browser_flows (id) on delete cascade,

  -- The version that actually executed. A run must stay readable after the flow
  -- has been repaired twice, so the number is copied, not joined.
  flow_version integer not null,

  -- replay    the stored steps, no model. The normal path, and the row whose
  --           model_calls is zero by construction.
  -- reasoned  a model drove the browser step by step. The comparison baseline,
  --           and what a first run looks like if nobody taught it.
  -- refine    a freshly extracted flow did not reproduce, so the model was
  --           shown the live page and fixed the step it misread.
  -- repair    a flow that used to work stopped because the site changed, and
  --           the model found the moved element.
  --
  -- refine and repair are the same machinery pointed at different problems, and
  -- they are kept apart because they mean opposite things about the flow:
  -- refine is "we have not finished learning this yet", repair is "the world
  -- moved under something we had already proven".
  mode text not null check (mode in ('replay', 'reasoned', 'refine', 'repair')),

  status text not null check (status in ('running', 'succeeded', 'failed')),
  -- `verify` is the replay fired automatically the moment a flow is extracted
  -- from a recording. Separated from `manual` because it is the run that
  -- decides propuesto vs probado, and because it must be excluded from the
  -- speed comparison -- it is the only replay that may be followed by a model
  -- call in the same breath.
  trigger text not null default 'manual' check (
    trigger in ('manual', 'chat', 'test', 'schedule', 'verify')
  ),

  -- The variables, as given. Secrets are not variables and are not here.
  inputs jsonb not null default '{}'::jsonb,
  -- Whatever the errand produced: extracted text, a download name, a status.
  result jsonb,

  failure_kind text check (failure_kind in ('transient', 'legitimate', 'site-changed')),
  error text,
  -- True when this run left the flow at a new version.
  updated_flow boolean not null default false,

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,

  model_calls integer not null default 0,
  model_input_tokens integer not null default 0,
  model_output_tokens integer not null default 0,
  model_cost_usd numeric(12, 6) not null default 0,

  started_by uuid references public.users(id) on delete set null
);

comment on table public.browser_flow_runs is
  'One execution. `mode`, `duration_ms` and `model_cost_usd` are here so "a learned run is faster and costs nothing" is something you can measure rather than assert -- a replay row carries model_calls = 0 because the replay path never loads a provider client.';

comment on column public.browser_flow_runs.failure_kind is
  'Why it failed, and therefore whether the model was allowed near the flow. Only site-changed triggers a repair. A flow repaired against an outage or against a legitimate refusal is worse than a broken one, because it looks fine.';

comment on column public.browser_flow_runs.inputs is
  'The named variables for this run. Credential values are a different kind of thing entirely (value.kind = secret) and are never written here, never logged and never returned.';

create index if not exists browser_flow_runs_flow_idx
  on public.browser_flow_runs (flow_id, started_at desc);

create index if not exists browser_flow_runs_org_idx
  on public.browser_flow_runs (organization_id, started_at desc);

-- The measurement query: replay against reasoned, per flow.
create index if not exists browser_flow_runs_mode_idx
  on public.browser_flow_runs (organization_id, mode, started_at desc)
  where status = 'succeeded';

-- ===========================================================================
-- 6. Step-by-step trace
-- ===========================================================================
--
-- A robot acting with the company's identity on a government website has to be
-- auditable afterwards: where it went, what it typed, what it got back. This
-- table is that record, and its one hard rule is that a secret never reaches
-- it. `value_preview` is written by the redactor in browser/redact.ts, which
-- emits the literal string '***' for a secret-valued step -- not a masked
-- version of the real value, not its length, nothing derived from it.

create table if not exists public.browser_flow_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.browser_flow_runs (id) on delete cascade,

  step_index integer not null,
  action text not null,
  label text not null default '',
  url text not null default '',

  -- The selector that actually matched, and where it sat in the stored list.
  -- matched_rank > 0 is drift: something above it stopped working.
  matched_target text,
  matched_rank integer,

  value_preview text,
  ok boolean not null,
  duration_ms integer not null default 0,
  error text,

  created_at timestamptz not null default now()
);

comment on table public.browser_flow_run_steps is
  'What the robot actually did, one row per step: the page it was on, the selector that matched, a redacted preview of what it typed, and whether it worked. Derived from browser_flow_runs -- every read constrains run_id.';

comment on column public.browser_flow_run_steps.value_preview is
  'Redacted. A step whose value came from a credential stores the literal ''***'' -- never a truncation, a mask or a length, because all three leak.';

comment on column public.browser_flow_run_steps.matched_rank is
  'Index of the selector that worked inside the step''s ranked list. Anything above 0 means the preferred selector stopped resolving and the flow healed itself without a model. Watching this column is how you see a portal changing before it breaks.';

create unique index if not exists browser_flow_run_steps_order_idx
  on public.browser_flow_run_steps (run_id, step_index);

-- Drift, across every flow: which steps are being carried by a fallback.
create index if not exists browser_flow_run_steps_drift_idx
  on public.browser_flow_run_steps (created_at desc)
  where matched_rank > 0;

-- ===========================================================================
-- 7. Row level security
-- ===========================================================================
--
-- Same posture as every table since 0064: RLS on, nothing granted to anon or
-- authenticated, and the service role reaching them only through
-- createOrgScopedClient, which pins the workspace onto every statement. An
-- auth.uid() policy would be theatre here -- no browser ever holds a Postgres
-- session in this application.
--
-- browser_credentials has no update grant on the secret path by convention
-- rather than by grant (rotation rewrites the row), but it does keep `update`
-- so last_used_at can be stamped. What it does NOT keep anywhere is a read path
-- that is not the execution path: see browser/credentials.ts, where the only
-- function that selects secret_encrypted is the one that hands it to the
-- browser service.

alter table public.browser_credentials enable row level security;
revoke all on table public.browser_credentials from public, anon, authenticated;
grant select, insert, update, delete on table public.browser_credentials to service_role;

alter table public.browser_flows enable row level security;
revoke all on table public.browser_flows from public, anon, authenticated;
grant select, insert, update, delete on table public.browser_flows to service_role;

alter table public.browser_flow_versions enable row level security;
revoke all on table public.browser_flow_versions from public, anon, authenticated;
grant select, insert, delete on table public.browser_flow_versions to service_role;

alter table public.browser_flow_grants enable row level security;
revoke all on table public.browser_flow_grants from public, anon, authenticated;
grant select, insert, delete on table public.browser_flow_grants to service_role;

alter table public.browser_flow_runs enable row level security;
revoke all on table public.browser_flow_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.browser_flow_runs to service_role;

alter table public.browser_flow_run_steps enable row level security;
revoke all on table public.browser_flow_run_steps from public, anon, authenticated;
grant select, insert, delete on table public.browser_flow_run_steps to service_role;

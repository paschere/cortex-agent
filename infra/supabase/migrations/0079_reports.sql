-- Informes: a report Cortex builds, that is read on screen, saved, and shared.
--
-- WHAT THIS IS FOR. A postal and customs operator runs on questions that repeat
-- every month: qué se nos vence, cómo está la flota, qué tiene cada cliente
-- pendiente. Today somebody answers them by opening three screens and typing
-- the numbers into an email. This table is where the answer lives instead —
-- with its charts, with the moment it was calculated, and with the source of
-- every figure attached to the figure.
--
-- IT IS NOT THE PDF MODULE. `presentation_files` (0044) stores a rendered PDF
-- somebody mails to a client and archives. This stores a document somebody
-- READS, reopens in November, and cites a figure out of. Different artifact,
-- different lifetime, different sharing posture; sharing the storage would have
-- meant one of the two behaving as an exception forever.
--
-- ===========================================================================
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE
-- ===========================================================================
-- A SAVED REPORT IS A PHOTOGRAPH, NOT A BOOKMARK.
--
-- The obvious design — store the report's parameters, re-run the query when
-- somebody opens it — is the one this table refuses. Under it, the July report
-- silently becomes a September report wearing July's title: the numbers a
-- decision was made from are gone, and nobody can tell, because both versions
-- look correct. The whole point of writing something down is that it stops
-- moving.
--
-- So `document` holds the RESOLVED report: every figure already computed, every
-- label already written, every source already stamped with the instant it was
-- read and the number of rows it returned. Opening a saved report runs no query
-- at all. The shape of that JSON is defined and validated by
-- packages/agent-tools/src/reports/document.ts, on the way in AND on the way
-- out, and `document_version` says which reader understands it.
--
-- What is deliberately NOT frozen is the HTML. Rendering is a pure function of
-- `document`, so a fixed typo, a contrast repair or an accessibility fix reaches
-- every report ever generated while not one number moves. `renderer_version`
-- records which presentation drew it.
--
-- ===========================================================================
-- AND THE FREEZE IS CHECKED
-- ===========================================================================
-- `content_hash` is the sha256 of a canonical serialization of `document`,
-- written at insert and recompared on every read. A mismatch is surfaced on the
-- page, not swallowed.
--
-- This is not a defence against somebody with database access — they can
-- rewrite the hash too. It is a defence against the thing that actually
-- happens: a migration, a backfill, a well-meant manual fix in production. A
-- document whose entire value is that it did not change should be able to say
-- whether it did.
--
-- ===========================================================================
-- WHY EVERY FIGURE CARRIES ITS SOURCE
-- ===========================================================================
-- Same rule as commitments (0069), one layer up. A commitment cannot exist
-- without a verifiable source; a report figure cannot exist without a source id
-- that resolves to a declared read — the system, the exact slice, the moment,
-- the row count — plus the method sentence that says how the arithmetic was
-- done. Enforced in TypeScript because the constraint is about the SHAPE of a
-- JSON document, which is where zod is a better tool than a CHECK; the database
-- guards the columns, the schema guards the contents, and neither can be
-- skipped by a caller.
--
-- A pretty chart over invented numbers is worse than no report at all: it is
-- the same failure as a false expiry alarm, one layer up, and it discredits the
-- true figures alongside it.
--
-- ===========================================================================
-- SHARING
-- ===========================================================================
-- One nullable token per report, on our own domain, with an expiry and a view
-- counter — the same posture as 0044's presentation links and for the same
-- reasons (see packages/agent-tools/src/presentations/storage.ts). The link is
-- for a person; the export (a single self-contained HTML file, charts included,
-- no requests, no scripts) is for a folder that an auditor opens in five years.
-- Re-sharing REPLACES the token rather than extending it, because "share this
-- again" usually follows "that went to the wrong person".
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` on every row, registered as `tenant()` in
-- packages/agent-tools/src/tenancy/tables.ts, and the application only ever
-- holds a scoped handle (0064). A reporting module is the easiest place in a
-- product to leak a row between workspaces, because a stray row lands inside a
-- total where nobody would ever see it as a row — so the isolation test asserts
-- on the TOTALS of reports built for two companies with deliberately
-- indistinguishable data, not on the presence of a filter.
--
-- RLS is deny-all + service_role, matching 0065, 0067 and 0069.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. Reports
-- ===========================================================================

create table if not exists public.reports (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     text        not null,

  -- Three, and only three. A fourth is a code change plus a migration, which is
  -- the correct amount of friction: the value of this surface is that each
  -- report is good, not that there are many.
  kind                text        not null
                                  check (kind in ('expiries','fleet','client_activity')),

  -- Denormalized out of `document` so the list screen and `reports.list` never
  -- have to deserialize a snapshot to draw a row. They are copies, and they are
  -- copies of an immutable field of an immutable document, so they cannot drift.
  title               text        not null check (length(title) between 1 and 300),
  subtitle            text        check (length(subtitle) <= 600),
  period_label        text        not null check (length(period_label) <= 200),

  -- What was ASKED for. Kept for "hazme ese mismo pero de 90 días" and for
  -- understanding an old report's scope. Never used to re-derive the content:
  -- that is what would turn this row back into a bookmark.
  params              jsonb       not null default '{}'::jsonb,

  -- The photograph. Everything the report says, already resolved.
  document            jsonb       not null,

  -- sha256 of the canonical serialization of `document`, written at insert.
  content_hash        text        not null check (content_hash ~ '^[0-9a-f]{64}$'),

  document_version    integer     not null default 1,
  renderer_version    integer     not null default 1,

  -- The instant the data was read, which is what the report prints on itself.
  -- Distinct from created_at: a rebuild of an old snapshot would share the
  -- former and not the latter.
  generated_at        timestamptz not null default now(),
  generated_by        uuid        references public.users(id) on delete set null,
  -- Which chat asked for it, when one did. Null for the button on the screen.
  conversation_id     uuid        references public.conversations(id) on delete set null,

  -- THE JOIN POINT FOR migration 0075, and nothing more today.
  --
  -- `public.clients` is another change in flight. This column exists so that
  -- attributing a report to a client, once that directory has rows, is a write
  -- to a column that is already here — additive, no migration, no rewrite. It
  -- is nullable and stays null for now, and NOTHING in the report builders
  -- reads `clients`: a report that needed a table which may still be empty
  -- would be a report that shows nothing on the day it ships. Client-facing
  -- figures come from `commitments.counterparty`, which exists today.
  --
  -- The foreign key is added below only if the table is there, so this
  -- migration is correct whether 0075 has run or not.
  client_id           uuid,

  -- --- Sharing ------------------------------------------------------------
  -- Null until somebody shares it. 32 random bytes, base64url. The token IS the
  -- credential: the link has to survive being clicked out of a WhatsApp thread
  -- where no session cookie exists. See the download route for the trade-off.
  share_token         text,
  share_expires_at    timestamptz,
  share_views         integer     not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A token without an expiry is a link nobody can reason about, and an expiry
  -- without a token is bookkeeping for a door that does not exist.
  constraint reports_share_pair
    check ((share_token is null) = (share_expires_at is null))
);

-- The list screen's only query: this workspace, newest first, optionally by kind.
create index if not exists reports_org_generated_idx
  on public.reports (organization_id, generated_at desc);

create index if not exists reports_org_kind_idx
  on public.reports (organization_id, kind, generated_at desc);

-- The share link resolves by token alone, across every workspace, because the
-- caller has no session to scope by. Unique so a mint can never collide, partial
-- so the thousands of unshared reports cost nothing.
create unique index if not exists reports_share_token_idx
  on public.reports (share_token)
  where share_token is not null;

-- Reserved until 0075 lands; harmless and cheap while every value is null.
create index if not exists reports_client_idx
  on public.reports (organization_id, client_id)
  where client_id is not null;

comment on table public.reports is
  'One saved report per row, holding the RESOLVED document rather than the query that produced it. Opening a saved report runs no query: it shows what it showed the day it was generated, which is the only way the July report can still be the July report in November.';

comment on column public.reports.document is
  'The photograph: sections, series, tables, figures — every number already computed and every source already stamped with the moment it was read. Shape defined and validated by packages/agent-tools/src/reports/document.ts on the way in and on the way out.';

comment on column public.reports.content_hash is
  'sha256 of the canonical serialization of `document`, written at insert and recompared on every read. Not a defence against an attacker with database access, but against the migration or the manual fix that quietly edits a document whose whole value is that it did not change.';

comment on column public.reports.params is
  'What was asked for. Kept for re-running a similar report and for understanding an old one''s scope. Never used to re-derive the content — that is exactly what would turn this row back into a bookmark.';

comment on column public.reports.client_id is
  'Reserved for migration 0075 (public.clients). Nullable, always null today, and read by nothing: the report builders group on commitments.counterparty so they work with that directory absent or empty. The foreign key is attached conditionally below.';

comment on column public.reports.share_token is
  'Unguessable 256-bit token, null until somebody shares the report. The token is the credential: a shared link has to open from WhatsApp or email where no session exists. Re-sharing replaces it rather than extending it, so a link sent to the wrong person dies the moment a new one is minted.';

comment on column public.reports.renderer_version is
  'Which presentation drew this document. The HTML is deliberately NOT frozen — it is a pure function of `document` — so an accessibility fix reaches every report ever generated while not one figure moves.';

-- ===========================================================================
-- 2. The clients foreign key, attached only if that table exists
-- ===========================================================================
-- Migrations run in order, so 0075 precedes this one and the constraint will
-- normally be created. Guarding it anyway means this file is correct in a
-- database where that change was never applied — a branch, a restored dump, a
-- deployment where the two shipped apart. A missing constraint costs a column
-- that is null everywhere; a failed migration costs the deploy.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'clients'
  ) and not exists (
    select 1 from pg_constraint where conname = 'reports_client_id_fkey'
  ) then
    alter table public.reports
      add constraint reports_client_id_fkey
      foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;

-- ===========================================================================
-- 3. Access
-- ===========================================================================
-- Deny-all + service_role, matching 0065, 0067 and 0069. The tenant boundary is
-- createOrgScopedClient, not a policy keyed off auth.uid(); see the 0064 header
-- for why an auth.uid() policy would be theatre in this schema, and why the
-- organization_id column is the whole prerequisite for making RLS real later.
--
-- The share link is the one read that legitimately crosses the boundary, and it
-- does so through a route holding the service client with the token as its only
-- key — exactly as /api/files/presentation/<token> already does.

alter table public.reports enable row level security;

revoke all on table public.reports from public, anon, authenticated;

grant select, insert, update, delete on table public.reports to service_role;

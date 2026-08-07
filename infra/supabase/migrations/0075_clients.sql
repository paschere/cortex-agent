-- Clients: the axis everything else in Cortex hangs from.
--
-- WHAT THIS IS FOR. Cortex already remembers a great deal about this company's
-- customers. It has the mail, the transcript of the call, the WhatsApp group
-- where the operation is coordinated, the contract in Brain Knowledge, the
-- deadline that came out of that contract. What it does not have is the
-- CUSTOMER. Every one of those things is filed under its own identity — a Gmail
-- thread id, a Meet conference record, a group jid, a document uuid — and the
-- only thing tying them together is that a person happens to know they are all
-- about Coltrans. So "muéstrame todo lo de Coltrans" is not a query anybody can
-- run; it is an act of memory, performed by whoever has been here longest.
--
-- This migration adds the missing noun. Nothing here is new MEMORY: every fact
-- the client card shows was already stored. What was missing was the spine.
--
-- ===========================================================================
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE
-- ===========================================================================
-- A LINK THAT WAS NOT EARNED IS WORSE THAN NO LINK AT ALL.
--
-- Everything else here is negotiable; this is not. The moment one of Coltrans's
-- emails shows up on Alpha Cargo's card, the whole surface stops being usable —
-- not because that one row is wrong, but because every OTHER row is now
-- suspect, and there is no way for the person reading to tell which is which.
-- A missing link costs a search. A wrong link costs the feature.
--
-- So association is split in two, in the schema and not by convention:
--
--   confirmed   The link is applied. It shows on the card, it is counted, it
--               is quotable. `client_links_confirmed_once_idx` makes it
--               impossible for one thing to be confirmed to two clients, and
--               `client_links_confirmed_needs_witness` makes it impossible to
--               reach this state without naming who vouched for it.
--
--   suggested   The link is a PROPOSAL. It appears in a review list and
--               nowhere else. Several may compete for the same thing; that is
--               the point of them. Nothing downstream reads a suggestion.
--
-- And the only automatic path to `confirmed` runs through something a HUMAN
-- asserted:
--
--   * a registered email domain (`client_domains`) — somebody said "@coltrans
--     .com is Coltrans"; matching a sender against it applies their statement,
--     it does not infer anything. This is the strongest signal available and
--     it is strong precisely because a person put it there.
--   * a registered contact address (`client_contacts.email`) — same shape,
--     one address instead of a whole domain.
--
-- Everything else — a name inside a document title, a NIT quoted in a body, a
-- group subject that reads like a company — PROPOSES. It never applies.
--
-- ===========================================================================
-- THE NIT IS THE KEY. THE NAME IS NOT.
-- ===========================================================================
-- In Colombia a company is its NIT. The name is marketing: "Coltrans",
-- "COLTRANS S.A.S.", "Coltrans Logística" and "Colombiana de Transportes" can
-- all be one legal entity, spelt four ways by four people in four systems, and
-- two genuinely different companies can share a trade name. The NIT cannot.
--
-- So `tax_id` holds the NIT as DIGITS ONLY, without the verification digit and
-- without dots — one representation, so `(organization_id, tax_id)` is a usable
-- key. The verification digit is not stored as typed; it is COMPUTED, by
-- `public.nit_dv`, into a generated column. That is what turns the DV from
-- decoration into a checksum: the application compares the DV a person typed
-- against the one the digits imply and refuses the pair when they disagree, so
-- a transposed digit is caught at the door instead of becoming a second, ghost
-- Coltrans six months later.
--
-- `(organization_id, lower(name))` is unique as well, because a workspace with
-- two rows called "Coltrans" has already lost — the card would be split in two
-- and neither half would look wrong.
--
-- ===========================================================================
-- WHY A LINK TABLE AND NOT A COLUMN ON EVERY TABLE
-- ===========================================================================
-- `commitments` gets a real `client_id` column: a commitment has exactly one
-- counterparty, the column replaces free text that was always meant to become
-- a key (see the note on `commitments.counterparty` in migration 0069), and
-- there is no such thing as a "proposed" deadline owner that the deadline
-- itself should not know about.
--
-- Documents, meetings and WhatsApp groups get `client_links` instead:
--
--   1. They are owned by other features. A join table is additive; it cannot
--      break a query somebody else wrote.
--   2. A column cannot hold a PROPOSAL, and most of the association for these
--      is a proposal. A nullable client_id has two states; this needs four.
--   3. A column cannot say WHY. `method`, `evidence` and `confidence` are the
--      difference between a card a person trusts and one they have to audit —
--      "carlos@coltrans.com escribió este hilo" is checkable in one glance,
--      and a bare foreign key is not.
--   4. The same row shape covers things that are not rows at all. A Gmail
--      thread lives at Google; there is no `emails` table to add a column to.
--      `entity_ref` holds its thread id, and the card treats it exactly like a
--      document.
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` on every row, all four tables registered as `tenant()` in
-- packages/agent-tools/src/tenancy/tables.ts, and the application only ever
-- holds a scoped handle (0064). RLS is deny-all + service_role, matching 0065,
-- 0067 and 0069 — see the 0064 header for why an `auth.uid()` policy would be
-- theatre in this schema, and why the column here is the whole prerequisite for
-- making RLS real later.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. The Colombian verification digit, as a function
-- ===========================================================================
-- The DIAN's algorithm, unchanged since it was published: multiply each digit
-- of the NIT — read from the right — by a fixed prime, sum, take the remainder
-- modulo 11, and subtract it from 11 unless it is 0 or 1.
--
-- IMMUTABLE and not merely STABLE, because a generated column may only call an
-- immutable function, and this one genuinely is: the same digits produce the
-- same DV forever. Any input that is not 4–15 digits returns NULL rather than
-- raising, so a half-typed NIT in a form does not become a database error.

create or replace function public.nit_dv(p_nit text)
returns smallint
language plpgsql
immutable
strict
as $$
declare
  -- The weights, applied to the digits from the right.
  weights constant int[] := array[3,7,13,17,19,23,29,37,41,43,47,53,59,67,71];
  reversed text;
  total    int := 0;
  i        int;
  rest     int;
begin
  -- Guarded before anything is cast. A form posting half a NIT must get null
  -- back, not an error with a stack trace in it.
  if p_nit !~ '^[0-9]{4,15}$' then
    return null;
  end if;

  reversed := reverse(p_nit);
  for i in 1..length(reversed) loop
    total := total + substr(reversed, i, 1)::int * weights[i];
  end loop;

  rest := total % 11;
  if rest in (0, 1) then
    return rest::smallint;
  end if;
  return (11 - rest)::smallint;
end $$;

comment on function public.nit_dv(text) is
  'Dígito de verificación for a Colombian NIT, computed from the digits. Immutable so clients.tax_id_dv can be a generated column; returns null for anything that is not 4-15 digits, so a partially typed NIT never raises.';

-- ===========================================================================
-- 2. The matching key for a company name
-- ===========================================================================
-- Casefold, strip accents, drop everything that is not a letter or a digit.
-- "COLTRANS S.A.S." and "Coltrans SAS" both become "coltranssas"; "Coltráns"
-- becomes "coltrans".
--
-- DELIBERATELY STRICTER THAN THE MATCHER IN TYPESCRIPT. `nameKey()` in
-- packages/agent-tools/src/clients/shape.ts additionally strips legal suffixes,
-- so it also folds "Coltrans S.A.S." into "coltrans" — which is right for a
-- search box or a register form, where a person sees the candidates and picks.
-- This one runs UNATTENDED, in the backfill in § 8, with nobody watching, and
-- an unattended matcher gets the conservative rule. The two are allowed to
-- disagree in exactly that direction: this one matches strictly less.

create or replace function public.client_name_key(p_name text)
returns text
language sql
immutable
strict
as $$
  select nullif(
    regexp_replace(
      lower(translate(btrim(p_name), 'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
                                     'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
      '[^a-z0-9]+', '', 'g'
    ),
    ''
  );
$$;

comment on function public.client_name_key(text) is
  'Casefolded, unaccented, punctuation-free form of a company name, for matching. Intentionally does NOT strip legal suffixes — the TypeScript nameKey() does, because it runs where a person can see and correct the result; this one runs in the unattended backfill.';

-- ===========================================================================
-- 3. The client
-- ===========================================================================

create table if not exists public.clients (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        text        not null references public.ba_organization(id) on delete cascade,

  -- Identity --------------------------------------------------------------
  -- What people call them out loud. This is the name on the card, in the chat
  -- and in the search box.
  name                   text        not null check (length(btrim(name)) between 2 and 160),
  -- What the RUT says. Kept apart from `name` because both are needed and for
  -- different jobs: nobody says "Colombiana de Transportes S.A.S." in a
  -- meeting, and nobody puts "Coltrans" on an invoice.
  legal_name             text        check (length(legal_name) <= 200),
  -- Digits only, no dots, no verification digit. See the header.
  tax_id                 text        check (tax_id ~ '^[0-9]{4,15}$'),
  -- Not stored as typed — DERIVED. A person typing "830025281-7" is checked
  -- against this and refused on a mismatch, which is how a transposed digit is
  -- caught before it becomes a second Coltrans.
  tax_id_dv              smallint    generated always as (public.nit_dv(tax_id)) stored,
  -- Matching key, generated so it cannot drift from the name it describes.
  name_key               text        generated always as (public.client_name_key(name)) stored,

  status                 text        not null default 'active'
                                     check (status in ('prospect','active','dormant','former','blocked')),

  -- Where they are --------------------------------------------------------
  -- A postal and customs operator routes by city before anything else: the
  -- same client in Buenaventura and in Bogotá is two different operations.
  city                   text        check (length(city) <= 80),
  -- Departamento. Spelt out, not a code — a code needs a lookup table nobody
  -- will maintain and the value is only ever read by a human.
  department             text        check (length(department) <= 80),
  address                text        check (length(address) <= 240),
  phone                  text        check (length(phone) <= 40),
  website                text        check (length(website) <= 200),

  -- What we do for them ---------------------------------------------------
  -- The lines of business BBIC actually sells. Free-form would drift into
  -- forty spellings of "aduana"; an enum in a constraint is one word each and
  -- can be filtered on.
  services               text[]      not null default '{}'::text[]
                                     check (services <@ array['courier','carga','aduana','almacenamiento','ultima_milla','otro']::text[]),
  -- Their side of the paperwork. A customs client with no SIA on file is a
  -- client whose imports will stall, and knowing that is half of this module.
  customs_role           text        check (customs_role in ('importador','exportador','ambos','ninguno')),
  -- Agreed payment window, in days. Drives nothing automatically — it is here
  -- because "¿a cuántos días nos paga Coltrans?" is asked constantly and the
  -- answer currently lives in somebody's inbox.
  payment_terms_days     int         check (payment_terms_days between 0 and 365),
  credit_limit_cop       bigint      check (credit_limit_cop >= 0),

  -- Who answers for them --------------------------------------------------
  owner_user_id          uuid        references public.users(id) on delete set null,
  -- When the relationship started. A date, not a timestamp: nobody knows the
  -- hour, and pretending to would be a lie with a timezone attached.
  since                  date,
  notes                  text        check (length(notes) <= 4000),

  created_by             uuid        references public.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- THE CONTRACT WITH THE OTHER MODULES. Both of these are named in the brief the
-- extraction, actions, Outlook and reports work was written against; they are
-- unique indexes rather than table constraints because one of them is partial
-- and the other is on an expression.

-- One NIT, one client. The real key.
create unique index if not exists clients_org_tax_id_idx
  on public.clients (organization_id, tax_id)
  where tax_id is not null;

-- One name, one client. A workspace with two rows called "Coltrans" has a card
-- split in half and no way to notice.
create unique index if not exists clients_org_name_idx
  on public.clients (organization_id, lower(name));

-- The matcher's lookup, and the near-duplicate warning the register flow shows
-- ("ya existe Coltrans S.A.S." before somebody adds "Coltrans"). NOT unique:
-- two legal entities can genuinely fold to the same key, and refusing the
-- second would be the schema overruling a person about their own customers.
create index if not exists clients_org_name_key_idx
  on public.clients (organization_id, name_key);

-- The list screen: who is live, most recently touched first.
create index if not exists clients_org_status_idx
  on public.clients (organization_id, status, updated_at desc);

create index if not exists clients_org_owner_idx
  on public.clients (organization_id, owner_user_id);

comment on table public.clients is
  'A customer company, as a first-class entity. Everything Cortex already stored — mail, meetings, documents, WhatsApp groups, deadlines — hangs off this row through commitments.client_id or client_links. The NIT is the identity; the name is how people refer to it.';

comment on column public.clients.tax_id is
  'The NIT as digits only: no dots, no dashes, no verification digit. One representation so (organization_id, tax_id) is a usable key.';

comment on column public.clients.tax_id_dv is
  'Computed from tax_id, never typed. The application compares it against the DV a person entered and refuses the pair when they disagree — that comparison is the only thing that catches a transposed digit before it becomes a duplicate client.';

comment on column public.clients.name_key is
  'Casefolded, unaccented, punctuation-free name, maintained by the database. Used to find near-duplicates and by the unattended backfill; never shown.';

comment on column public.clients.status is
  'prospect (talking, not billing) / active / dormant (no movement, relationship intact) / former / blocked (do not trade — a credit or compliance decision, and the only status that is a refusal rather than a description).';

-- ===========================================================================
-- 4. The domains that belong to them
-- ===========================================================================
-- THE STRONGEST SIGNAL IN THE PRODUCT, and the reason it is strong is that a
-- person put it here.
--
-- "Whoever writes from @coltrans.com is from Coltrans" is true, and it is true
-- because somebody who knows the account said so — not because a model noticed
-- a string. Storing that statement, with the name of who made it and when,
-- turns every future email match from an inference into an APPLICATION of a
-- human decision. That is the whole difference, and it is why matching on a
-- domain may write `state = 'confirmed'` while matching on a name may not.
--
-- Two guards make it safe to lean on:
--
--   `client_domains_org_domain_idx`  A domain belongs to at most one client per
--                                    workspace. If two clients claim
--                                    coltrans.com the database refuses the
--                                    second, so the ambiguous case cannot exist
--                                    to be resolved wrongly later.
--
--   `client_domains_not_public`      gmail.com and its cousins are refused
--                                    outright. Registering one would silently
--                                    attach every personal address in the
--                                    company's mail to one client — the single
--                                    most damaging row this table could hold.

create table if not exists public.client_domains (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  client_id         uuid        not null references public.clients(id) on delete cascade,
  -- Bare hostname, lower case, no '@' and no scheme.
  domain            text        not null check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  -- Who vouched for it. NOT NULL: this row is a person's statement, and a
  -- statement with no author is exactly what this table must never hold, since
  -- everything downstream cites it as the reason a link was applied.
  verified_by       uuid        not null references public.users(id) on delete restrict,
  verified_at       timestamptz not null default now(),
  note              text        check (length(note) <= 300),
  created_at        timestamptz not null default now(),

  constraint client_domains_not_public check (
    domain not in (
      'gmail.com','googlemail.com','hotmail.com','hotmail.es','outlook.com','outlook.es',
      'live.com','msn.com','yahoo.com','yahoo.es','icloud.com','me.com','aol.com',
      'protonmail.com','proton.me','gmx.com','zoho.com','mail.com','yandex.com'
    )
  )
);

create unique index if not exists client_domains_org_domain_idx
  on public.client_domains (organization_id, domain);

create index if not exists client_domains_client_idx
  on public.client_domains (client_id);

comment on table public.client_domains is
  'Email domains a person has stated belong to a client. The unique index means a domain can point at only one client, which is what makes automatic email association safe: matching a sender applies somebody''s statement instead of guessing.';

comment on column public.client_domains.verified_by is
  'The person who vouched for this domain. Not null, and copied onto every link this domain produces — an automatically applied link still carries a human name, because a human is what made it true.';

-- ===========================================================================
-- 5. The people at the client
-- ===========================================================================
-- WHY THIS IS NOT packages/agent-tools/src/people/. That module is a client of
-- the Google People API: it resolves OUR colleagues out of the Workspace
-- directory, plus whatever sits in the asking person's private contacts. It
-- stores nothing, it is per-user, and half of what it can see is somebody's
-- personal address book rather than a company record. "Con quién se habla en
-- Coltrans" is a fact about the WORKSPACE — it has to survive the person who
-- knew it leaving, it has to be the same for everybody, and it has to be
-- writable by Cortex when a new address appears in a thread. None of those are
-- true of a Google contact.
--
-- So this table holds the client's side of the relationship, and people/ keeps
-- holding ours. They never overlap: a row here is somebody who does not work
-- at this company.

create table if not exists public.client_contacts (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  client_id         uuid        not null references public.clients(id) on delete cascade,

  full_name         text        not null check (length(btrim(full_name)) between 2 and 160),
  email             text        check (position('@' in email) > 1 and length(email) <= 200),
  phone             text        check (length(phone) <= 40),
  role_title        text        check (length(role_title) <= 120),
  -- The one to write to when there is no better reason to pick somebody else.
  is_primary        boolean     not null default false,
  status            text        not null default 'active'
                                check (status in ('active','left','unknown')),

  -- WHERE THIS PERSON CAME FROM. Same posture as commitments.source_kind: a
  -- contact Cortex added from a mail thread must be distinguishable from one a
  -- person typed, because only one of the two is anybody's word.
  source            text        not null default 'manual'
                                check (source in ('manual','email','whatsapp','meeting','document')),
  source_detail     text        check (length(source_detail) <= 300),
  first_seen_at     timestamptz,
  last_seen_at      timestamptz,

  notes             text        check (length(notes) <= 2000),
  created_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One address, one contact, per workspace. Not per client: the same address
-- appearing under two clients is either a mistake or a person who changed jobs,
-- and both want the collision surfaced rather than duplicated.
create unique index if not exists client_contacts_org_email_idx
  on public.client_contacts (organization_id, lower(email))
  where email is not null;

create index if not exists client_contacts_client_idx
  on public.client_contacts (client_id, is_primary desc, full_name);

-- At most one primary per client. A card that shows two "contacto principal"
-- rows is a card nobody can act on.
create unique index if not exists client_contacts_primary_idx
  on public.client_contacts (client_id)
  where is_primary;

comment on table public.client_contacts is
  'The people at the client — their side, not ours. packages/agent-tools/src/people/ resolves colleagues out of Google Workspace and stores nothing; this is workspace memory about outsiders, and it has to outlive whoever knew them.';

comment on column public.client_contacts.source is
  'manual when a person typed it; email/whatsapp/meeting/document when Cortex saw the address somewhere and proposed it. The card shows the difference, because only one of them is a statement anybody made.';

-- ===========================================================================
-- 6. Everything else, hung off the client
-- ===========================================================================
-- One row = "this thing is about this client", plus WHY, plus whether the why
-- was good enough to apply. Read the header before changing anything here.
--
-- `entity_key` exists so the confirmed-once index can cover both kinds of
-- entity at one time: rows that live in this database (a document, a meeting, a
-- WhatsApp group, a vehicle) are named by uuid, and things that live somewhere
-- else (a Gmail thread, an Outlook conversation) are named by whatever string
-- their system uses. Generated, so it cannot fall out of step with the columns
-- it derives from.

create table if not exists public.client_links (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  client_id         uuid        not null references public.clients(id) on delete cascade,

  entity_kind       text        not null
                                check (entity_kind in ('document','meeting','whatsapp_group','email_thread','vehicle','contact')),
  -- Set for entities that are rows in this database. No foreign key: the
  -- column points at four different tables depending on entity_kind, and a
  -- constraint that can only name one of them would be worse than none. The
  -- deletion story is handled instead by the readers, which hydrate through the
  -- scoped client and simply drop a link whose target has gone.
  entity_id         uuid,
  -- Set for entities that live in another system: a Gmail thread id, an
  -- Outlook conversation id.
  entity_ref        text        check (length(entity_ref) <= 400),
  entity_key        text        generated always as (coalesce(entity_id::text, entity_ref)) stored,

  -- A short human label, copied at link time. Denormalised on purpose: the
  -- card has to render even when the entity is unreachable (a thread in a
  -- mailbox this person cannot open), and "a link to something I cannot name"
  -- is not something anybody can review.
  label             text        check (length(label) <= 300),
  occurred_at       timestamptz,

  state             text        not null default 'suggested'
                                check (state in ('suggested','confirmed','rejected')),

  -- HOW the link was arrived at. This is the sentence the card shows, so the
  -- values are the actual distinctions a reader cares about, not a confidence
  -- bucket:
  --   email_domain   the sender's domain is registered to this client
  --   contact_email  the address is a registered contact of this client
  --   tax_id         the client's NIT appears verbatim in the text
  --   name_exact     the client's name appears as a whole, normalized
  --   name_partial   a weaker name overlap
  --   manual         a person linked it themselves
  --   inherited      it came in attached to something already linked (a
  --                  document extracted from a linked thread)
  method            text        not null
                                check (method in ('email_domain','contact_email','tax_id','name_exact','name_partial','manual','inherited')),
  -- The literal thing that justified it: "carlos@coltrans.com", "NIT
  -- 830.025.281", the matched phrase. Checkable in one glance, which is the
  -- only kind of justification worth showing.
  evidence          text        check (length(evidence) <= 600),
  confidence        numeric(3,2) check (confidence >= 0 and confidence <= 1),

  -- Who vouched. For a manual link this is the person who clicked; for an
  -- automatic one it is whoever registered the domain or the contact that
  -- matched — see § 4. Either way a confirmed link names a human.
  confirmed_by      uuid        references public.users(id) on delete set null,
  confirmed_at      timestamptz,
  rejected_by       uuid        references public.users(id) on delete set null,
  rejected_at       timestamptz,
  rejected_reason   text        check (length(rejected_reason) <= 300),

  created_by        uuid        references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- An entity is named exactly one way. Both, or neither, is a row nothing can
  -- resolve.
  constraint client_links_one_identity check (
    (entity_id is not null) <> (entity_ref is not null)
  ),
  -- A thing that lives in this database is named by its uuid; a thing that
  -- lives elsewhere is named by its own system's id. Mixing them up is how a
  -- Gmail thread ends up unresolvable against kb_documents.
  constraint client_links_identity_matches_kind check (
    case entity_kind
      when 'email_thread' then entity_ref is not null
      else entity_id is not null
    end
  ),
  -- THE RULE, IN A CONSTRAINT. There is no code path that can apply a link
  -- without recording who stands behind it, because there is no such row.
  constraint client_links_confirmed_needs_witness check (
    state <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null)
  ),
  constraint client_links_rejected_has_time check (
    state <> 'rejected' or rejected_at is not null
  ),
  -- A person's own link is applied by definition — there is nobody left to
  -- review it. A 'manual' row sitting in 'suggested' would mean the product
  -- asked somebody to confirm what they just did.
  constraint client_links_manual_is_applied check (
    method <> 'manual' or state <> 'suggested'
  )
);

-- THE SAFETY PROPERTY, AS AN INDEX. One thing cannot be confirmed to two
-- clients. Competing SUGGESTIONS are allowed and expected — that is what a
-- proposal is for — but the moment one is applied the others cannot be, and
-- the failure is a database error rather than a card showing another company's
-- mail.
create unique index if not exists client_links_confirmed_once_idx
  on public.client_links (organization_id, entity_kind, entity_key)
  where state = 'confirmed';

-- The same proposal must not be made twice by the same route.
create unique index if not exists client_links_proposal_once_idx
  on public.client_links (organization_id, client_id, entity_kind, entity_key, method);

-- The card: everything applied for this client, most recent first.
create index if not exists client_links_client_state_idx
  on public.client_links (client_id, state, occurred_at desc nulls last);

-- The review list: what is waiting on somebody, across the workspace.
create index if not exists client_links_org_state_idx
  on public.client_links (organization_id, state, created_at desc);

-- "Which client is this thing already about?" — the lookup every proposer runs
-- before proposing, so it does not re-propose what is settled.
create index if not exists client_links_entity_idx
  on public.client_links (organization_id, entity_kind, entity_key);

comment on table public.client_links is
  'What Cortex already stored, attached to a client: documents, meetings, WhatsApp groups, email threads, vehicles and contacts. state=confirmed is applied and shows on the card; state=suggested is a proposal and is read by nothing but the review list. The partial unique index makes it impossible for one thing to be confirmed to two clients.';

comment on column public.client_links.method is
  'How the link was arrived at, and therefore whether it could be applied without a review. email_domain and contact_email match something a person registered, so they apply; tax_id, name_exact and name_partial are inferences and only ever propose.';

comment on column public.client_links.evidence is
  'The literal thing that justified the link — the address that matched, the NIT as it was written. Shown on the card so a person can check the claim in one glance, exactly like commitments.source_quote.';

comment on column public.client_links.entity_key is
  'coalesce(entity_id, entity_ref), maintained by the database so the confirmed-once index covers rows that live here and things that live at Google with one rule.';

-- ===========================================================================
-- 7. The commitment finally knows whose it is
-- ===========================================================================
-- Migration 0069 wrote, on `commitments.counterparty`: "When a real customer
-- record exists, this becomes a foreign key and the text stays as the fallback
-- for counterparties that are not customers." This is that.
--
-- The text column STAYS, and stays populated. Most counterparties are not
-- clients — the DIAN is not a client, neither is the insurer, and inventing a
-- client row to hold "DIAN" would corrupt the very list this migration exists
-- to make trustworthy. So: `client_id` when the counterparty IS a client,
-- `counterparty` always, and the screen prefers the former and falls back to
-- the latter.
--
-- `on delete set null` and not cascade: deleting a client is a decision about
-- a RELATIONSHIP. The customs deadline it left behind is still a real date the
-- company still has to meet, and taking the deadlines down with the client is
-- how a lapsed obligation becomes invisible on the day somebody tidies up.

alter table public.commitments
  add column if not exists client_id uuid references public.clients(id) on delete set null;

create index if not exists commitments_client_due_idx
  on public.commitments (client_id, due_on)
  where client_id is not null;

comment on column public.commitments.client_id is
  'The client this deadline is with, when the counterparty is one. Null is a legitimate and common answer — the DIAN, an insurer and a supplier are counterparties and not clients. counterparty keeps the text either way.';

-- ===========================================================================
-- 8. The backfill
-- ===========================================================================
-- Attach the deadlines that already exist to the clients that already exist,
-- and REPORT WHAT WAS LEFT ALONE.
--
-- The rule is deliberately narrow, because nobody is watching it run:
--
--   * only rows with a counterparty and no client_id yet;
--   * the normalized counterparty must equal the normalized name or legal
--     name of a client in the SAME workspace, or the counterparty text must
--     contain that client's NIT verbatim;
--   * and exactly ONE client must match. Two candidates means the row is left
--     null. An unlinked commitment costs a search; a commitment linked to the
--     wrong company puts one customer's obligations on another's card.
--
-- Everything softer than that — suffix folding, partial names, "Coltrans Cargo"
-- against "Coltrans" — is left to the interactive matcher in
-- packages/agent-tools/src/clients/shape.ts, where the candidates are shown to
-- a person before anything is written.
--
-- Re-running this is a no-op: it only ever touches rows where client_id is null.

do $$
declare
  v_total      bigint;
  v_candidates bigint;
  v_matched    bigint;
  v_ambiguous  bigint;
begin
  select count(*) into v_total from public.commitments;

  select count(*) into v_candidates
  from public.commitments
  where client_id is null and nullif(btrim(coalesce(counterparty, '')), '') is not null;

  with candidate as (
    select
      c.id,
      c.organization_id,
      public.client_name_key(c.counterparty) as key,
      regexp_replace(c.counterparty, '[^0-9]', '', 'g') as digits
    from public.commitments c
    where c.client_id is null
      and nullif(btrim(coalesce(c.counterparty, '')), '') is not null
  ),
  hit as (
    select
      candidate.id,
      cl.id as client_id
    from candidate
    join public.clients cl
      on cl.organization_id = candidate.organization_id
     and (
          cl.name_key = candidate.key
       or public.client_name_key(cl.legal_name) = candidate.key
       or (cl.tax_id is not null and length(candidate.digits) >= 8 and candidate.digits like '%' || cl.tax_id || '%')
     )
  ),
  unambiguous as (
    select id, min(client_id) as client_id
    from hit
    group by id
    having count(distinct client_id) = 1
  ),
  applied as (
    update public.commitments c
       set client_id = u.client_id,
           updated_at = now()
      from unambiguous u
     where c.id = u.id
    returning c.id
  )
  select count(*) into v_matched from applied;

  select count(*) into v_ambiguous
  from (
    select candidate.id
    from (
      select
        c.id,
        c.organization_id,
        public.client_name_key(c.counterparty) as key,
        regexp_replace(c.counterparty, '[^0-9]', '', 'g') as digits
      from public.commitments c
      where c.client_id is null
        and nullif(btrim(coalesce(c.counterparty, '')), '') is not null
    ) candidate
    join public.clients cl
      on cl.organization_id = candidate.organization_id
     and (
          cl.name_key = candidate.key
       or public.client_name_key(cl.legal_name) = candidate.key
       or (cl.tax_id is not null and length(candidate.digits) >= 8 and candidate.digits like '%' || cl.tax_id || '%')
     )
    group by candidate.id
    having count(distinct cl.id) > 1
  ) ambiguous_rows;

  raise notice '0075 clients backfill: % commitments total, % with a counterparty and no client, % linked, % left unlinked because more than one client matched, % left unlinked because none did.',
    v_total, v_candidates, v_matched, v_ambiguous, v_candidates - v_matched - v_ambiguous;
end $$;

-- ===========================================================================
-- 9. Keeping updated_at honest
-- ===========================================================================
-- The card sorts by "lo más reciente" and the list screen sorts by
-- updated_at. A column that only moves when somebody remembers to set it makes
-- both of those quietly wrong, so the database sets it.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists clients_touch_updated_at on public.clients;
create trigger clients_touch_updated_at
  before update on public.clients
  for each row execute function public.touch_updated_at();

drop trigger if exists client_contacts_touch_updated_at on public.client_contacts;
create trigger client_contacts_touch_updated_at
  before update on public.client_contacts
  for each row execute function public.touch_updated_at();

drop trigger if exists client_links_touch_updated_at on public.client_links;
create trigger client_links_touch_updated_at
  before update on public.client_links
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- 10. Access
-- ===========================================================================
-- Deny-all + service_role, matching 0065, 0067 and 0069. The tenant boundary is
-- createOrgScopedClient, not a policy keyed off auth.uid().

alter table public.clients enable row level security;
alter table public.client_domains enable row level security;
alter table public.client_contacts enable row level security;
alter table public.client_links enable row level security;

revoke all on table public.clients from public, anon, authenticated;
revoke all on table public.client_domains from public, anon, authenticated;
revoke all on table public.client_contacts from public, anon, authenticated;
revoke all on table public.client_links from public, anon, authenticated;

grant select, insert, update, delete on table public.clients to service_role;
grant select, insert, update, delete on table public.client_domains to service_role;
grant select, insert, update, delete on table public.client_contacts to service_role;
grant select, insert, update, delete on table public.client_links to service_role;

revoke all on function public.nit_dv(text) from public, anon, authenticated;
revoke all on function public.client_name_key(text) from public, anon, authenticated;
grant execute on function public.nit_dv(text) to service_role;
grant execute on function public.client_name_key(text) to service_role;

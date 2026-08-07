-- Document extraction: turning the paperwork this company already stores into
-- numbers and dates it can add up, without ever losing the words they came from.
--
-- WHAT THIS IS FOR. A postal and customs operator in Colombia lives on
-- documents: a factura electrónica, a guía de transporte, a declaración de
-- importación, a certificado de origen, a contrato, a póliza. Brain Knowledge
-- already holds their TEXT, which answers "¿qué dice esta factura?" and nothing
-- else. It cannot answer "¿cuánto le facturamos a Coltrans en julio?" or "¿qué
-- guías tienen el plazo vencido?", because a sum is not a search — those
-- questions need the fields pulled out and stored as fields.
--
-- ===========================================================================
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE
-- ===========================================================================
-- A VALUE READ BY A MODEL IS NOT A FACT UNTIL A PERSON CONFIRMS IT, AND NO
-- VALUE EXISTS HERE WITHOUT THE SENTENCE IT WAS READ FROM.
--
-- This is migration 0069's rule for dates, applied to money. It has to be at
-- least as strict, because the failure is worse: a wrong deadline produces one
-- alarm somebody can check against the document, while a wrong amount is
-- summed into a total, reported to a client, and is invisible from that moment
-- on. Nobody audits a number that already looks plausible.
--
-- So, in constraints:
--
--   document_fields.quote   NOT NULL, at least 8 characters. Every extracted
--                           value carries the literal sentence it came from.
--                           Not a summary, not a paraphrase — the words on the
--                           page, so a reviewer checks the claim in one glance
--                           instead of trusting that the model read well.
--
--   review_state            A field is 'pending' until a human resolves it.
--                           `document_fields_confirmed_needs_human` makes a
--                           confirmed field without a named confirmer
--                           impossible, exactly as
--                           `commitments_extracted_needs_human` does in 0069.
--
--   the canonical columns   `total_amount`, `issued_on`, `due_on` and the rest
--                           on document_extractions are written ONLY from
--                           confirmed fields, and every query tool filters on
--                           review_state = 'confirmed'. An unreviewed
--                           extraction contributes nothing to any total. It is
--                           not a smaller number, it is not in the number.
--
-- WHAT THE APPLICATION ADDS ON TOP (packages/agent-tools/src/documents/verify.ts):
-- the quote must appear VERBATIM in a chunk of that same document, and the
-- value must be WRITTEN INSIDE THAT QUOTE — the digits of the amount, the day,
-- month and year of the date, the digits of the NIT. A subtotal plus an IVA
-- that happens to equal the proposed total is rejected, because arithmetic is
-- not reading. That is the same test `commitments/extract.ts` applies to a date
-- computed from "vigencia de doce meses", extended to every kind of value.
--
-- ===========================================================================
-- WHY doc_type IS A FREE-FORM SLUG AND NOT AN ENUM
-- ===========================================================================
-- The document types live in DOCUMENT_TYPES in
-- packages/agent-tools/src/documents/types.ts: each one declares its Spanish
-- name, the phrases that identify it, and the fields worth pulling out of it.
-- Adding "manifiesto de carga" next quarter should be a new object in that
-- list, not a migration plus a deploy plus a backfill. The CHECK here therefore
-- validates the SHAPE of the slug and not its membership: the database refuses
-- rubbish, and the product decides what it knows how to read.
--
-- NULL is a first-class value. It means the classifier did not recognise the
-- document, which is a legitimate and frequent answer — an unlabelled scan, a
-- photo of a page, an email printed to PDF. Guessing a type would produce
-- confident nonsense in every field that followed, so a null type stops the
-- extraction before it starts and the row waits for a person to say what it is.
--
-- ===========================================================================
-- CLIENTS
-- ===========================================================================
-- `client_id` points at public.clients (migration 0075, owned by another
-- change) and is NULLABLE AND STAYS NULL UNLESS THE NIT MATCHES. The NIT is the
-- one identifier a Colombian company cannot share with another, so it is the
-- only thing this module will match on. Matching on a name would link "Coltrans
-- S.A.S." to "Coltrans Express Ltda." and file half a month's invoices under
-- the wrong client — silently, and in a table people report from. An unmatched
-- extraction is a small, visible gap; a wrongly matched one is a false report.
--
-- The foreign key is added conditionally below so this migration applies in
-- either order relative to 0075.
--
-- ===========================================================================
-- TENANCY
-- ===========================================================================
-- `organization_id` on all three tables, all three registered as `tenant()` in
-- packages/agent-tools/src/tenancy/tables.ts, and the application only ever
-- holds a scoped handle (0064). RLS deny-all + service_role, matching 0069.
--
-- Idempotent throughout.

-- ===========================================================================
-- 1. One extraction per document
-- ===========================================================================

create table if not exists public.document_extractions (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         text        not null references public.ba_organization(id) on delete cascade,
  -- The document this was read out of. Cascade: the extraction is a derived
  -- reading of that text and has no meaning once the text is gone.
  document_id             uuid        not null references public.kb_documents(id) on delete cascade,

  -- What kind of paper this is. Null = the classifier did not recognise it.
  doc_type                text        check (doc_type ~ '^[a-z][a-z0-9_]{2,39}$'),
  -- The sentence that named the type — "FACTURA ELECTRÓNICA DE VENTA No. FE-4471".
  -- Verified verbatim against the document, same as every field quote.
  classification_quote    text        check (length(classification_quote) <= 600),
  classification_chunk_id uuid        references public.kb_chunks(id) on delete set null,
  -- Why nothing was recognised, in Spanish, for the person who has to decide.
  unclassified_reason     text        check (length(unclassified_reason) <= 500),

  -- Who it is with -------------------------------------------------------
  client_id               uuid,
  -- The NIT the match was attempted with, digits only. Kept even when it
  -- matched nothing: "we read 900123456 and no client has it" is actionable,
  -- "no match" is not.
  client_nit              text        check (length(client_nit) <= 20),
  client_match_state      text        not null default 'no_nit'
                                      check (client_match_state in ('matched','unmatched','ambiguous','no_nit')),

  -- Review ---------------------------------------------------------------
  review_state            text        not null default 'pending'
                                      check (review_state in ('unclassified','pending','confirmed','rejected')),
  confirmed_at            timestamptz,
  confirmed_by            uuid        references public.users(id) on delete set null,
  rejected_at             timestamptz,
  rejected_by             uuid        references public.users(id) on delete set null,

  -- THE QUERYABLE SURFACE -------------------------------------------------
  -- Denormalised from the confirmed fields, and from nowhere else. These six
  -- columns are what makes "cuánto le facturamos a Coltrans en julio" one index
  -- scan instead of a pivot over an attribute table, and they are the reason a
  -- new document type costs no migration: whatever a type calls its number, its
  -- counterparty and its dates, it maps them onto these slots in its spec.
  --
  -- They are recomputed by recomputeCanonical() every time a field is confirmed
  -- or corrected, and they are empty on a pending row. That is not an
  -- optimisation, it is the guarantee: unreviewed money cannot reach a total.
  doc_number              text        check (length(doc_number) <= 120),
  counterparty_nit        text        check (length(counterparty_nit) <= 20),
  counterparty_name       text        check (length(counterparty_name) <= 200),
  total_amount            numeric(18,2) check (total_amount >= 0),
  tax_amount              numeric(18,2) check (tax_amount >= 0),
  -- Three letters or nothing. NEVER defaulted to COP: an amount written "$" with
  -- no unit is an amount of unknown currency, and assuming pesos on an import
  -- invoice priced in dollars is a 4 000x error in the direction that looks
  -- normal.
  currency                text        check (currency ~ '^[A-Z]{3}$'),
  issued_on               date,
  due_on                  date,

  -- Provenance of the reading itself --------------------------------------
  -- Which version of the extractor and which model produced this. When a field
  -- turns out to be systematically wrong, the answer to "since when" has to be
  -- in the row.
  extractor_version       text        not null default 'v1' check (length(extractor_version) <= 20),
  model_id                text        check (length(model_id) <= 60),
  -- Null when the ingestion pipeline produced it, which is the normal case.
  created_by              uuid        references public.users(id) on delete set null,
  error_message           text        check (length(error_message) <= 500),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- A document has one current reading. Re-running the extractor replaces it
  -- rather than accumulating alternatives — two readings of the same invoice
  -- would double every total that counted them both.
  constraint document_extractions_one_per_document unique (organization_id, document_id),

  -- A recognised type must say where it read the name of that type.
  constraint document_extractions_type_has_quote check (
    doc_type is null
    or (classification_quote is not null and length(btrim(classification_quote)) >= 8)
  ),
  -- Nothing is confirmed without a person's name and the moment they did it.
  constraint document_extractions_confirmed_needs_human check (
    review_state <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null)
  ),
  -- A link to a client is only ever the result of a NIT that matched.
  constraint document_extractions_client_needs_match check (
    client_id is null or client_match_state = 'matched'
  )
);

-- The review queue: what is waiting for somebody in this workspace, oldest
-- first, because a document that has been waiting a week is the one to do.
create index if not exists document_extractions_org_review_idx
  on public.document_extractions (organization_id, review_state, created_at);

-- "Total facturado a este cliente en julio" — the shape of nearly every
-- question this module exists to answer.
create index if not exists document_extractions_org_client_issued_idx
  on public.document_extractions (organization_id, client_id, issued_on)
  where review_state = 'confirmed';

-- "Guías con plazo vencido", and every other deadline question over documents.
create index if not exists document_extractions_org_type_due_idx
  on public.document_extractions (organization_id, doc_type, due_on)
  where review_state = 'confirmed';

-- From a document to what was read out of it, for the KB screen.
create index if not exists document_extractions_document_idx
  on public.document_extractions (document_id);

comment on table public.document_extractions is
  'One structured reading per document in Brain Knowledge: what kind of paper it is, which client it belongs to, and the handful of canonical values (number, counterparty, amounts, dates) that make it addable and filterable. The canonical columns are written only from human-confirmed fields, so an unreviewed extraction contributes nothing to any total.';

comment on column public.document_extractions.doc_type is
  'A slug from DOCUMENT_TYPES in packages/agent-tools/src/documents/types.ts — invoice, waybill, customs_declaration, origin_certificate, contract, insurance_policy today. Deliberately not an enum: adding a type is a change to that list, not a migration. NULL means the classifier did not recognise the document, which is a legitimate answer and not an error.';

comment on column public.document_extractions.client_id is
  'Set only when the NIT read from the document matched exactly one row in public.clients. Names are never matched on. An unmatched extraction keeps this null rather than guessing, because a wrongly attributed invoice is worse than an unattributed one.';

comment on column public.document_extractions.total_amount is
  'Denormalised from the confirmed field carrying the type''s total. Empty until a person confirms that field. Paired with `currency`, which is null unless the currency was written next to the amount.';

-- ===========================================================================
-- 2. The fields, each with the words it came from
-- ===========================================================================
-- One row per value read out of the document. Three typed value columns rather
-- than one text column: a date that is stored as text sorts alphabetically, and
-- an amount that is stored as text cannot be summed — which is the entire point
-- of this module. The correction columns sit beside the proposal instead of
-- replacing it, so the screen can show "el modelo leyó X, Ana lo corrigió a Y"
-- forever, and so document_field_corrections can be rebuilt from the rows if it
-- ever needs to be.

create table if not exists public.document_fields (
  id              uuid        primary key default gen_random_uuid(),
  organization_id text        not null references public.ba_organization(id) on delete cascade,
  extraction_id   uuid        not null references public.document_extractions(id) on delete cascade,

  -- Which field of the type's spec this is: 'invoice_number', 'total', 'nit'…
  field_key       text        not null check (field_key ~ '^[a-z][a-z0-9_]{1,39}$'),

  -- THE PROPOSAL. Never mutated after it is written; a correction goes in the
  -- corrected_* columns beside it.
  value_text      text        check (length(value_text) <= 400),
  value_number    numeric(18,2),
  value_date      date,
  currency        text        check (currency ~ '^[A-Z]{3}$'),

  -- THE EVIDENCE. Not nullable, ever. Eight characters is not a judgement about
  -- prose, it is the floor that stops "n/a" and "-" from passing as a citation
  -- — the same floor migration 0069 puts on a commitment's source_quote.
  quote           text        not null check (length(btrim(quote)) >= 8 and length(quote) <= 600),
  chunk_id        uuid        references public.kb_chunks(id) on delete set null,

  review_state    text        not null default 'pending'
                              check (review_state in ('pending','confirmed','rejected')),
  confirmed_at    timestamptz,
  confirmed_by    uuid        references public.users(id) on delete set null,
  rejected_at     timestamptz,
  rejected_by     uuid        references public.users(id) on delete set null,

  -- THE CORRECTION, when the reviewer changed the value while confirming it.
  corrected_text     text     check (length(corrected_text) <= 400),
  corrected_number   numeric(18,2),
  corrected_date     date,
  corrected_currency text     check (corrected_currency ~ '^[A-Z]{3}$'),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One reading per field per extraction. A second proposal for 'total' is not
  -- a second total, it is a duplicate.
  constraint document_fields_one_per_key unique (extraction_id, field_key),
  -- A field with no value is not a field.
  constraint document_fields_has_value check (
    value_text is not null or value_number is not null or value_date is not null
  ),
  -- The rule, in the database. There is no code path that can confirm a value
  -- without recording who vouched for it, because there is no such row.
  constraint document_fields_confirmed_needs_human check (
    review_state <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null)
  )
);

create index if not exists document_fields_extraction_idx
  on public.document_fields (extraction_id, field_key);

-- The review screen, and the "what is still waiting" count.
create index if not exists document_fields_org_review_idx
  on public.document_fields (organization_id, review_state);

comment on table public.document_fields is
  'Every value read out of a document, with the literal sentence it was read from. The quote is NOT NULL and is verified to appear verbatim in the document at extraction time; a candidate whose quote cannot be found, or whose value is not written inside that quote, is discarded rather than stored with a paraphrase.';

comment on column public.document_fields.quote is
  'The words on the page. This is what a reviewer compares against, and it is why confirming twenty invoices is twenty glances rather than twenty trips back to the PDF.';

comment on column public.document_fields.corrected_number is
  'What the person put instead of value_number. The proposal is kept beside it on purpose: a corrected field is the most informative row in this schema, because it says exactly where the extractor is wrong.';

-- ===========================================================================
-- 3. What people corrected, so the misreadings become visible
-- ===========================================================================
-- Nothing here retrains anything. It answers one question: which fields of
-- which document types does a human change EVERY time? That is not a curiosity,
-- it is the work order — a field corrected 90% of the time is a prompt bug, a
-- field corrected 5% of the time is the world being messy. Without this table
-- the difference is invisible, because the corrected value simply looks right
-- afterwards.
--
-- doc_type and field_key are denormalised on purpose: the grouping this table
-- exists for must not require joining back through an extraction that may have
-- been re-run, re-typed or deleted since.

create table if not exists public.document_field_corrections (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   text        not null references public.ba_organization(id) on delete cascade,
  field_id          uuid        references public.document_fields(id) on delete set null,
  extraction_id     uuid        references public.document_extractions(id) on delete set null,

  doc_type          text        check (length(doc_type) <= 40),
  field_key         text        not null check (length(field_key) <= 40),

  -- Both sides as displayed to the person who made the call — the comparison is
  -- what matters, and it has to stay readable without knowing which of the
  -- three typed columns this field used.
  proposed_display  text        check (length(proposed_display) <= 400),
  corrected_display text        check (length(corrected_display) <= 400),
  -- 'corrected' when the value changed, 'rejected' when the reviewer threw the
  -- whole reading out. Both are evidence; only one has a replacement value.
  outcome           text        not null default 'corrected'
                                check (outcome in ('corrected','rejected')),

  corrected_by      uuid        references public.users(id) on delete set null,
  corrected_at      timestamptz not null default now()
);

create index if not exists document_field_corrections_org_idx
  on public.document_field_corrections (organization_id, doc_type, field_key);

comment on table public.document_field_corrections is
  'Append-only record of every field a human changed or threw out while reviewing an extraction. Read by documents.correction_stats to answer "which fields do we always have to fix", which is the only honest signal about where the extractor is failing.';

-- ===========================================================================
-- 4. The link to clients, whichever order the migrations land in
-- ===========================================================================
-- public.clients arrives in migration 0075, written by a change running in
-- parallel with this one. The column above is declared unconditionally so the
-- application contract holds either way; the foreign key is added here only
-- once the table exists. A fresh database applies 0075 first and gets the
-- constraint immediately; a database where this lands first keeps a plain uuid
-- until 0075 runs, and re-running this migration then completes it.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'clients'
  ) and not exists (
    select 1 from pg_constraint where conname = 'document_extractions_client_id_fkey'
  ) then
    alter table public.document_extractions
      add constraint document_extractions_client_id_fkey
      foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;

-- ===========================================================================
-- 5. Access
-- ===========================================================================
-- Deny-all + service_role, matching 0069. The tenant boundary is
-- createOrgScopedClient, not a policy keyed off auth.uid().

alter table public.document_extractions       enable row level security;
alter table public.document_fields            enable row level security;
alter table public.document_field_corrections enable row level security;

revoke all on table public.document_extractions       from public, anon, authenticated;
revoke all on table public.document_fields            from public, anon, authenticated;
revoke all on table public.document_field_corrections from public, anon, authenticated;

grant select, insert, update, delete on table public.document_extractions       to service_role;
grant select, insert, update, delete on table public.document_fields            to service_role;
grant select, insert, update, delete on table public.document_field_corrections to service_role;

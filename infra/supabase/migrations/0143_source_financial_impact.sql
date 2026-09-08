-- Human classification is the boundary between a document Cortex can cite and
-- a document whose amount may affect Finance. Existing rows deliberately start
-- unclassified: an old generic `invoice` does not say whether we issued it or
-- owe it.

alter table public.document_extractions
  add column if not exists source_domains text[] not null default '{}'::text[]
    check (source_domains <@ array['financial', 'administrative', 'commercial', 'operations']::text[]),
  add column if not exists financial_role text not null default 'unclassified'
    check (financial_role in ('unclassified', 'receivable', 'payable', 'reference')),
  add column if not exists source_classified_at timestamptz,
  add column if not exists source_classified_by uuid references public.users(id) on delete restrict;

alter table public.document_extractions
  add constraint document_extractions_financial_role_domain check (
    financial_role not in ('receivable', 'payable') or 'financial' = any(source_domains)
  ),
  add constraint document_extractions_source_classification_human check (
    financial_role = 'unclassified'
    or (source_classified_at is not null and source_classified_by is not null)
  );

create index if not exists document_extractions_org_finance_role_idx
  on public.document_extractions (organization_id, financial_role, review_state)
  where financial_role in ('receivable', 'payable');

create table if not exists public.source_classification_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references public.ba_organization(id) on delete cascade,
  extraction_id uuid not null references public.document_extractions(id) on delete cascade,
  changed_by uuid references public.users(id) on delete restrict,
  previous_domains text[] not null,
  previous_financial_role text not null,
  new_domains text[] not null,
  new_financial_role text not null,
  changed_at timestamptz not null default now()
);

create index if not exists source_classification_audit_org_extraction_idx
  on public.source_classification_audit (organization_id, extraction_id, changed_at desc);

alter table public.source_classification_audit enable row level security;
revoke all on table public.source_classification_audit from public, anon, authenticated;
grant select, insert on table public.source_classification_audit to service_role;

create or replace function public.audit_source_classification_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.source_domains is distinct from new.source_domains
     or old.financial_role is distinct from new.financial_role then
    insert into public.source_classification_audit
      (organization_id, extraction_id, changed_by, previous_domains,
       previous_financial_role, new_domains, new_financial_role)
    values
      (new.organization_id, new.id, new.source_classified_by, old.source_domains,
       old.financial_role, new.source_domains, new.financial_role);
  end if;
  return new;
end;
$$;

drop trigger if exists document_extractions_audit_source_classification on public.document_extractions;
create trigger document_extractions_audit_source_classification
  after update of source_domains, financial_role on public.document_extractions
  for each row execute function public.audit_source_classification_change();

create or replace function public.finance_classify_source(
  p_organization_id text,
  p_user_id uuid,
  p_extraction_id uuid,
  p_source_domains text[],
  p_financial_role text,
  p_expected_updated_at timestamptz
) returns setof public.document_extractions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_row public.document_extractions%rowtype;
  membership_role text;
begin
  select m.role into membership_role
    from public.users u
    join public.ba_user account on lower(account.email) = lower(u.email)
    join public.ba_member m
      on m."userId" = account.id and m."organizationId" = u.organization_id
   where u.id = p_user_id and u.organization_id = p_organization_id;

  if membership_role is null then
    raise exception using errcode = '42501', message = 'La membresía ya no permite clasificar fuentes.';
  end if;
  if membership_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'Sólo propietarios y administradores pueden clasificar fuentes financieras.';
  end if;

  if p_source_domains is null
     or not (p_source_domains <@ array['financial', 'administrative', 'commercial', 'operations']::text[])
     or cardinality(p_source_domains) <> (select count(distinct value) from unnest(p_source_domains) value)
     or p_financial_role is null
     or p_financial_role not in ('unclassified', 'receivable', 'payable', 'reference') then
    raise exception using errcode = '22023', message = 'Clasificación de fuente inválida.';
  end if;
  if p_financial_role in ('receivable', 'payable') and not ('financial' = any(p_source_domains)) then
    raise exception using errcode = '22023', message = 'Una fuente no financiera no puede mover cartera ni compras.';
  end if;

  select e.* into current_row
    from public.document_extractions e
    join public.kb_documents d on d.id = e.document_id and d.organization_id = e.organization_id
   where e.id = p_extraction_id and e.organization_id = p_organization_id
     and d.collection_id in (select v.space_id from public.kb_visible_space_ids(p_user_id) v)
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Fuente no encontrada en esta empresa.';
  end if;
  if current_row.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = '40001', message = 'La fuente cambió mientras la estabas revisando.';
  end if;
  if p_financial_role in ('receivable', 'payable') and current_row.doc_type is distinct from 'invoice' then
    raise exception using errcode = '22023', message = 'Sólo una factura puede clasificarse como cuenta por cobrar o por pagar.';
  end if;

  update public.document_extractions
     set source_domains = p_source_domains,
         financial_role = p_financial_role,
         source_classified_at = now(),
         source_classified_by = p_user_id,
         updated_at = now()
   where id = current_row.id;

  return query select * from public.document_extractions where id = current_row.id;
end;
$$;

revoke all on function public.finance_classify_source(text, uuid, uuid, text[], text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.finance_classify_source(text, uuid, uuid, text[], text, timestamptz)
  to service_role;

create or replace function public.finance_list_sources(
  p_organization_id text,
  p_user_id uuid,
  p_limit integer default 500
) returns table (
  extraction_id uuid,
  document_id uuid,
  document_title text,
  doc_type text,
  review_state text,
  source_domains text[],
  financial_role text,
  total_amount numeric,
  currency text,
  counterparty_name text,
  issued_on date,
  classification_quote text,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
      from public.users u
      join public.ba_user account on lower(account.email) = lower(u.email)
      join public.ba_member m
        on m."userId" = account.id and m."organizationId" = u.organization_id
     where u.id = p_user_id and u.organization_id = p_organization_id
  ) then
    raise exception using errcode = '42501', message = 'La membresía ya no permite leer fuentes.';
  end if;

  return query
  select e.id, e.document_id, d.title, e.doc_type, e.review_state,
         e.source_domains, e.financial_role, e.total_amount, e.currency,
         e.counterparty_name, e.issued_on, e.classification_quote, e.updated_at
    from public.document_extractions e
    join public.kb_documents d
      on d.id = e.document_id and d.organization_id = e.organization_id
   where e.organization_id = p_organization_id
     and d.collection_id in (select v.space_id from public.kb_visible_space_ids(p_user_id) v)
   order by e.updated_at desc
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;

revoke all on function public.finance_list_sources(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.finance_list_sources(text, uuid, integer)
  to service_role;

comment on column public.document_extractions.financial_role is
  'Human classification for financial impact. Only confirmed receivable rows enter cartera; confirmed payable rows are reported separately as purchases. unclassified and reference never affect a total.';
comment on table public.source_classification_audit is
  'Append-only before/after ledger written by a trigger in the same transaction as every classification change. changed_by is null for a system re-extraction reset.';

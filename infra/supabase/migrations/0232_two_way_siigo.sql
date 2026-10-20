-- ===========================================================================
-- CONEXIÓN EN DOS VÍAS CON SIIGO (app → Siigo y Siigo → app)
-- ===========================================================================
-- 1. «POR ENVIAR A SIIGO». La bandeja de prefacturas (0230) se generaliza: un
--    borrador puede ser una FACTURA (como hasta hoy), un RECIBO DE CAJA, una
--    NOTA CRÉDITO o un CLIENTE (tercero). Misma tabla, misma idempotencia
--    (`idempotency_key` única), mismo ciclo (pending → creating → created /
--    error / discarded) y la misma regla de oro: nada llega a Siigo sin que una
--    persona lo apruebe.
--      · kind     — 'invoice' (por defecto: lo que ya había), 'receipt',
--                   'credit_note', 'customer'.
--      · payload  — lo que se manda, en forma común (accounting/outbound/shape.ts):
--                   cliente {taxId, dv, name, city…}; recibo {customerTaxId,
--                   applications[{invoiceNumber, amount}]…}; nota {invoiceNumber,
--                   reason, mode, items…}. Una factura sigue usando `lines`.
--    Sólo las facturas exigen líneas; los demás tipos llevan `lines = []`.
--
-- 2. NOTAS CRÉDITO SINCRONIZADAS. `accounting_connections.entities` admite
--    'credit_notes' (la tabla «Notas crédito (Siigo)») para el disparador «se crea
--    una nota crédito». Las conexiones de Siigo existentes la activan.
--
-- 3. SINCRONIZAR MÁS SEGUIDO. Cada corrida incremental son pocas peticiones (un
--    listado por cosa); con 15 minutos Siigo queda muy lejos de su tope (100 por
--    minuto) y los sucesos contables («una factura queda pagada») salen a los
--    minutos. El defecto pasa de 60 a 15 y las conexiones que seguían en 60 se
--    bajan a 15; quien eligió otro valor lo conserva.
--
-- Los sucesos contables NO necesitan columnas: `custom_app_automations.trigger_kind`
-- admite 'accounting_event'. Idempotente.

alter table public.app_invoice_drafts
  add column if not exists kind text not null default 'invoice',
  add column if not exists payload jsonb not null default '{}'::jsonb;

-- Un borrador preparado desde el chat no pertenece a una app.
alter table public.app_invoice_drafts alter column app_id drop not null;

alter table public.app_invoice_drafts
  drop constraint if exists app_invoice_drafts_kind_check;
alter table public.app_invoice_drafts
  add constraint app_invoice_drafts_kind_check
  check (kind in ('invoice', 'receipt', 'credit_note', 'customer'));
alter table public.app_invoice_drafts
  drop constraint if exists app_invoice_drafts_payload_obj;
alter table public.app_invoice_drafts
  add constraint app_invoice_drafts_payload_obj check (jsonb_typeof(payload) = 'object');

alter table public.app_invoice_drafts
  drop constraint if exists app_invoice_drafts_lines_len;
alter table public.app_invoice_drafts
  add constraint app_invoice_drafts_lines_len check (
    jsonb_array_length(lines) <= 50
    and (kind <> 'invoice' or jsonb_array_length(lines) >= 1)
  );

create index if not exists app_invoice_drafts_kind_idx
  on public.app_invoice_drafts (organization_id, kind, status, created_at desc);

comment on column public.app_invoice_drafts.kind is
  'Qué se enviará a Siigo al aprobar: invoice, receipt (recibo de caja), credit_note o customer.';
comment on column public.app_invoice_drafts.payload is
  'Lo que se manda, en forma común, para kind <> invoice (ver accounting/outbound/shape.ts).';

-- Disparador «pasa algo en el programa contable».
alter table public.custom_app_automations
  drop constraint if exists custom_app_automations_kind;
alter table public.custom_app_automations
  add constraint custom_app_automations_kind check (
    trigger_kind in ('row_created', 'row_updated', 'row_flagged_duplicate',
                     'form_submitted', 'approval_decided', 'schedule', 'button',
                     'rows_poll', 'row_deleted', 'accounting_event')
  );

-- Notas crédito como cosa que se trae.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.accounting_connections'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%entities%'
  loop
    execute format('alter table public.accounting_connections drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.accounting_connections
  add constraint accounting_connections_entities_check check (
    cardinality(entities) between 1 and 6
    and entities <@ array['customers', 'products', 'invoices', 'payments', 'credit_notes', 'payroll']::text[]
  );

update public.accounting_connections
   set entities = entities || array['credit_notes']::text[]
 where provider = 'siigo'
   and not ('credit_notes' = any (entities))
   and 'invoices' = any (entities);

alter table public.accounting_connections
  alter column interval_minutes set default 15;
update public.accounting_connections
   set interval_minutes = 15
 where interval_minutes = 60;

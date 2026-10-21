-- ===========================================================================
-- LO QUE FALTABA DE LA API DE SIIGO, TAMBIÉN POR DEFECTO
-- ===========================================================================
--   accounts_payable   Reporte oficial de cuentas por pagar (siigo_cuentas_por_pagar).
--   party_balances     Balance de prueba por tercero, mes a mes (siigo_saldos_terceros).
--   product_prices     Precio de cada producto por lista (siigo_precios_productos).
--   fixed_assets, price_lists, account_groups, expense_concepts, cities
--                      Catálogos (activos fijos, listas de precios, grupos de
--                      inventario, descuentos de recibos de caja, ciudades DANE).
--   Facturas y notas crédito: estado DIAN, CUFE/CUDE, mensaje de rechazo y
--   descarga del PDF (campos nuevos de sus tablas, los crea la sincronización).
--   payroll            La nómina por persona se trae por defecto; la protege el
--                      permiso (administradores y dueño) y la auditoría, no
--                      dejarla apagada.
-- Idempotente.

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
    cardinality(entities) between 1 and 30
    and entities <@ array[
      'customers', 'products', 'invoices', 'payments', 'credit_notes',
      'purchases', 'supplier_payments', 'journal_lines', 'quotations', 'stock',
      'statements', 'payroll_costs', 'cost_centers', 'taxes', 'payment_methods',
      'warehouses', 'document_types', 'sellers', 'payroll',
      'accounts_payable', 'party_balances', 'product_prices', 'fixed_assets',
      'price_lists', 'account_groups', 'expense_concepts', 'cities'
    ]::text[]
  );

-- Copia de los saldos por tercero de cada mes (un mes cerrado no se vuelve a pedir).
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.accounting_report_snapshots'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.accounting_report_snapshots drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.accounting_report_snapshots
  add constraint accounting_report_snapshots_kind_check
  check (kind in ('balance', 'pnl', 'party'));

-- Todo activado en Siigo, nómina por persona incluida.
update public.accounting_connections c
   set entities = (
         select array(
           select distinct e
           from unnest(
             c.entities || array[
               'accounts_payable', 'party_balances', 'product_prices', 'fixed_assets',
               'price_lists', 'account_groups', 'expense_concepts', 'cities', 'payroll'
             ]::text[]
           ) as e
         )
       ),
       -- Facturas y notas crédito se releen completas una vez: así traen el estado DIAN.
       cursors = coalesce(cursors, '{}'::jsonb) - 'invoices' - 'credit_notes',
       next_run_at = now()
 where c.provider = 'siigo';

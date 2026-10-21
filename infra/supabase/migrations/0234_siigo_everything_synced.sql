-- ===========================================================================
-- TODO LO DEL PROGRAMA CONTABLE, COMO TABLAS SINCRONIZADAS
-- ===========================================================================
-- Hasta 0232 un programa contable traía cinco cosas (clientes, productos,
-- facturas, recibos de caja y notas crédito). Ahora trae TODO lo que su
-- conector sabe leer, para tableros, apps, reglas y avisos:
--
--   purchases          Compras y documentos soporte (siigo_compras), y de ahí a
--                      cuentas por pagar (payable_invoices, source 'contable').
--   supplier_payments  Pagos a proveedores / egresos (siigo_pagos_proveedores).
--   journal_lines      Movimientos de comprobantes contables por cuenta PUC,
--                      tercero y centro de costo (siigo_movimientos_contables).
--   quotations         Cotizaciones (siigo_cotizaciones).
--   stock              Existencias por bodega (siigo_existencias).
--   statements         Estado de resultados y balance general mes a mes
--                      (siigo_estados_financieros), del balance de prueba.
--   payroll_costs      Costo de nómina por mes, área y concepto
--                      (siigo_costo_nomina): sólo totales de la empresa.
--   cost_centers, taxes, payment_methods, warehouses, document_types, sellers
--                      Catálogos de referencia, una revisión diaria.
--
-- POR DEFECTO SE TRAE TODO: las conexiones existentes activan todo lo que su
-- programa sabe traer (la «nómina» por persona sigue siendo opcional: es
-- confidencial). El selector «Qué traer» queda para APAGAR cosas.
--
-- Los sucesos nuevos de las reglas («entra una compra», «se registra un pago a
-- proveedor», «producto bajo de existencias», «nueva cotización») no necesitan
-- columnas: salen de las mismas filas sincronizadas (trigger_kind
-- 'accounting_event', 0232).
--
-- CURSOR. `cursors.purchases` era el cursor de las compras hacia cuentas por
-- pagar (0181); ahora ese nombre es el de la tabla «Compras». El viejo pasa a
-- `cursors.payables` (sólo lo usa una conexión que apague «Compras»), y la
-- tabla hace su primera carga completa. Idempotente.

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
    cardinality(entities) between 1 and 19
    and entities <@ array[
      'customers', 'products', 'invoices', 'payments', 'credit_notes',
      'purchases', 'supplier_payments', 'journal_lines', 'quotations', 'stock',
      'statements', 'payroll_costs', 'cost_centers', 'taxes', 'payment_methods',
      'warehouses', 'document_types', 'sellers', 'payroll'
    ]::text[]
  );

-- El cursor viejo de compras → cuentas por pagar cambia de nombre (una sola vez).
update public.accounting_connections
   set cursors = (cursors - 'purchases') || jsonb_build_object('payables', cursors -> 'purchases')
 where cursors ? 'purchases'
   and not (cursors ? 'payables')
   and jsonb_typeof(cursors -> 'purchases') = 'object'
   and not (cursors -> 'purchases' ? 'coverage_version')
   and not coalesce(cursors -> 'purchases' -> 'resume' ? 'queries', false);

-- Todo activado en las conexiones que ya existen, según lo que cada programa sabe traer.
update public.accounting_connections c
   set entities = (
         select array(
           select distinct e
           from unnest(
             c.entities || case c.provider
               when 'siigo' then array[
                 'customers', 'products', 'invoices', 'payments', 'credit_notes',
                 'purchases', 'supplier_payments', 'journal_lines', 'quotations', 'stock',
                 'statements', 'payroll_costs', 'cost_centers', 'taxes', 'payment_methods',
                 'warehouses', 'document_types', 'sellers'
               ]::text[]
               when 'alegra' then array['purchases', 'stock', 'statements']::text[]
               when 'quickbooks' then array['purchases', 'statements']::text[]
               else array[]::text[]
             end
           ) as e
         )
       ),
       next_run_at = now()
 where c.provider in ('siigo', 'alegra', 'quickbooks');

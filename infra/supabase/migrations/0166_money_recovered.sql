-- ===========================================================================
-- PLATA RECUPERADA CON CORTEX
-- ===========================================================================
-- Cortex ya decía cuánta plata estaba en riesgo (payments/risk.ts). Faltaba la
-- otra mitad, la que prueba el valor: cuánta VOLVIÓ porque Cortex hizo algo.
--
-- LA CIFRA SE CALCULA AL LEER, NO SE GUARDA. Un pago que entra después de un
-- cobro enviado por Cortex, de un seguimiento en Gerencia o de un aviso de mora,
-- dentro de 45 días, cuenta (reglas puras y probadas en
-- packages/agent-tools/src/payments/recovered.ts). Calcularla al leer la hace
-- auditable —cada peso nombra su pago y su acción— y honesta: un pago que
-- después se descarta o entra en disputa deja de contar solo, sin un libro que
-- corregir. Esta migración sólo agrega lo que NO se puede reconstruir después:
--
--   1. LO QUE SE DEBÍA AL AVISAR. `receivable_notices` gana `balance` y
--      `currency`: el saldo de la factura el día del aviso. Sin él, «cuánto se
--      debía cuando Cortex actuó» sería una suposición. Los avisos anteriores
--      quedan en null y se leen con el total de la factura.
--
--   2. LAS CAÍDAS DE SALDO de una factura de un programa contable que NO trae
--      sus pagos. El programa sólo da el saldo de hoy; si nadie anota el día en
--      que bajó, ese dato se pierde con la siguiente sincronización. El
--      vigilante de cartera (apps/web/inngest/functions/receivables-watch.ts)
--      compara cada mañana el saldo de las facturas avisadas con el último que
--      vio y anota la diferencia aquí. Una por factura y día (el índice único
--      decide; un reintento no duplica). Si el programa sí trae pagos, estas
--      filas no cuentan: los pagos mandan, y una caída sin pago suele ser una
--      nota crédito, que no es plata.
--
--   3. LO MANUAL vive en el propio asunto de Gerencia (`data.recovered`:
--      `{ amountCop, note }`), que ya tiene diario inmutable de quién cambió qué
--      (`management_events`) y cierre con revisión humana. Aquí sólo se le pone
--      forma a ese campo: pesos enteros positivos y una nota corta.
--
-- Tenencia: `organization_id` en la tabla nueva, `tenant()` en tenancy/tables.ts.

-- 1. Lo que se debía el día del aviso -----------------------------------------
alter table public.receivable_notices
  add column balance numeric(18,2) check (balance is null or balance >= 0);

alter table public.receivable_notices
  add column currency text check (currency is null or currency ~ '^[A-Z]{3}$');

-- 2. Las caídas de saldo vistas ------------------------------------------------
create table public.receivable_balance_drops (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       text not null,
  accounting_invoice_id uuid not null
                          references public.accounting_invoices (id) on delete cascade,
  -- El aviso cuyo saldo (o la caída anterior) sirvió de punto de partida.
  notice_id             uuid references public.receivable_notices (id) on delete set null,
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  balance_before        numeric(18,2) not null check (balance_before > 0),
  balance_after         numeric(18,2) not null check (balance_after >= 0),
  -- El día en que se vio `balance_before`: el saldo seguía alto ese día.
  seen_before_on        date not null,
  -- El día en que se vio bajar.
  observed_on           date not null,
  created_at            timestamptz not null default now(),
  constraint receivable_balance_drops_down check (balance_after < balance_before),
  constraint receivable_balance_drops_order check (seen_before_on <= observed_on),
  constraint receivable_balance_drops_once unique (organization_id, accounting_invoice_id, observed_on)
);

create index receivable_balance_drops_org_idx
  on public.receivable_balance_drops (organization_id, observed_on desc);

comment on table public.receivable_balance_drops is
  'Cuándo bajó el saldo de una factura de un programa contable que no trae sus pagos, visto por el vigilante de cartera después de un aviso. Sirve para atribuir plata recuperada; si el programa trae pagos, no cuenta.';

alter table public.receivable_balance_drops enable row level security;
revoke all on table public.receivable_balance_drops from public, anon, authenticated;
grant select, insert, update, delete on table public.receivable_balance_drops to service_role;

-- 3. La forma de lo manual en el asunto ---------------------------------------
-- `jsonb_typeof` de una llave ausente es null; el coalesce lo vuelve un «no».
alter table public.management_cases
  add constraint management_cases_recovered_shape check (
    case
      when data->'recovered' is null or jsonb_typeof(data->'recovered') = 'null' then true
      when jsonb_typeof(data->'recovered') <> 'object' then false
      when coalesce(jsonb_typeof(data#>'{recovered,amountCop}'), 'missing') <> 'number' then false
      when coalesce(jsonb_typeof(data#>'{recovered,note}'), 'missing') <> 'string' then false
      else (data#>>'{recovered,amountCop}')::numeric between 1 and 10000000000000
        and (data#>>'{recovered,amountCop}')::numeric = trunc((data#>>'{recovered,amountCop}')::numeric)
        and char_length(btrim(data#>>'{recovered,note}')) between 1 and 300
    end
  );

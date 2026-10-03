-- Cobrar dentro de Cortex: pruebas, pagos y la puerta del registro.
--
-- ===========================================================================
-- QUÉ AGREGA ESTA MIGRACIÓN
-- ===========================================================================
--   § 1  billing_subscriptions   el estado COMERCIAL de cada empresa: prueba,
--                                al día, en mora, en solo lectura, cancelada.
--   § 2  billing_payments        cada intento de pago, con su referencia única.
--   § 3  billing_events          cada aviso de la pasarela, una sola vez.
--   § 4  access_requests         «Pide tu acceso»: global, lo revisa operaciones.
--
-- ===========================================================================
-- POR QUÉ UNA TABLA NUEVA Y NO MÁS COLUMNAS EN organization_subscriptions
-- ===========================================================================
-- `organization_subscriptions` (0085) dice QUÉ PLAN rige el cupo de una empresa,
-- y la lee la puerta del medidor antes de cada respuesta. Esta dice si la
-- empresa ESTÁ PAGANDO. Son dos preguntas: una empresa de la 0114 está en
-- `enterprise` sin haber pagado nunca nada en el producto, y tiene que seguir
-- así para siempre. Por eso:
--
--   * SIN FILA AQUÍ = NADA CAMBIA. Las empresas que ya existen no tienen fila y
--     ningún código las bloquea por eso. Sólo una empresa que empezó prueba
--     (registro abierto) o que pagó en el producto tiene fila.
--   * El pago aprobado escribe AMBAS: aquí el período pagado, allá el plan.
--
-- ===========================================================================
-- NUNCA SE BORRAN DATOS
-- ===========================================================================
-- `grace` es solo lectura: la empresa entra, lee y exporta todo; lo que se
-- detiene es empezar trabajo nuevo de Cortex. Ninguna transición de estado
-- borra filas, y no hay ningún trabajo programado que lo haga.
--
-- Idempotente: `if not exists` en todo, sin enums (texto + check), sin datos
-- sembrados. No toca ninguna tabla existente.


-- ===========================================================================
-- 1. billing_subscriptions — una fila por empresa que entró al cobro
-- ===========================================================================
create table if not exists public.billing_subscriptions (
  organization_id            text        primary key
                               references public.ba_organization(id) on delete cascade,
  plan_code                  text        not null references public.plans(code),
  -- trialing  prueba en curso, todo funciona.
  -- active    pagó el período que corre.
  -- past_due  se venció el período; unos días de margen con todo funcionando.
  -- grace     solo lectura: la prueba o el margen se acabaron sin pago.
  -- canceled  la cancelaron; al terminar lo pagado queda en solo lectura.
  -- Lo que se guarda es el último estado ESCRITO; el efectivo se calcula con las
  -- fechas en cada lectura (packages/agent-tools/src/billing/subscription.ts),
  -- así que una prueba vencida a medianoche no espera al barrido diario.
  status                     text        not null default 'trialing'
                               check (status in ('trialing', 'active', 'past_due', 'grace', 'canceled')),
  trial_ends_at              timestamptz,
  current_period_start       timestamptz,
  current_period_end         timestamptz,
  cancel_at_period_end       boolean     not null default false,
  canceled_at                timestamptz,
  -- Pasarela que cobra esta empresa. 'manual' = acordado por fuera.
  provider                   text        check (provider is null or provider in ('wompi', 'manual')),
  provider_customer_ref      text,
  provider_subscription_ref  text,
  -- Fuente de pago tokenizada (tarjeta/Nequi) para cobros recurrentes, cuando
  -- se cablee. Hoy el cobro mensual es un enlace nuevo cada período.
  provider_payment_source_ref text,
  -- El último recordatorio enviado («trial:3», «period:2026-11-01:3»…), para
  -- que el barrido diario no mande el mismo dos veces.
  last_reminder_key          text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint billing_subscriptions_trial_has_end
    check (status <> 'trialing' or trial_ends_at is not null),
  constraint billing_subscriptions_period_order
    check (current_period_start is null or current_period_end is null
           or current_period_end > current_period_start)
);

comment on table public.billing_subscriptions is
  'Estado comercial de una empresa (prueba, al día, mora, solo lectura, cancelada). Sin fila = empresa anterior al cobro: nunca se bloquea. El plan del cupo sigue en organization_subscriptions. Ver 0187.';

create index if not exists billing_subscriptions_due_idx
  on public.billing_subscriptions (status, current_period_end);
create index if not exists billing_subscriptions_trial_idx
  on public.billing_subscriptions (trial_ends_at)
  where status = 'trialing';


-- ===========================================================================
-- 2. billing_payments — cada intento de pago
-- ===========================================================================
-- La referencia la pone Cortex y la firma con el secreto de integridad: es lo
-- que vuelve en el aviso de la pasarela y lo que une el aviso con la empresa.
-- Única en TODA la instalación (la pasarela también la exige única).
create table if not exists public.billing_payments (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  plan_code        text        not null references public.plans(code),
  reference        text        not null unique check (length(reference) between 8 and 64),
  -- Pesos enteros, como se factura en Colombia. La pasarela recibe centavos.
  amount_cop       integer     not null check (amount_cop > 0),
  currency         text        not null default 'COP' check (currency = 'COP'),
  seats            integer     check (seats is null or seats > 0),
  months           integer     not null default 1 check (months between 1 and 12),
  status           text        not null default 'pending'
                     check (status in ('pending', 'approved', 'declined', 'voided', 'error', 'expired')),
  provider         text        not null check (provider in ('wompi', 'manual')),
  provider_tx_id   text,
  payment_method   text,
  checkout_url     text,
  -- Qué período cubrió, escrito al aprobarse.
  period_start     timestamptz,
  period_end       timestamptz,
  -- Huella del último aviso aplicado (nunca el aviso entero: trae datos del
  -- pagador que no hace falta guardar).
  raw_event_hash   text,
  -- Por qué quedó en error (monto distinto, moneda distinta…), en palabras.
  status_note      text        check (status_note is null or length(status_note) <= 500),
  created_by       uuid        references public.users(id) on delete set null,
  paid_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.billing_payments is
  'Intentos de pago por empresa. reference es única y firmada; el aviso de la pasarela la trae de vuelta. Montos en COP enteros. Ver 0187.';

create unique index if not exists billing_payments_provider_tx_idx
  on public.billing_payments (provider, provider_tx_id)
  where provider_tx_id is not null;
create index if not exists billing_payments_org_idx
  on public.billing_payments (organization_id, created_at desc);


-- ===========================================================================
-- 3. billing_events — cada aviso, aplicado una vez
-- ===========================================================================
-- La pasarela reintenta (Wompi: a los 30 min, 3 h y 24 h si no recibe 200) y
-- el regreso del pagador también consulta la transacción. El índice único es
-- la idempotencia: el segundo aviso igual choca y no se aplica.
create table if not exists public.billing_events (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  text        not null references public.ba_organization(id) on delete cascade,
  provider         text        not null,
  event_id         text        not null,
  event_type       text        not null,
  payment_id       uuid        references public.billing_payments(id) on delete set null,
  status           text,
  received_at      timestamptz not null default now()
);

create unique index if not exists billing_events_once_idx
  on public.billing_events (provider, event_id);
create index if not exists billing_events_org_idx
  on public.billing_events (organization_id, received_at desc);


-- ===========================================================================
-- 4. access_requests — «Pide tu acceso» (GLOBAL)
-- ===========================================================================
-- No es de ninguna empresa: la persona todavía no tiene una. La leen y deciden
-- los operadores de la plataforma desde /overview/access, por el `pool` (igual
-- que company_groups), nunca por el cliente con alcance de empresa — por eso no
-- está en el registro de inquilinos.
--
-- El código de invitación se guarda como HUELLA (sha256). El código en claro
-- sale una sola vez, en el correo de aprobación.
create table if not exists public.access_requests (
  id                      uuid        primary key default gen_random_uuid(),
  name                    text        not null check (length(btrim(name)) between 2 and 120),
  company                 text        not null check (length(btrim(company)) between 2 and 160),
  email                   text        not null check (length(email) between 5 and 254 and position('@' in email) > 1),
  phone                   text        check (phone is null or length(phone) <= 40),
  message                 text        check (message is null or length(message) <= 2000),
  status                  text        not null default 'pending'
                            check (status in ('pending', 'approved', 'rejected', 'signed_up')),
  reviewed_by             text        references public.ba_user(id) on delete set null,
  reviewed_at             timestamptz,
  review_note             text        check (review_note is null or length(review_note) <= 500),
  invite_code_hash        text        unique,
  invite_code_expires_at  timestamptz,
  signed_up_at            timestamptz,
  signed_up_user_id       text        references public.ba_user(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint access_requests_approved_has_code
    check (status <> 'approved' or (invite_code_hash is not null and invite_code_expires_at is not null))
);

comment on table public.access_requests is
  'Solicitudes públicas de acceso. Global (sin organization_id): la revisan los operadores de la plataforma. El código va como sha256. Ver 0187.';

-- Una solicitud pendiente por correo: el segundo envío no apila filas.
create unique index if not exists access_requests_pending_email_idx
  on public.access_requests (lower(email))
  where status = 'pending';
create index if not exists access_requests_status_idx
  on public.access_requests (status, created_at desc);


-- ===========================================================================
-- 5. Postura de seguridad: todo cerrado salvo service_role
-- ===========================================================================
alter table public.billing_subscriptions enable row level security;
alter table public.billing_payments      enable row level security;
alter table public.billing_events        enable row level security;
alter table public.access_requests       enable row level security;

revoke all on table public.billing_subscriptions from public, anon, authenticated;
revoke all on table public.billing_payments      from public, anon, authenticated;
revoke all on table public.billing_events        from public, anon, authenticated;
revoke all on table public.access_requests       from public, anon, authenticated;

grant select, insert, update          on table public.billing_subscriptions to service_role;
grant select, insert, update          on table public.billing_payments      to service_role;
grant select, insert                  on table public.billing_events        to service_role;
grant select, insert, update          on table public.access_requests       to service_role;

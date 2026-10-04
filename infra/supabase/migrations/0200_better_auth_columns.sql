-- ===========================================================================
-- LAS COLUMNAS QUE BETTER-AUTH 1.6 ESCRIBE Y NUESTRAS TABLAS NO TENÍAN
-- ===========================================================================
-- Las tablas ba_* se crearon a mano (0011, 0052) con el esquema de la versión
-- de entonces. better-auth 1.6 añadió campos que escribe en cada inserción, y
-- un INSERT con una columna que no existe falla entero:
--
--   · ba_invitation."createdAt" — `createInvitation` lo manda siempre. Sin él,
--     invitar a alguien respondía «column "createdAt" of relation
--     "ba_invitation" does not exist» y no salía ninguna invitación.
--   · ba_two_factor.verified / "failedVerificationCount" / "lockedUntil" — el
--     alta de la verificación en dos pasos y el bloqueo por intentos fallidos.
--
-- Se comprobó contra `getAuthTables()` de better-auth 1.6.24 con los plugins
-- que usa lib/auth.ts (organization, admin, twoFactor): éstas son las únicas
-- que faltaban. Aditiva e idempotente; las filas viejas toman el valor por
-- omisión (una invitación vieja «se creó» al migrar, que sólo sirve para
-- ordenar; un 2FA viejo queda verificado, que es lo que ya era).

alter table public.ba_invitation
  add column if not exists "createdAt" timestamptz not null default now();

alter table public.ba_two_factor
  add column if not exists verified boolean default true,
  add column if not exists "failedVerificationCount" integer default 0,
  add column if not exists "lockedUntil" timestamptz;

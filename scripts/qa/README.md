# QA local de las apps ("Control de vuelos")

Solo local. La base `cortex_qa` vive dentro del contenedor `supabase_db_cortex-agent` (no toca la base `postgres`).

1. `docker start supabase_db_cortex-agent`; crear `cortex_qa`, restaurar los esquemas `auth` y `storage`
   (`pg_dump -s -n auth -n storage postgres`) y aplicar `infra/supabase/migrations/*.sql` en orden (como `supabase_admin`,
   luego `grant all on all tables/functions in schema public to postgres, anon, authenticated, service_role`).
2. PostgREST suelto sobre `cortex_qa` en :54392 (imagen `public.ecr.aws/supabase/postgrest:v12.2.0`, mismo JWT secret local)
   y `node scripts/qa/rest-proxy.mjs` (:54391, quita el prefijo `/rest/v1`).
3. `next dev -p 3100` con `SUPABASE_DB_URL=…/cortex_qa`, `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54391`, `APP_BASE_URL`/`BETTER_AUTH_URL=http://localhost:3100`.
4. Crear cuentas (`/api/auth/sign-up/email`), una empresa (`/api/auth/organization/create`), añadir miembros a `ba_member`, entrar una vez con cada uno.
5. `QA_ORG=<id empresa> tsx scripts/qa/seed-vuelos.ts` monta la app; `tsx scripts/qa/run-automations.ts` ejecuta la cola de reglas (Inngest no corre en local).
Contraseña local de las cuentas @qa.test (solo base cortex_qa): QaLocal-2026-vuelos

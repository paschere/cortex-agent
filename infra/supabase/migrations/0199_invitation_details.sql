-- ===========================================================================
-- LO QUE UNA INVITACIÓN LLEVA ADEMÁS DEL CORREO Y EL ROL
-- ===========================================================================
-- `ba_invitation` es de better-auth y sólo sabe de correo, rol, vencimiento y
-- quién invitó. Invitar bien necesita tres cosas más, y las tres tienen que
-- sobrevivir hasta el día —a veces una semana después— en que la persona acepta:
--
--   · un MENSAJE PERSONAL de quien invita («Bienvenida, empiezas con cartera»),
--     que sale en el correo y en la página del enlace;
--   · el CARGO con el que entra (`work_people_meta.role_label`, 0174);
--   · el EQUIPO al que se une (`team_members`).
--
-- No se pueden aplicar al invitar: la persona todavía no tiene fila en
-- `public.users`, y `work_people_meta` y `team_members` cuelgan de ella. Se
-- guardan aquí, atados al id de la invitación, y se aplican al aceptar
-- (`applied_at` dice cuándo, para no aplicarlas dos veces).
--
-- Una tabla propia y no columnas en `ba_invitation`: esa tabla es de
-- better-auth y migrarla a mano es el tipo de cambio que una actualización de la
-- librería deshace sin avisar. `invitation_id` no es llave foránea por la misma
-- razón, y porque better-auth puede borrar su fila sin pasar por aquí; el
-- `on delete cascade` sobre la organización sí limpia lo que quede.
--
-- Tenencia: `organization_id` en la fila, `tenant()` en
-- packages/agent-tools/src/tenancy/tables.ts. RLS encendido sin políticas
-- (deny-all) y sólo service_role. Idempotente.

create table if not exists public.invitation_details (
  invitation_id     text primary key,
  organization_id   text not null references public.ba_organization (id) on delete cascade,
  personal_message  text check (personal_message is null or char_length(personal_message) <= 600),
  position_label    text check (position_label is null or char_length(btrim(position_label)) between 1 and 80),
  team_id           uuid references public.teams (id) on delete set null,
  invited_by        text,
  applied_at        timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists invitation_details_org_idx
  on public.invitation_details (organization_id);

comment on table public.invitation_details is
  'Lo que lleva una invitación además del correo y el rol: mensaje personal, cargo y equipo. Se aplican al aceptar (cargo → work_people_meta.role_label, equipo → team_members); applied_at marca que ya se aplicaron.';
comment on column public.invitation_details.invitation_id is
  'ba_invitation.id. Sin llave foránea a propósito: la tabla es de better-auth.';
comment on column public.invitation_details.applied_at is
  'Cuándo se aplicaron el cargo y el equipo a la persona que aceptó. Nulo mientras la invitación sigue pendiente.';

alter table public.invitation_details enable row level security;
revoke all on table public.invitation_details from public, anon, authenticated;
grant select, insert, update, delete on table public.invitation_details to service_role;

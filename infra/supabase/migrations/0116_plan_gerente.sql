-- El plan Gerente: un retainer, no un asiento más grande.
--
-- Equipo y Empresa venden un asistente por persona. Diez millones al mes no
-- es 333 asientos de Equipo: es el sueldo de un gerente operativo, y la
-- factura tiene que decir eso. `retainer_cop` es el monto mensual en pesos;
-- cuando está puesto, la cuenta del mes ES ese número, no la tarifa por
-- persona por el headcount. `price_cop_per_seat` se queda en 0 en esta fila
-- para que un lector que no haya visto la columna nueva no los cobre como
-- Equipo.
--
-- Enterprise sigue existiendo. Es el plan del espacio que ya estaba (0114).
-- Gerente es la conversación nueva: implantación, WhatsApp, briefing, SLA.
-- Nadie se mueve de fila solo.

alter table public.plans
  add column if not exists retainer_cop integer;

comment on column public.plans.retainer_cop is
  'Retainer mensual en COP. Si no es NULL, la factura del mes es este monto, no price_cop_per_seat × asientos. NULL = precio por persona.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'plans_retainer_cop_positive'
  ) then
    alter table public.plans
      add constraint plans_retainer_cop_positive
      check (retainer_cop is null or retainer_cop > 0);
  end if;
end
$$;

insert into public.plans
  (code, name, tagline, price_cop_per_seat, answers_per_seat, documents_per_seat,
   billable_seats_minimum, seats_maximum, self_serve, sort_order, retainer_cop)
values
  ('gerente', 'Gerente',
   'Un gerente operativo para tu empresa: abre el martes, propone, recuerda y rinde cuentas. Implantación, WhatsApp y un acuerdo de servicio.',
   0, null, null, 1, null, false, 5, 10000000)
on conflict (code) do update
   set name                    = excluded.name,
       tagline                 = excluded.tagline,
       price_cop_per_seat      = excluded.price_cop_per_seat,
       answers_per_seat        = excluded.answers_per_seat,
       documents_per_seat      = excluded.documents_per_seat,
       billable_seats_minimum  = excluded.billable_seats_minimum,
       seats_maximum           = excluded.seats_maximum,
       self_serve              = excluded.self_serve,
       sort_order              = excluded.sort_order,
       retainer_cop            = excluded.retainer_cop;

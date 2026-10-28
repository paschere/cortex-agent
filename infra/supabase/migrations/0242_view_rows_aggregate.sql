-- 0242 — Agregados de las vistas en la base (tablas de más de 2.000 filas).
--
-- Una vista lee como mucho 2.000 filas por tabla (VIEW_ROW_CAP). Con una tabla
-- de 5.000 filas, las cifras, gráficos, avances y conteos por columna salían
-- de las 2.000 más recientes, sin decirlo. Aquí el cálculo se hace DONDE
-- ESTÁN LAS FILAS: `view_rows_aggregate` suma/cuenta/promedia/min/max los
-- valores guardados en tracker_rows.values, agrupados por un campo o por
-- fecha, con los mismos filtros que aplica el servidor (filtros del bloque,
-- barra de filtros) y el alcance del rol («own», «equals»). Al servidor web
-- sólo vuelven los grupos con sus totales, nunca las filas.
--
-- Las reglas de cada filtro copian a las de views/compute.ts (`matches`,
-- `matchesBar`) para que el número con tabla truncada sea el mismo que con
-- todas las filas en memoria. Los totales calculados al vuelo y sin valor
-- guardado NO se pueden sumar aquí: el cliente los detecta y vuelve al cálculo
-- sobre las filas cargadas, avisando.
--
-- Tenencia: security definer, pero TODA lectura va con
-- `organization_id = p_organization_id` (el cliente con alcance lo pone; ver
-- RPC_TENANCY 'organization'). Sólo service_role puede ejecutarla. No hay SQL
-- dinámico: los nombres de campo se validan con una expresión regular y viajan
-- como parámetros. Idempotente.

-- ---------------------------------------------------------------------------
-- Ayudantes (puros)
-- ---------------------------------------------------------------------------

-- Texto → número, como `Number(v)` finito de JS; lo que no es número → null.
create or replace function public.view_num(t text)
returns numeric
language plpgsql immutable parallel safe as $$
begin
  if t is null then return null; end if;
  t := btrim(t);
  if t !~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return null; end if;
  return t::numeric;
exception when others then
  return null;
end $$;

-- Un valor de fecha → su día (YYYY-MM-DD) en Bogotá, como `dayOf`.
create or replace function public.view_day(t text)
returns text
language plpgsql immutable parallel safe as $$
begin
  if t is null then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}$' then return t; end if;
  return to_char((t::timestamptz at time zone 'America/Bogota'), 'YYYY-MM-DD');
exception when others then
  return null;
end $$;

-- Minúsculas, sin tildes ni espacios de los bordes (`fold` del servidor).
create or replace function public.view_fold(t text)
returns text
language sql immutable parallel safe as $$
  select lower(btrim(translate(coalesce(t, ''),
    'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ',
    'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')))
$$;

-- El nombre que se pinta de un valor de relación (id suelto o {id,label}).
create or replace function public.view_relation_label(t text)
returns text
language plpgsql immutable parallel safe as $$
declare j jsonb;
begin
  if t is null then return null; end if;
  t := btrim(t);
  if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return left(t, 8);
  end if;
  begin
    j := t::jsonb;
  exception when others then
    return t;
  end;
  if jsonb_typeof(j) = 'object' and (j->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return case when coalesce(j->>'label', '') <> '' then left(j->>'label', 200) else left(j->>'id', 8) end;
  end if;
  return t;
end $$;

-- El valor crudo de una columna de la vista: label, created_at/updated_at (el
-- día en Bogotá) o un campo de values. Vacío = null, como `rawValue`.
create or replace function public.view_raw(r public.tracker_rows, f text)
returns text
language sql immutable parallel safe as $$
  select case f
    when 'label' then r.label
    when 'created_at' then to_char(r.created_at at time zone 'America/Bogota', 'YYYY-MM-DD')
    when 'updated_at' then to_char(r.updated_at at time zone 'America/Bogota', 'YYYY-MM-DD')
    else nullif(r.values ->> f, '')
  end
$$;

-- ¿La fila cumple este filtro? f = {field, op, value, t} con t = num|date|text.
-- Los operadores del bloque son los de `matches`; los de la barra son
-- fold_eq, search y range (los de `matchesBar`).
create or replace function public.view_filter_match(r public.tracker_rows, f jsonb, p_today date)
returns boolean
language plpgsql immutable parallel safe as $$
declare
  v text := public.view_raw(r, f ->> 'field');
  op text := f ->> 'op';
  val text := f ->> 'value';
  t text := coalesce(f ->> 't', 'text');
  eq boolean;
  cmp numeric;
  c integer;
  d text;
  n integer;
  today text := to_char(p_today, 'YYYY-MM-DD');
begin
  case op
    when 'empty' then return v is null;
    when 'not_empty' then return v is not null;
    when 'eq', 'neq' then
      eq := v is not null and (
        case when t = 'num'
          then coalesce(public.view_num(v) = public.view_num(val), false)
          else lower(btrim(v)) = lower(btrim(val))
        end);
      return case when op = 'eq' then eq else not eq end;
    when 'fold_eq' then
      if v is null then return false; end if;
      if t = 'num' then return coalesce(public.view_num(v) = public.view_num(val), false); end if;
      return public.view_fold(v) = public.view_fold(val);
    when 'search' then
      if public.view_fold(val) = '' then return true; end if;
      return position(public.view_fold(val) in public.view_fold(v)) > 0
        or position(public.view_fold(val) in public.view_fold(r.label)) > 0;
    when 'range' then
      if v is null then return false; end if;
      d := public.view_day(v);
      if d is null then return false; end if;
      return (coalesce(f ->> 'from', '') = '' or d >= f ->> 'from')
         and (coalesce(f ->> 'to', '') = '' or d <= f ->> 'to');
    when 'contains' then
      return v is not null and position(lower(btrim(val)) in lower(v)) > 0;
    when 'gt', 'gte', 'lt', 'lte' then
      if v is null then return false; end if;
      if t = 'num' then
        cmp := public.view_num(v) - public.view_num(val);
        if cmp is null then return false; end if;
        c := sign(cmp)::integer;
      else
        c := case when v collate "C" < val collate "C" then -1
                  when v collate "C" > val collate "C" then 1 else 0 end;
      end if;
      return case op when 'gt' then c > 0 when 'gte' then c >= 0 when 'lt' then c < 0 else c <= 0 end;
    when 'before_today', 'after_today', 'next_days', 'last_days' then
      if t <> 'date' or v is null then return false; end if;
      d := public.view_day(v);
      if d is null then return false; end if;
      if op = 'before_today' then return d < today; end if;
      if op = 'after_today' then return d > today; end if;
      n := greatest(0, floor(coalesce(public.view_num(val), 0))::integer);
      if op = 'next_days' then
        return d >= today and d <= to_char(p_today + n, 'YYYY-MM-DD');
      end if;
      return d <= today and d >= to_char(p_today - n, 'YYYY-MM-DD');
    else
      return false;
  end case;
end $$;

-- ---------------------------------------------------------------------------
-- La función
-- ---------------------------------------------------------------------------
-- p_field   campo numérico a agregar (null = sólo se cuenta)
-- p_group   null (un solo grupo) | {kind:'value'|'relation'|'date', field,
--           bucket:'day'|'week'|'month', from:'YYYY-MM-DD'}
-- p_filters arreglo de filtros (ver view_filter_match); todos deben cumplirse
-- p_scope   {kind:'all'} | {kind:'own', userId, external} | {kind:'equals', field, value}
-- Devuelve un renglón por grupo: cnt = filas, n = filas con número, total/lo/hi
-- = suma/mínimo/máximo de los números. A lo sumo 5.001 grupos.
create or replace function public.view_rows_aggregate(
  p_organization_id text,
  p_tracker_id      uuid,
  p_field           text,
  p_group           jsonb,
  p_filters         jsonb,
  p_scope           jsonb,
  p_today           date
)
returns table (grp text, cnt bigint, n bigint, total numeric, lo numeric, hi numeric)
language plpgsql stable security definer set search_path = public, pg_temp set timezone = 'UTC' as $$
declare
  v_field   text := nullif(p_field, '');
  v_gkind   text := p_group ->> 'kind';
  v_gfield  text := p_group ->> 'field';
  v_bucket  text := coalesce(p_group ->> 'bucket', 'month');
  v_from    text := nullif(p_group ->> 'from', '');
  v_scope   text := coalesce(p_scope ->> 'kind', 'all');
  v_sfield  text := p_scope ->> 'field';
  v_sval    text := p_scope ->> 'value';
  v_user    uuid;
  v_ext     boolean := coalesce((p_scope ->> 'external')::boolean, false);
  v_filters jsonb := case when jsonb_typeof(p_filters) = 'array' then p_filters else '[]'::jsonb end;
  v_name    text := '^[A-Za-z0-9_]{1,32}$';
begin
  if p_organization_id is null or p_tracker_id is null then
    raise exception 'view_rows_aggregate: falta la empresa o la tabla';
  end if;
  if v_field is not null and v_field !~ v_name then
    raise exception 'view_rows_aggregate: campo inválido';
  end if;
  if p_group is not null and jsonb_typeof(p_group) = 'object' then
    if v_gkind not in ('value', 'relation', 'date') or v_gfield is null or v_gfield !~ v_name then
      raise exception 'view_rows_aggregate: grupo inválido';
    end if;
    if v_gkind = 'date' and v_bucket not in ('day', 'week', 'month') then
      raise exception 'view_rows_aggregate: período inválido';
    end if;
  else
    v_gkind := null;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_filters) e
    where jsonb_typeof(e) <> 'object'
       or (e ->> 'field') is null or (e ->> 'field') !~ '^[A-Za-z0-9_]{1,32}$'
  ) then
    raise exception 'view_rows_aggregate: filtro inválido';
  end if;
  if v_scope = 'none' then return; end if;
  if v_scope = 'own' then
    v_user := (p_scope ->> 'userId')::uuid;
  elsif v_scope = 'equals' then
    -- La misma regla que `rowVisible`: un valor nulo no deja ver nada.
    if v_sfield is null or v_sfield !~ v_name or v_sval is null then return; end if;
  elsif v_scope <> 'all' then
    raise exception 'view_rows_aggregate: alcance inválido';
  end if;

  return query
  with picked as (
    select r,
           case v_gkind
             when 'value' then public.view_raw(r, v_gfield)
             when 'relation' then public.view_relation_label(public.view_raw(r, v_gfield))
             when 'date' then
               (select case v_bucket
                         when 'day' then d
                         when 'month' then left(d, 7)
                         else to_char(d::date - (extract(isodow from d::date)::integer - 1), 'YYYY-MM-DD')
                       end
                  from (select public.view_day(public.view_raw(r, v_gfield)) as d) x)
             else null
           end as g,
           case when v_field is null then null else public.view_num(public.view_raw(r, v_field)) end as num,
           case when v_gkind = 'date' then public.view_day(public.view_raw(r, v_gfield)) end as day
    from public.tracker_rows r
    where r.organization_id = p_organization_id
      and r.tracker_id = p_tracker_id
      and (v_scope = 'all'
           or (v_scope = 'own' and case when v_ext then r.created_by_app_user else r.created_by end = v_user)
           or (v_scope = 'equals' and coalesce(r.values ->> v_sfield, '') = v_sval))
      and not exists (
        select 1 from jsonb_array_elements(v_filters) f
        where not public.view_filter_match(r, f, p_today)
      )
  )
  select p.g, count(*)::bigint, count(p.num)::bigint, sum(p.num), min(p.num), max(p.num)
  from picked p
  where v_gkind is distinct from 'date' or (p.day is not null and (v_from is null or p.day >= v_from))
  group by p.g
  order by count(*) desc, p.g
  limit 5001;
end $$;

comment on function public.view_rows_aggregate(text, uuid, text, jsonb, jsonb, jsonb, date) is
  'Agregados de una tabla propia para las vistas: cuenta/suma/min/max por grupo con los filtros y el alcance del servidor. Sin filas hacia el servidor web. Por empresa (p_organization_id).';

revoke all on function public.view_rows_aggregate(text, uuid, text, jsonb, jsonb, jsonb, date) from public, anon, authenticated;
grant execute on function public.view_rows_aggregate(text, uuid, text, jsonb, jsonb, jsonb, date) to service_role;

revoke all on function public.view_num(text) from public, anon, authenticated;
revoke all on function public.view_day(text) from public, anon, authenticated;
revoke all on function public.view_fold(text) from public, anon, authenticated;
revoke all on function public.view_relation_label(text) from public, anon, authenticated;
revoke all on function public.view_raw(public.tracker_rows, text) from public, anon, authenticated;
revoke all on function public.view_filter_match(public.tracker_rows, jsonb, date) from public, anon, authenticated;
grant execute on function public.view_num(text) to service_role;
grant execute on function public.view_day(text) to service_role;
grant execute on function public.view_fold(text) to service_role;
grant execute on function public.view_relation_label(text) to service_role;
grant execute on function public.view_raw(public.tracker_rows, text) to service_role;
grant execute on function public.view_filter_match(public.tracker_rows, jsonb, date) to service_role;

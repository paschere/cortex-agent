-- La línea de mando: a quién le responde cada quien.
--
-- ===========================================================================
-- EL HUECO QUE ESTO TAPA, MEDIDO
-- ===========================================================================
-- Cortex ya sabe escalar. La 0069 le puso a `commitments` dos columnas
-- (`escalate_to_user_id`, `escalate_after_days`), `noticesOwed`
-- (packages/agent-tools/src/commitments/shape.ts) decide cuándo se ha ganado un
-- escalado, y `commitments-watch.ts` lo manda por correo reclamándolo contra el
-- índice único (commitment_id, notice_kind, due_on) para no repetirlo. Todo eso
-- funciona entero y esta migración no lo toca.
--
-- Lo que falta es más simple y más grave: CORTEX NO SABE QUIÉN LE RESPONDE A
-- QUIÉN. La única manera de nombrar al destinatario de un escalado es
-- `commitments.record(escalateToEmail: …)`, o sea a mano, por correo, compromiso
-- a compromiso. Nadie hace eso en el compromiso número cuatrocientos. Y lo que
-- pasa cuando nadie lo hace es peor que no tener escalado, porque no se ve:
--
--     const to = noticeKind === 'escalation'
--       ? (row.escalate_to_user_id ?? admins[0] ?? null)   ← admins[0]
--       : (row.owner_user_id ?? admins[0] ?? null);
--
-- y `admins` salía de un `select('id').eq('role','org_admin').limit(10)` SIN
-- `order by`. Así que todo escalado que nadie nombró caía en un administrador
-- cualquiera, elegido por el orden en que Postgres devolvió las filas. En una
-- empresa de cuarenta personas eso es un solo buzón recibiendo los escalados de
-- todos, y un buzón así deja de leerse en dos semanas — que es literalmente el
-- modo de fallo contra el que avisa el comentario de `noticesOwed`: «así es como
-- la gente a la que avergüenza desactiva en silencio un camino de escalado».
--
-- Con una columna, el orden de resolución pasa a ser:
--
--   1. `escalate_to_user_id`  Lo nombrado a mano en ESE compromiso. Gana siempre,
--                             sin cambios. Ni una fila existente hay que tocar.
--   2. El jefe del responsable (`owner_user_id` → su `manager_id`).  ← esto es nuevo
--   3. `admins[0]`            Último recurso, como hoy, pero ORDENADO.
--
-- ===========================================================================
-- POR QUÉ UNA COLUMNA Y NO UNA TABLA DE RELACIONES
-- ===========================================================================
-- La alternativa sería `reporting_lines(user_id, manager_id, kind)`, que admite
-- matriz —un jefe funcional y otro de línea— y fechas de vigencia. Se descarta,
-- y no por simplicidad: una segunda relación obliga a que TODO el que lea la
-- línea elija cuál, y el que la lee es el que decide a quién se le manda un
-- correo por encima de tu cabeza. Una pregunta con dos respuestas correctas en
-- ese sitio se contesta distinto en cada llamada.
--
-- Un jefe por persona es además lo que la empresa puede mantener al día. Cuando
-- haga falta la matriz, esta columna es el caso «línea» de aquella tabla y la
-- migración es un `insert … select`.
--
-- ===========================================================================
-- LAS CUATRO GUARDAS, Y CADA UNA CONTRA SU CASO VACÍO
-- ===========================================================================
-- Un CHECK que devuelve NULL PASA. Es la trampa que ya mordió a este repositorio
-- (`array_length('{}',1)` es NULL, y el CHECK pasó), así que cada guarda de aquí
-- abajo dice explícitamente qué hace cuando no hay dato:
--
--   NADIE ES SU PROPIO JEFE. `manager_id is null or manager_id <> id`. La
--   primera rama está escrita a mano en vez de dejar que `null <> null` decida:
--   con sólo `manager_id <> id` el caso «sin jefe» pasaría por NULL, que es la
--   respuesta correcta por el camino equivocado, y el día que alguien añada un
--   `and` al CHECK dejaría de serlo.
--
--   MEDIDO: en la práctica quien rechaza esto primero es el disparador de
--   ciclos de más abajo —los disparadores BEFORE corren antes que los CHECK, y
--   ser tu propio jefe es el ciclo de longitud uno—, así que el mensaje que ve
--   la gente es el del círculo. El CHECK se queda igual y no sobra: es
--   declarativo, sale en un `\d users`, y sigue rechazando la fila con el
--   disparador desactivado, que es el único estado en que el otro no está.
--
--   EL JEFE ES DE LA MISMA EMPRESA. Una clave foránea simple contra
--   `public.users(id)` NO lo obliga: desde la 0064 una fila de directorio
--   pertenece a exactamente un espacio de trabajo, y `manager_id` apuntando a
--   otro sería una línea de mando que cruza inquilinos — Cortex mandándole el
--   escalado de una empresa a alguien de otra. Se cierra con una clave foránea
--   COMPUESTA sobre (manager_id, organization_id), que es estructural y no se
--   puede desactivar. Con `manager_id` NULL la restricción no se comprueba
--   (MATCH SIMPLE), que es justo lo que se quiere.
--
--   EL JEFE QUE SE VA. `on delete set null (manager_id)`. La cadena se ACORTA
--   hasta los administradores; nunca se rompe ni deja filas colgando. La forma
--   con lista de columnas es de PostgreSQL 15 (infra/supabase/config.toml fija
--   major_version = 15) y hace falta: sin ella, `set null` nularía también
--   `organization_id`, que es NOT NULL, y borrar a un jefe fallaría.
--
--   CICLOS. A responde a B y B a A cuelga cualquier recorrido de la cadena. No
--   cabe en un CHECK —hace falta caminar la tabla—, así que va en un disparador.
--   Y va en un disparador y no sólo en la pantalla a propósito: la validación de
--   la pantalla no para una fila escrita a mano ni por una migración. La otra
--   mitad de la defensa está en `chainAbove`
--   (packages/agent-tools/src/directory/line.ts), que acota TODA lectura con un
--   tope de profundidad y un conjunto de visitados. Hacen falta las dos: el
--   disparador impide crear el ciclo, el tope impide que un ciclo que ya exista
--   cuelgue el vigilante nocturno.
--
-- ===========================================================================
-- LO QUE ESTA MIGRACIÓN DELIBERADAMENTE NO HACE
-- ===========================================================================
-- No rellena nada. No hay ninguna heurística honesta para adivinar el jefe de
-- nadie —«el que creó el espacio de trabajo» es una suposición con cara de
-- dato—, y una línea de mando inventada es peor que ninguna: escalaría a la
-- persona equivocada y nadie sabría que hay algo que corregir. Todo el mundo
-- nace sin jefe, el escalado sigue cayendo en el primer administrador tal como
-- hoy, y cada línea que alguien escriba mejora el reparto.
--
-- Idempotente de principio a fin.

alter table public.users
  add column if not exists manager_id uuid;

-- ---------------------------------------------------------------------------
-- Nadie es su propio jefe
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_manager_not_self') then
    alter table public.users
      add constraint users_manager_not_self
      check (manager_id is null or manager_id <> id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- El jefe es de la misma empresa
-- ---------------------------------------------------------------------------
-- La clave foránea compuesta necesita un índice único sobre exactamente
-- (id, organization_id). `id` ya es la clave primaria, así que este par no añade
-- ninguna restricción nueva sobre los datos: existe para que la foránea de abajo
-- tenga a qué apuntar.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_id_org_key') then
    alter table public.users
      add constraint users_id_org_key unique (id, organization_id);
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_manager_same_org_fkey') then
    alter table public.users
      add constraint users_manager_same_org_fkey
      foreign key (manager_id, organization_id)
      references public.users (id, organization_id)
      on delete set null (manager_id);
  end if;
end
$$;

-- «¿Quién me responde a mí?» es la mitad de las lecturas de esta columna: la
-- pantalla dibuja el árbol hacia abajo y el vigilante resuelve hacia arriba.
-- Parcial porque la inmensa mayoría de las filas tendrán `manager_id` nulo
-- durante mucho tiempo y ninguna de ellas se busca nunca por aquí.
create index if not exists users_manager_idx
  on public.users (organization_id, manager_id)
  where manager_id is not null;

-- ---------------------------------------------------------------------------
-- Ciclos
-- ---------------------------------------------------------------------------
-- Camina hacia arriba desde el jefe que se está poniendo. Si llega a la propia
-- persona, la línea se muerde la cola y se rechaza.
--
-- EL TOPE DE SALTOS NO ES DEFENSIVO POR COSTUMBRE: si en la tabla YA hay un
-- ciclo (escrito antes de que existiera este disparador, o por una restauración
-- parcial), este bucle no terminaría nunca y colgaría la transacción que
-- intentaba arreglarlo. Con el tope, lo que pasa es que la escritura falla
-- diciendo lo que ocurre.
create or replace function public.users_manager_no_cycle()
returns trigger
language plpgsql
as $$
declare
  walker uuid := new.manager_id;
  hops   int  := 0;
begin
  while walker is not null loop
    if walker = new.id then
      raise exception
        'La línea de mando se muerde la cola: esa persona ya está por encima en la cadena.'
        using errcode = 'check_violation';
    end if;
    hops := hops + 1;
    if hops > 64 then
      raise exception
        'La línea de mando pasa de 64 escalones o ya tiene un ciclo escrito. Revísala antes de cambiar este jefe.'
        using errcode = 'check_violation';
    end if;
    select u.manager_id into walker from public.users u where u.id = walker;
  end loop;
  return new;
end;
$$;

drop trigger if exists users_manager_no_cycle_trg on public.users;
create trigger users_manager_no_cycle_trg
  before insert or update of manager_id on public.users
  for each row
  when (new.manager_id is not null)
  execute function public.users_manager_no_cycle();

-- ---------------------------------------------------------------------------

comment on column public.users.manager_id is
  'A quién le responde esta persona dentro de este espacio de trabajo. Decide el destinatario de un escalado cuando el compromiso no nombró a nadie: escalate_to_user_id gana siempre, luego el jefe del responsable, y sólo entonces el primer administrador. Nulo es lo normal y es válido: la cadena se acorta hasta los administradores. Nadie es su propio jefe (users_manager_not_self), el jefe es del mismo espacio (users_manager_same_org_fkey, compuesta a propósito: una foránea simple no lo obliga), y no puede haber ciclos (users_manager_no_cycle_trg). Toda lectura de la cadena va además acotada por chainAbove() en packages/agent-tools/src/directory/line.ts.';

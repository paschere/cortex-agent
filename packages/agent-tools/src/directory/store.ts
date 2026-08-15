import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type DirectoryPerson,
  type ManagerLink,
  type ManagerMap,
  managerMapOf,
  personLabel,
  wouldCycle,
} from './line';

/**
 * Toda lectura y toda escritura de la línea de mando, en un módulo.
 *
 * UNA SOLA PUERTA DE ESCRITURA, igual que `writeCompanyFact` (0104) y por la
 * lección de la 0064: la pantalla es cortesía, esto es la regla. `setManager` es
 * el único sitio del producto que escribe `users.manager_id`, así que las
 * comprobaciones que aquí se hacen no se pueden saltar añadiendo una pantalla
 * nueva — y las que la base también hace (ciclo, mismo espacio, no ser tu propio
 * jefe) se repiten aquí NO por redundancia sino porque un `check_violation` de
 * Postgres es un mensaje que nadie puede leer, y esta es la capa que sabe decir
 * el nombre de la persona.
 *
 * `db` es siempre un handle con alcance de espacio de trabajo. Nada de aquí
 * filtra por `organization_id` a mano.
 */

export const DIRECTORY_COLUMNS = 'id, email, name, role, manager_id, created_at';

export interface DirectoryRow {
  id: string;
  email: string;
  name: string | null;
  role: 'member' | 'team_admin' | 'org_admin';
  manager_id: string | null;
  created_at: string;
}

export function adaptDirectoryPerson(row: DirectoryRow): DirectoryPerson {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    managerId: row.manager_id,
  };
}

/** Toda la gente del espacio, con su jefe. Orden estable, no el del planificador. */
export async function listDirectory(db: SupabaseClient): Promise<DirectoryRow[]> {
  const { data, error } = await db
    .from('users')
    .select(DIRECTORY_COLUMNS)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DirectoryRow[];
}

/**
 * Sólo los dos campos que hacen falta para resolver un escalado.
 *
 * Separada de `listDirectory` porque la llama el vigilante nocturno una vez por
 * espacio de trabajo y por noche, y ahí no hace falta bajar nombres ni correos
 * de toda la empresa para contestar «¿quién es el jefe de esta persona?».
 */
export async function loadManagerLinks(db: SupabaseClient): Promise<ManagerLink[]> {
  const { data, error } = await db.from('users').select('id, manager_id');
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; manager_id: string | null }>).map((r) => ({
    id: r.id,
    managerId: r.manager_id,
  }));
}

export async function loadManagerMap(db: SupabaseClient): Promise<ManagerMap> {
  return managerMapOf(await loadManagerLinks(db));
}

/**
 * Los administradores del espacio, EN UN ORDEN ESTABLE.
 *
 * ===========================================================================
 * EL `ORDER BY` ES LA MITAD DEL ARREGLO DE ESTE COMMIT
 * ===========================================================================
 * Esta consulta vivía en `commitments-watch.ts` sin ordenar, y `admins[0]` es el
 * último recurso de TODO escalado que nadie nombró. Sin `order by`, quién lo
 * recibe lo decidía el orden en que Postgres devolvió las filas — que no es
 * aleatorio pero tampoco es una decisión de nadie, y puede cambiar con un
 * `vacuum`. Un buzón elegido así recibe los escalados de toda la empresa hasta
 * que deja de leerse, y nadie puede señalar la línea donde se decidió.
 *
 * Por antigüedad, y eso sí es una decisión: el primer administrador de un
 * espacio de trabajo es casi siempre quien lo creó, es decir el dueño. `id` de
 * desempate para que dos cuentas creadas en el mismo instante —una importación,
 * una siembra— no vuelvan a dejarlo al azar.
 */
export async function orgAdmins(db: SupabaseClient, limit = 10): Promise<string[]> {
  const { data, error } = await db
    .from('users')
    .select('id')
    .eq('role', 'org_admin')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((u) => u.id);
}

/** Correo de cada id pedido. Los que no estén en el espacio no salen. */
export async function emailsFor(
  db: SupabaseClient,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data, error } = await db.from('users').select('id, email').in('id', unique);
  if (error) throw error;
  return new Map(
    ((data ?? []) as Array<{ id: string; email: string }>).map((u) => [u.id, u.email]),
  );
}

// ---------------------------------------------------------------------------
// La única escritura
// ---------------------------------------------------------------------------

export interface SetManagerInput {
  userId: string;
  /** `null` quita el jefe. Es un estado válido y el que traen todos al nacer. */
  managerId: string | null;
}

/**
 * Decir a quién le responde alguien.
 *
 * Las dos filas se leen ANTES de escribir, con el handle con alcance, y eso es
 * lo que comprueba de verdad que las dos personas son de esta empresa: una
 * lectura con alcance que no devuelve la fila significa que ese id no es de
 * aquí, sin tener que confiar en un `organization_id` que venga de un
 * formulario. La foránea compuesta de la 0106 lo vuelve a impedir en la base;
 * esta capa existe para poder decirlo con palabras.
 */
export async function setManager(db: SupabaseClient, input: SetManagerInput): Promise<void> {
  const people = await listDirectory(db);
  const person = people.find((p) => p.id === input.userId);
  if (!person) throw new NotFoundError('Esa persona no está en este espacio de trabajo.');

  if (input.managerId) {
    const manager = people.find((p) => p.id === input.managerId);
    if (!manager) {
      throw new NotFoundError(
        'Quien pusiste de jefe no está en este espacio de trabajo, así que Cortex no podría escribirle.',
      );
    }
    if (manager.id === person.id) {
      throw new ValidationError(`${personLabel(person)} no puede responderse a sí misma.`);
    }
    const managers = managerMapOf(people.map((p) => ({ id: p.id, managerId: p.manager_id })));
    if (wouldCycle(managers, person.id, manager.id)) {
      throw new ValidationError(
        `${personLabel(person)} ya está por encima de ${personLabel(manager)} en la línea, ` +
          'así que ponerlo de jefe cerraría un círculo y el escalado no llegaría a nadie.',
      );
    }
  }

  const { error } = await db
    .from('users')
    .update({ manager_id: input.managerId })
    .eq('id', input.userId);
  if (error) throw error;
}

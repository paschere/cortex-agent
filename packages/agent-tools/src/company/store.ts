import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COMPANY_FACTS_BUDGET,
  COMPANY_FACTS_MAX,
  COMPANY_FACT_LABEL_MAX,
  COMPANY_FACT_VALUE_MAX,
  type CompanyFact,
  companySectionByKey,
  weighCompanyFact,
  weighCompanyFacts,
} from './shape';

/**
 * Toda lectura y toda escritura de la ficha de la empresa, en un módulo.
 *
 * La pantalla, el prompt y la herramienta del chat pasan por aquí, que es lo que
 * impide que las dos reglas que importan tengan dos implementaciones:
 *
 *   UNA SECCIÓN SÓLO EXISTE SI ESTÁ EN EL REGISTRO. `writeCompanyFact` la busca
 *   en COMPANY_SECTIONS aunque la pantalla ya lo haya hecho. La pantalla es
 *   cortesía; esto es la regla. El CHECK de la 0104 sólo comprueba la forma del
 *   slug, a propósito.
 *
 *   EL PRESUPUESTO SE RECHAZA AL ESCRIBIR, CON LA CIFRA. No se trunca al leer.
 *   El renderizador escribe todo lo que hay, siempre, porque recortar en el
 *   sitio más profundo del sistema haría desaparecer una instrucción de «Lo que
 *   no» sin que nadie lo viera.
 *
 * `db` es siempre un handle con alcance de espacio de trabajo. Nada de aquí
 * filtra por `organization_id` a mano.
 */

export const COMPANY_FACT_COLUMNS =
  'id, section, label, value, sort, updated_by, created_at, updated_at';

export interface CompanyFactRow extends CompanyFact {
  id: string;
  sort: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /** Rellenado por `hydrateCompanyFacts`. Nombres, no ids. */
  updated_by_name?: string | null;
}

/**
 * Todos los hechos del espacio, en el orden en que se leen y se inyectan.
 *
 * Ordenados por (section, sort, created_at) en la base y NO reordenados aquí:
 * `company_facts_org_section_idx` existe exactamente para esto, y el orden de la
 * sección lo pone `renderCompanyFactsBlock` recorriendo el registro, no esta
 * consulta.
 */
export async function listCompanyFacts(db: SupabaseClient): Promise<CompanyFactRow[]> {
  const { data, error } = await db
    .from('company_facts')
    .select(COMPANY_FACT_COLUMNS)
    .order('section', { ascending: true })
    .order('sort', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CompanyFactRow[];
}

/**
 * Lo que se le pasa al prompt, y la única lectura que NUNCA lanza.
 *
 * Mismo contrato que `loadMemoryContext`: un turno con menos contexto es un
 * turno peor, y un turno muerto es un producto caído. Si la consulta falla —la
 * migración no está aplicada en un entorno, la base parpadeó— el turno sigue sin
 * ficha y sin decir nada, que es exactamente lo que hace la otra mitad del
 * prompt cuando le pasa lo mismo.
 */
export async function loadCompanyFactsContext(db: SupabaseClient): Promise<CompanyFact[]> {
  try {
    const rows = await listCompanyFacts(db);
    return rows.map((r) => ({ section: r.section, label: r.label, value: r.value }));
  } catch {
    return [];
  }
}

export interface WriteCompanyFactInput {
  /** Presente para editar en sitio; ausente para crear. */
  id?: string | null;
  section: string;
  label: string;
  value: string;
  sort?: number;
  updatedBy: string | null;
}

/**
 * LA ÚNICA PUERTA DE ESCRITURA.
 *
 * Crea o corrige un hecho. Comprueba, en este orden y por este motivo:
 *
 *   1. Que la sección exista en el registro. Barato y descarta lo imposible.
 *   2. Que la etiqueta y el valor quepan. Espeja los CHECK de la 0104 para dar
 *      una frase en español en vez de un error de Postgres.
 *   3. Que el espacio no se pase del presupuesto NI del número de filas —y se
 *      comprueba CONTRA EL ESTADO YA GUARDADO, descontando la fila que se está
 *      editando, para que corregir un hecho largo por uno corto no lo rechace
 *      el peso del que se va a sustituir.
 *
 * El presupuesto se comprueba aquí y no en la base porque es una SUMA por
 * espacio de trabajo: no cabe en un CHECK, y un trigger que reagregara la tabla
 * en cada INSERT sería un candado por escritura para proteger de «el prompt
 * salió más largo de lo previsto». Ver la cabecera de la 0104.
 */
export async function writeCompanyFact(
  db: SupabaseClient,
  input: WriteCompanyFactInput,
): Promise<CompanyFactRow> {
  const section = companySectionByKey(input.section);

  const label = input.label.trim();
  const value = input.value.trim();
  if (label.length < 2 || label.length > COMPANY_FACT_LABEL_MAX)
    throw new ValidationError(
      `El nombre del dato tiene que tener entre 2 y ${COMPANY_FACT_LABEL_MAX} caracteres.`,
    );
  if (value.length < 1 || value.length > COMPANY_FACT_VALUE_MAX)
    throw new ValidationError(
      `«${label}» se pasa: el dato puede tener hasta ${COMPANY_FACT_VALUE_MAX} caracteres y tiene ${value.length}. Resúmelo, o pártelo en dos datos.`,
    );

  const existing = await listCompanyFacts(db);
  const others = existing.filter((r) => r.id !== input.id);

  if (!input.id && others.length >= COMPANY_FACTS_MAX)
    throw new ValidationError(
      `La ficha ya tiene ${COMPANY_FACTS_MAX} datos, que es el máximo. Borra alguno que ya no aplique antes de añadir otro.`,
    );

  const next: CompanyFact = { section: section.key, label, value };
  const used = weighCompanyFacts([...others, next]);
  if (used > COMPANY_FACTS_BUDGET) {
    const spare = COMPANY_FACTS_BUDGET - weighCompanyFacts(others);
    throw new ValidationError(
      `No cabe: la ficha entra entera en cada respuesta de Cortex y tiene un tope de ${COMPANY_FACTS_BUDGET} caracteres. «${label}» ocupa ${weighCompanyFact(next)} y sólo quedan ${Math.max(spare, 0)}. Borra un dato que ya no aplique o acorta este.`,
    );
  }

  const row = {
    section: section.key,
    label,
    value,
    sort: Math.max(0, Math.trunc(input.sort ?? 0)),
    updated_by: input.updatedBy,
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { data, error } = await db
      .from('company_facts')
      .update(row)
      .eq('id', input.id)
      .select(COMPANY_FACT_COLUMNS)
      .maybeSingle();
    if (error) throw translate(error, label);
    if (!data) throw new NotFoundError('Ese dato ya no está en la ficha.');
    return data as CompanyFactRow;
  }

  const { data, error } = await db
    .from('company_facts')
    .insert(row)
    .select(COMPANY_FACT_COLUMNS)
    .single();
  if (error) throw translate(error, label);
  return data as CompanyFactRow;
}

export async function deleteCompanyFact(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('company_facts').delete().eq('id', id);
  if (error) throw error;
}

/**
 * El duplicado, dicho en español.
 *
 * `company_facts_label_once_idx` es lo que impide dos respuestas a la misma
 * pregunta, y lo decide la base y no una consulta previa esperanzada. Lo único
 * que hace falta aquí es que el error no llegue a la pantalla como «23505».
 */
function translate(error: { code?: string }, label: string): Error {
  if (error.code === '23505')
    return new ValidationError(
      `Ya hay un dato que se llama «${label}» en esa sección. Edita el que hay en vez de añadir otro, o ponle otro nombre.`,
    );
  return error as Error;
}

/** Los nombres de quien escribió cada cosa, en una consulta y no en N. */
export async function hydrateCompanyFacts(
  db: SupabaseClient,
  rows: CompanyFactRow[],
): Promise<CompanyFactRow[]> {
  const ids = [...new Set(rows.map((r) => r.updated_by).filter((x): x is string => !!x))];
  if (ids.length === 0) return rows;
  const { data } = await db.from('users').select('id, name, email').in('id', ids);
  const byId = new Map((data ?? []).map((u) => [u.id as string, (u.name ?? u.email) as string]));
  return rows.map((r) => ({
    ...r,
    updated_by_name: r.updated_by ? (byId.get(r.updated_by) ?? null) : null,
  }));
}

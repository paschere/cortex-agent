import { TABLE_TENANCY, type TableTenancy } from '@cortex/agent-tools';

/**
 * QUÉ ENTRA EN «DESCARGAR TODOS LOS DATOS DE LA EMPRESA».
 *
 * La lista NO se escribe a mano: sale del registro de tenencia
 * (packages/agent-tools/src/tenancy/tables.ts), que es la única lista que ya
 * está obligada a nombrar cada tabla del producto — `registry.test.ts` falla si
 * aparece una consulta a una tabla sin clasificar. Así, una tabla nueva de
 * empresa entra en la exportación el mismo día que entra en el producto, sin
 * que nadie se acuerde de esto. `export-plan.test.ts` lo comprueba:
 * exportadas ∪ excluidas = tenant ∪ derived del registro.
 *
 * Lo que se EXCLUYE se dice con su razón, igual que el registro exige una razón
 * para cada `shared`. Hoy son dos tablas, y ninguna es «dato de la empresa» en
 * el sentido del titular: los archivos (que van aparte, con su contenido) y las
 * llaves criptográficas de la sesión de WhatsApp.
 *
 * Y las COLUMNAS con credenciales se vacían en todas las tablas: un ZIP que se
 * descarga, se reenvía y se olvida en una carpeta no debe llevar tokens de
 * Google cifrados ni contraseñas de portales. Se dice en el manifiesto qué se
 * vació y por qué.
 */

export interface ExportTable {
  table: string;
  kind: 'tenant' | 'derived';
  /** Para las derivadas: la columna que apunta al padre y el padre. */
  parentKey?: string;
  parent?: string;
}

export const EXPORT_EXCLUDED: Readonly<Record<string, string>> = {
  app_files:
    'Los archivos se exportan aparte, en la carpeta archivos/, con su contenido original; como filas serían bytes en hexadecimal dentro de un JSON.',
  whatsapp_session_keys:
    'Llaves criptográficas de la sesión vinculada de WhatsApp: son una credencial del dispositivo, no información de la empresa, y con ellas cualquiera podría suplantar la sesión.',
};

/** Columnas que nunca salen en una exportación, en ninguna tabla. */
const SECRET_COLUMN =
  /(_enc|_encrypted|_ciphertext|_hash)$|secret|password|passwd|private_key|api_key|cookie|credential|(^|_)token$|^access_token|^refresh_token|storage_state/i;

/** Vectores numéricos derivados del texto: pesan mucho y no informan nada. */
const DERIVED_COLUMN = /^embedding$/i;

export type ColumnTreatment = 'keep' | 'secret' | 'derived';

export function columnTreatment(column: string): ColumnTreatment {
  if (SECRET_COLUMN.test(column)) return 'secret';
  if (DERIVED_COLUMN.test(column)) return 'derived';
  return 'keep';
}

/** Lo que sale, en el orden del registro. */
export function exportTables(
  registry: Readonly<Record<string, TableTenancy>> = TABLE_TENANCY,
  excluded: Readonly<Record<string, string>> = EXPORT_EXCLUDED,
): ExportTable[] {
  const out: ExportTable[] = [];
  for (const [table, t] of Object.entries(registry)) {
    if (table in excluded) continue;
    if (t.kind === 'tenant') out.push({ table, kind: 'tenant' });
    else if (t.kind === 'derived') {
      out.push({ table, kind: 'derived', parentKey: t.parentKey, parent: t.parent });
    }
  }
  return out;
}

/** Un nombre de tabla que se puede interpolar entre comillas sin miedo. */
export function safeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Identificador inválido: ${name}`);
  return `"${name}"`;
}

/**
 * La consulta de una tabla para la exportación de la empresa. Las columnas a
 * quitar van como parámetro ($2) para `to_jsonb(t) - $2::text[]`.
 */
export function companyExportQuery(t: ExportTable): { sql: string; params: 'org' } {
  const table = safeIdentifier(t.table);
  if (t.kind === 'tenant') {
    return {
      sql: `select (to_jsonb(t) - $2::text[]) as row from public.${table} t where t.organization_id = $1`,
      params: 'org',
    };
  }
  const parent = safeIdentifier(t.parent as string);
  const key = safeIdentifier(t.parentKey as string);
  return {
    sql: `select (to_jsonb(t) - $2::text[]) as row from public.${table} t where t.${key} in (select p.id from public.${parent} p where p.organization_id = $1)`,
    params: 'org',
  };
}

/**
 * La consulta de una tabla para la exportación PERSONAL: sólo lo que está a
 * nombre de la persona en este espacio. Devuelve null si la tabla no tiene cómo
 * atribuirse a alguien (entonces es de la empresa, no suya).
 *
 *   users          su fila del directorio.
 *   messages       los mensajes de SUS conversaciones (tienen conversation_id).
 *   con user_id    lo que lleva su id.
 */
export function personalExportQuery(t: ExportTable, columns: readonly string[]): string | null {
  const table = safeIdentifier(t.table);
  if (t.table === 'users') {
    return `select (to_jsonb(t) - $3::text[]) as row from public.${table} t where t.organization_id = $1 and t.id = $2`;
  }
  if (t.kind !== 'tenant') return null;
  if (columns.includes('user_id')) {
    return `select (to_jsonb(t) - $3::text[]) as row from public.${table} t where t.organization_id = $1 and t.user_id = $2`;
  }
  if (t.table === 'messages' && columns.includes('conversation_id')) {
    return `select (to_jsonb(t) - $3::text[]) as row from public.${table} t where t.organization_id = $1 and t.conversation_id in (select c.id from public.conversations c where c.organization_id = $1 and c.user_id = $2)`;
  }
  return null;
}

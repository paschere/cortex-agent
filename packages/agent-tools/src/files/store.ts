import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * La capa de archivos del producto: `public.app_files` (migración 0109).
 *
 * Antes los archivos vivían en Supabase Storage; eran lo único que amarraba el
 * producto a Supabase además de Postgres. Ahora viven como bytea al lado de los
 * datos que los describen, y este módulo es la única forma de tocarlos. La API
 * calca la semántica que Storage daba a los call sites reales:
 *
 *   putFile      = upload con upsert:true — la identidad es (bucket, path),
 *                  subir a la misma ruta reemplaza, no duplica.
 *   getFile      = download — bytes y content-type, o null si no está.
 *   removeFiles  = remove([paths]) — borra varias rutas de un bucket.
 *
 * EL CONTENIDO VIAJA EN HEX. PostgREST habla JSON, y un bytea en JSON es su
 * representación de texto de Postgres: `\x` seguido de hex. Al escribir se
 * manda `'\x' + hex`; al leer llega la misma forma y se decodifica. El hex
 * duplica el tamaño en tránsito, lo cual es aceptable para los caminos que
 * pasan por aquí (todos con techo de 10 MB). Los caminos grandes — el audio de
 * reuniones, hasta 200 MB — NO usan este módulo: van por una conexión pg
 * directa en apps/web/lib/files-db.ts, donde está el argumento.
 *
 * El handle que se recibe es el cliente scopeado de siempre: `app_files` está
 * registrada como tabla tenant en tenancy/tables.ts, así que cada fila lleva su
 * organization_id sin que ningún caller tenga que acordarse.
 */

/** Codifica bytes al formato hex de bytea que PostgREST acepta en JSON. */
export function encodeBytea(bytes: Uint8Array): string {
  return `\\x${Buffer.from(bytes).toString('hex')}`;
}

/**
 * Decodifica lo que PostgREST devuelve para un bytea (`\x` + hex).
 *
 * Estricta a propósito: si algún día PostgREST cambiara de representación, el
 * síntoma debe ser un error con nombre y no un archivo corrupto que se abre
 * como basura tres pantallas más allá.
 */
export function decodeBytea(value: string): Uint8Array {
  if (!value.startsWith('\\x')) {
    throw new Error(
      `Unexpected bytea representation (wanted \\x-prefixed hex, got ${JSON.stringify(value.slice(0, 8))}…)`,
    );
  }
  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('Unexpected bytea representation: not valid hex');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export interface PutFileInput {
  bucket: string;
  path: string;
  content: Uint8Array;
  contentType: string;
}

export interface StoredFileContent {
  content: Uint8Array;
  contentType: string | null;
}

/**
 * Guarda un archivo. Upsert por (bucket, path), igual que Storage con
 * upsert:true: la misma ruta reemplaza el contenido anterior.
 */
export async function putFile(db: SupabaseClient, input: PutFileInput): Promise<void> {
  const { error } = await db.from('app_files').upsert(
    {
      bucket: input.bucket,
      path: input.path,
      content: encodeBytea(input.content),
      content_type: input.contentType,
      size_bytes: input.content.byteLength,
    },
    { onConflict: 'bucket,path' },
  );
  if (error)
    throw new Error(`Could not store file ${input.bucket}/${input.path}: ${error.message}`);
}

/** Lee un archivo, o null si esa ruta no existe en ese bucket. */
export async function getFile(
  db: SupabaseClient,
  bucket: string,
  path: string,
): Promise<StoredFileContent | null> {
  const { data, error } = await db
    .from('app_files')
    .select('content, content_type')
    .eq('bucket', bucket)
    .eq('path', path)
    .maybeSingle();
  if (error) throw new Error(`Could not read file ${bucket}/${path}: ${error.message}`);
  if (!data) return null;
  return {
    content: decodeBytea(data.content as string),
    contentType: (data.content_type as string | null) ?? null,
  };
}

/** Borra varias rutas de un bucket. Rutas que no existen no son un error. */
export async function removeFiles(
  db: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await db.from('app_files').delete().eq('bucket', bucket).in('path', paths);
  if (error) throw new Error(`Could not remove files from ${bucket}: ${error.message}`);
}

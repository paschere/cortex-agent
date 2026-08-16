import 'server-only';
import { Pool } from 'pg';

/**
 * app_files por conexión pg DIRECTA — el camino de los archivos grandes.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ NO POSTGREST AQUÍ
 * ---------------------------------------------------------------------------
 * La capa normal de archivos (packages/agent-tools/src/files/store.ts) habla
 * PostgREST con el contenido en hex, y eso está bien para los caminos con techo
 * de 10 MB. Pero el audio de reuniones acepta hasta 200 MB
 * (MAX_AUDIO_SIZE en /api/kb/documents), y en hex eso son 400 MB de cuerpo
 * JSON: por encima de cualquier límite razonable de PostgREST y del proxy, y
 * una copia entera extra en memoria sólo para codificarla. node-postgres, en
 * cambio, manda un Buffer como parámetro bytea en formato binario — sin
 * duplicación de hex al escribir — y devuelve el bytea ya parseado a Buffer al
 * leer. Así que TODO camino que pueda cargar un archivo grande (la subida de
 * kb/documents, la ruta /api/files/blob que Deepgram usa para bajar el audio,
 * y la mudanza admin desde Storage) pasa por aquí.
 *
 * ---------------------------------------------------------------------------
 * EL POOL
 * ---------------------------------------------------------------------------
 * Mismo patrón que lib/auth.ts, y por las mismas razones: el pool se construye
 * en el import pero no abre conexiones hasta la primera query (seguro en
 * build), se queda diminuto por disciplina serverless, y el manejo de sslmode
 * es idéntico — ver el comentario largo en auth.ts. No se reutiliza el pool de
 * auth.ts para no arrastrar better-auth y el email al bundle de estas rutas.
 *
 * ---------------------------------------------------------------------------
 * TENANCY
 * ---------------------------------------------------------------------------
 * Esto NO pasa por el cliente scopeado, así que el organization_id es
 * responsabilidad del caller en cada escritura (viene de la sesión o de la
 * fila que un job procesa, nunca de input del usuario), y las lecturas son por
 * (bucket, path) — la identidad completa del archivo, no un listado que pueda
 * cruzar espacios.
 */

const connectionString =
  process.env.SUPABASE_DB_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder';

const isRemoteDb = /sslmode=/.test(connectionString);
const cleanConnectionString = connectionString
  .replace(/[?&]sslmode=[^&]*/g, (m) => (m.startsWith('?') ? '?' : ''))
  .replace(/\?&/, '?')
  .replace(/\?$/, '');

const pool = new Pool({
  connectionString: cleanConnectionString,
  ...(isRemoteDb ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export interface DirectPutInput {
  organizationId: string;
  bucket: string;
  path: string;
  content: Buffer;
  contentType: string;
}

/** Upsert por (bucket, path) — la semántica de Storage con upsert:true. */
export async function putFileDirect(input: DirectPutInput): Promise<void> {
  await pool.query(
    `insert into public.app_files (organization_id, bucket, path, content, content_type, size_bytes)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (bucket, path) do update
       set content = excluded.content,
           content_type = excluded.content_type,
           size_bytes = excluded.size_bytes`,
    [
      input.organizationId,
      input.bucket,
      input.path,
      input.content,
      input.contentType,
      input.content.byteLength,
    ],
  );
}

/**
 * Inserta sólo si la ruta no existe. Devuelve true si insertó — lo que la
 * mudanza admin necesita para contar {copiados, yaEstaban} y ser idempotente.
 */
export async function insertFileIfAbsentDirect(input: DirectPutInput): Promise<boolean> {
  const result = await pool.query(
    `insert into public.app_files (organization_id, bucket, path, content, content_type, size_bytes)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (bucket, path) do nothing`,
    [
      input.organizationId,
      input.bucket,
      input.path,
      input.content,
      input.contentType,
      input.content.byteLength,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getFileDirect(
  bucket: string,
  path: string,
): Promise<{ content: Buffer; contentType: string | null } | null> {
  const result = await pool.query<{ content: Buffer; content_type: string | null }>(
    'select content, content_type from public.app_files where bucket = $1 and path = $2',
    [bucket, path],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { content: row.content, contentType: row.content_type };
}

export async function fileExistsDirect(bucket: string, path: string): Promise<boolean> {
  const result = await pool.query(
    'select 1 from public.app_files where bucket = $1 and path = $2',
    [bucket, path],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function removeFilesDirect(bucket: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await pool.query('delete from public.app_files where bucket = $1 and path = any($2::text[])', [
    bucket,
    paths,
  ]);
}

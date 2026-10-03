import 'server-only';
import { pool } from '@/lib/auth';
import { getFileDirect, putFileDirect, removeFilesDirect } from '@/lib/files-db';
import { logger } from '@cortex/core';
import type { PoolClient } from 'pg';
import {
  EXPORT_EXCLUDED,
  type ExportTable,
  columnTreatment,
  companyExportQuery,
  exportTables,
  personalExportQuery,
} from './export-plan';
import { ZipStreamWriter, partitionedSink } from './zip-writer';

/**
 * EL TRABAJO QUE ARMA LA EXPORTACIÓN (data_exports → ZIP en app_files).
 *
 * POR QUÉ pg DIRECTO Y NO EL CLIENTE SCOPEADO. Una exportación lee decenas de
 * tablas completas de una empresa, algunas con cientos de miles de filas. Se
 * hace en UNA transacción `repeatable read` de sólo lectura — así el ZIP es una
 * foto coherente de un instante, no una mezcla de antes y después — y con
 * cursores, para no tener una tabla entera en memoria. PostgREST no ofrece ni
 * lo uno ni lo otro. La tenencia la pone cada consulta: TODAS llevan
 * `organization_id = $1` (o el padre de una derivada con esa condición), con
 * el id que trae la fila de data_exports, que escribió la sesión del dueño.
 * Mismo argumento y misma postura que lib/files-db.ts.
 *
 * DÓNDE QUEDA. En app_files, bucket `legal-exports`, en partes de 16 MB
 * (`<org>/<id>/export.zip.part-0000`, …): ver partitionedSink. La descarga
 * (/api/legal/exports/[id]/download) las concatena al vuelo.
 */

export const EXPORT_BUCKET = 'legal-exports';
export const EXPORT_PART_BYTES = 16 * 1024 * 1024;
export const EXPORT_TTL_DAYS = 7;
const FETCH_ROWS = 500;

interface ExportRow {
  id: string;
  organization_id: string;
  scope: 'empresa' | 'personal';
  requested_by: string | null;
  requested_by_account: string;
  status: string;
  started_at: Date | null;
}

interface TableReport {
  table: string;
  rows: number;
  omittedColumns?: string[];
  note?: string;
}

export function exportPrefix(organizationId: string, exportId: string): string {
  return `${organizationId}/${exportId}/export.zip`;
}

export function partPath(prefix: string, index: number): string {
  return `${prefix}.part-${String(index).padStart(4, '0')}`;
}

/** Las columnas de cada tabla del esquema público. */
async function columnsByTable(client: PoolClient): Promise<Map<string, string[]>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' order by table_name, ordinal_position`,
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.table_name) ?? [];
    list.push(r.column_name);
    map.set(r.table_name, list);
  }
  return map;
}

/**
 * Las filas de una consulta como un arreglo JSON, en trozos, con un cursor.
 * Cada tabla corre bajo un SAVEPOINT: una tabla que falle (una vista vieja, un
 * tipo raro) no tumba la exportación entera, queda anotada en el manifiesto.
 */
async function* jsonArrayRows(
  client: PoolClient,
  sql: string,
  params: unknown[],
  counter: { rows: number },
): AsyncGenerator<Buffer> {
  await client.query(`declare legal_export_cursor no scroll cursor for ${sql}`, params);
  yield Buffer.from('[\n');
  let first = true;
  try {
    for (;;) {
      const { rows } = await client.query<{ row: unknown }>(
        `fetch ${FETCH_ROWS} from legal_export_cursor`,
      );
      if (rows.length === 0) break;
      const parts: string[] = [];
      for (const r of rows) {
        parts.push(`${first ? '' : ',\n'}${JSON.stringify(r.row)}`);
        first = false;
      }
      counter.rows += rows.length;
      yield Buffer.from(parts.join(''), 'utf8');
    }
  } finally {
    await client.query('close legal_export_cursor').catch(() => undefined);
  }
  yield Buffer.from('\n]\n');
}

function omittedColumns(columns: readonly string[]): { secret: string[]; derived: string[] } {
  const secret: string[] = [];
  const derived: string[] = [];
  for (const c of columns) {
    const t = columnTreatment(c);
    if (t === 'secret') secret.push(c);
    else if (t === 'derived') derived.push(c);
  }
  return { secret, derived };
}

async function addTable(
  zip: ZipStreamWriter,
  client: PoolClient,
  t: ExportTable,
  columns: Map<string, string[]>,
  scope: 'empresa' | 'personal',
  organizationId: string,
  directoryUserId: string | null,
): Promise<TableReport | null> {
  const cols = columns.get(t.table);
  if (!cols) return { table: t.table, rows: 0, note: 'La tabla no existe en esta base.' };
  const { secret, derived } = omittedColumns(cols);
  const drop = [...secret, ...derived];

  let sql: string;
  let params: unknown[];
  if (scope === 'empresa') {
    if (t.kind === 'tenant' && !cols.includes('organization_id')) {
      return { table: t.table, rows: 0, note: 'Sin columna organization_id: no se pudo atribuir.' };
    }
    sql = companyExportQuery(t).sql;
    params = [organizationId, drop];
  } else {
    const personal = personalExportQuery(t, cols);
    if (!personal || !directoryUserId) return null; // no es suya: es de la empresa
    sql = personal;
    params = [organizationId, directoryUserId, drop];
  }

  const counter = { rows: 0 };
  await client.query('savepoint legal_export_table');
  try {
    await zip.addEntry(`tablas/${t.table}.json`, jsonArrayRows(client, sql, params, counter));
    await client.query('release savepoint legal_export_table');
  } catch (err) {
    await client.query('rollback to savepoint legal_export_table');
    // La entrada pudo quedar a medias en el ZIP: el lector la verá truncada,
    // así que el manifiesto lo dice con claridad.
    return {
      table: t.table,
      rows: counter.rows,
      note: `Error al leer la tabla; el archivo puede estar incompleto: ${
        err instanceof Error ? err.message.slice(0, 200) : String(err)
      }`,
    };
  }
  if (scope === 'personal' && counter.rows === 0) return null;
  return {
    table: t.table,
    rows: counter.rows,
    ...(drop.length > 0 ? { omittedColumns: drop } : {}),
  };
}

async function addAccount(zip: ZipStreamWriter, client: PoolClient, accountId: string) {
  const one = async (sql: string) => (await client.query(sql, [accountId])).rows;
  const account = {
    cuenta: await one(
      `select id, name, email, "emailVerified", image, "createdAt", "updatedAt" from public.ba_user where id = $1`,
    ),
    accesos: await one(
      `select "providerId", "accountId", scope, "createdAt" from public.ba_account where "userId" = $1`,
    ),
    sesiones: await one(
      `select "createdAt", "expiresAt", "userAgent" from public.ba_session where "userId" = $1`,
    ),
    espacios: await one(
      `select o.name as espacio, m.role, m."createdAt" from public.ba_member m
         join public.ba_organization o on o.id = m."organizationId" where m."userId" = $1`,
    ),
    autorizaciones: await one(
      'select document, version, accepted_at, source, revoked_at from public.legal_consents where user_id = $1',
    ),
    solicitudes: await one(
      `select kind, right_invoked, message, status, received_at, due_on, response, responded_at
         from public.legal_requests where user_id = $1`,
    ),
  };
  await zip.addEntry('cuenta/mi-cuenta.json', Buffer.from(JSON.stringify(account, null, 2)));
}

async function addFiles(
  zip: ZipStreamWriter,
  client: PoolClient,
  organizationId: string,
): Promise<{ files: number; skipped: number }> {
  const { rows } = await client.query<{
    bucket: string;
    path: string;
    content_type: string | null;
  }>(
    `select bucket, path, content_type from public.app_files
      where organization_id = $1 and bucket <> $2 order by bucket, path`,
    [organizationId, EXPORT_BUCKET],
  );
  let files = 0;
  let skipped = 0;
  for (const f of rows) {
    const file = await getFileDirect(f.bucket, f.path);
    if (!file) {
      skipped++;
      continue;
    }
    const type = file.contentType ?? '';
    // Lo que ya viene comprimido se guarda tal cual: recomprimir cuesta y no gana.
    const compress = !/^(audio|video|image)\/|zip|pdf|octet-stream/.test(type);
    const safe = `${f.bucket}/${f.path}`.replace(/\.\.+/g, '_').replace(/^\/+/, '');
    await zip.addEntry(`archivos/${safe}`, file.content, { compress });
    files++;
  }
  return { files, skipped };
}

function readme(scope: 'empresa' | 'personal', when: Date, orgName: string): string {
  return [
    scope === 'empresa'
      ? `Exportación de TODOS los datos de la empresa «${orgName}» en Cortex.`
      : `Exportación de tus datos personales en el espacio «${orgName}» de Cortex.`,
    `Generada: ${when.toISOString()}`,
    '',
    'Contenido:',
    '  manifiesto.json   qué tablas se incluyeron, cuántas filas y qué columnas se omitieron.',
    '  tablas/*.json     una tabla por archivo, como arreglo JSON (una fila por objeto).',
    scope === 'empresa'
      ? '  archivos/         los archivos guardados (documentos, audios, adjuntos), con su ruta.'
      : '  cuenta/           tu cuenta: datos de acceso, espacios, autorizaciones y solicitudes.',
    '',
    'Por seguridad NO se incluyen credenciales: tokens de conexión (Google, Microsoft…),',
    'contraseñas o llaves cifradas, ni las llaves de la sesión de WhatsApp. Tampoco los',
    'vectores numéricos de búsqueda (embedding), que se derivan del texto que sí va.',
    '',
    'Este archivo contiene datos personales. Guárdalo en un lugar seguro y bórralo cuando',
    'ya no lo necesites.',
    '',
  ].join('\n');
}

/**
 * Corre una exportación. Idempotente por fila: si ya está lista, no hace nada;
 * si quedó «generando» hace más de 30 minutos (un trabajo que murió), la retoma.
 */
export interface DataExportResult {
  exportId: string;
  organizationId: string;
  scope: 'empresa' | 'personal';
  requestedBy: string | null;
  requestedByAccount: string;
  bytes: number;
  tables: number;
  rows: number;
  files: number;
  expiresAt: string;
}

export async function runDataExport(
  exportId: string,
  now: Date = new Date(),
): Promise<DataExportResult | { skipped: string }> {
  const claim = await pool.query<ExportRow>(
    `update public.data_exports
        set status = 'generando', started_at = now(), error = null
      where id = $1
        and (status = 'pendiente'
             or (status = 'generando' and started_at < now() - interval '30 minutes'))
      returning id, organization_id, scope, requested_by, requested_by_account, status, started_at`,
    [exportId],
  );
  const job = claim.rows[0];
  if (!job) return { skipped: 'no está pendiente' };

  const prefix = exportPrefix(job.organization_id, job.id);
  const savedParts: string[] = [];
  const { sink, flush } = partitionedSink(EXPORT_PART_BYTES, async (index, content) => {
    const path = partPath(prefix, index);
    await putFileDirect({
      organizationId: job.organization_id,
      bucket: EXPORT_BUCKET,
      path,
      content,
      contentType: 'application/zip',
    });
    savedParts.push(path);
  });

  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const org = await client.query<{ name: string }>(
      'select name from public.ba_organization where id = $1',
      [job.organization_id],
    );
    const orgName = org.rows[0]?.name ?? job.organization_id;
    const columns = await columnsByTable(client);

    const zip = new ZipStreamWriter(sink, now);
    await zip.addEntry('LEEME.txt', Buffer.from(readme(job.scope, now, orgName), 'utf8'));

    const tables: TableReport[] = [];
    for (const t of exportTables()) {
      const report = await addTable(
        zip,
        client,
        t,
        columns,
        job.scope,
        job.organization_id,
        job.requested_by,
      );
      if (report) tables.push(report);
    }

    let files = { files: 0, skipped: 0 };
    if (job.scope === 'empresa') files = await addFiles(zip, client, job.organization_id);
    else await addAccount(zip, client, job.requested_by_account);

    const rowsCount = tables.reduce((n, t) => n + t.rows, 0);
    const manifest = {
      generada: now.toISOString(),
      alcance: job.scope,
      espacio: { id: job.organization_id, nombre: orgName },
      tablas: tables,
      excluidas: job.scope === 'empresa' ? EXPORT_EXCLUDED : undefined,
      archivos: files,
      filas: rowsCount,
    };
    await zip.addEntry('manifiesto.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    const { bytes } = await zip.finish();
    await flush();
    await client.query('commit');

    const expiresAt = new Date(now.getTime() + EXPORT_TTL_DAYS * 86_400_000);
    await pool.query(
      `update public.data_exports
          set status = 'lista', file_bucket = $2, file_path = $3, size_bytes = $4,
              tables_count = $5, rows_count = $6, files_count = $7,
              completed_at = now(), expires_at = $8
        where id = $1`,
      [job.id, EXPORT_BUCKET, prefix, bytes, tables.length, rowsCount, files.files, expiresAt],
    );
    return {
      exportId: job.id,
      organizationId: job.organization_id,
      scope: job.scope,
      requestedBy: job.requested_by,
      requestedByAccount: job.requested_by_account,
      bytes,
      tables: tables.length,
      rows: rowsCount,
      files: files.files,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    // Lo que se alcanzó a guardar no sirve sin el directorio central: fuera.
    await removeFilesDirect(EXPORT_BUCKET, savedParts).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    logger.error('legal: falló una exportación', { exportId, error: message });
    await pool.query(
      `update public.data_exports set status = 'fallida', error = $2, completed_at = now() where id = $1`,
      [job.id, message.slice(0, 2000)],
    );
    throw err;
  } finally {
    client.release();
  }
}

/** Las partes de un ZIP listo, en orden. */
export async function exportParts(bucket: string, prefix: string): Promise<string[]> {
  const { rows } = await pool.query<{ path: string }>(
    'select path from public.app_files where bucket = $1 and path like $2 order by path',
    [bucket, `${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}.part-%`],
  );
  return rows.map((r) => r.path);
}

/** Vence una exportación lista cuyo plazo pasó: borra sus partes y marca la fila. */
export async function expireDataExport(exportId: string): Promise<boolean> {
  const { rows } = await pool.query<{ file_bucket: string; file_path: string }>(
    `update public.data_exports set status = 'vencida'
      where id = $1 and status = 'lista' and expires_at < now()
      returning file_bucket, file_path`,
    [exportId],
  );
  const row = rows[0];
  if (!row) return false;
  await removeFilesDirect(row.file_bucket, await exportParts(row.file_bucket, row.file_path));
  return true;
}

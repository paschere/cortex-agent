import { fileExistsDirect, insertFileIfAbsentDirect } from '@/lib/files-db';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

/**
 * POST /api/admin/storage-migrate — el puente de mudanza de Supabase Storage a
 * app_files (migración 0109).
 *
 * ESTE ES EL ÚNICO SITIO DONDE `.storage` SOBREVIVE. Todo el producto lee y
 * escribe ya en app_files; esta ruta existe sólo para copiar lo que quedó en
 * los buckets viejos ('kb-uploads' y 'presentation-files'), path→path, y muere
 * con Supabase — cuando el dump/restore esté hecho, se borra junto con la
 * dependencia de Storage.
 *
 * IDEMPOTENTE: la identidad de un archivo es (bucket, path) y la copia es
 * "insertar si no existe", así que correrla dos veces no duplica nada — la
 * segunda pasada cuenta todo como yaEstaban. Un fallo a mitad de camino se
 * arregla corriéndola otra vez.
 *
 * EL organization_id no existe en Storage, así que se resuelve del dato que ya
 * lo sabe: en kb-uploads la ruta empieza por el id del usuario que subió
 * (`${userId}/${documentId}/…`), y ese directorio nombra su espacio; en
 * presentation-files la fila de presentation_files que apunta al path lo trae.
 * Un objeto cuyo dueño ya no se puede resolver se cuenta en fallidos con su
 * razón — copiarlo a un espacio adivinado sería peor que dejarlo.
 *
 * Las escrituras van por pg directo (lib/files-db.ts): el audio de reuniones
 * pesa hasta 200MB y en la representación hex de PostgREST se duplicaría.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 800;

const BUCKETS = ['kb-uploads', 'presentation-files'] as const;
const PAGE_SIZE = 100;

interface StorageEntry {
  name: string;
  id: string | null;
}

/**
 * Lista todas las rutas de un bucket. `.list()` es jerárquico — una entrada sin
 * id es una "carpeta" — así que se recorre en profundidad, paginando cada nivel.
 */
async function listAllPaths(
  storage: ReturnType<typeof getSupabaseServiceClient>['storage'],
  bucket: string,
  prefix = '',
): Promise<string[]> {
  const paths: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await storage.from(bucket).list(prefix, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`No se pudo listar ${bucket}/${prefix}: ${error.message}`);
    const entries = (data ?? []) as StorageEntry[];
    if (entries.length === 0) break;
    for (const entry of entries) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) paths.push(full);
      else paths.push(...(await listAllPaths(storage, bucket, full)));
    }
    if (entries.length < PAGE_SIZE) break;
    offset += entries.length;
  }
  return paths;
}

export async function POST() {
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Sólo un administrador puede correr la mudanza de archivos' },
      { status: 403 },
    );
  }

  // Cliente crudo a propósito: la mudanza recorre los archivos de TODOS los
  // espacios (Storage no sabe de espacios), y cada fila copiada lleva el
  // organization_id resuelto del dato que ya lo conocía. Allowlisted en
  // lib/tenancy-guard.test.ts.
  const sb = getSupabaseServiceClient();

  let copiados = 0;
  let yaEstaban = 0;
  const fallidos: Array<{ bucket: string; path: string; razon: string }> = [];

  /**
   * kb-uploads: la ruta empieza por el id del usuario que subió el archivo.
   * Un error de la consulta LANZA (y cae en fallidos con su razón) en vez de
   * confundirse con "el dueño ya no existe", que es un veredicto distinto.
   */
  async function orgForKbPath(path: string): Promise<string | null> {
    const userId = path.split('/')[0] ?? '';
    if (!userId) return null;
    const { data, error } = await sb
      .from('users')
      .select('organization_id')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw new Error(`No se pudo resolver el dueño de ${path}: ${error.message}`);
    return (data?.organization_id as string | undefined) ?? null;
  }

  /** presentation-files: la fila que apunta al path trae el espacio. */
  async function orgForPresentationPath(path: string): Promise<string | null> {
    const { data, error } = await sb
      .from('presentation_files')
      .select('organization_id')
      .eq('storage_path', path)
      .maybeSingle();
    if (error) throw new Error(`No se pudo resolver el espacio de ${path}: ${error.message}`);
    return (data?.organization_id as string | undefined) ?? null;
  }

  for (const bucket of BUCKETS) {
    let paths: string[];
    try {
      paths = await listAllPaths(sb.storage, bucket, '');
    } catch (err) {
      fallidos.push({ bucket, path: '*', razon: (err as Error).message });
      continue;
    }

    for (const path of paths) {
      try {
        // Antes de bajar 200MB: si ya está copiado, no hay nada que hacer.
        if (await fileExistsDirect(bucket, path)) {
          yaEstaban++;
          continue;
        }

        const organizationId =
          bucket === 'kb-uploads' ? await orgForKbPath(path) : await orgForPresentationPath(path);
        if (!organizationId) {
          fallidos.push({ bucket, path, razon: 'no se pudo resolver el espacio de trabajo' });
          continue;
        }

        const { data: blob, error: downloadError } = await sb.storage.from(bucket).download(path);
        if (downloadError || !blob) {
          fallidos.push({ bucket, path, razon: downloadError?.message ?? 'descarga vacía' });
          continue;
        }

        const inserted = await insertFileIfAbsentDirect({
          organizationId,
          bucket,
          path,
          content: Buffer.from(await blob.arrayBuffer()),
          contentType: blob.type || 'application/octet-stream',
        });
        if (inserted) copiados++;
        else yaEstaban++;
      } catch (err) {
        fallidos.push({ bucket, path, razon: (err as Error).message });
      }
    }
  }

  logger.info('storage-migrate: mudanza terminada', {
    copiados,
    yaEstaban,
    fallidos: fallidos.length,
  });

  return NextResponse.json({ copiados, yaEstaban, fallidos });
}

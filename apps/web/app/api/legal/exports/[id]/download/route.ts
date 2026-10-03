import { getFileDirect } from '@/lib/files-db';
import { currentAccount } from '@/lib/legal/consent-store';
import { exportParts } from '@/lib/legal/export-run';
import { canExportCompany } from '@/lib/legal/permissions';
import { getOptionalSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/legal/exports/<id>/download — baja el ZIP.
 *
 * El enlace es de vida limitada (`expires_at`, 7 días) Y exige sesión: a
 * diferencia del enlace de un informe, este archivo es TODO lo de una empresa,
 * y un enlace reenviado por error no puede bastar para llevárselo. La fila se
 * lee con el handle de la empresa de la sesión; la exportación de empresa la
 * baja un dueño o administrador, la personal sólo quien la pidió.
 *
 * Las partes (lib/legal/export-run.ts) se concatenan al vuelo en un stream: no
 * se junta el ZIP entero en memoria.
 */

function notFound() {
  return new NextResponse('No encontrado', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();
  const user = await getOptionalSession();
  const account = await currentAccount();
  if (!user || !account) return new NextResponse('Inicia sesión.', { status: 401 });

  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('data_exports')
    .select(
      'id, scope, status, file_bucket, file_path, size_bytes, expires_at, requested_by_account',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) return new NextResponse('No se pudo leer la exportación.', { status: 500 });
  const row = data as {
    scope: string;
    status: string;
    file_bucket: string | null;
    file_path: string | null;
    size_bytes: number | null;
    expires_at: string | null;
    requested_by_account: string;
  } | null;
  if (!row || row.status !== 'lista' || !row.file_bucket || !row.file_path) return notFound();
  if (!row.expires_at || Date.parse(row.expires_at) <= Date.now()) return notFound();
  const allowed =
    row.scope === 'empresa'
      ? canExportCompany(user.organization.role)
      : row.requested_by_account === account.id;
  if (!allowed) return notFound();

  const bucket = row.file_bucket;
  const parts = await exportParts(bucket, row.file_path);
  if (parts.length === 0) return notFound();

  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const path = parts[index++];
      if (!path) {
        controller.close();
        return;
      }
      const part = await getFileDirect(bucket, path);
      if (!part) {
        controller.error(new Error('Falta una parte de la exportación.'));
        return;
      }
      controller.enqueue(new Uint8Array(part.content));
    },
  });

  const day = new Date().toISOString().slice(0, 10);
  const slug = row.scope === 'empresa' ? 'empresa' : 'personal';
  return new NextResponse(stream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      ...(row.size_bytes ? { 'content-length': String(row.size_bytes) } : {}),
      'content-disposition': `attachment; filename="cortex-datos-${slug}-${day}.zip"`,
      'cache-control': 'private, no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}

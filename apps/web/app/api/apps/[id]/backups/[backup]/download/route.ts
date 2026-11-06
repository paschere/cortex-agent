import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { backupToWorkbook, mustGetApp, readBackup, viewerFromSession } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';

/**
 * Descarga de una copia de una app (0247): Excel (una hoja por tabla) o el JSON
 * completo. Sólo quien administra la empresa; la copia se lee con el handle de
 * su empresa, así que una copia de otra jamás existe para esta ruta.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; backup: string }> },
) {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    return NextResponse.json({ error: 'Sólo quien administra la empresa.' }, { status: 403 });
  const { id, backup } = await params;
  const format = new URL(req.url).searchParams.get('formato') === 'json' ? 'json' : 'xlsx';
  try {
    const db = getOrgScopedClient(user.organization.id);
    const app = await mustGetApp(db, id, { includeArchived: true });
    const { content } = await readBackup(db, app.id, backup);
    const stamp = content.createdAt.slice(0, 16).replace(/[:T]/g, '-');
    const base = `copia-${app.slug}-${stamp}`;
    if (format === 'json')
      return new NextResponse(JSON.stringify(content), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${base}.json"`,
          'cache-control': 'no-store',
        },
      });
    const bytes = await backupToWorkbook(content);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${base}.xlsx"`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'No se encontró esa copia.' }, { status: 404 });
  }
}

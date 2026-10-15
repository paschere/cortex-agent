import { loadTeam } from '@/lib/clients/read';
import { closeWorkbook } from '@/lib/close-xlsx';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { XLSX_MIME } from '@/lib/xlsx/write';
import { isClosePeriod, isModuleEnabled, loadCloseReport } from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/**
 * El informe del cierre de un mes en Excel (0228), para el contador. Mismo
 * contenido que el PDF: un mes cerrado sale con la foto que se guardó al
 * cerrarlo; uno abierto, con la revisión de este momento.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  const user = await requireSession().catch(() => null);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!isClosePeriod(period)) return new Response('Not found', { status: 404 });
  const db = getOrgScopedClient(user.organization.id);
  if (!(await isModuleEnabled(db, 'accounting_close')))
    return new Response('Not found', { status: 404 });
  const team = await loadTeam(db).catch(() => []);
  const input = await loadCloseReport(db, period, new Map(team.map((m) => [m.id, m.name])));
  const { bytes } = closeWorkbook(input);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="cierre-${period}.xlsx"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

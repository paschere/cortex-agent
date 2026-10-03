import { readBranding, readLogo } from '@/lib/branding/store';
import { loadTeam } from '@/lib/clients/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  isClosePeriod,
  isModuleEnabled,
  loadCloseReport,
  renderClosePdf,
} from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/**
 * El informe del cierre de un mes en PDF (0192), para el equipo (con sesión).
 * Un mes cerrado sale con la foto que se guardó al cerrarlo; uno abierto, con
 * la revisión de este momento.
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
  const [team, branding, logo] = await Promise.all([
    loadTeam(db).catch(() => []),
    readBranding(db).catch(() => null),
    readLogo(db).catch(() => null),
  ]);
  const input = await loadCloseReport(db, period, new Map(team.map((m) => [m.id, m.name])));
  const bytes = renderClosePdf(input, {
    name: branding?.display_name?.trim() || user.organization.name || 'Cortex',
    primary: branding?.primary_color ?? null,
    logo: logo?.content ?? null,
  });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `inline; filename="cierre-${period}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

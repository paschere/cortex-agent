import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { loadExogena } from '@/lib/tax/exogena-load';
import { EXOGENA_FORMATS, type ExogenaFormatCode, exogenaCsv } from '@cortex/agent-tools';

/**
 * Un formato de exógena en CSV para el contador (0197): `?anio=2025&formato=1001`.
 * Es la lista por tercero que arma Cortex con sus datos, no el XML de la DIAN.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const year = Number(url.searchParams.get('anio'));
  const code = url.searchParams.get('formato') as ExogenaFormatCode | null;
  if (
    !(year >= 2020 && year <= 2100) ||
    !code ||
    !(EXOGENA_FORMATS as readonly string[]).includes(code)
  )
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const formats = await loadExogena(db, year);
  const f = formats.find((x) => x.code === code);
  if (!f)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(exogenaCsv(f), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="exogena-${year}-formato-${code}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

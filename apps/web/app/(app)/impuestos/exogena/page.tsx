import { ExogenaView } from '@/components/tax/ExogenaView';
import type { ExogenaScreen } from '@/components/tax/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { loadExogena } from '@/lib/tax/exogena-load';
import { taxTabLinks } from '@/lib/tax/tabs';
import { workspaceHref } from '@/lib/workspace-context';
import { bogotaToday } from '@cortex/agent-tools';

export const dynamic = 'force-dynamic';

/**
 * PREPARAR LA EXÓGENA (0197): los formatos 1001, 1007, 1008 y 1009 del año
 * gravable, por tercero, armados con las facturas de venta, las de proveedor y
 * el libro, para descargar en CSV y entregarle al contador. No genera el XML
 * ni lo sube a la DIAN; versiones de formato y códigos de concepto por
 * confirmar. Parámetro: `?anio=2025` (por defecto, el año anterior).
 */
export default async function ExogenaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const q = await searchParams;
  const thisYear = Number(bogotaToday().slice(0, 4));
  const years = [thisYear - 2, thisYear - 1, thisYear];
  const asked = Number(typeof q.anio === 'string' ? q.anio : Number.NaN);
  const year = years.includes(asked) ? asked : thisYear - 1;
  const formats = await loadExogena(db, year);
  const data: ExogenaScreen = {
    year,
    years,
    versionNote: formats[0]?.versionNote ?? '',
    formats: formats.map((f) => ({
      code: f.code,
      title: f.title,
      rows: f.rows.length,
      total: f.total,
      columns: f.columns,
      preview: f.rows.slice(0, 8),
      missing: f.missing,
      notes: f.notes,
      csvHref: href(`/api/impuestos/exogena?anio=${year}&formato=${f.code}`),
    })),
    hrefs: { tabs: taxTabLinks(href), self: href('/impuestos/exogena') },
  };
  return <ExogenaView data={data} />;
}

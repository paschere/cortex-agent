import {
  type AuditFilters,
  auditHref,
  auditSearchParams,
  describeAuditFilters,
  fetchAuditEvents,
  fetchUserNames,
  parseAuditFilters,
} from '@/app/api/admin/_lib/audit-filters';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { Download, ScrollText, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { AuditTable } from './_components/AuditTable';
import { FilterBar } from './_components/FilterBar';

export const dynamic = 'force-dynamic';

/** How many events the table renders per view. */
const PAGE_SIZE = 200;

function EmptyState({ filters }: { filters: AuditFilters }) {
  const unfiltered =
    filters.status === 'all' &&
    filters.surface === 'all' &&
    filters.risk === 'all' &&
    filters.decision === 'all' &&
    !filters.tool &&
    !filters.user;
  return (
    <div className="px-4 py-12 text-center">
      <ScrollText className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
      <p className="text-[13px] font-semibold text-ink">
        {unfiltered
          ? 'Todavía no se ha registrado nada'
          : 'Ningún evento coincide con estos filtros'}
      </p>
      <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
        {unfiltered
          ? 'Cada llamada a una herramienta, cada turno de chat y cada rutina cae aquí apenas ocurre, con quién la pidió y qué devolvió.'
          : 'Amplía el rango o quita un filtro para ver más del registro.'}
      </p>
      {!unfiltered && (
        <Link
          href="/admin/audit?range=all"
          className="mt-4 inline-block rounded-card border border-border-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
        >
          Quitar todos los filtros
        </Link>
      )}
    </div>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseAuditFilters(await searchParams);
  const sb = getSupabaseServiceClient();

  const { rows, total, legacySchema } = await fetchAuditEvents(sb, filters, {
    limit: PAGE_SIZE,
    count: true,
  });

  const userNames = await fetchUserNames(
    sb,
    rows.map((e) => e.user_id),
  );

  // Status counts + tool families come from the loaded window — cheap, and they
  // describe exactly what the auditor can see.
  const statusCounts: Record<string, number> = {};
  const familySet = new Set<string>();
  let riskyCount = 0;
  for (const e of rows) {
    statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
    familySet.add(e.tool_id.split('.')[0] ?? e.tool_id);
    if (e.risk_level === 'high' || e.risk_level === 'critical' || e.decision === 'blocked') {
      riskyCount += 1;
    }
  }
  if (filters.tool) familySet.add(filters.tool);
  const families = [...familySet].filter((f) => f && f !== '__agent_turn').sort();

  const userHrefs = Object.fromEntries(
    [...new Set(rows.map((e) => e.user_id))].map((id) => [id, auditHref(filters, { user: id })]),
  );

  const exportQs = auditSearchParams(filters).toString();
  const exportHref = `/api/admin/audit/export${exportQs ? `?${exportQs}` : ''}`;

  return (
    <>
      <PageHeader
        title="Auditoría"
        subtitle="Cada llamada, de cada persona, desde cada superficie: quién la pidió, qué se ejecutó y qué pasó"
        icon={<ScrollText className="h-5 w-5" />}
        actions={
          <a
            href={exportHref}
            className="inline-flex items-center gap-2 rounded-card border border-border-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            <Download className="h-4 w-4" />
            Exportar CSV
          </a>
        }
      />

      <FilterBar
        filters={filters}
        families={families}
        statusCounts={statusCounts}
        userLabel={filters.user ? (userNames[filters.user] ?? null) : null}
      />

      {legacySchema && (
        <div className="mb-4 flex items-start gap-2.5 rounded-card border border-border bg-amber-soft p-3 text-[12.5px] text-amber">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Esta base de datos todavía no corrió la migración de seguridad, así que no se registran
            origen, riesgo ni decisión. Las filas siguen mostrando estado, latencia y metadatos.
          </p>
        </div>
      )}

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState filters={filters} />
        ) : (
          <AuditTable rows={rows} userNames={userNames} userHrefs={userHrefs} />
        )}
      </Panel>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-faint">
        <span>
          Mostrando <span className="tabular">{rows.length}</span>
          {typeof total === 'number' && total > rows.length ? (
            <>
              {' '}
              de <span className="tabular">{total.toLocaleString('es-CO')}</span>
            </>
          ) : (
            ''
          )}{' '}
          evento{rows.length === 1 ? '' : 's'} · {describeAuditFilters(filters)}
          {riskyCount > 0 ? (
            <>
              {' '}
              · <span className="tabular text-amber">{riskyCount}</span> por revisar
            </>
          ) : (
            ''
          )}
        </span>
        <span>Abre cualquier fila para ver el registro completo.</span>
      </div>
    </>
  );
}

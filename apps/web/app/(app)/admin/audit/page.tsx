import Link from 'next/link';
import { Download, ScrollText, ShieldAlert } from 'lucide-react';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import {
  type AuditFilters,
  auditSearchParams,
  describeAuditFilters,
  fetchAuditEvents,
  fetchUserNames,
  auditHref,
  parseAuditFilters,
} from '@/app/api/admin/_lib/audit-filters';
import { FilterBar } from './_components/FilterBar';
import { AuditTable } from './_components/AuditTable';

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
        {unfiltered ? 'Nothing has been recorded yet' : 'No events match these filters'}
      </p>
      <p className="mt-1 text-[12px] text-ink-faint">
        {unfiltered
          ? 'Every tool call, chat turn and scheduled run will show up here as it happens.'
          : 'Try widening the date range or clearing a chip.'}
      </p>
      {!unfiltered && (
        <Link
          href="/admin/audit?range=all"
          className="mt-3 inline-block rounded-pill bg-surface-2 px-3 py-1.5 text-[11.5px] font-semibold text-ink-muted hover:text-ink"
        >
          Clear all filters
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

  const userNames = await fetchUserNames(sb, rows.map((e) => e.user_id));

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
        title="Audit log"
        subtitle="Every tool call, by everyone, on every surface — who asked, what ran, what happened"
        icon={<ScrollText className="h-5 w-5" />}
        actions={
          <a
            href={exportHref}
            className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted shadow-card hover:text-ink"
          >
            <Download className="h-4 w-4" />
            Export CSV
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
            This database has not run the security migration yet, so surface, risk and decision are
            not recorded. Rows still show status, latency and metadata.
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
          Showing {rows.length}
          {typeof total === 'number' && total > rows.length ? ` of ${total.toLocaleString()}` : ''}{' '}
          event{rows.length === 1 ? '' : 's'} · {describeAuditFilters(filters)}
          {riskyCount > 0 ? ` · ${riskyCount} need a look` : ''}
        </span>
        <span>Click any row for the full record.</span>
      </div>
    </>
  );
}

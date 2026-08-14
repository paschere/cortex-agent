import { Panel } from '@/components/ui/panel';
import { REPORT_KIND_LABEL, type ReportKind } from '@/lib/reports-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getReport, renderReportHtml, shareIsLive, shareUrl } from '@cortex/agent-tools';
import { ArrowLeft, Download, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ShareControls } from '../_components/ShareControls';
import { stamp } from '../_components/format';

/**
 * One saved report, on screen.
 *
 * ===========================================================================
 * WHY THIS PAGE INJECTS AN HTML STRING
 * ===========================================================================
 * The report is rendered by `renderReportHtml` in the agent-tools package, and
 * this page mounts the string it returns. That is a `dangerouslySetInnerHTML`,
 * and it is the right call here for one specific reason: EVERY BYTE OF THAT
 * STRING WAS PRODUCED BY OUR RENDERER. No model text, no database text and no
 * user text reaches it except through the escaping boundary in
 * `reports/html.ts`, and `reports/__tests__/render.test.ts` renders a document
 * whose every string is an attack and asserts nothing executable survives.
 *
 * The alternative — a React tree here and a string renderer for the shared link
 * and the export — would mean three renderings of the same document that
 * nothing forces to agree. They would drift, and we would find out when a
 * client said the report they were sent does not match the one on screen.
 *
 * The stylesheet is injected the same way and scoped entirely to `.rp-doc`, so
 * it cannot reach the app's own chrome.
 *
 * ===========================================================================
 * NO QUERY RUNS HERE
 * ===========================================================================
 * Opening a saved report reads one row and renders what is in it. The numbers
 * were computed the day it was generated and they do not move. If the stored
 * hash disagrees with the stored document, the page says so at the top rather
 * than quietly showing figures nobody should quote.
 */

export const dynamic = 'force-dynamic';

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const stored = await getReport(db, id).catch(() => null);
  if (!stored) notFound();

  const { row, document, intact } = stored;
  const live = shareIsLive(row);
  const html = renderReportHtml(document, { idPrefix: `r${row.id.replace(/-/g, '').slice(0, 12)}` });

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/reports"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Informes
          </Link>
          <h1 className="mt-2 text-lg font-extrabold tracking-[-0.02em] text-ink">
            {REPORT_KIND_LABEL[row.kind as ReportKind] ?? row.kind}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <span className="field-label">Calculado</span>
            <span className="tabular">{stamp(row.generated_at)}</span>
            <span aria-hidden className="opacity-40">
              ·
            </span>
            <span>no cambia aunque cambien los datos</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/reports/${row.id}/export`}
            className="inline-flex items-center justify-center gap-1.5 rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-card transition-all duration-150 hover:border-border-strong hover:bg-surface-2"
            download
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Exportar
          </a>
        </div>
      </div>

      <div className="mb-5">
        <ShareControls
          reportId={row.id}
          initialUrl={live && row.share_token ? shareUrl(row.share_token) : null}
          initialExpiresLabel={
            live && row.share_expires_at
              ? new Date(row.share_expires_at).toLocaleDateString('es-CO')
              : null
          }
          views={row.share_views ?? 0}
        />
      </div>

      {!intact && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-3 rounded-card border border-rose/20 bg-rose-soft p-4"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-rose">
              El contenido guardado no coincide con su huella
            </p>
            <p className="mt-1 text-xs leading-snug text-ink-muted">
              La fila se modificó después de generarse. Estas cifras ya no son la fotografía que se
              guardó: vuelve a generar el informe antes de citarlas.
            </p>
          </div>
        </div>
      )}

      {/* La hoja ya no se inyecta aquí: es `/report.css`, enlazada una vez
          desde `app/layout.tsx` y cacheada con su huella. Ver
          `app/report.css/route.ts`. */}
      <Panel className="p-6 sm:p-8">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: every byte produced by renderReportHtml, which escapes all content; see the header and reports/__tests__/render.test.ts. */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </Panel>
    </>
  );
}

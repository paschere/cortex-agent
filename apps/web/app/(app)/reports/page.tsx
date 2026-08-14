import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { REPORT_KIND_LABEL, type ReportKind } from '@/lib/reports-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listReports, shareIsLive } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { FileBarChart, Link2 } from 'lucide-react';
import Link from 'next/link';
import { GenerateReport } from './_components/GenerateReport';
import { longDate, monthHeading, stamp } from './_components/format';

/**
 * Informes.
 *
 * THE SHAPE OF THE SCREEN. Three cards on top, a shelf underneath. The cards
 * are the three questions this business asks every month; the shelf is every
 * answer it has already written down. Putting the generator first is not a
 * marketing decision — it is what makes the empty state an invitation instead
 * of an apology, and it is the honest summary of the product: there are three
 * reports, they are good, and there is no fourth.
 *
 * THE SHELF IS GROUPED BY MONTH because that is how these are asked for
 * ("pásame el de julio"). Sorting alone would put July's fleet report between
 * two August expiry reports and make the question unanswerable by scrolling.
 *
 * Everything here is read through the workspace-scoped handle; nothing on this
 * page filters by organization by hand.
 */

export const dynamic = 'force-dynamic';

const KIND_TONE: Record<ReportKind, string> = {
  expiries: 'bg-amber-soft text-amber',
  fleet: 'bg-emerald-soft text-emerald',
  client_activity: 'bg-primary-soft text-primary',
  // Neutral: a chart kept from a conversation can be about anything, so a tone
  // here would be asserting a meaning the report does not have. The three above
  // are subjects with a fixed colour; this one is a provenance.
  chart: 'bg-surface-2 text-ink-muted',
  // El parte no es un tema, es una cadencia: se distingue del resto porque
  // llega solo, no porque hable de otra cosa. Sky, que en el sistema de diseño
  // es «informativo», y no uno de los tres colores de estado.
  weekly: 'bg-sky-soft text-sky',
};

export default async function ReportsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const rows = await listReports(db, { limit: 60 });

  // Grouped in one pass, keeping the query's newest-first order inside each
  // month, so the shelf reads top-down without a second sort anywhere.
  const groups: Array<{ key: string; items: typeof rows }> = [];
  for (const row of rows) {
    const key = row.generated_at.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(row);
    else groups.push({ key, items: [row] });
  }

  return (
    <>
      <PageHeader
        title="Informes"
        subtitle="Informes con texto y gráficos que se leen acá mismo. Cada uno queda guardado tal como se calculó y no cambia después, así que el de julio sigue diciendo en noviembre lo que decía en julio."
        icon={<FileBarChart className="h-5 w-5" />}
      />

      <GenerateReport />

      {rows.length === 0 ? (
        <Panel className="mt-6 p-8 text-center">
          <h2 className="text-[15px] font-semibold text-ink">Todavía no hay informes guardados</h2>
          <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-ink-muted">
            Genera el primero desde una de las tres tarjetas de arriba, o pídeselo a Cortex en el
            chat: «hazme el informe de vencimientos de este mes». Queda guardado acá con la fecha en
            que se calculó y la fuente de cada cifra.
          </p>
        </Panel>
      ) : (
        <section className="mt-8">
          <h2 className="field-label mb-3">Guardados</h2>
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.key}>
                <h3 className="mb-2 text-[12px] font-semibold text-ink-faint">
                  {monthHeading(group.key)}
                </h3>
                <ul className="grid gap-2.5 sm:grid-cols-2">
                  {group.items.map((row) => {
                    const live = shareIsLive(row);
                    return (
                      <li key={row.id}>
                        <Link
                          href={`/reports/${row.id}`}
                          className="group block rounded-card border border-border bg-surface p-4 shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:shadow-pop"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span
                              className={clsx(
                                'rounded-pill px-2.5 py-0.5 text-[10.5px] font-semibold',
                                KIND_TONE[row.kind as ReportKind] ?? 'bg-surface-2 text-ink-muted',
                              )}
                            >
                              {REPORT_KIND_LABEL[row.kind as ReportKind] ?? row.kind}
                            </span>
                            {live && (
                              <span
                                className="flex items-center gap-1 text-[10.5px] font-medium text-ink-faint"
                                title={`Enlace público activo · ${row.share_views} ${row.share_views === 1 ? 'apertura' : 'aperturas'}`}
                              >
                                <Link2 className="h-3 w-3" aria-hidden />
                                <span className="tabular">{row.share_views}</span>
                                <span className="sr-only">
                                  aperturas del enlace público, que sigue activo
                                </span>
                              </span>
                            )}
                          </div>

                          <h4 className="mt-2.5 text-[14px] font-semibold leading-snug text-ink group-hover:text-primary-ink">
                            {row.title}
                          </h4>
                          <p className="mt-1 text-[12px] text-ink-muted">{row.period_label}</p>

                          {/* The stamp that says this is a photograph. Mono, because
                              it is the one thing on the card somebody might check. */}
                          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-faint">
                            <span className="field-label">Calculado</span>
                            <span className="tabular">{stamp(row.generated_at)}</span>
                          </p>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          {rows.length >= 60 && (
            <p className="mt-4 text-[11.5px] text-ink-faint">
              Se muestran los 60 más recientes. Los anteriores siguen guardados y se abren por su
              enlace directo. Hoy es {longDate(new Date().toISOString().slice(0, 10))}.
            </p>
          )}
        </section>
      )}
    </>
  );
}

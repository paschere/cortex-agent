import { pillLink, statusPill } from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { AlertTriangle, Download, Landmark } from 'lucide-react';
import Link from 'next/link';
import { TaxTabs } from './TaxTabs';
import type { ExogenaScreen } from './types';

/**
 * /impuestos/exogena (0197): los formatos de exógena por tercero, armados con
 * los datos de la empresa, para descargar en CSV y entregarle al contador.
 * Sin estado ni acciones: es una vista de servidor.
 */

const cop = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;

function withYear(base: string, year: number): string {
  const url = new URL(base, 'https://x.invalid');
  url.searchParams.set('anio', String(year));
  return `${url.pathname}${url.search}`;
}

export function ExogenaView({ data }: { data: ExogenaScreen }) {
  return (
    <>
      <PageHeader
        title="Impuestos"
        subtitle="La información exógena, preparada por tercero con lo que ya está en Cortex. Tu contador la revisa, la completa y la presenta."
        icon={<Landmark className="h-5 w-5" />}
      />
      <TaxTabs active="exogena" links={data.hrefs.tabs} />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <nav
          aria-label="Año gravable"
          className="inline-flex rounded-pill border border-border bg-surface-2 p-1"
        >
          {data.years.map((y) => (
            <Link
              key={y}
              href={withYear(data.hrefs.self, y)}
              aria-current={y === data.year ? 'page' : undefined}
              className={clsx(
                'tabular min-h-8 rounded-pill px-3 py-1.5 font-mono text-xs font-semibold',
                y === data.year
                  ? 'bg-surface text-ink shadow-card'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {y}
            </Link>
          ))}
        </nav>
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <AlertTriangle className="h-3.5 w-3.5 text-amber" aria-hidden />
          Borrador — tu contador revisa y presenta. {data.versionNote}.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {data.formats.map((f) => (
          <Panel key={f.code} className="min-w-0 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="tabular font-mono text-xs font-bold text-ink-faint">
                  Formato {f.code}
                </p>
                <h2 className="text-base font-extrabold text-ink">{f.title}</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {f.rows} tercero{f.rows === 1 ? '' : 's'} · {cop(f.total)}
                </p>
              </div>
              <a href={f.csvHref} className={clsx(pillLink, 'min-h-8 px-3')} download>
                <Download className="h-3.5 w-3.5" aria-hidden />
                CSV
              </a>
            </div>
            {f.missing.length > 0 && (
              <ul className="mt-3 space-y-1">
                {f.missing.map((m) => (
                  <li key={m}>
                    <span className={statusPill('amber')}>{m}</span>
                  </li>
                ))}
              </ul>
            )}
            {f.preview.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <caption className="sr-only">Primeros terceros del formato {f.code}</caption>
                  <thead>
                    <tr className="border-b border-border text-left text-ink-faint">
                      {[0, 2, 4, 5].map((i) => (
                        <th
                          key={i}
                          className={clsx('py-1.5 pr-2 font-semibold', i === 5 && 'text-right')}
                        >
                          {f.columns[i]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {f.preview.map((r) => (
                      <tr key={`${r[0]}-${r[2]}`} className="border-b border-border/60">
                        <td className="tabular py-1.5 pr-2 font-mono text-ink-muted">{r[0]}</td>
                        <td className="tabular py-1.5 pr-2 font-mono text-ink-muted">{r[2]}</td>
                        <td className="max-w-0 truncate py-1.5 pr-2 text-ink">{r[4]}</td>
                        <td className="tabular py-1.5 text-right font-mono text-ink">
                          {typeof r[5] === 'number' ? cop(r[5]) : r[5]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 rounded-sm bg-surface-2 px-3 py-4 text-center text-xs text-ink-muted">
                Nada que reportar con los datos de Cortex de {data.year}.
              </p>
            )}
            <ul className="mt-3 space-y-1 text-micro text-ink-faint">
              {f.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </>
  );
}

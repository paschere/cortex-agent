'use client';

import { Download, FileBarChart, Printer } from 'lucide-react';
import Link from 'next/link';
import { PinSurface } from '../PinSurface';
import type { ResultViewProps } from './registry';

/**
 * EL INFORME, DENTRO DEL TURNO.
 *
 * `reports.generate` y `reports.open` devolvían markdown y un enlace. El
 * modelo lo citaba; la persona no veía las cifras hasta salir del chat. Esta
 * vista es la fotografía: cada número con su método, y dos descargas — el
 * HTML que sobrevive sin servidor, y el PDF que el navegador arma al imprimir
 * la misma fotografía.
 *
 * No se dibuja ninguna cifra que no haya venido de la herramienta. Un
 * componente de cliente que volviera a calcular sería un segundo sitio donde
 * se suma, y dos sitios acaban dando dos números.
 */

interface Figure {
  label: string;
  value: string;
  method: string;
  source: string;
}

interface ReportView {
  id: string;
  title: string;
  periodLabel: string;
  generatedAt: string;
  url: string;
  figures: Figure[];
  notes: string[];
  intact: boolean;
}

export function ReportCard({ result, toolCallId }: ResultViewProps) {
  const view = reportOf(result);
  if (!view) return null;

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <FileBarChart className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">Informe</span>
        <span className="ml-auto flex items-center gap-2">
          <PinSurface surface="reports" hidden={toolCallId.startsWith('panel:')} />
        </span>
      </div>

      <div className="px-4 py-3">
        <p className="text-sm font-semibold text-ink">{view.title}</p>
        <p className="mt-0.5 text-xs text-ink-faint">
          {view.periodLabel}
          {view.generatedAt ? ` · ${view.generatedAt.slice(0, 10)}` : ''}
        </p>
        {!view.intact && (
          <p className="mt-2 text-xs font-medium text-rose">
            El contenido guardado no coincide con su huella. No cites estas cifras.
          </p>
        )}
      </div>

      {view.figures.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {view.figures.map((f) => (
            <li key={`${f.label}:${f.value}`} className="px-4 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs text-ink-muted">{f.label}</span>
                <span className="stat-num text-sm font-semibold tabular text-ink">{f.value}</span>
              </div>
              <p className="mt-1 text-micro leading-relaxed text-ink-faint">
                {f.method} · {f.source}
              </p>
            </li>
          ))}
        </ul>
      )}

      {view.notes.length > 0 && (
        <ul className="border-t border-border bg-surface-2 px-4 py-2.5 text-xs leading-relaxed text-ink-muted">
          {view.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
        <Link
          href={view.url}
          className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-micro font-semibold text-ink transition-colors hover:bg-surface-2"
        >
          Abrir
        </Link>
        <a
          href={`/api/reports/${view.id}/export`}
          download
          className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-micro font-semibold text-ink transition-colors hover:bg-surface-2"
        >
          <Download className="h-3 w-3" aria-hidden />
          HTML
        </a>
        <Link
          href={`${view.url}${view.url.includes('?') ? '&' : '?'}print=1`}
          className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-micro font-semibold text-ink transition-colors hover:bg-surface-2"
        >
          <Printer className="h-3 w-3" aria-hidden />
          PDF
        </Link>
      </div>
    </div>
  );
}

function reportOf(result: unknown): ReportView | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  const raw = r.report;
  if (!raw || typeof raw !== 'object') return null;
  if (r.found === false) return null;
  const report = raw as Record<string, unknown>;
  if (typeof report.id !== 'string' || typeof report.title !== 'string') return null;

  const figures = Array.isArray(r.figures)
    ? r.figures.flatMap((row): Figure[] => {
        if (!row || typeof row !== 'object') return [];
        const f = row as Record<string, unknown>;
        if (typeof f.label !== 'string' || typeof f.value !== 'string') return [];
        return [
          {
            label: f.label,
            value: f.value,
            method: typeof f.method === 'string' ? f.method : '',
            source: typeof f.source === 'string' ? f.source : '',
          },
        ];
      })
    : [];

  const notes = Array.isArray(r.notes)
    ? r.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : [];

  return {
    id: report.id,
    title: report.title,
    periodLabel: typeof report.periodLabel === 'string' ? report.periodLabel : '',
    generatedAt: typeof report.generatedAt === 'string' ? report.generatedAt : '',
    url: `/reports/${report.id}`,
    figures,
    notes,
    intact: r.intact !== false,
  };
}

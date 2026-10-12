'use client';

import type { ComputedPortal, PortalSection } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { CreditCard, Download, FileText, Upload } from 'lucide-react';
import Link from 'next/link';

/**
 * EL PORTAL DE UN CLIENTE (0225): lo suyo y nada más. Envíos o pedidos,
 * lo que debe (con «Pagar» sólo si la factura trae enlace de pago), sus
 * documentos para bajar y el botón para subir un soporte. La marca de la app
 * viene del marco (ViewBrandProvider/AppTheme); aquí sólo colores del tema.
 */

const TONE: Record<string, string> = {
  primary: 'bg-primary-soft text-primary-ink',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  sky: 'bg-sky-soft text-sky',
  rose: 'bg-rose-soft text-rose',
};

const CARD = 'rounded-card border border-border bg-surface p-4 shadow-card';

function Chip({ status }: { status: { label: string; tone: string } | null }) {
  if (!status) return null;
  return (
    <span
      className={clsx(
        'shrink-0 rounded-pill px-2 py-0.5 text-micro font-semibold',
        TONE[status.tone] ?? TONE.primary,
      )}
    >
      {status.label}
    </span>
  );
}

function size(n: number): string {
  return n > 1_000_000
    ? `${(n / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1000))} KB`;
}

function Section({ s }: { s: PortalSection }) {
  if (s.kind === 'upload')
    return (
      <section className={clsx(CARD, 'flex flex-wrap items-center justify-between gap-3')}>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
          <p className="text-xs text-ink-muted">
            {s.hint ?? 'Adjunta un soporte (foto o PDF) y la empresa lo recibe de inmediato.'}
          </p>
        </div>
        {s.href && (
          <Link
            href={s.href}
            className="cortex-primary-button inline-flex h-11 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-semibold text-white shadow-card"
          >
            <Upload className="h-4 w-4" aria-hidden /> Subir soporte
          </Link>
        )}
      </section>
    );
  if (s.kind === 'documents')
    return (
      <section className={CARD}>
        <h3 className="mb-2 text-sm font-semibold text-ink">{s.title}</h3>
        {s.files.length === 0 ? (
          <p className="py-3 text-sm text-ink-muted">Todavía no hay documentos para ti.</p>
        ) : (
          <ul className="divide-y divide-border">
            {s.files.map((f) => (
              <li key={`${f.rowId}:${f.file.url}`}>
                <a
                  href={f.file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 items-center gap-3 py-2 hover:bg-surface-2"
                >
                  <FileText className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{f.label}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {f.file.name} · {size(f.file.size)}
                    </span>
                  </span>
                  <Download className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  if (s.kind === 'invoices')
    return (
      <section className={CARD}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
          {s.owed && (
            <div className="text-right">
              <div className="text-micro text-ink-faint">Por pagar</div>
              <div className="stat-display text-xl leading-none text-ink">{s.owed}</div>
              {s.overdueCount > 0 && (
                <div className="mt-1 text-micro font-semibold text-rose">
                  {s.overdueCount} vencidas
                </div>
              )}
            </div>
          )}
        </div>
        {s.rows.length === 0 ? (
          <p className="py-3 text-sm text-ink-muted">No tienes facturas por ahora.</p>
        ) : (
          <ul className="divide-y divide-border">
            {s.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{r.title}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    {r.due ? `${r.overdue ? 'Venció' : 'Vence'} ${r.due}` : ''}
                    {r.cells.map((c) => ` · ${c.value}`).join('')}
                  </span>
                </span>
                {r.amount && (
                  <span className="tabular text-sm font-semibold text-ink">{r.amount}</span>
                )}
                <Chip
                  status={
                    r.paid
                      ? { label: 'Pagada', tone: 'emerald' }
                      : r.overdue
                        ? { label: 'Vencida', tone: 'rose' }
                        : r.status
                  }
                />
                {r.payUrl && (
                  <a
                    href={r.payUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cortex-primary-button inline-flex h-9 items-center gap-1.5 rounded-pill bg-primary px-3.5 text-xs font-semibold text-white"
                  >
                    <CreditCard className="h-3.5 w-3.5" aria-hidden /> Pagar
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  return (
    <section className={CARD}>
      <h3 className="mb-2 text-sm font-semibold text-ink">{s.title}</h3>
      {s.rows.length === 0 ? (
        <p className="py-3 text-sm text-ink-muted">Todavía no hay nada para mostrar.</p>
      ) : (
        <ul className="divide-y divide-border">
          {s.rows.map((r) => {
            const inner = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{r.title}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    {r.cells.map((c) => `${c.label}: ${c.value}`).join(' · ')}
                  </span>
                </span>
                <Chip status={r.status} />
              </>
            );
            return (
              <li key={r.id}>
                {r.href ? (
                  <Link
                    href={r.href}
                    className="flex min-h-11 items-center gap-3 py-2 hover:bg-surface-2"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="flex min-h-11 items-center gap-3 py-2">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {s.total > s.rows.length && (
        <p className="mt-2 text-xs text-ink-faint">y {s.total - s.rows.length} más</p>
      )}
    </section>
  );
}

export function PortalHome({ portal }: { portal: ComputedPortal }) {
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-ink">{portal.title}</h2>
        {portal.client ? (
          <p className="mt-0.5 text-sm text-ink-muted">
            Cliente: <span className="font-semibold text-ink">{portal.client}</span>
          </p>
        ) : (
          <p className="mt-0.5 rounded-card bg-amber-soft px-3 py-2 text-sm text-amber">
            Tu usuario todavía no está asignado a un cliente. Pídele a la empresa que lo configure.
          </p>
        )}
        {portal.welcome && <p className="mt-1 text-sm text-ink-muted">{portal.welcome}</p>}
      </header>
      {portal.sections.map((s) => (
        <Section key={`${s.kind}:${s.title}`} s={s} />
      ))}
    </div>
  );
}

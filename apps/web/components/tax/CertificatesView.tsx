'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { Download, Landmark, Send } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { TaxTabs } from './TaxTabs';
import type { CertificatesActions, CertificatesScreen } from './types';

/**
 * /impuestos/certificados (0197): los certificados de retención que la empresa
 * le expide a cada proveedor, calculados con las facturas de proveedor. Se
 * descargan en PDF con la marca; mandarlos por correo pide confirmar.
 */

const cop = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;
const KINDS = [
  { id: 'renta', label: 'Retención en la fuente' },
  { id: 'iva', label: 'ReteIVA' },
  { id: 'ica', label: 'ReteICA' },
] as const;
const BIMESTERS = ['ene–feb', 'mar–abr', 'may–jun', 'jul–ago', 'sep–oct', 'nov–dic'];

function withParams(base: string, params: Record<string, string | null>): string {
  const url = new URL(base, 'https://x.invalid');
  for (const [k, v] of Object.entries(params)) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  return `${url.pathname}${url.search}`;
}

export function CertificatesView({
  data,
  actions,
}: { data: CertificatesScreen; actions: CertificatesActions }) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const mailable = data.rows.filter((r) => r.hasEmail);
  const send = (keys: string[], label: string) => {
    if (
      !window.confirm(
        `¿Mandar ${label} por correo desde tu Gmail u Outlook? Antes, confirma con tu contador que las retenciones estén declaradas.`,
      )
    )
      return;
    setNote(null);
    start(async () => {
      const r = await actions.send(keys);
      setNote({ ok: r.ok, text: r.note });
    });
  };

  return (
    <>
      <PageHeader
        title="Impuestos"
        subtitle="Los certificados de retención que le debes a cada proveedor, calculados con sus facturas. Revísalos con tu contador antes de mandarlos."
        icon={<Landmark className="h-5 w-5" />}
      />
      <TaxTabs active="certificados" links={data.hrefs.tabs} />

      <Panel className="mb-6 flex flex-wrap items-center gap-3 p-4 sm:p-5">
        <nav aria-label="Clase de certificado" className="inline-flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <Link
              key={k.id}
              href={withParams(data.hrefs.self, {
                tipo: k.id,
                bimestre: k.id === 'iva' ? String(data.period ?? 1) : null,
              })}
              aria-current={k.id === data.kind ? 'page' : undefined}
              className={clsx(
                'inline-flex min-h-8 items-center rounded-pill border px-3.5 text-xs font-semibold',
                k.id === data.kind
                  ? 'border-primary/30 bg-primary-soft text-primary-ink'
                  : 'border-border text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {k.label}
            </Link>
          ))}
        </nav>
        <nav
          aria-label="Año"
          className="inline-flex rounded-pill border border-border bg-surface-2 p-1"
        >
          {data.years.map((y) => (
            <Link
              key={y}
              href={withParams(data.hrefs.self, { anio: String(y) })}
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
        {data.kind === 'iva' && (
          <nav aria-label="Bimestre" className="inline-flex flex-wrap gap-1">
            {BIMESTERS.map((b, i) => (
              <Link
                key={b}
                href={withParams(data.hrefs.self, { bimestre: String(i + 1) })}
                aria-current={data.period === i + 1 ? 'page' : undefined}
                className={clsx(
                  'min-h-8 rounded-pill px-2.5 py-1.5 text-xs font-semibold',
                  data.period === i + 1
                    ? 'bg-primary-soft text-primary-ink'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {b}
              </Link>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-3">
          <p className="text-sm text-ink-muted">
            Total retenido{' '}
            <span className="tabular font-mono font-bold text-ink">{cop(data.total)}</span>
          </p>
          {data.canAct && mailable.length > 0 && (
            <button
              type="button"
              className={pillPrimary}
              disabled={pending}
              onClick={() =>
                send([], `${mailable.length} certificado${mailable.length === 1 ? '' : 's'}`)
              }
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              Mandar a todos
            </button>
          )}
        </div>
      </Panel>
      <div className="mb-4">
        <ActionNote note={note} />
      </div>

      <Panel className="min-w-0 overflow-x-auto p-0">
        {data.rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">
            No hay retenciones anotadas en las facturas de proveedor de este periodo.
          </p>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Certificados de retención por proveedor</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-ink-faint">
                <th className="px-5 py-2.5 font-semibold">Proveedor</th>
                <th className="px-3 py-2.5 font-semibold">Concepto</th>
                <th className="px-3 py-2.5 text-right font-semibold">
                  {data.kind === 'iva' ? 'IVA (base)' : 'Base'}
                </th>
                <th className="px-3 py-2.5 text-right font-semibold">Retenido</th>
                <th className="px-3 py-2.5 font-semibold">Estado</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-5 py-3">
                    <p className="font-semibold text-ink">{r.supplierName}</p>
                    <p className="tabular font-mono text-micro text-ink-muted">
                      {r.supplierNit ? `NIT ${r.supplierNit}` : 'Sin NIT'} · {r.invoices} factura
                      {r.invoices === 1 ? '' : 's'}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-ink-muted">
                    {data.kind === 'renta' && data.canAct && r.supplierId ? (
                      <ConceptSelect row={r} options={data.concepts} actions={actions} />
                    ) : (
                      (r.concept ?? '—')
                    )}
                  </td>
                  <td className="tabular whitespace-nowrap px-3 py-3 text-right font-mono">{cop(r.base)}</td>
                  <td className="tabular whitespace-nowrap px-3 py-3 text-right font-mono font-bold text-ink">
                    {cop(r.withheld)}
                  </td>
                  <td className="px-3 py-3">
                    {r.sentLabel ? (
                      <span className={statusPill('emerald')}>{r.sentLabel}</span>
                    ) : r.hasEmail ? (
                      <span className={statusPill('neutral')}>Sin enviar</span>
                    ) : (
                      <span className={statusPill('amber')}>Sin correo</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span className="flex justify-end gap-1.5">
                      <a
                        href={r.pdfHref}
                        target="_blank"
                        rel="noreferrer"
                        className={clsx(pillLink, 'min-h-8 px-3')}
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden />
                        PDF
                      </a>
                      {data.canAct && r.hasEmail && (
                        <button
                          type="button"
                          className={clsx(pillLink, 'min-h-8 px-3')}
                          disabled={pending}
                          onClick={() =>
                            send(
                              [r.supplierNit ?? r.supplierName],
                              `el certificado a ${r.supplierName}`,
                            )
                          }
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden />
                          Mandar
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-3 text-micro text-ink-faint">
        Las cifras salen de la retención anotada en cada factura de proveedor (Por pagar). Un
        concepto sin confirmar se deduce de la tarifa: ponlo en el proveedor para que el certificado
        y la declaración de retención lo usen.
      </p>
    </>
  );
}

function ConceptSelect({
  row,
  options,
  actions,
}: {
  row: CertificatesScreen['rows'][number];
  options: CertificatesScreen['concepts'];
  actions: CertificatesActions;
}) {
  const [value, setValue] = useState(row.supplierConcept ?? '');
  const [pending, start] = useTransition();
  return (
    <span className="flex flex-col gap-0.5">
      <select
        className={`${fieldClass} min-h-8 w-auto py-1 text-xs`}
        value={value}
        disabled={pending}
        aria-label={`Concepto de retención de ${row.supplierName}`}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          start(async () => {
            await actions.setConcept(row.supplierId as string, next || null);
          });
        }}
      >
        <option value="">
          {row.concept && row.concept !== 'Sin concepto'
            ? `${row.concept} (deducido por la tarifa)`
            : 'Sin concepto'}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

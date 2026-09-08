'use client';

import { Panel } from '@/components/ui/panel';
import type { FinanceSource, readFinanceSources } from '@/lib/finance/sources';
import { chipClass } from '@/lib/status-chip';
import clsx from 'clsx';
import { ArrowUpRight, Check, FileSearch, Loader2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

export type FinanceSourcesResult = Awaited<ReturnType<typeof readFinanceSources>>;
type Domain = FinanceSource['sourceDomains'][number];
type FinancialRole = FinanceSource['financialRole'];

const DOMAIN_OPTIONS: { value: Domain; label: string }[] = [
  { value: 'financial', label: 'Financiera' },
  { value: 'administrative', label: 'Administrativa' },
  { value: 'commercial', label: 'Comercial' },
  { value: 'operations', label: 'Operativa' },
];

const ROLE_OPTIONS: { value: FinancialRole; label: string; help: string }[] = [
  { value: 'unclassified', label: 'Sin clasificar', help: 'Queda pendiente y no entra en cifras.' },
  { value: 'receivable', label: 'Por cobrar', help: 'Venta o cobro que la empresa debe recibir.' },
  { value: 'payable', label: 'Por pagar', help: 'Compra u obligación que la empresa debe pagar.' },
  { value: 'reference', label: 'Referencia', help: 'Sirve para consultar, sin alimentar totales.' },
];

const DOMAIN_LABEL = Object.fromEntries(DOMAIN_OPTIONS.map((item) => [item.value, item.label]));
const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS.map((item) => [item.value, item.label]));

export function SourceClassification({
  initial,
  apiHref,
  extractionHref,
  error,
}: {
  initial: FinanceSourcesResult;
  apiHref: string;
  extractionHref: string;
  error?: string;
}) {
  const [sources, setSources] = useState(initial.sources);
  const [message, setMessage] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(initial.sources);
  if (snapshot !== initial.sources) {
    setSnapshot(initial.sources);
    setSources(initial.sources);
    setMessage(null);
  }
  const summary = useMemo(
    () => ({
      unclassified: sources.filter((source) => source.financialRole === 'unclassified').length,
      receivableConfirmed: sources.filter(
        (source) => source.reviewState === 'confirmed' && source.financialRole === 'receivable',
      ).length,
      payableConfirmed: sources.filter(
        (source) => source.reviewState === 'confirmed' && source.financialRole === 'payable',
      ).length,
    }),
    [sources],
  );

  return (
    <section id="sources" className="scroll-mt-24 space-y-4" aria-labelledby="sources-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="field-label">Control de fuentes</p>
          <h2 id="sources-title" className="mt-1 text-lg font-semibold text-ink">
            Qué impacto tiene cada documento
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted">
            Cortex puede consultar un documento sin convertirlo en una cifra. Aquí una persona
            confirma sus áreas y su rol; solo una factura confirmada como por cobrar alimenta
            cartera.
          </p>
        </div>
        <span
          className={chipClass(
            summary.unclassified > 0 ? 'amber' : sources.length ? 'emerald' : 'neutral',
          )}
        >
          {sources.length === 0
            ? 'Sin documentos leídos'
            : summary.unclassified > 0
              ? `${summary.unclassified} ${summary.unclassified === 1 ? 'pendiente' : 'pendientes'}`
              : 'Fuentes revisadas'}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SourceMetric
          label="Sin clasificar"
          value={summary.unclassified}
          note="No afectan cifras"
        />
        <SourceMetric
          label="Por cobrar confirmadas"
          value={summary.receivableConfirmed}
          note="Pueden alimentar cartera"
        />
        <SourceMetric
          label="Por pagar confirmadas"
          value={summary.payableConfirmed}
          note="Separadas de cartera"
        />
      </div>

      {!initial.canClassify ? (
        <div className="flex gap-3 rounded-card border border-border bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <p>
            Puedes revisar el origen y el impacto. Solo un administrador del espacio puede cambiar
            la clasificación.
          </p>
        </div>
      ) : null}

      {message ? (
        <output className="block rounded-card border border-border bg-surface px-4 py-3 text-sm text-ink">
          {message}
        </output>
      ) : null}

      {error ? (
        <Panel>
          <div className="px-5 py-7 text-center">
            <p className="text-sm font-semibold text-ink">No pudimos leer las fuentes</p>
            <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">{error}</p>
            <button
              type="button"
              onClick={() => location.reload()}
              className="mt-3 text-sm font-semibold text-primary hover:underline"
            >
              Reintentar
            </button>
          </div>
        </Panel>
      ) : null}

      {!error && sources.length === 0 ? (
        <Panel>
          <div className="px-5 py-9 text-center">
            <FileSearch className="mx-auto h-5 w-5 text-ink-faint" aria-hidden />
            <p className="mt-2 text-sm font-semibold text-ink">No hay documentos extraídos</p>
            <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">
              Aquí aparecen documentos ya leídos por Cortex. Subirlos al Feed por sí solo no los
              clasifica ni los incluye en Finanzas.
            </p>
            <Link
              href={extractionHref}
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              Pedir a Cortex que los lea <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        </Panel>
      ) : (
        <div className="space-y-3">
          {sources.map((source) => (
            <SourceRow
              key={`${source.extractionId}:${source.updatedAt}`}
              source={source}
              canClassify={initial.canClassify}
              apiHref={apiHref}
              onSaved={(saved, note) => {
                setSources((current) =>
                  current.map((item) => (item.extractionId === saved.extractionId ? saved : item)),
                );
                setMessage(note);
              }}
            />
          ))}
        </div>
      )}
      {initial.summary.payableByCurrency.length > 0 ? (
        <p className="text-xs leading-relaxed text-ink-faint">
          Total documental por pagar:{' '}
          {initial.summary.payableByCurrency
            .map(
              (item) =>
                `${item.currency} ${item.amount.toLocaleString('es-CO')} (${item.documents})`,
            )
            .join(' · ')}
          . Es valor de documentos confirmados; no es un saldo pendiente ni calcula caja.
        </p>
      ) : null}
      {initial.truncated ? (
        <p className="text-xs leading-relaxed text-amber">
          Esta cola muestra los 500 documentos más recientes. Hay más fuentes por revisar.
        </p>
      ) : null}
    </section>
  );
}

function SourceMetric({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-muted">{label}</span>
        <span className="stat-num text-lg font-semibold text-ink">{value}</span>
      </div>
      <p className="mt-1 text-micro text-ink-faint">{note}</p>
    </div>
  );
}

function SourceRow({
  source,
  canClassify,
  apiHref,
  onSaved,
}: {
  source: FinanceSource;
  canClassify: boolean;
  apiHref: string;
  onSaved: (source: FinanceSource, note: string) => void;
}) {
  const [domains, setDomains] = useState<Domain[]>(source.sourceDomains);
  const [role, setRole] = useState(source.financialRole);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const effectiveRole = domains.includes('financial')
    ? role
    : role === 'unclassified'
      ? role
      : 'reference';
  const dirty =
    domains.join('|') !== source.sourceDomains.join('|') || effectiveRole !== source.financialRole;

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(apiHref, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            extractionId: source.extractionId,
            sourceDomains: domains,
            financialRole: effectiveRole,
            expectedUpdatedAt: source.updatedAt,
          }),
        });
        const payload = (await response.json()) as { source?: FinanceSource; error?: string };
        if (!response.ok || !payload.source)
          throw new Error(payload.error ?? 'No se pudo guardar.');
        const saved = { ...payload.source, sourceHref: source.sourceHref };
        onSaved(saved, `Guardado: ${source.title}. ${impactText(saved)}`);
        router.refresh();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'No se pudo guardar la clasificación.');
      }
    });
  }

  return (
    <Panel className="overflow-hidden">
      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(220px,1.2fr)_minmax(170px,.55fr)_minmax(190px,.7fr)_minmax(210px,.8fr)] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={source.sourceHref}
              className="truncate text-sm font-semibold text-ink hover:text-primary hover:underline"
            >
              {source.title}
            </Link>
            <span
              className={chipClass(source.financialRole === 'unclassified' ? 'amber' : 'neutral')}
            >
              {ROLE_LABEL[source.financialRole]}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            {source.docType ?? 'Documento'} ·{' '}
            {source.sourceDomains.length
              ? source.sourceDomains.map((item) => DOMAIN_LABEL[item]).join(' · ')
              : 'Sin área'}
          </p>
          {source.classificationQuote ? (
            <blockquote className="mt-3 border-l-2 border-border-strong pl-3 text-xs leading-relaxed text-ink-muted">
              “{source.classificationQuote}”
            </blockquote>
          ) : (
            <p className="mt-3 text-xs text-ink-faint">
              Sin fragmento suficiente para orientar la clasificación.
            </p>
          )}
          <Link
            href={source.sourceHref}
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            Abrir documento fuente <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
        </div>

        <fieldset className="block">
          <legend className="field-label">Áreas donde aporta</legend>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {DOMAIN_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={clsx(
                  'flex min-h-9 items-center gap-2 rounded-sm border px-2.5 text-xs font-medium',
                  domains.includes(option.value)
                    ? 'border-primary/30 bg-primary-soft text-primary-ink'
                    : 'border-border bg-surface text-ink-muted',
                )}
              >
                <input
                  type="checkbox"
                  checked={domains.includes(option.value)}
                  disabled={!canClassify || pending}
                  onChange={(event) =>
                    setDomains((current) =>
                      event.target.checked
                        ? [...current, option.value]
                        : current.filter((item) => item !== option.value),
                    )
                  }
                  className="accent-primary"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="field-label">Rol financiero</span>
          <select
            value={effectiveRole}
            onChange={(event) => setRole(event.target.value as FinancialRole)}
            disabled={!canClassify || pending || !domains.includes('financial')}
            className="mt-2 min-h-10 w-full rounded-sm border border-border-strong bg-surface px-3 text-sm text-ink disabled:cursor-not-allowed disabled:bg-surface-2"
          >
            {ROLE_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={
                  source.docType !== 'invoice' &&
                  (option.value === 'receivable' || option.value === 'payable')
                }
              >
                {option.label}
              </option>
            ))}
          </select>
          {source.docType !== 'invoice' ? (
            <span className="text-micro leading-relaxed text-ink-faint">
              Por cobrar y por pagar requieren un documento identificado como factura.
            </span>
          ) : null}
          <span className="mt-1.5 block text-micro leading-relaxed text-ink-faint">
            {ROLE_OPTIONS.find((option) => option.value === effectiveRole)?.help}
          </span>
        </label>

        <div className="rounded-sm border border-border bg-surface-2 px-3 py-3">
          <p className="field-label">Impacto al guardar</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            {impactText({ ...source, sourceDomains: domains, financialRole: effectiveRole })}
          </p>
          {canClassify ? (
            <button
              type="button"
              onClick={save}
              disabled={!dirty || pending}
              className={clsx(
                'mt-3 inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-sm px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                dirty ? 'bg-primary text-white hover:bg-primary/90' : 'bg-surface text-ink-faint',
              )}
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="h-3.5 w-3.5" aria-hidden />
              )}
              {pending ? 'Guardando…' : 'Guardar clasificación'}
            </button>
          ) : null}
          {error ? <p className="mt-2 text-xs font-medium text-rose">{error}</p> : null}
        </div>
      </div>
    </Panel>
  );
}

function impactText(
  source: Pick<
    FinanceSource,
    'sourceDomains' | 'financialRole' | 'reviewState' | 'amount' | 'currency'
  >,
): string {
  if (!source.sourceDomains.includes('financial') || source.financialRole === 'reference')
    return 'Quedará disponible para consulta, sin cambiar cifras financieras.';
  if (source.financialRole === 'unclassified')
    return 'Seguirá pendiente y visible; no cambiará ninguna cifra.';
  if (source.financialRole === 'payable')
    return 'Quedará como cuenta por pagar, separada de cartera. No calcula utilidad ni caja.';
  if (source.reviewState !== 'confirmed')
    return 'Quedará marcada por cobrar, pero no entrará en cartera hasta confirmar los datos de la factura.';
  const amount =
    source.amount == null
      ? null
      : `${source.currency ?? ''} ${source.amount.toLocaleString('es-CO')}`.trim();
  return amount
    ? `Esta factura confirmada podrá alimentar cartera por ${amount}.`
    : 'El rol será por cobrar; requiere importe y moneda confirmados antes de alimentar cartera.';
}

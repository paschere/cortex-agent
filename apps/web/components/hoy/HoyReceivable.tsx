import { DeltaPill } from '@/components/charts/DeltaPill';
import { RankBars } from '@/components/charts/RankBars';
import { SegmentBar } from '@/components/charts/SegmentBar';
import { CHART_COLOR } from '@/components/charts/colors';
import type { ReceivableView } from '@/lib/hoy/insights';
import { formatCompactMoney, formatMoney } from '@cortex/agent-tools/src/format/display';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SectionHead } from './SectionHead';

/**
 * «QUIÉN TE DEBE»: lo que te deben y qué tan vencido está (una barra segmentada
 * por antigüedad), los clientes que más pesan (con lo vencido de cada uno) y
 * dos lecturas rápidas: lo cobrado este mes y en cuántos días te pagan. Todo
 * sale de «Cartera y pagos», con el plazo por defecto de la empresa para las
 * facturas sin fecha. Cada nombre y cada tramo abre la cartera.
 */
export function HoyReceivable({ data }: { data: ReceivableView }) {
  const cur = data.currency;
  const money = (n: number) => formatMoney(n, cur);
  const goodDown = (r: number | null) => (r === null || Math.abs(r) < 0.005 ? null : r < 0);
  const goodUp = (r: number | null) => (r === null || Math.abs(r) < 0.005 ? null : r > 0);
  const dsoRatio =
    data.dso !== null && data.dsoPrev !== null && data.dsoPrev > 0
      ? (data.dso - data.dsoPrev) / data.dsoPrev
      : null;
  return (
    <section aria-label="Quién te debe" className="flex min-w-0 flex-col gap-3">
      <SectionHead
        title="Quién te debe"
        hint="Facturas abiertas, por qué tan vencidas están"
        href={data.href}
        hrefLabel="Abrir la cartera"
      />

      <dl className="grid grid-cols-2 gap-2">
        <Tile
          label="Te deben"
          title={money(data.total)}
          value={formatCompactMoney(data.total, cur)}
        >
          <DeltaPill
            ratio={data.totalVsPrev}
            good={goodDown(data.totalVsPrev)}
            compact
            label="vs. hace 30 días"
          />
        </Tile>
        <Tile
          label="Vencido"
          alert={data.overdue > 0}
          title={money(data.overdue)}
          value={formatCompactMoney(data.overdue, cur)}
        >
          <span className="flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
            {data.overdueVsPrev !== null && (
              <DeltaPill ratio={data.overdueVsPrev} good={goodDown(data.overdueVsPrev)} compact />
            )}
            {Math.round(data.overduePct * 100)} % del total
          </span>
        </Tile>
        <Tile
          label="Cobrado este mes"
          title={money(data.collectedMonth)}
          value={formatCompactMoney(data.collectedMonth, cur)}
        >
          <DeltaPill
            ratio={data.collectedVsPrev}
            good={goodUp(data.collectedVsPrev)}
            compact
            label="vs. el mes pasado"
          />
        </Tile>
        <Tile label="Te pagan en" value={data.dso === null ? '—' : `${data.dso} días`}>
          {data.dso !== null && (
            <DeltaPill
              ratio={dsoRatio}
              good={goodDown(dsoRatio)}
              compact
              label="vs. hace 30 días"
            />
          )}
        </Tile>
      </dl>

      {data.aging.length > 0 && (
        <SegmentBar
          name="Antigüedad de la cartera"
          compact
          total={formatCompactMoney(data.total, cur)}
          totalLabel="Por antigüedad"
          items={data.aging.map((a) => ({
            key: a.key,
            label: a.label,
            value: a.amount,
            display: formatCompactMoney(a.amount, cur),
            color: CHART_COLOR[a.tone],
            href: data.href,
          }))}
        />
      )}

      {data.clients.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-ink-muted">Los que más te deben</h3>
          <RankBars
            name="Clientes que más te deben"
            color={CHART_COLOR.primary}
            showShare={false}
            items={data.clients.map((c) => ({
              label: c.name,
              value: c.open,
              display: formatCompactMoney(c.open, cur),
              color: c.overdue > 0 ? CHART_COLOR.rose : CHART_COLOR.primary,
              sub: `${c.invoices} ${c.invoices === 1 ? 'factura' : 'facturas'}${
                c.overdue > 0 ? ` · ${formatCompactMoney(c.overdue, cur)} vencido` : ' · al día'
              }`,
              href: data.href,
              alert: c.overdue > 0,
            }))}
          />
          {data.clientsMore > 0 && (
            <Link
              href={data.href}
              className="text-xs font-semibold text-primary-ink hover:underline"
            >
              y {data.clientsMore} {data.clientsMore === 1 ? 'cliente más' : 'clientes más'}
            </Link>
          )}
        </div>
      )}
      {data.noTerm.count > 0 && (
        <p className="text-micro text-ink-faint">
          {data.noTerm.count} {data.noTerm.count === 1 ? 'factura' : 'facturas'} (
          {formatCompactMoney(data.noTerm.amount, cur)}) no tienen plazo: no cuentan como vencidas.
        </p>
      )}
    </section>
  );
}

function Tile({
  label,
  value,
  title,
  alert,
  children,
}: {
  label: string;
  value: string;
  title?: string;
  alert?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-surface p-3">
      <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        {alert && <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-rose" />}
        {label}
        {alert && <span className="sr-only">(pide atención)</span>}
      </dt>
      <dd className="m-0 flex flex-col gap-1">
        <span
          title={title}
          className="stat-display text-base leading-tight tabular-nums text-ink sm:text-lg"
        >
          {value}
        </span>
        {children}
      </dd>
    </div>
  );
}

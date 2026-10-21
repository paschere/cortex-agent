'use client';

import {
  BarChart,
  type BarSeries,
  CHART_COLOR,
  CartesianChart,
  DeltaPill,
  deltaRatio,
  formatCompact,
} from '@/components/charts';
import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import {
  MONTHS_SHORT,
  formatDay,
  formatMoney,
  formatNumber,
  formatPercent,
} from '@cortex/agent-tools/src/format/display';
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  type CarteraBucketKey,
  type CarteraClient,
  type CarteraInvoice,
  type CarteraModel,
  type CarteraPayment,
} from '@cortex/agent-tools/src/payments/cartera';
import clsx from 'clsx';
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  ChevronDown,
  ExternalLink,
  FileText,
  Loader2,
  Sparkles,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useMemo, useState, useTransition } from 'react';

/**
 * LA CARTERA, PARA LEERSE DE ARRIBA ABAJO.
 *
 * Cuatro cifras con su comparación, la antigüedad (clicable: filtra la lista),
 * los clientes que más deben (clic: su detalle), facturado contra cobrado,
 * lo que se espera cobrar por semana, y al final las facturas abiertas y los
 * recibos con a qué factura fueron. No calcula plata: todo viene de
 * `buildCartera` (packages/agent-tools/src/payments/cartera.ts); aquí sólo se
 * filtra, se ordena y se escribe en español.
 */

export interface CarteraActions {
  /** Emparejar un recibo con una factura (queda con el nombre de quien lo hace). */
  match: (input: {
    paymentId: string;
    kind: 'accounting' | 'document';
    invoiceId: string;
  }) => Promise<{ ok: boolean; note?: string; error?: string }>;
  /** Guardar el plazo de pago por defecto de la empresa (días). */
  setTerm?: (days: number) => Promise<{ ok: boolean; error?: string }>;
}

interface Props {
  model: CarteraModel;
  actions: CarteraActions;
  /** El plazo con el que se cuentan las facturas sin plazo propio. */
  plazo: number | null;
  /** El plazo guardado de la empresa (el de `plazo` puede ser sólo para mirar). */
  savedTerm?: number;
  /** La propia página: los botones de plazo agregan `?plazo=N` (o lo quitan). */
  plazoBase: string;
  askHref: string;
  /** La frase que Cortex da en el chat sobre la cartera, entera. */
  sentence?: string;
}

const SHORT_BUCKET: Record<CarteraBucketKey, string> = {
  current: 'Al día',
  d1_30: '1–30',
  d31_60: '31–60',
  d61_90: '61–90',
  d90_plus: '+90',
  no_term: 'Sin plazo',
};

const BUCKET_COLOR: Record<CarteraBucketKey, string> = {
  current: CHART_COLOR.emerald,
  d1_30: CHART_COLOR.amber,
  d31_60: CHART_COLOR.amber,
  d61_90: CHART_COLOR.rose,
  d90_plus: CHART_COLOR.rose,
  no_term: CHART_COLOR.ink,
};

const STACK_COLORS = [CHART_COLOR.primary, CHART_COLOR.sky, CHART_COLOR.emerald, CHART_COLOR.amber];
const OTHERS_COLOR = CHART_COLOR.ink;

export function CarteraScreen({
  model,
  actions,
  plazo,
  savedTerm,
  plazoBase,
  askHref,
  sentence,
}: Props) {
  const plazoHref = (days: number | null) =>
    days ? `${plazoBase}${plazoBase.includes('?') ? '&' : '?'}plazo=${days}` : plazoBase;
  const m = model;
  const money = (n: number) => formatMoney(n, m.currency);
  const [bucket, setBucket] = useState<CarteraBucketKey | null>(null);
  const [clientKey, setClientKey] = useState<string | null>(null);

  const empty = m.invoices.length === 0 && m.payments.length === 0;
  if (empty) return <EmptyCartera askHref={askHref} />;

  return (
    <div className="space-y-6">
      <Kpis model={m} money={money} />
      <TermNotice
        model={m}
        plazo={plazo}
        savedTerm={savedTerm}
        setTerm={actions.setTerm}
        plazoHref={plazoHref}
        money={money}
      />
      <AdvanceNotice model={m} money={money} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AgingPanel
          model={m}
          money={money}
          bucket={bucket}
          onBucket={(b) => {
            setBucket(b);
            if (b)
              document
                .getElementById('facturas-abiertas')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
        <ClientsPanel
          model={m}
          money={money}
          selected={clientKey}
          onSelect={setClientKey}
          onSeeInvoices={(key) => {
            setClientKey(key);
            setBucket(null);
            document
              .getElementById('facturas-abiertas')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <MonthlyPanel model={m} money={money} />
        <ProjectionPanel model={m} money={money} plazoHref={plazoHref} />
      </div>

      <InvoicesPanel
        model={m}
        money={money}
        bucket={bucket}
        clientKey={clientKey}
        onBucket={setBucket}
        onClient={setClientKey}
      />
      <PaymentsPanel model={m} money={money} actions={actions} />
      <HowItAdds model={m} money={money} sentence={sentence} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cifras de arriba
// ---------------------------------------------------------------------------

function Kpis({ model: m, money }: { model: CarteraModel; money: (n: number) => string }) {
  const k = m.kpis;
  const overdueTone = k.overdue.pct > 0.25 ? 'rose' : k.overdue.pct > 0 ? 'amber' : 'emerald';
  return (
    <section
      aria-label="Resumen de la cartera"
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <Kpi
        icon={<Wallet className="h-4 w-4" aria-hidden />}
        label="Por cobrar"
        value={money(k.outstanding.value)}
        sub={`en ${plural(k.outstanding.openInvoices, 'factura abierta', 'facturas abiertas')}`}
        delta={
          k.outstanding.prev !== null ? deltaRatio(k.outstanding.value, k.outstanding.prev) : null
        }
        goodWhenUp={false}
        prevText={
          k.outstanding.prev !== null ? `hace 30 días ≈ ${money(k.outstanding.prev)}` : null
        }
      />
      <Kpi
        icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
        label="Vencido"
        tone={overdueTone}
        value={money(k.overdue.value)}
        sub={
          m.noTermInvoices > 0 && k.overdue.value === 0
            ? 'sin fechas de plazo no se puede decir'
            : `${formatPercent(k.overdue.pct * 100)} de lo que te deben · ${plural(k.overdue.invoices, 'factura')}`
        }
        delta={k.overdue.prev ? deltaRatio(k.overdue.value, k.overdue.prev) : null}
        goodWhenUp={false}
        prevText={k.overdue.prev !== null ? `hace 30 días ≈ ${money(k.overdue.prev)}` : null}
      />
      <Kpi
        icon={<Banknote className="h-4 w-4" aria-hidden />}
        label="Cobrado este mes"
        tone="emerald"
        value={money(k.collectedMonth.value)}
        sub="recibos de caja desde el 1 del mes"
        delta={
          k.collectedMonth.prev ? deltaRatio(k.collectedMonth.value, k.collectedMonth.prev) : null
        }
        goodWhenUp
        prevText={
          k.collectedMonth.prev !== null
            ? `mes anterior, mismo tramo: ${money(k.collectedMonth.prev)}`
            : null
        }
      />
      <Kpi
        icon={<CalendarClock className="h-4 w-4" aria-hidden />}
        label="Días promedio de cobro"
        tone="sky"
        value={k.dso.value === null ? '—' : `${formatNumber(k.dso.value, 0)} días`}
        sub="lo que se tarda en cobrar lo que facturas"
        delta={k.dso.value !== null && k.dso.prev ? deltaRatio(k.dso.value, k.dso.prev) : null}
        goodWhenUp={false}
        prevText={k.dso.prev !== null ? `hace 30 días ≈ ${formatNumber(k.dso.prev, 0)} días` : null}
        help="Se calcula como lo que te deben dividido entre lo facturado en los últimos 90 días, por 90."
      />
    </section>
  );
}

const TONE: Record<string, { chip: string; icon: string }> = {
  primary: { chip: 'bg-primary-soft', icon: 'text-primary' },
  emerald: { chip: 'bg-emerald-soft', icon: 'text-emerald' },
  amber: { chip: 'bg-amber-soft', icon: 'text-amber' },
  sky: { chip: 'bg-sky-soft', icon: 'text-sky' },
  rose: { chip: 'bg-rose-soft', icon: 'text-rose' },
};

function Kpi({
  icon,
  label,
  value,
  sub,
  delta,
  goodWhenUp,
  prevText,
  tone = 'primary',
  help,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  delta: number | null;
  goodWhenUp: boolean;
  prevText: string | null;
  tone?: 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';
  help?: string;
}) {
  const t = TONE[tone] ?? TONE.primary;
  return (
    <div
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
      title={help}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-sm', t?.chip, t?.icon)}
        >
          {icon}
        </span>
        <span className="text-sm font-bold text-ink-muted">{label}</span>
      </div>
      <p className="stat-num mt-2.5 break-words text-xl leading-tight text-ink xl:text-lg 2xl:text-xl">
        {value}
      </p>
      <p className="mt-1.5 text-xs text-ink-muted">{sub}</p>
      <div className="mt-2.5 min-h-6 border-t border-border pt-2">
        {prevText ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <DeltaPill
              ratio={delta}
              good={delta === null || delta === 0 ? null : goodWhenUp ? delta > 0 : delta < 0}
              compact
            />
            <span className="text-micro text-ink-faint">{prevText}</span>
          </div>
        ) : (
          <span className="text-micro text-ink-faint">Sin base para comparar todavía</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avisos honestos
// ---------------------------------------------------------------------------

function TermNotice({
  model: m,
  plazo,
  savedTerm,
  setTerm,
  plazoHref,
  money,
}: {
  model: CarteraModel;
  plazo: number | null;
  savedTerm?: number;
  setTerm?: (days: number) => Promise<{ ok: boolean; error?: string }>;
  plazoHref: (d: number | null) => string;
  money: (n: number) => string;
}) {
  const [pending, start] = useTransition();
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const counted = m.termBasis.plazo_supuesto;
  const noTerm = m.termBasis.sin_plazo;
  if (counted === 0 && noTerm === 0) return null;
  const previewing = plazo !== null && savedTerm !== undefined && plazo !== savedTerm;
  const save = (days: number) => {
    setError(null);
    if (!setTerm) return;
    start(async () => {
      const r = await setTerm(days);
      if (!r.ok) setError(r.error ?? 'No se pudo guardar.');
      else setCustom('');
    });
  };
  const customDays = Number(custom);
  const customOk = Number.isInteger(customDays) && customDays >= 1 && customDays <= 365;
  return (
    <aside
      className="rounded-card border border-border bg-surface px-5 py-4"
      aria-label="Plazo de pago por defecto"
    >
      <p className="text-sm text-ink">
        <strong className="font-semibold">
          Plazo de pago por defecto: {savedTerm ?? plazo ?? '—'} días.
        </strong>{' '}
        {counted > 0
          ? `${counted} de ${m.invoices.length} facturas no traen plazo en Siigo y se cuentan con este plazo desde su fecha para saber qué está vencido.`
          : `${noTerm} facturas no traen plazo: ${money(m.projection.noTerm)} quedan como «Sin plazo definido».`}{' '}
        El plazo propio de cada cliente, si lo tiene, manda sobre este.
      </p>
      {previewing ? (
        <p className="mt-2 text-xs text-ink-muted">
          Estás mirando cómo se vería a {plazo} días; no está guardado.{' '}
          <Link href={plazoHref(null)} scroll={false} className="font-semibold text-primary">
            Volver a {savedTerm} días
          </Link>
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {[30, 60, 90].map((d) => {
          const active = (savedTerm ?? plazo) === d;
          return setTerm ? (
            <button
              key={d}
              type="button"
              disabled={pending || active}
              onClick={() => save(d)}
              aria-pressed={active}
              className={clsx(
                'inline-flex min-h-9 items-center rounded-pill border px-3.5 text-xs font-semibold transition-colors disabled:cursor-default',
                active
                  ? 'border-primary bg-primary text-white'
                  : 'border-border-strong bg-surface text-ink hover:bg-surface-2',
              )}
            >
              {d} días
            </button>
          ) : (
            <Link
              key={d}
              href={plazoHref(d)}
              scroll={false}
              aria-current={plazo === d ? 'true' : undefined}
              className={clsx(
                'inline-flex min-h-9 items-center rounded-pill border px-3.5 text-xs font-semibold transition-colors',
                plazo === d
                  ? 'border-primary bg-primary text-white'
                  : 'border-border-strong bg-surface text-ink hover:bg-surface-2',
              )}
            >
              {d} días
            </Link>
          );
        })}
        {setTerm ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (customOk) save(customDays);
            }}
          >
            <label className="sr-only" htmlFor="plazo-propio">
              Otro plazo en días
            </label>
            <input
              id="plazo-propio"
              inputMode="numeric"
              placeholder="Otro"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 3))}
              className="h-9 w-20 rounded-pill border border-border-strong bg-surface px-3 text-xs text-ink"
            />
            <button
              type="submit"
              disabled={pending || !customOk}
              className="inline-flex min-h-9 items-center rounded-pill px-2 text-xs font-semibold text-primary disabled:text-ink-faint"
            >
              Guardar
            </button>
          </form>
        ) : null}
        {pending ? <span className="text-xs text-ink-muted">Guardando…</span> : null}
      </div>
      {error ? <p className="mt-2 text-xs text-rose">{error}</p> : null}
    </aside>
  );
}

function AdvanceNotice({ model: m, money }: { model: CarteraModel; money: (n: number) => string }) {
  if (m.advances.pending <= 0) return null;
  return (
    <aside
      className="rounded-card border border-sky/25 bg-sky-soft px-5 py-4 text-sm text-ink"
      aria-label="Anticipos de clientes"
    >
      <strong className="font-semibold">
        {money(m.advances.pending)} en anticipos de clientes todavía sin cruzar con facturas.
      </strong>{' '}
      Son plata que ya entró y que no resta de «Por cobrar» hasta que se cruce en Siigo
      {m.advances.crossed > 0
        ? ` (otros ${money(m.advances.crossed)} ya se cruzaron y por eso esas facturas salen pagadas)`
        : ''}
      . El detalle está en «Pagos recientes».
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Antigüedad
// ---------------------------------------------------------------------------

function AgingPanel({
  model: m,
  money,
  bucket,
  onBucket,
}: {
  model: CarteraModel;
  money: (n: number) => string;
  bucket: CarteraBucketKey | null;
  onBucket: (b: CarteraBucketKey | null) => void;
}) {
  const series: BarSeries[] = [
    ...m.stackClients.map((c, i) => ({
      id: c.key,
      label: c.name,
      color: STACK_COLORS[i] ?? OTHERS_COLOR,
      values: m.aging.map((a) => a.byClient.find((b) => b.key === c.key)?.amount ?? 0),
    })),
    {
      id: '__otros',
      label: 'Otros clientes',
      color: OTHERS_COLOR,
      values: m.aging.map((a) => a.byClient.find((b) => b.key === '__otros')?.amount ?? 0),
    },
  ].filter((s) => s.values.some((v) => v > 0));
  const selected = bucket ? BUCKET_ORDER.indexOf(bucket) : null;
  return (
    <Panel className="p-5">
      <SectionTitle
        title="Antigüedad de la cartera"
        hint="Cuánto se debe, según qué tan vencido está. Toca una barra para ver sus facturas."
      />
      <div className="mt-3">
        <BarChart
          labels={m.aging.map((a) => SHORT_BUCKET[a.key])}
          titles={m.aging.map((a) => `${a.label} · ${plural(a.count, 'factura')}`)}
          bars={series}
          barMode="stacked"
          height={220}
          formatAxis={(n) => formatCompact(n, { money: true })}
          formatValue={money}
          selectedIndex={selected}
          onSelect={(i) => {
            const key = BUCKET_ORDER[i];
            if (!key) return;
            onBucket(bucket === key ? null : key);
          }}
          ariaLabel={`Antigüedad de la cartera: ${m.aging
            .filter((a) => a.amount > 0)
            .map((a) => `${a.label} ${money(a.amount)}`)
            .join(', ')}.`}
          emptyNote="No hay facturas abiertas"
        />
      </div>
      <p className="mt-1 text-micro text-ink-faint">
        De izquierda a derecha: al día, 1 a 30 días, 31 a 60, 61 a 90, más de 90 y sin plazo
        definido.
      </p>
      <ul
        className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3"
        aria-label="Filtrar por antigüedad"
      >
        {m.aging.map((a) => (
          <li key={a.key}>
            <button
              type="button"
              disabled={a.count === 0}
              onClick={() => onBucket(bucket === a.key ? null : a.key)}
              aria-pressed={bucket === a.key}
              className={clsx(
                'flex min-h-11 w-full flex-col items-start rounded-sm border px-3 py-2 text-left transition-colors disabled:opacity-40',
                bucket === a.key
                  ? 'border-primary bg-primary-soft'
                  : 'border-border bg-surface hover:bg-surface-2',
              )}
            >
              <span className="flex items-center gap-1.5 text-micro text-ink-muted">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: BUCKET_COLOR[a.key] }}
                  aria-hidden
                />
                {a.label}
              </span>
              <span className="tabular text-xs font-semibold text-ink">{money(a.amount)}</span>
              <span className="text-micro text-ink-faint">{plural(a.count, 'factura')}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

function ClientsPanel({
  model: m,
  money,
  selected,
  onSelect,
  onSeeInvoices,
}: {
  model: CarteraModel;
  money: (n: number) => string;
  selected: string | null;
  onSelect: (k: string | null) => void;
  onSeeInvoices: (k: string) => void;
}) {
  const withBalance = m.clients.filter((c) => c.open > 0);
  const top = withBalance.slice(0, 10);
  const rest = withBalance.slice(10);
  const max = Math.max(...top.map((c) => c.open), 1);
  return (
    <Panel className="p-5">
      <SectionTitle
        title="Quién te debe"
        hint={`Los ${Math.min(top.length, 10)} clientes con más saldo. Toca uno para ver sus facturas y abonos.`}
      />
      {top.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">Nadie tiene saldo abierto.</p>
      ) : (
        <ul className="mt-3 space-y-1" aria-label="Clientes con saldo">
          {top.map((c) => (
            <li key={c.key}>
              <ClientRow
                c={c}
                max={max}
                money={money}
                open={selected === c.key}
                onToggle={() => onSelect(selected === c.key ? null : c.key)}
                model={m}
                onSeeInvoices={() => onSeeInvoices(c.key)}
              />
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 ? (
        <p className="mt-3 text-xs text-ink-muted">
          y {plural(rest.length, 'cliente más', 'clientes más')} por{' '}
          {money(rest.reduce((s, c) => s + c.open, 0))}
        </p>
      ) : null}
    </Panel>
  );
}

function ClientRow({
  c,
  max,
  money,
  open,
  onToggle,
  model,
  onSeeInvoices,
}: {
  c: CarteraClient;
  max: number;
  money: (n: number) => string;
  open: boolean;
  onToggle: () => void;
  model: CarteraModel;
  onSeeInvoices: () => void;
}) {
  const w = (n: number) => `${(n / max) * 100}%`;
  return (
    <div className={clsx('rounded-sm', open && 'bg-surface-2')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full rounded-sm px-2 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-xs font-semibold text-ink">{c.name}</span>
          <span className="tabular shrink-0 text-xs font-semibold text-ink">{money(c.open)}</span>
        </span>
        <span className="mt-1.5 flex h-2.5 overflow-hidden rounded-pill bg-border/60" aria-hidden>
          <span className="h-full bg-rose" style={{ width: w(c.overdue) }} />
          <span className="h-full bg-emerald" style={{ width: w(c.current) }} />
          <span className="h-full bg-ink-faint/60" style={{ width: w(c.noTerm) }} />
        </span>
        <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-micro text-ink-muted">
          {c.overdue > 0 ? <span className="text-rose">{money(c.overdue)} vencido</span> : null}
          {c.current > 0 ? <span>{money(c.current)} al día</span> : null}
          {c.noTerm > 0 ? <span>{money(c.noTerm)} sin plazo</span> : null}
          <span>
            {c.avgAgeDays !== null ? `lleva ${c.avgAgeDays} días en promedio` : 'sin antigüedad'}
          </span>
          <span>
            {c.lastPaymentOn
              ? `último pago ${formatDay(c.lastPaymentOn)}`
              : 'sin pagos registrados'}
          </span>
        </span>
      </button>
      {open ? (
        <ClientDetail c={c} model={model} money={money} onSeeInvoices={onSeeInvoices} />
      ) : null}
    </div>
  );
}

function ClientDetail({
  c,
  model: m,
  money,
  onSeeInvoices,
}: {
  c: CarteraClient;
  model: CarteraModel;
  money: (n: number) => string;
  onSeeInvoices: () => void;
}) {
  const invoices = m.invoices.filter((i) => i.clientKey === c.key).slice(0, 6);
  const payments = m.payments.filter((p) => p.clientKey === c.key).slice(0, 5);
  const notes = m.creditNotes.filter((n) => n.clientKey === c.key).slice(0, 4);
  return (
    <div className="space-y-3 border-t border-border px-2 pb-3 pt-3 text-xs">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Stat label="Saldo según las facturas" value={money(c.open)} />
        <Stat
          label="Saldo según la contabilidad"
          value={c.ledgerBalance === null ? 'Aún no disponible' : money(c.ledgerBalance)}
          note={
            c.ledgerDiff === null
              ? null
              : c.ledgerDiff === 0
                ? 'Cuadra'
                : `Diferencia ${money(c.ledgerDiff)}`
          }
        />
        <Stat
          label="Anticipos recibidos"
          value={money(c.advanceReceived)}
          note={c.advancePending > 0 ? `${money(c.advancePending)} sin cruzar` : null}
        />
      </dl>

      <DetailList title="Facturas abiertas" empty="Sin facturas abiertas">
        {invoices.map((i) => (
          <li key={i.id} className="flex items-baseline justify-between gap-3 py-1">
            <span className="min-w-0 truncate">
              <span className="tabular font-semibold text-ink">{i.docNumber}</span>{' '}
              <span className="text-ink-muted">{dueText(i)}</span>
            </span>
            <span className="tabular shrink-0 text-ink">{money(i.balance)}</span>
          </li>
        ))}
      </DetailList>
      <DetailList title="Abonos y anticipos" empty="Sin pagos registrados">
        {payments.map((p) => (
          <li key={p.id} className="flex items-baseline justify-between gap-3 py-1">
            <span className="min-w-0 truncate text-ink-muted">
              {formatDay(p.paidOn)} · {p.number ?? 'Pago'} · {roleText(p)}
            </span>
            <span className="tabular shrink-0 text-ink">{money(p.amount)}</span>
          </li>
        ))}
      </DetailList>
      {notes.length > 0 ? (
        <DetailList title="Notas crédito" empty="">
          {notes.map((n) => (
            <li key={n.number} className="flex items-baseline justify-between gap-3 py-1">
              <span className="min-w-0 truncate text-ink-muted">
                {formatDay(n.date)} · {n.number}
                {n.invoiceNumber ? ` sobre ${n.invoiceNumber}` : ''}
              </span>
              <span className="tabular shrink-0 text-ink">{money(n.amount)}</span>
            </li>
          ))}
        </DetailList>
      ) : null}
      <button
        type="button"
        onClick={onSeeInvoices}
        className="inline-flex min-h-9 items-center rounded-pill border border-border-strong bg-surface px-3.5 text-xs font-semibold text-ink hover:bg-surface-2"
      >
        Ver todas sus facturas abiertas
      </button>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div>
      <dt className="text-micro text-ink-faint">{label}</dt>
      <dd className="tabular mt-0.5 text-xs font-semibold text-ink">{value}</dd>
      {note ? <dd className="text-micro text-ink-muted">{note}</dd> : null}
    </div>
  );
}

function DetailList({
  title,
  empty,
  children,
}: { title: string; empty: string; children: ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div>
      <p className="text-micro font-semibold text-ink-muted">{title}</p>
      {items.length === 0 ? (
        <p className="py-1 text-ink-faint">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">{children}</ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facturado vs cobrado y proyección
// ---------------------------------------------------------------------------

function monthLabel(month: string): string {
  const [y, mm] = month.split('-');
  const name = MONTHS_SHORT[Number(mm) - 1] ?? mm ?? '';
  return mm === '01' ? `${name} ${y?.slice(2)}` : (name ?? '');
}

function MonthlyPanel({ model: m, money }: { model: CarteraModel; money: (n: number) => string }) {
  const hasData = m.monthly.some((x) => x.invoiced > 0 || x.collected > 0);
  return (
    <Panel className="p-5">
      <SectionTitle
        title="Facturado y cobrado por mes"
        hint="Las barras son lo que facturaste; la línea, lo que entró en recibos de caja."
      />
      <div className="mt-3">
        {hasData ? (
          <CartesianChart
            labels={m.monthly.map((x) => monthLabel(x.month))}
            titles={m.monthly.map((x) => {
              const [y, mm] = x.month.split('-');
              return `${MONTHS_SHORT[Number(mm) - 1]} ${y}`;
            })}
            bars={[
              {
                id: 'facturado',
                label: 'Facturado',
                color: CHART_COLOR.primary,
                values: m.monthly.map((x) => x.invoiced),
                dim: [m.monthly.length - 1],
              },
            ]}
            lines={[
              {
                id: 'cobrado',
                label: 'Cobrado',
                color: CHART_COLOR.emerald,
                values: m.monthly.map((x) => x.collected),
                dots: true,
                curve: 'linear',
              },
            ]}
            height={220}
            formatAxis={(n) => formatCompact(n, { money: true })}
            formatValue={money}
            ariaLabel="Facturado y cobrado en los últimos doce meses"
            legend
          />
        ) : (
          <p className="py-8 text-center text-sm text-ink-muted">
            Todavía no hay meses con facturas ni cobros.
          </p>
        )}
      </div>
      <p className="mt-2 text-micro text-ink-faint">
        El mes en curso va más claro porque no ha terminado.
      </p>
    </Panel>
  );
}

function weekLabel(from: string): string {
  const [, mm, dd] = from.split('-');
  return `${Number(dd)} ${MONTHS_SHORT[Number(mm) - 1]}`;
}

function ProjectionPanel({
  model: m,
  money,
  plazoHref,
}: {
  model: CarteraModel;
  money: (n: number) => string;
  plazoHref: (d: number | null) => string;
}) {
  const p = m.projection;
  const labels = ['Ya vencido', ...p.weeks.map((w) => weekLabel(w.from)), 'Después'];
  const dueSoon = p.weeks.reduce((s, w) => s + w.amount, 0);
  const has = p.overdue + dueSoon + p.later > 0;
  return (
    <Panel className="p-5">
      <SectionTitle
        title="Qué se espera cobrar"
        hint="Según la fecha de vencimiento de cada factura, por semana (la semana empieza el lunes)."
      />
      <div className="mt-3">
        {has ? (
          <BarChart
            labels={labels}
            titles={[
              `Ya vencido · ${plural(p.overdueCount, 'factura')}`,
              ...p.weeks.map(
                (w) =>
                  `Vence del ${formatDay(w.from)} al ${formatDay(w.to)} · ${plural(w.count, 'factura')}`,
              ),
              'Más adelante',
            ]}
            bars={[
              {
                id: 'vencido',
                label: 'Ya vencido',
                color: CHART_COLOR.rose,
                values: [p.overdue, ...p.weeks.map(() => 0), 0],
              },
              {
                id: 'por-vencer',
                label: 'Por vencer',
                color: CHART_COLOR.primary,
                values: [0, ...p.weeks.map((w) => w.amount), p.later],
              },
            ]}
            barMode="stacked"
            height={220}
            formatAxis={(n) => formatCompact(n, { money: true })}
            formatValue={money}
            ariaLabel="Cobros esperados por semana según el vencimiento"
          />
        ) : (
          <p className="py-8 text-center text-sm text-ink-muted">
            No hay facturas con fecha de vencimiento por cobrar.
          </p>
        )}
      </div>
      {p.noTerm > 0 ? (
        <p className="mt-2 text-xs text-ink-muted">
          {money(p.noTerm)} ({plural(p.noTermCount, 'factura')}) no tienen plazo y no entran en el
          gráfico.{' '}
          <Link
            href={plazoHref(30)}
            scroll={false}
            className="font-semibold text-primary hover:underline"
          >
            Ver con 30 días
          </Link>
        </p>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Facturas abiertas
// ---------------------------------------------------------------------------

type SortKey = 'due' | 'balance' | 'age' | 'client';

function dueText(i: CarteraInvoice): string {
  if (i.daysOverdue === null)
    return `sin plazo · hace ${i.ageDays} ${i.ageDays === 1 ? 'día' : 'días'}`;
  if (i.daysOverdue > 0)
    return `vencida hace ${i.daysOverdue} ${i.daysOverdue === 1 ? 'día' : 'días'}`;
  if (i.daysOverdue === 0) return 'vence hoy';
  return `vence en ${-i.daysOverdue} ${i.daysOverdue === -1 ? 'día' : 'días'}`;
}

function InvoicesPanel({
  model: m,
  money,
  bucket,
  clientKey,
  onBucket,
  onClient,
}: {
  model: CarteraModel;
  money: (n: number) => string;
  bucket: CarteraBucketKey | null;
  clientKey: string | null;
  onBucket: (b: CarteraBucketKey | null) => void;
  onClient: (k: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('due');
  const [limit, setLimit] = useState(15);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = m.invoices.filter(
      (i) =>
        (!bucket || i.bucket === bucket) &&
        (!clientKey || i.clientKey === clientKey) &&
        (!q || i.docNumber.toLowerCase().includes(q) || i.clientName.toLowerCase().includes(q)),
    );
    const cmp: Record<SortKey, (a: CarteraInvoice, b: CarteraInvoice) => number> = {
      // Lo más vencido primero; las que no tienen plazo, después por antigüedad.
      due: (a, b) => (b.daysOverdue ?? -9999) - (a.daysOverdue ?? -9999) || b.ageDays - a.ageDays,
      balance: (a, b) => b.balance - a.balance,
      age: (a, b) => b.ageDays - a.ageDays,
      client: (a, b) => a.clientName.localeCompare(b.clientName, 'es') || b.balance - a.balance,
    };
    return [...list].sort(cmp[sort]);
  }, [m.invoices, bucket, clientKey, query, sort]);

  const total = rows.reduce((s, i) => s + i.balance, 0);
  const filtered = Boolean(bucket || clientKey || query);
  const clientName = clientKey ? m.clients.find((c) => c.key === clientKey)?.name : null;

  return (
    <Panel className="scroll-mt-24 overflow-hidden" id="facturas-abiertas">
      <div className="space-y-3 p-5 pb-3">
        <SectionTitle
          title="Facturas abiertas"
          hint={`${plural(rows.length, 'factura')} por ${money(total)}${filtered ? ' con los filtros puestos' : ''}.`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por cliente o número"
            aria-label="Buscar facturas por cliente o número"
            className="min-h-10 w-full rounded-pill border border-border bg-surface px-4 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:w-72"
          />
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            Ordenar por
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="min-h-10 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            >
              <option value="due">Más vencida</option>
              <option value="balance">Saldo</option>
              <option value="age">Más antigua</option>
              <option value="client">Cliente</option>
            </select>
          </label>
          {bucket ? (
            <FilterChip label={BUCKET_LABEL[bucket]} onClear={() => onBucket(null)} />
          ) : null}
          {clientName ? <FilterChip label={clientName} onClear={() => onClient(null)} /> : null}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 pb-6 pt-2 text-sm text-ink-muted">
          Ninguna factura abierta con esos filtros.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border border-t border-border">
            {rows.slice(0, limit).map((i) => (
              <li
                key={i.id}
                className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="tabular text-xs font-semibold text-ink">{i.docNumber}</span>
                    <span className="min-w-0 truncate text-xs text-ink-muted">{i.clientName}</span>
                  </p>
                  <p className="mt-0.5 text-micro text-ink-faint">
                    Expedida {formatDay(i.issuedOn)}
                    {i.dueOn ? ` · vence ${formatDay(i.dueOn)}` : ''}
                    {i.dueBasis === 'plazo_cliente' ? ' (plazo del cliente)' : ''}
                    {i.dueBasis === 'plazo_supuesto' ? ' (plazo por defecto)' : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={chipClass(
                      i.bucket === 'current'
                        ? 'emerald'
                        : i.bucket === 'no_term'
                          ? 'neutral'
                          : i.bucket === 'd1_30'
                            ? 'amber'
                            : 'rose',
                    )}
                  >
                    {dueText(i)}
                  </span>
                  {i.einvoice ? (
                    <span
                      className={chipClass(
                        i.einvoice === 'Aceptada'
                          ? 'emerald'
                          : i.einvoice === 'Rechazada'
                            ? 'rose'
                            : 'amber',
                      )}
                      title="Estado ante la DIAN"
                    >
                      DIAN: {i.einvoice}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-3 sm:justify-end">
                  <span className="tabular text-xs font-semibold text-ink">{money(i.balance)}</span>
                  {i.url ? (
                    <a
                      href={i.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Abrir el PDF de ${i.docNumber}`}
                      className="inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-pill border border-border px-2.5 text-micro font-semibold text-ink-muted hover:bg-surface-2"
                    >
                      <FileText className="h-3.5 w-3.5" aria-hidden />
                      PDF
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {rows.length > limit ? (
            <div className="border-t border-border p-3 text-center">
              <button
                type="button"
                onClick={() => setLimit((l) => l + 25)}
                className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-4 text-xs font-semibold text-ink hover:bg-surface-2"
              >
                Mostrar 25 más ({rows.length - limit} sin ver)
              </button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-primary/25 bg-primary-soft px-3 text-xs font-semibold text-primary-ink"
      aria-label={`Quitar el filtro ${label}`}
    >
      {label}
      <span aria-hidden>×</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Pagos recientes
// ---------------------------------------------------------------------------

function roleText(p: CarteraPayment): string {
  if (p.role === 'invoice') return `abonó a ${p.invoiceNumber}`;
  if (p.role === 'reversal') return 'anulación';
  if (p.role === 'unmatched') return 'sin emparejar';
  if (p.advanceStatus === 'crossed') return 'anticipo, ya cruzado en Siigo';
  if (p.advanceStatus === 'partial') return 'anticipo, cruzado en parte';
  if (p.advanceStatus === 'pending') return 'anticipo por cruzar';
  return 'anticipo';
}

function PaymentsPanel({
  model: m,
  money,
  actions,
}: {
  model: CarteraModel;
  money: (n: number) => string;
  actions: CarteraActions;
}) {
  const [limit, setLimit] = useState(8);
  const shown = m.payments.slice(0, limit);
  return (
    <Panel className="overflow-hidden" id="pagos-recientes">
      <div className="p-5 pb-3">
        <SectionTitle
          title="Pagos recientes"
          hint="Cada recibo y a qué factura se aplicó. Un anticipo no paga una factura concreta: se cruza después."
        />
        {m.unmatched.count > 0 ? (
          <p className="mt-2 rounded-sm bg-amber-soft px-3 py-2 text-xs text-ink">
            {plural(m.unmatched.count, 'pago', 'pagos')} por {money(m.unmatched.amount)} no dicen a
            qué factura iban. Cortex sugiere la factura abierta más antigua del cliente, pero no la
            aplica sola.
          </p>
        ) : null}
      </div>
      {m.payments.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-ink-muted">Todavía no hay pagos registrados.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((p) => (
            <PaymentRow key={p.id} p={p} model={m} money={money} actions={actions} />
          ))}
        </ul>
      )}
      {m.payments.length > limit ? (
        <div className="border-t border-border p-3 text-center">
          <button
            type="button"
            onClick={() => setLimit((l) => l + 15)}
            className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-4 text-xs font-semibold text-ink hover:bg-surface-2"
          >
            Mostrar más ({m.payments.length - limit} sin ver)
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

function PaymentRow({
  p,
  model: m,
  money,
  actions,
}: {
  p: CarteraPayment;
  model: CarteraModel;
  money: (n: number) => string;
  actions: CarteraActions;
}) {
  const options = useMemo(
    () => (p.clientKey ? m.invoices.filter((i) => i.clientKey === p.clientKey).slice(0, 40) : []),
    [m.invoices, p.clientKey],
  );
  const [choice, setChoice] = useState(p.suggestion?.invoiceId ?? options[0]?.id ?? '');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const tone =
    p.role === 'invoice'
      ? 'emerald'
      : p.role === 'unmatched'
        ? 'amber'
        : p.role === 'reversal'
          ? 'rose'
          : p.advanceStatus === 'pending'
            ? 'primary'
            : 'neutral';

  function pair() {
    const inv = options.find((o) => o.id === choice);
    if (!inv) return;
    setResult(null);
    start(async () => {
      const r = await actions.match({ paymentId: p.id, kind: inv.kind, invoiceId: inv.id });
      setResult({
        ok: r.ok,
        text: r.ok ? (r.note ?? 'Emparejado.') : (r.error ?? 'No se pudo emparejar.'),
      });
    });
  }

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 text-xs">
          <span className="tabular font-semibold text-ink">{p.number ?? 'Pago'}</span>{' '}
          <span className="text-ink-muted">
            · {p.clientName ?? 'Sin cliente identificado'} · {formatDay(p.paidOn)}
          </span>
        </p>
        <span className="tabular text-xs font-semibold text-ink">{money(p.amount)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className={chipClass(tone)}>{roleText(p)}</span>
      </div>
      {p.role === 'unmatched' && options.length > 0 && !result?.ok ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`emp-${p.id}`}>
            Factura a la que fue este pago
          </label>
          <select
            id={`emp-${p.id}`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="min-h-10 min-w-0 max-w-full flex-1 rounded-pill border border-border bg-surface px-3 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:flex-none sm:basis-96"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.docNumber} · {money(o.balance)}
                {p.suggestion?.invoiceId === o.id ? ' · sugerida (la más antigua)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={pair}
            disabled={pending || !choice}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-bold text-white transition-colors hover:bg-primary-strong disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Emparejar
          </button>
        </div>
      ) : null}
      {result ? (
        <p
          className={clsx(
            'mt-2 rounded-sm px-3 py-1.5 text-xs',
            result.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {result.text}
        </p>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Cómo se suma
// ---------------------------------------------------------------------------

function HowItAdds({
  model: m,
  money,
  sentence,
}: { model: CarteraModel; money: (n: number) => string; sentence?: string }) {
  const r = m.reconciliation;
  return (
    <details className="group rounded-card border border-border bg-surface shadow-card">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-bold text-ink [&::-webkit-details-marker]:hidden">
        Cómo se calcula esto
        <ChevronDown
          className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="space-y-3 border-t border-border px-5 py-4 text-xs leading-relaxed text-ink-muted">
        <p>
          <strong className="text-ink">Por cobrar</strong> es la suma de lo que Siigo dice que falta
          en cada factura abierta. Siigo ya descuenta los recibos aplicados, los anticipos cruzados
          y las notas crédito, así que Cortex no los resta otra vez. Las cuentas cuadran así:{' '}
          <span className="tabular text-ink">
            facturado {money(r.invoiced)} = por cobrar {money(r.open)} + abonado o cruzado{' '}
            {money(r.cashApplied)} + notas crédito {money(r.creditNotes)}
          </span>
          .
        </p>
        <p>
          <strong className="text-ink">Vencido</strong> usa el plazo que trae la factura. Si Siigo
          no trae plazo, se usa el del cliente; si tampoco existe, la factura queda «sin plazo» y no
          se declara vencida.
        </p>
        <p>
          <strong className="text-ink">Días promedio de cobro</strong> es lo que te deben dividido
          entre lo facturado en los últimos 90 días, por 90. Menos días es mejor.
        </p>
        <p>
          <strong className="text-ink">Las comparaciones con hace 30 días</strong> son estimadas:
          Siigo no guarda el historial de saldos, así que se reconstruyen con las fechas de factura
          y de pago.
        </p>
        {m.ledgerCheck ? (
          <p>
            <strong className="text-ink">Contra la contabilidad</strong> (cuenta 1305,{' '}
            {m.ledgerCheck.period}): Siigo dice {money(m.ledgerCheck.ledger)} y las facturas suman{' '}
            {money(m.ledgerCheck.invoices)}
            {m.ledgerCheck.diff === 0
              ? ': cuadra.'
              : `: diferencia de ${money(m.ledgerCheck.diff)}.`}
          </p>
        ) : (
          <p>
            <strong className="text-ink">Contra la contabilidad:</strong> todavía no llegan los
            saldos por tercero de Siigo, así que no se puede cuadrar la cuenta 1305 contra estas
            facturas.
          </p>
        )}
        {sentence ? (
          <p>
            <strong className="text-ink">Lo que Cortex dice en el chat:</strong> {sentence}
          </p>
        ) : null}
        {m.otherCurrencies.length > 0 ? (
          <p>
            Hay facturas en otras monedas que no se mezclan con esta cifra:{' '}
            {m.otherCurrencies
              .map((o) => `${formatMoney(o.open, o.currency)} (${plural(o.count, 'factura')})`)
              .join(', ')}
            .
          </p>
        ) : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="text-base font-bold text-ink">{title}</h2>
      {hint ? <p className="mt-0.5 text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n, 0)} ${n === 1 ? one : many}`;
}

function EmptyCartera({ askHref }: { askHref: string }) {
  return (
    <Panel className="px-5 py-10 text-center">
      <p className="text-base font-semibold text-ink">Todavía no hay cartera que mostrar</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
        Conecta tu programa contable o sube tus facturas y Cortex calcula quién te debe, desde
        cuándo y cuánto vas a cobrar cada semana.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link
          href="/integrations#programas-contables"
          className="inline-flex min-h-10 items-center rounded-pill bg-primary px-5 py-2 text-sm font-bold text-white hover:bg-primary-strong"
        >
          Conectar Siigo, Alegra o QuickBooks
        </Link>
        <Link
          href={askHref}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-5 py-2 text-sm font-bold text-ink hover:bg-surface-2"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          Pregúntale a Cortex
        </Link>
      </div>
    </Panel>
  );
}

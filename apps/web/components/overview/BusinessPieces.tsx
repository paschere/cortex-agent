/**
 * Las piezas del negocio de una empresa, compartidas por el centro de mando
 * (/overview, componente de cliente) y la ficha de cada empresa
 * (/overview/companies/[id], componente de servidor). Sin estado ni efectos,
 * para que sirvan en los dos lados; las reglas viven en founder-business-shape.ts.
 *
 * «Sin dato» se dice con esas palabras: una cifra que no se pudo leer nunca se
 * pinta como cero.
 */

import {
  type ActionItem,
  type CompanyBusiness,
  type CompanyStatus,
  cashIsTight,
  cashWeeksLabel,
  compactCop,
  daysSince,
  fullCop,
  initialsOf,
  inkOn,
  otherCurrency,
} from '@/lib/founder-business-shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ArrowRight } from 'lucide-react';
import { OpenWorkspace } from './OpenWorkspace';

/* ------------------------------------------------------------------------- */

export function BrandMark({
  name,
  brand,
  size = 'md',
}: {
  name: string;
  brand: CompanyBusiness['brand'] | undefined;
  size?: 'sm' | 'md' | 'lg';
}) {
  const box =
    size === 'lg'
      ? 'h-12 w-12 text-base'
      : size === 'sm'
        ? 'h-8 w-8 text-micro'
        : 'h-10 w-10 text-sm';
  if (brand?.logoUrl)
    return (
      <span
        className={clsx(
          'grid shrink-0 place-items-center overflow-hidden rounded-sm border border-border bg-surface',
          box,
        )}
      >
        {/* El logo sale de la ruta con sesión de ESA empresa; sin optimizador a propósito. */}
        <img src={brand.logoUrl} alt="" className="h-full w-full object-contain p-1" />
      </span>
    );
  const color = brand?.color ?? null;
  return (
    <span
      aria-hidden
      className={clsx(
        'grid shrink-0 place-items-center rounded-sm font-extrabold tracking-tight',
        box,
        !color && 'bg-primary-soft text-primary-ink',
      )}
      style={color ? { backgroundColor: color, color: inkOn(color) } : undefined}
    >
      {initialsOf(name)}
    </span>
  );
}

/* ------------------------------------------------------------------------- */

const DOT = {
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  rose: 'bg-rose',
  neutral: 'bg-ink-faint',
} as const;

export function StatusChip({ status }: { status: CompanyStatus | null }) {
  if (!status)
    return (
      <span className="inline-block h-6 w-20 animate-pulse rounded-pill bg-surface-2">
        <span className="sr-only">Leyendo…</span>
      </span>
    );
  return (
    <span className={chipClass(status.tone)} title={status.reasons.join(' · ') || undefined}>
      <span aria-hidden className={clsx('h-1.5 w-1.5 rounded-full', DOT[status.tone])} />
      {status.label}
    </span>
  );
}

/* ------------------------------------------------------------------------- */

const NO_DATA = 'Sin dato';

function Skeleton({ className }: { className?: string }) {
  return <span className={clsx('block animate-pulse rounded-sm bg-surface-2', className)} />;
}

function Figure({
  label,
  value,
  sub,
  tone,
  title,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'rose' | 'amber' | 'emerald' | 'muted';
  title?: string;
  loading?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-micro text-ink-faint">{label}</dt>
      {loading ? (
        <dd className="mt-1.5 space-y-1.5">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-3 w-24" />
        </dd>
      ) : (
        <dd className="mt-0.5 min-w-0">
          <span
            title={title}
            className={clsx(
              // «Sin dato» es prosa, no una cifra: va en la letra del texto.
              'block truncate text-base font-semibold',
              value !== NO_DATA && 'tabular',
              tone === 'rose' && 'text-rose',
              tone === 'amber' && 'text-amber',
              tone === 'emerald' && 'text-emerald',
              tone === 'muted' && 'text-ink-faint',
              !tone && 'text-ink',
            )}
          >
            {value}
          </span>
          {sub && <span className="block truncate text-micro text-ink-faint">{sub}</span>}
        </dd>
      )}
    </div>
  );
}

/**
 * Las siete cifras del negocio de una empresa propia. `business` es `undefined`
 * mientras llega (esqueleto) y `null` si la empresa entera no respondió.
 */
export function BusinessFacts({
  business,
  decisions,
  now,
  columns = 'card',
}: {
  business: CompanyBusiness | null | undefined;
  /** Decisiones que esperan a quien mira (del pulso, llega antes). `null`: sin lectura. */
  decisions: number | null;
  now: Date;
  columns?: 'card' | 'wide';
}) {
  const loading = business === undefined;
  const b = business ?? null;
  const risk = b?.risk ?? null;
  const recovered = b?.recovered ?? null;
  const cash = b?.cash ?? null;
  const waited = daysSince(b?.oldestDecisionAt ?? null, now);

  const riskOthers = risk?.others.map((o) => otherCurrency(o.amount, o.currency)).join(' · ');
  const riskSub = risk
    ? risk.overdueInvoices > 0
      ? `${risk.overdueInvoices} ${risk.overdueInvoices === 1 ? 'factura vencida' : 'facturas vencidas'}`
      : risk.total > 0
        ? 'Pagos y multas por atender'
        : riskOthers
          ? 'Cartera en otra moneda'
          : 'Nada vencido'
    : 'No se pudo leer';

  return (
    <dl
      className={clsx(
        'grid gap-x-4 gap-y-3',
        columns === 'wide'
          ? 'grid-cols-2 sm:grid-cols-4 xl:grid-cols-7'
          : 'grid-cols-2 sm:grid-cols-3',
      )}
    >
      <Figure
        label="Caja"
        loading={loading}
        value={cash ? compactCop(cash.today) : NO_DATA}
        title={
          cash
            ? `${fullCop(cash.today)} hoy · lo más bajo: ${fullCop(cash.lowest.closing)} la semana del ${cash.lowest.week}`
            : undefined
        }
        tone={!cash ? 'muted' : cash.today < 0 || cashIsTight(cash) ? 'rose' : undefined}
        sub={
          cash
            ? `Semanas de caja: ${cashWeeksLabel(cash)}`
            : b?.ledger === false
              ? 'Sube un extracto'
              : 'No se pudo leer'
        }
      />
      <Figure
        label="Plata en riesgo"
        loading={loading}
        value={risk ? (risk.total > 0 ? compactCop(risk.total) : riskOthers || '$ 0') : NO_DATA}
        title={risk && risk.total > 0 ? fullCop(risk.total) : undefined}
        tone={
          !risk
            ? 'muted'
            : risk.receivablesOverdue > 0 || risk.paymentsOverdue > 0
              ? 'rose'
              : undefined
        }
        sub={riskOthers && risk && risk.total > 0 ? `+ ${riskOthers}` : riskSub}
      />
      <Figure
        label="Recuperado este mes"
        loading={loading}
        value={recovered ? compactCop(recovered.month) : NO_DATA}
        title={recovered ? fullCop(recovered.month) : undefined}
        tone={!recovered ? 'muted' : recovered.month > 0 ? 'emerald' : undefined}
        sub={
          recovered
            ? recovered.monthInvoices > 0
              ? `${recovered.monthInvoices} ${recovered.monthInvoices === 1 ? 'factura' : 'facturas'} con Cortex`
              : recovered.total > 0
                ? `${compactCop(recovered.total)} en total`
                : 'Aún nada este mes'
            : 'No se pudo leer'
        }
      />
      <Figure
        label="Ventas del mes"
        loading={loading}
        value={b?.sales ? compactCop(b.sales.month) : NO_DATA}
        title={b?.sales ? fullCop(b.sales.month) : undefined}
        tone={b?.sales ? undefined : 'muted'}
        sub={
          b?.sales
            ? b.sales.previous !== null
              ? `Mes pasado: ${compactCop(b.sales.previous)}`
              : 'Sin mes anterior'
            : b?.pulseView
              ? 'El pulso aún no la trae'
              : 'Activa su pulso'
        }
      />
      <Figure
        label="Decisiones"
        value={decisions === null ? NO_DATA : decisions.toLocaleString('es-CO')}
        tone={
          decisions === null ? 'muted' : decisions > 0 && (waited ?? 0) >= 2 ? 'amber' : undefined
        }
        sub={
          decisions === null
            ? 'No se pudo leer'
            : decisions === 0
              ? 'Nada te espera'
              : waited === null
                ? 'Te esperan'
                : waited === 0
                  ? 'Esperan desde hoy'
                  : waited === 1
                    ? 'Esperan desde ayer'
                    : `Esperan hace ${waited} días`
        }
      />
      <Figure
        label="Procesos con error"
        loading={loading}
        value={b?.failing ? b.failing.total.toLocaleString('es-CO') : NO_DATA}
        tone={!b?.failing ? 'muted' : b.failing.total > 0 ? 'amber' : undefined}
        sub={
          b?.failing
            ? b.failing.total === 0
              ? 'Todo andando'
              : [
                  b.failing.routines > 0 &&
                    `${b.failing.routines} ${b.failing.routines === 1 ? 'rutina' : 'rutinas'}`,
                  b.failing.syncs > 0 &&
                    `${b.failing.syncs} ${b.failing.syncs === 1 ? 'sincronización' : 'sincronizaciones'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
            : 'No se pudo leer'
        }
      />
      <Figure
        label="Puesta en marcha"
        loading={loading}
        value={b?.setup ? `${b.setup.percent} %` : NO_DATA}
        tone={!b?.setup ? 'muted' : b.setup.percent === 100 ? 'emerald' : undefined}
        sub={
          b?.setup ? (
            b.setup.percent === 100 ? (
              'Completa'
            ) : (
              <span className="flex items-center gap-2">
                <span
                  className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-surface-2"
                  aria-hidden
                >
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(b.setup.percent, 4)}%` }}
                  />
                </span>
                <span className="truncate">
                  {b.setup.ready} de {b.setup.total} pasos
                </span>
              </span>
            )
          ) : (
            'No se pudo leer'
          )
        }
      />
    </dl>
  );
}

/* ------------------------------------------------------------------------- */

const ITEM_DOT: Record<ActionItem['tone'], string> = {
  rose: 'bg-rose',
  amber: 'bg-amber',
  primary: 'bg-primary',
  neutral: 'bg-ink-faint',
};

/** «Dónde actuar hoy»: la lista corta, cada renglón con su botón a ESA empresa. */
export function ActNowList({
  items,
  loading,
  showCompany = true,
}: {
  items: ActionItem[];
  loading: boolean;
  /** En la ficha de UNA empresa, repetir su nombre en cada renglón sobra. */
  showCompany?: boolean;
}) {
  if (loading)
    return (
      <ul className="space-y-2" aria-busy>
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 rounded-sm bg-surface-2/60 px-3 py-3">
            <Skeleton className="h-2 w-2 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-7 w-20 rounded-pill" />
          </li>
        ))}
      </ul>
    );
  if (items.length === 0)
    return (
      <p className="rounded-sm bg-surface-2/60 px-3 py-4 text-sm text-ink-muted">
        Nada urgente hoy en tus empresas. Cuando algo se venza, se caiga o te espere, aparece aquí
        primero.
      </p>
    );
  return (
    <ol className="space-y-1.5">
      {items.map((item, index) => (
        <li
          key={item.id}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-sm bg-surface-2/60 px-3 py-2.5"
        >
          <span className="tabular w-4 shrink-0 text-center text-micro text-ink-faint">
            {index + 1}
          </span>
          <span
            aria-hidden
            className={clsx('h-2 w-2 shrink-0 rounded-full', ITEM_DOT[item.tone])}
          />
          <p className="min-w-[12rem] flex-1 text-sm leading-snug">
            {showCompany ? (
              <>
                <span className="font-bold text-ink">{item.companyName}:</span>{' '}
                <span className="text-ink-muted">{item.text}</span>
              </>
            ) : (
              <span className="font-semibold text-ink">
                {item.text.charAt(0).toUpperCase() + item.text.slice(1)}
              </span>
            )}
          </p>
          <OpenWorkspace
            workspaceId={item.companyId}
            href={item.path}
            className={clsx(
              'ml-auto inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-pill px-3.5 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60',
              index === 0
                ? 'bg-primary text-white shadow-pop hover:bg-primary-strong'
                : 'border border-border bg-surface text-ink hover:border-border-strong',
            )}
          >
            {item.cta}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </OpenWorkspace>
        </li>
      ))}
    </ol>
  );
}

'use client';

/**
 * El centro de mando del fundador: cómo va cada negocio y dónde actuar hoy.
 *
 * ===========================================================================
 * QUÉ CAMBIÓ Y POR QUÉ (2026-10)
 * ===========================================================================
 * La versión anterior era, sobre todo, administración de Cortex: plan,
 * asientos, cupo de respuestas, integraciones, rutinas. Útil una vez al mes.
 * Quien dirige varias empresas abre esta pantalla para saber CÓMO VA CADA
 * NEGOCIO y A CUÁL ENTRAR, así que ahora el orden es ése:
 *
 *  1. Totales grandes entre las empresas propias: plata en riesgo, recuperado
 *     este mes, decisiones que esperan, procesos con error y cuántas empresas
 *     piden atención.
 *  2. «Dónde actuar hoy»: las cinco cosas más importantes entre todas, cada
 *     una con su botón a ESA empresa (founder-business-shape.ts las ordena).
 *  3. Una tarjeta por empresa con su marca, su estado en palabras («Al día»,
 *     «Pide atención», «Sin datos todavía») y sus cifras de negocio.
 *  4. Plan y uso, plegado al final (PlanAndUse.tsx).
 *
 * ===========================================================================
 * LO RÁPIDO PRIMERO, LAS CIFRAS DESPUÉS
 * ===========================================================================
 * Los pendientes y la salud del plan llegan con la página. Las cifras de
 * negocio (cartera, recuperado, ventas, procesos) cuestan más —son una docena
 * de lecturas por empresa— y llegan como una promesa que el servidor sigue
 * resolviendo mientras la página ya se ve (overview/page.tsx). Mientras tanto,
 * esqueletos; si una empresa no responde, «sin dato», nunca un cero.
 *
 * Dos vistas del mismo dato —tarjetas para leer, tabla para comparar— y un
 * filtro por grupo empresarial. La vista elegida se recuerda en este
 * navegador; en el teléfono siempre son tarjetas, que una tabla de nueve
 * columnas no cabe.
 */

import {
  type BusinessMap,
  type CompanyBusiness,
  businessTotals,
  compactCop,
  companyStatus,
  fullCop,
  otherCurrency,
  pulseHref,
  rankActionItems,
} from '@/lib/founder-business-shape';
import { type ConsoleRow, type GroupFilter, filterRows } from '@/lib/founder-console-shape';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Bell,
  CalendarClock,
  CircleAlert,
  Gauge,
  Home,
  LayoutGrid,
  List,
  LockKeyhole,
  Send,
  Settings2,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ActNowList, BrandMark, BusinessFacts, StatusChip } from './BusinessPieces';
import { OpenWorkspace } from './OpenWorkspace';
import { PlanAndUse } from './PlanAndUse';

type View = 'grid' | 'table';
const VIEW_KEY = 'cortex:founder-console:view';

type BusinessSource = Promise<BusinessMap> | BusinessMap | null;

function isPromise(value: BusinessSource): value is Promise<BusinessMap> {
  return !!value && typeof (value as Promise<BusinessMap>).then === 'function';
}

/**
 * Las cifras de negocio cuando lleguen. Tras un `router.refresh()` llega una
 * promesa nueva: se conservan las cifras anteriores hasta que la nueva
 * resuelva, para que las tarjetas no parpadeen a esqueleto.
 */
function useBusiness(source: BusinessSource): { business: BusinessMap | null; loading: boolean } {
  const [state, setState] = useState<{ business: BusinessMap | null; loading: boolean }>(() =>
    isPromise(source) ? { business: null, loading: true } : { business: source, loading: false },
  );
  useEffect(() => {
    if (!isPromise(source)) {
      setState({ business: source, loading: false });
      return;
    }
    let alive = true;
    source.then(
      (business) => {
        if (alive) setState({ business, loading: false });
      },
      () => {
        // El servidor nunca la rechaza (founder-business.ts); si pasara, cada
        // cifra dice «sin dato» en vez de quedarse cargando para siempre.
        if (alive) setState({ business: {}, loading: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [source]);
  return state;
}

function roleLabel(role: ConsoleRow['role']) {
  if (role === 'owner') return 'Fundador';
  if (role === 'admin') return 'Gerente';
  return 'Colaborador';
}

const signals = [
  { key: 'approvals', label: 'Aprobaciones', Icon: ShieldCheck },
  { key: 'actions', label: 'Acciones', Icon: Send },
  { key: 'deadlines', label: 'Vencimientos', Icon: CalendarClock },
  { key: 'blocked', label: 'Bloqueos', Icon: CircleAlert },
] as const;

const PRIMARY_PILL =
  'inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-bold text-white transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60';
const QUIET_PILL =
  'inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const ICON_PILL =
  'grid h-9 w-9 shrink-0 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

/* ------------------------------------------------------------------------- */
/* Totales                                                                   */
/* ------------------------------------------------------------------------- */

function Tile({
  label,
  value,
  caption,
  tone,
  loading,
  title,
  className,
}: {
  label: string;
  value: React.ReactNode;
  caption: React.ReactNode;
  tone?: 'rose' | 'amber' | 'emerald';
  loading?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <div className={clsx('min-w-0 px-4 py-4 sm:px-5 sm:py-5', className)}>
      <p className="truncate text-xs font-semibold text-ink-muted">{label}</p>
      {loading ? (
        <span className="mt-3 block h-9 w-28 animate-pulse rounded-sm bg-surface-2" />
      ) : (
        <p
          title={title}
          className={clsx(
            'stat-num mt-2 truncate text-xl sm:text-display',
            tone === 'rose' && 'text-rose',
            tone === 'amber' && 'text-amber',
            tone === 'emerald' && 'text-emerald',
            !tone && 'text-ink',
          )}
        >
          {value}
        </p>
      )}
      <p className="mt-1 line-clamp-2 text-micro text-ink-faint sm:truncate">
        {loading ? 'Leyendo…' : caption}
      </p>
    </div>
  );
}

function missingNote(missing: number): string {
  return missing === 1 ? 'sin dato de 1 empresa' : `sin dato de ${missing} empresas`;
}

function TotalsBand({
  rows,
  business,
  loading,
  companies,
}: {
  rows: ConsoleRow[];
  business: BusinessMap | null;
  loading: boolean;
  companies: number;
}) {
  const now = useMemo(() => new Date(), []);
  const t = useMemo(() => businessTotals(rows, business, now), [rows, business, now]);
  const owned = t.owned > 0;
  const others = t.riskOthers.map((o) => otherCurrency(o.amount, o.currency)).join(' · ');
  const tiles = [
    owned && (
      <Tile
        key="risk"
        label="Plata en riesgo"
        loading={loading}
        value={t.riskMissing === t.owned ? 'Sin dato' : compactCop(t.riskCop)}
        title={fullCop(t.riskCop)}
        tone={t.riskCop > 0 ? 'rose' : undefined}
        caption={
          [others && `+ ${others}`, t.riskMissing > 0 && missingNote(t.riskMissing)]
            .filter(Boolean)
            .join(' · ') || 'Cartera vencida, pagos y multas'
        }
      />
    ),
    owned && (
      <Tile
        key="recovered"
        label="Recuperado este mes"
        loading={loading}
        value={t.recoveredMissing === t.owned ? 'Sin dato' : compactCop(t.recoveredCop)}
        title={fullCop(t.recoveredCop)}
        tone={t.recoveredCop > 0 ? 'emerald' : undefined}
        caption={
          t.recoveredMissing > 0
            ? missingNote(t.recoveredMissing)
            : 'Pagos que llegaron tras avisar'
        }
      />
    ),
    <Tile
      key="decisions"
      label="Decisiones pendientes"
      value={t.decisions.toLocaleString('es-CO')}
      tone={t.decisions > 0 ? 'amber' : undefined}
      caption="Te esperan en todos tus espacios"
    />,
    owned && (
      <Tile
        key="failing"
        label="Procesos con error"
        loading={loading}
        value={t.failingMissing === t.owned ? 'Sin dato' : t.failing.toLocaleString('es-CO')}
        tone={t.failing > 0 ? 'amber' : undefined}
        caption={
          t.failingMissing > 0 ? missingNote(t.failingMissing) : 'Rutinas y sincronizaciones'
        }
      />
    ),
    <Tile
      key="attention"
      label="Empresas que piden atención"
      loading={loading && owned}
      value={
        <>
          {t.attention}
          <span className="text-lg text-ink-faint sm:text-xl"> / {companies}</span>
        </>
      }
      tone={t.attention > 0 ? 'amber' : 'emerald'}
      caption={t.attention > 0 ? 'Mira «Dónde actuar hoy»' : 'Todas al día'}
    />,
  ].filter(Boolean);

  return (
    <section
      aria-label="Tus empresas hoy"
      className={clsx(
        'grid overflow-hidden rounded-card border border-border bg-surface shadow-card',
        'grid-cols-2 [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1',
        tiles.length === 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-2',
        'divide-x divide-y divide-border lg:divide-y-0',
      )}
    >
      {tiles}
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Tarjeta                                                                   */
/* ------------------------------------------------------------------------- */

function CompanyCard({
  row,
  business,
  loading,
  groupName,
  now,
}: {
  row: ConsoleRow;
  business: CompanyBusiness | null | undefined;
  loading: boolean;
  groupName: string | null;
  now: Date;
}) {
  const personal = row.kind === 'personal';
  const status =
    row.owned && loading && business === undefined ? null : companyStatus(row, business, now);
  const decisions = row.pulse.status === 'ready' ? row.pulse.approvals + row.pulse.actions : null;
  const sub = personal
    ? 'Espacio personal · Solo tú'
    : [groupName, roleLabel(row.role)].filter(Boolean).join(' · ');

  return (
    <article
      className={clsx(
        'flex min-w-0 flex-col overflow-hidden rounded-card border bg-surface shadow-card',
        row.active ? 'border-primary/40' : 'border-border',
      )}
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        {personal ? (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
            <Home className="h-4 w-4" aria-hidden />
          </span>
        ) : (
          <BrandMark name={row.name} brand={business?.brand} />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-bold text-ink">
            {row.owned ? (
              <Link
                href={`/overview/companies/${encodeURIComponent(row.id)}`}
                className="hover:text-primary"
              >
                {row.name}
              </Link>
            ) : (
              row.name
            )}
          </h3>
          <p className="mt-0.5 truncate text-xs text-ink-faint">
            {sub}
            {row.active ? ' · en esta pestaña' : ''}
          </p>
        </div>
        <StatusChip status={status} />
      </header>

      {status && status.reasons.length > 0 && (
        <p
          className={clsx(
            'mx-4 mb-3 line-clamp-2 rounded-sm px-3 py-2 text-xs leading-snug',
            status.tone === 'rose' && 'bg-rose-soft text-rose',
            status.tone === 'amber' && 'bg-amber-soft text-amber',
            status.tone === 'neutral' && 'bg-surface-2 text-ink-muted',
            status.tone === 'emerald' && 'bg-emerald-soft text-emerald',
          )}
        >
          {status.reasons.join(' · ')}
        </p>
      )}

      {row.owned ? (
        <div className="border-t border-border px-4 py-4">
          <BusinessFacts
            business={loading && business === undefined ? undefined : (business ?? null)}
            decisions={decisions}
            now={now}
          />
        </div>
      ) : row.pulse.status === 'ready' ? (
        <dl className="grid grid-cols-4 border-t border-border">
          {signals.map(({ key, label, Icon }, index) => (
            <div
              key={key}
              className={clsx('min-w-0 px-3 py-3', index > 0 && 'border-l border-border')}
            >
              <dt className="flex items-center gap-1 text-micro text-ink-faint">
                <Icon className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
              </dt>
              <dd className="tabular mt-1 text-lg font-semibold text-ink">
                {row.pulse[key] ?? '—'}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="border-t border-border px-4 py-4 text-xs leading-relaxed text-ink-muted">
          Cortex no pudo leer este espacio ahora. Los demás siguen separados y disponibles.
        </p>
      )}

      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
        <OpenWorkspace workspaceId={row.id} href="/dashboard" className={PRIMARY_PILL}>
          Entrar <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </OpenWorkspace>
        {row.owned ? (
          <>
            <a
              href={pulseHref(row.id, row.name, business?.pulseView ?? null)}
              className={QUIET_PILL}
            >
              <Gauge className="h-3.5 w-3.5" aria-hidden />
              <span className="sm:hidden">Pulso</span>
              <span className="hidden sm:inline">Ver su pulso</span>
            </a>
            <a href={workspaceHref(row.id, '/admin/users')} className={QUIET_PILL}>
              <UserPlus className="h-3.5 w-3.5" aria-hidden /> Invitar
            </a>
            <Link
              href={`/overview/companies/${encodeURIComponent(row.id)}`}
              aria-label={`Administrar ${row.name}`}
              title="Ficha, nombre y equipo"
              className={clsx(ICON_PILL, 'ml-auto')}
            >
              <Settings2 className="h-4 w-4" aria-hidden />
            </Link>
          </>
        ) : (
          <span className="ml-auto px-2 text-micro text-ink-faint">
            {personal ? 'Cerebro propio de tu espacio' : 'Lo administra su fundador'}
          </span>
        )}
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------------------- */
/* Tabla                                                                     */
/* ------------------------------------------------------------------------- */

function Cell({
  value,
  sub,
  tone,
  loading,
}: {
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'rose' | 'amber' | 'emerald' | 'muted';
  loading?: boolean;
}) {
  if (loading)
    return <span className="ml-auto block h-4 w-16 animate-pulse rounded-sm bg-surface-2" />;
  return (
    <>
      <span
        className={clsx(
          'block font-semibold',
          value !== 'Sin dato' && 'tabular',
          tone === 'rose' && 'text-rose',
          tone === 'amber' && 'text-amber',
          tone === 'emerald' && 'text-emerald',
          tone === 'muted' && 'font-normal text-ink-faint',
          !tone && 'text-ink',
        )}
      >
        {value}
      </span>
      {sub && <span className="block text-micro text-ink-faint">{sub}</span>}
    </>
  );
}

function CompanyTable({
  rows,
  business,
  loading,
  now,
}: {
  rows: ConsoleRow[];
  business: BusinessMap | null;
  loading: boolean;
  now: Date;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-xs">
          <thead className="border-b border-border-strong bg-surface-2 text-left">
            <tr>
              <th className="field-label px-4 py-2.5">Empresa</th>
              <th className="field-label px-3 py-2.5">Estado</th>
              <th className="field-label px-3 py-2.5 text-right">Plata en riesgo</th>
              <th className="field-label px-3 py-2.5 text-right">Recuperado (mes)</th>
              <th className="field-label px-3 py-2.5 text-right">Ventas del mes</th>
              <th className="field-label px-3 py-2.5 text-right">Decisiones</th>
              <th className="field-label px-3 py-2.5 text-right">Procesos con error</th>
              <th className="field-label px-3 py-2.5 text-right">Puesta en marcha</th>
              <th className="px-3 py-2.5">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const b = row.owned
                ? (business?.[row.id] ?? (loading ? undefined : null))
                : undefined;
              const pending = row.owned && b === undefined;
              const status = pending ? null : companyStatus(row, b, now);
              const decisions =
                row.pulse.status === 'ready' ? row.pulse.approvals + row.pulse.actions : null;
              const na = <Cell value="—" tone="muted" />;
              return (
                <tr
                  key={row.id}
                  className="border-t border-border align-middle hover:bg-surface-2/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {row.kind === 'personal' ? (
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
                          <Home className="h-3.5 w-3.5" aria-hidden />
                        </span>
                      ) : (
                        <BrandMark name={row.name} brand={b?.brand} size="sm" />
                      )}
                      <span className="min-w-0">
                        {row.owned ? (
                          <Link
                            href={`/overview/companies/${encodeURIComponent(row.id)}`}
                            className="block truncate font-semibold text-ink hover:text-primary"
                          >
                            {row.name}
                          </Link>
                        ) : (
                          <span className="block truncate font-semibold text-ink">{row.name}</span>
                        )}
                        <span className="block text-micro text-ink-faint">
                          {row.kind === 'personal' ? 'Personal' : roleLabel(row.role)}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <StatusChip status={status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    {row.owned ? (
                      <Cell
                        loading={pending}
                        value={b?.risk ? compactCop(b.risk.total) : 'Sin dato'}
                        tone={
                          !b?.risk ? 'muted' : b.risk.receivablesOverdue > 0 ? 'rose' : undefined
                        }
                        sub={
                          b?.risk && b.risk.overdueInvoices > 0
                            ? `${b.risk.overdueInvoices} vencidas`
                            : undefined
                        }
                      />
                    ) : (
                      na
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    {row.owned ? (
                      <Cell
                        loading={pending}
                        value={b?.recovered ? compactCop(b.recovered.month) : 'Sin dato'}
                        tone={
                          !b?.recovered ? 'muted' : b.recovered.month > 0 ? 'emerald' : undefined
                        }
                      />
                    ) : (
                      na
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    {row.owned ? (
                      <Cell
                        loading={pending}
                        value={b?.sales ? compactCop(b.sales.month) : 'Sin dato'}
                        tone={b?.sales ? undefined : 'muted'}
                        sub={
                          b?.sales?.previous != null
                            ? `mes pasado ${compactCop(b.sales.previous)}`
                            : undefined
                        }
                      />
                    ) : (
                      na
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    <Cell
                      value={decisions ?? 'Sin dato'}
                      tone={decisions === null ? 'muted' : undefined}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    {row.owned ? (
                      <Cell
                        loading={pending}
                        value={b?.failing ? b.failing.total : 'Sin dato'}
                        tone={!b?.failing ? 'muted' : b.failing.total > 0 ? 'amber' : undefined}
                      />
                    ) : (
                      na
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    {row.owned ? (
                      <Cell
                        loading={pending}
                        value={b?.setup ? `${b.setup.percent} %` : 'Sin dato'}
                        tone={!b?.setup ? 'muted' : b.setup.percent === 100 ? 'emerald' : undefined}
                      />
                    ) : (
                      na
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    <OpenWorkspace
                      workspaceId={row.id}
                      href="/dashboard"
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-bold text-primary transition-colors hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
                    >
                      Entrar <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </OpenWorkspace>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

export interface FounderOverviewProps {
  rows: ConsoleRow[];
  unavailable: number;
  groups: Array<{ id: string; name: string }>;
  ownedCount: number;
  ownedLimit: number;
  /** Las cifras de negocio de las empresas propias; llegan después de la página. */
  business: BusinessSource;
  /** Sólo para el escaparate de desarrollo: la vista inicial. */
  initialView?: View;
}

export function FounderOverview({
  rows,
  unavailable,
  groups,
  ownedCount,
  ownedLimit,
  business: source,
  initialView = 'grid',
}: FounderOverviewProps) {
  const [view, setView] = useState<View>(initialView);
  const [filter, setFilter] = useState<GroupFilter>('all');
  const { business, loading } = useBusiness(source);
  // El reloj de «hace 3 días»: fijo durante la visita, igual en todas las tarjetas.
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === 'grid' || saved === 'table') setView(saved);
    } catch {
      /* Sin almacenamiento: la vista por defecto sirve igual. */
    }
  }, []);
  function chooseView(next: View) {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* Preferencia local, no dato: si no se guarda, no pasa nada. */
    }
  }

  // Un grupo borrado en otra pestaña no puede dejar el filtro apuntando a nada.
  const effectiveFilter =
    filter === 'all' || filter === 'ungrouped' || groups.some((g) => g.id === filter)
      ? filter
      : 'all';
  const visible = useMemo(() => filterRows(rows, effectiveFilter), [rows, effectiveFilter]);
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const companies = rows.filter((row) => row.kind === 'company').length;
  const actNow = useMemo(
    () =>
      rankActionItems(
        rows.map((row) => ({
          row,
          business: row.owned ? (business?.[row.id] ?? (loading ? undefined : null)) : undefined,
        })),
        { now },
      ),
    [rows, business, loading, now],
  );
  const businessOf = (row: ConsoleRow): CompanyBusiness | null | undefined =>
    row.owned ? (business?.[row.id] ?? (loading ? undefined : null)) : undefined;

  const filters: Array<{ id: GroupFilter; label: string }> = [
    { id: 'all', label: 'Todas' },
    ...groups.map((group) => ({ id: group.id, label: group.name })),
    ...(groups.length > 0 ? [{ id: 'ungrouped' as const, label: 'Sin grupo' }] : []),
  ];

  return (
    <div className="space-y-6">
      <TotalsBand rows={rows} business={business} loading={loading} companies={companies} />

      <section
        aria-labelledby="donde-actuar"
        className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
      >
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="donde-actuar" className="text-lg font-extrabold text-ink">
            Dónde actuar hoy
          </h2>
          <p className="text-micro text-ink-faint">
            Lo más importante entre todas tus empresas, primero lo que más pesa.
          </p>
        </div>
        <ActNowList items={actNow} loading={loading && ownedCount > 0} />
      </section>

      <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold text-ink">Tus empresas</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Cada una mantiene sus datos, conexiones y cerebro separados. «Entrar» la abre en esta
            pestaña sin cambiar las demás.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/notifications" className={QUIET_PILL}>
            <Bell className="h-4 w-4" aria-hidden /> Bandeja global
          </Link>
          <fieldset className="hidden rounded-pill border border-border bg-surface p-0.5 md:inline-flex">
            <legend className="sr-only">Vista</legend>
            {(
              [
                { id: 'grid', label: 'Tarjetas', Icon: LayoutGrid },
                { id: 'table', label: 'Tabla', Icon: List },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => chooseView(id)}
                className={clsx(
                  'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  view === id
                    ? 'bg-primary-soft text-primary-ink'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {label}
              </button>
            ))}
          </fieldset>
        </div>
      </div>

      {filters.length > 1 && (
        <nav
          aria-label="Filtrar por grupo"
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
        >
          {filters.map((item) => {
            const count = filterRows(rows, item.id).length;
            const selected = effectiveFilter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setFilter(item.id)}
                className={clsx(
                  'inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-pill border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  selected
                    ? 'border-primary/40 bg-primary-soft text-primary-ink'
                    : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {item.label}
                <span className="tabular text-micro opacity-70">{count}</span>
              </button>
            );
          })}
        </nav>
      )}

      {unavailable > 0 && (
        <output className="flex items-start gap-2 rounded-card border border-amber/30 bg-amber-soft px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
          {unavailable === 1
            ? '1 espacio no respondió; sus pendientes no están incluidos.'
            : `${unavailable} espacios no respondieron; sus pendientes no están incluidos.`}
        </output>
      )}

      {visible.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-10 text-center text-sm text-ink-muted">
          Ninguna empresa en este grupo todavía.
        </p>
      ) : (
        <>
          {view === 'table' && (
            <div className="hidden md:block">
              <CompanyTable rows={visible} business={business} loading={loading} now={now} />
            </div>
          )}
          <section
            aria-label="Empresas"
            className={clsx(
              'grid gap-4 md:grid-cols-2 2xl:grid-cols-3',
              view === 'table' && 'md:hidden',
            )}
          >
            {visible.map((row) => (
              <CompanyCard
                key={row.id}
                row={row}
                business={businessOf(row)}
                loading={loading}
                groupName={row.groupId ? (groupName.get(row.groupId) ?? null) : null}
                now={now}
              />
            ))}
          </section>
        </>
      )}

      <PlanAndUse rows={rows} ownedCount={ownedCount} ownedLimit={ownedLimit} />

      <aside className="flex items-start gap-3 rounded-card border border-border bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p>
          Las cifras de plata se suman sólo en pesos y sólo entre las empresas que fundaste; lo que
          esté en otra moneda va aparte, con su código. «Sin dato» quiere decir que esa cifra no se
          pudo leer ahora, no que sea cero. En las empresas donde eres gerente o colaborador ves tus
          pendientes; su negocio lo ve su fundador.
        </p>
      </aside>
    </div>
  );
}

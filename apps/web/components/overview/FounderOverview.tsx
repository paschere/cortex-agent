'use client';

/**
 * El centro de mando del fundador: todas sus empresas en una pantalla.
 *
 * ===========================================================================
 * QUÉ CAMBIÓ Y POR QUÉ
 * ===========================================================================
 * Antes esto era una rejilla de tarjetas iguales con cuatro contadores y una
 * banda oscura pintada con hexadecimales a mano (#18171d, zinc-400…), que en el
 * tema claro se leía como un bloque ajeno y en el oscuro duplicaba la paleta.
 * Ahora todo sale de los tokens (`surface`, `ink`, `primary-soft`…), así que
 * la pantalla hereda el tema del espacio autenticado sin una línea propia.
 *
 * Y lo que enseña es lo que un fundador necesita para decidir dónde entrar:
 * por empresa propia, la señal de salud, el plan con sus asientos, el consumo
 * de respuestas, cuánta gente hay y cuánta está por llegar, integraciones,
 * rutinas y cuándo hubo actividad por última vez — además de los cuatro
 * pendientes de siempre. Las empresas donde la cuenta es gerente o
 * colaboradora siguen saliendo, sólo con sus pendientes: su administración es
 * de otro fundador.
 *
 * Dos vistas del mismo dato —tarjetas para leer, tabla para comparar— y un
 * filtro por grupo empresarial. La elección de vista se recuerda en este
 * navegador; es una comodidad, no un dato, y si el almacenamiento no está
 * disponible la pantalla funciona igual.
 */

import {
  type ConsoleRow,
  type GroupFilter,
  answersPercent,
  filterRows,
  founderTotals,
  seatsLabel,
} from '@/lib/founder-console-shape';
import type { HealthTone } from '@/lib/founder-rules';
import { relativeTime } from '@/lib/relative-time';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  Activity,
  ArrowRight,
  Bell,
  Building2,
  CalendarClock,
  CircleAlert,
  Home,
  LayoutGrid,
  List,
  LockKeyhole,
  Plug,
  Repeat,
  Send,
  Settings2,
  ShieldCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { OpenWorkspace } from './OpenWorkspace';

type View = 'grid' | 'table';
const VIEW_KEY = 'cortex:founder-console:view';

function roleLabel(role: ConsoleRow['role']) {
  if (role === 'owner') return 'Fundador';
  if (role === 'admin') return 'Gerente';
  return 'Colaborador';
}

const HEALTH_TONE: Record<HealthTone, StatusTone> = {
  emerald: 'emerald',
  amber: 'amber',
  rose: 'rose',
  neutral: 'neutral',
};

const signals = [
  { key: 'approvals', label: 'Aprobaciones', caption: 'Pendientes de decisión', Icon: ShieldCheck },
  { key: 'actions', label: 'Acciones', caption: 'Listas para revisar', Icon: Send },
  { key: 'deadlines', label: 'Vencimientos', caption: 'Fechas por atender', Icon: CalendarClock },
  { key: 'blocked', label: 'Bloqueos', caption: 'Procesos que no avanzan', Icon: CircleAlert },
] as const;

const OPEN_CLASS =
  'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60';

function HealthChip({ row }: { row: ConsoleRow }) {
  if (row.pulse.status === 'unavailable')
    return <span className={chipClass('rose')}>Sin lectura</span>;
  if (!row.health) {
    return row.pulse.pending > 0 ? (
      <span className={chipClass('amber')}>
        {row.pulse.pending} {row.pulse.pending === 1 ? 'pendiente' : 'pendientes'}
      </span>
    ) : (
      <span className={chipClass('neutral')}>Al día</span>
    );
  }
  const tone = HEALTH_TONE[row.health.health.tone];
  return (
    <span className={chipClass(tone)}>
      <span
        aria-hidden
        className={clsx(
          'h-1.5 w-1.5 rounded-full',
          tone === 'emerald' && 'bg-emerald',
          tone === 'amber' && 'bg-amber',
          tone === 'rose' && 'bg-rose',
          tone === 'neutral' && 'bg-ink-faint',
        )}
      />
      {row.health.health.label}
    </span>
  );
}

function AnswersMeter({ row }: { row: ConsoleRow }) {
  const answers = row.health?.answers ?? null;
  const pct = answersPercent(answers);
  if (!answers) return <span className="text-ink-faint">—</span>;
  const bar =
    answers.state === 'blocked'
      ? 'bg-rose'
      : answers.state === 'grace' || answers.state === 'warning'
        ? 'bg-amber'
        : 'bg-primary';
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular text-ink">{answers.used.toLocaleString('es-CO')}</span>
        <span className="tabular text-micro text-ink-faint">
          {answers.limit === null ? 'sin límite' : `de ${answers.limit.toLocaleString('es-CO')}`}
        </span>
      </div>
      {pct !== null && (
        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={`Respuestas usadas: ${pct}%`}
        >
          <div
            className={clsx('h-full rounded-full', bar)}
            style={{ width: `${Math.max(pct, 3)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Fact({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: 'rose' | 'amber';
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-micro text-ink-faint">
        <span aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd
        className={clsx(
          'tabular mt-1 truncate text-sm font-semibold',
          tone === 'rose' ? 'text-rose' : tone === 'amber' ? 'text-amber' : 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function CompanyCard({ row }: { row: ConsoleRow }) {
  const personal = row.kind === 'personal';
  const Icon = personal ? Home : Building2;
  const health = row.health;
  return (
    <article
      className={clsx(
        'flex min-w-0 flex-col overflow-hidden rounded-card border bg-surface shadow-card',
        row.active ? 'border-primary/40' : 'border-border',
      )}
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-semibold text-ink">{row.name}</h3>
            {row.active && <span className={chipClass('primary')}>En esta pestaña</span>}
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-faint">
            {personal
              ? 'Espacio personal · Solo tú'
              : `${roleLabel(row.role)}${health?.planName ? ` · Plan ${health.planName}` : ''}`}
          </p>
        </div>
        <HealthChip row={row} />
      </header>

      {row.pulse.status === 'ready' ? (
        <dl className="grid grid-cols-4 border-y border-border">
          {signals.map(({ key, label, Icon: SignalIcon }, index) => (
            <div
              key={key}
              className={clsx('min-w-0 px-3 py-3', index > 0 && 'border-l border-border')}
            >
              <dt className="flex items-center gap-1 text-micro text-ink-faint">
                <SignalIcon className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
              </dt>
              <dd className="tabular mt-1 text-lg font-semibold text-ink">
                {row.pulse[key] ?? '—'}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="border-y border-border px-4 py-4 text-xs leading-relaxed text-rose">
          Cortex no pudo leer este espacio. Los demás resultados siguen separados y disponibles.
        </p>
      )}

      {health && health.status === 'ready' && (
        <div className="space-y-4 px-4 py-4">
          <div>
            <p className="mb-1.5 text-micro text-ink-faint">Respuestas este mes</p>
            <AnswersMeter row={row} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Fact
              icon={<Users className="h-3 w-3" />}
              label="Asientos"
              value={seatsLabel(health.seats)}
              tone={health.seats?.full ? 'amber' : undefined}
            />
            <Fact
              icon={<UserPlus className="h-3 w-3" />}
              label="Por aceptar"
              value={health.pendingInvitations}
            />
            <Fact
              icon={<Plug className="h-3 w-3" />}
              label="Integraciones"
              value={health.integrations ?? '—'}
            />
            <Fact
              icon={<Repeat className="h-3 w-3" />}
              label="Rutinas activas"
              value={health.routines?.active ?? '—'}
            />
            <Fact
              icon={<CircleAlert className="h-3 w-3" />}
              label="Fallos · 7 días"
              value={health.routines?.failedRecently ?? '—'}
              tone={(health.routines?.failedRecently ?? 0) > 0 ? 'amber' : undefined}
            />
            <Fact
              icon={<Activity className="h-3 w-3" />}
              label="Actividad"
              value={
                health.lastActivityAt ? (
                  <span suppressHydrationWarning>{relativeTime(health.lastActivityAt)}</span>
                ) : (
                  'Sin registro'
                )
              }
            />
          </dl>
        </div>
      )}
      {health && health.status === 'unavailable' && (
        <p className="px-4 py-4 text-xs text-ink-muted">
          El plan y el consumo de esta empresa no respondieron. Sus pendientes sí están arriba.
        </p>
      )}

      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-border px-3 py-2.5">
        {row.owned ? (
          <Link
            href={`/overview/companies/${encodeURIComponent(row.id)}`}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Administrar
          </Link>
        ) : (
          <span className="px-3 text-micro text-ink-faint">
            {personal ? 'Cerebro propio de tu espacio' : 'Lo administra su fundador'}
          </span>
        )}
        <OpenWorkspace
          workspaceId={row.id}
          href={row.pulse.pending > 0 ? '/approvals' : '/chat'}
          className={OPEN_CLASS}
        >
          {row.pulse.pending > 0 ? 'Revisar' : 'Abrir'}{' '}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </OpenWorkspace>
      </footer>
    </article>
  );
}

function CompanyTable({ rows }: { rows: ConsoleRow[] }) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-xs">
          <thead className="border-b border-border-strong bg-surface-2 text-left">
            <tr>
              <th className="field-label px-4 py-2.5">Espacio</th>
              <th className="field-label px-3 py-2.5">Salud</th>
              <th className="field-label px-3 py-2.5">Plan · asientos</th>
              <th className="field-label w-40 px-3 py-2.5">Respuestas</th>
              <th className="field-label px-3 py-2.5 text-right">Personas</th>
              <th className="field-label px-3 py-2.5 text-right">Integr.</th>
              <th className="field-label px-3 py-2.5 text-right">Rutinas</th>
              <th className="field-label px-3 py-2.5 text-right">Pendientes</th>
              <th className="field-label px-3 py-2.5">Actividad</th>
              <th className="px-3 py-2.5">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const health = row.health;
              return (
                <tr
                  key={row.id}
                  className="border-t border-border align-middle hover:bg-surface-2/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {row.kind === 'personal' ? (
                        <Home className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                      ) : (
                        <Building2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{row.name}</span>
                        <span className="block text-micro text-ink-faint">
                          {row.kind === 'personal' ? 'Personal' : roleLabel(row.role)}
                          {row.active ? ' · en esta pestaña' : ''}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <HealthChip row={row} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-ink-muted">
                    {health?.planName ? (
                      <>
                        <span className="text-ink">{health.planName}</span>
                        <span className="tabular block text-micro text-ink-faint">
                          {seatsLabel(health.seats)}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <AnswersMeter row={row} />
                  </td>
                  <td className="tabular whitespace-nowrap px-3 py-3 text-right text-ink">
                    {health ? (
                      <>
                        {health.members}
                        {health.pendingInvitations > 0 && (
                          <span className="block text-micro text-ink-faint">
                            +{health.pendingInvitations} por aceptar
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="tabular px-3 py-3 text-right text-ink">
                    {health?.integrations ?? '—'}
                  </td>
                  <td className="tabular whitespace-nowrap px-3 py-3 text-right text-ink">
                    {health?.routines ? (
                      <>
                        {health.routines.active}
                        {health.routines.failedRecently > 0 && (
                          <span className="block text-micro text-amber">
                            {health.routines.failedRecently} con fallo
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="tabular px-3 py-3 text-right font-semibold text-ink">
                    {row.pulse.status === 'ready' ? row.pulse.pending : '—'}
                  </td>
                  <td className="tabular whitespace-nowrap px-3 py-3 text-ink-muted">
                    {health?.lastActivityAt ? (
                      <span suppressHydrationWarning>{relativeTime(health.lastActivityAt)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {row.owned && (
                        <Link
                          href={`/overview/companies/${encodeURIComponent(row.id)}`}
                          aria-label={`Administrar ${row.name}`}
                          title="Administrar"
                          className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink"
                        >
                          <Settings2 className="h-3.5 w-3.5" aria-hidden />
                        </Link>
                      )}
                      <OpenWorkspace workspaceId={row.id} href="/chat" className={OPEN_CLASS}>
                        Abrir <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </OpenWorkspace>
                    </div>
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

export interface FounderOverviewProps {
  rows: ConsoleRow[];
  totals: { approvals: number; actions: number; deadlines: number; blocked: number };
  unavailable: number;
  groups: Array<{ id: string; name: string }>;
  ownedCount: number;
  ownedLimit: number;
}

export function FounderOverview({
  rows,
  totals,
  unavailable,
  groups,
  ownedCount,
  ownedLimit,
}: FounderOverviewProps) {
  const [view, setView] = useState<View>('grid');
  const [filter, setFilter] = useState<GroupFilter>('all');

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
  const admin = useMemo(() => founderTotals(rows), [rows]);
  const capPct = ownedLimit > 0 ? Math.min(100, Math.round((ownedCount / ownedLimit) * 100)) : 0;

  const filters: Array<{ id: GroupFilter; label: string }> = [
    { id: 'all', label: 'Todos' },
    ...groups.map((group) => ({ id: group.id, label: group.name })),
    ...(groups.length > 0 ? [{ id: 'ungrouped' as const, label: 'Sin grupo' }] : []),
  ];

  return (
    <div className="space-y-6">
      {/* Banda de pendientes: lo que espera una decisión, sumado entre espacios. */}
      <section
        aria-label="Pendientes de todos tus espacios"
        className="grid grid-cols-2 overflow-hidden rounded-card border border-border bg-surface shadow-card lg:grid-cols-4"
      >
        {signals.map(({ key, label, caption, Icon }, index) => (
          <div
            key={key}
            className={clsx(
              'min-w-0 px-4 py-4 sm:px-5 sm:py-5',
              index % 2 === 1 && 'border-l border-border',
              index > 1 && 'border-t border-border lg:border-t-0',
              index === 2 && 'lg:border-l',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-medium text-ink-muted">{label}</p>
              <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            </div>
            <p className="stat-num mt-3 text-display text-ink">{totals[key]}</p>
            <p className="mt-1 truncate text-micro text-ink-faint">{caption}</p>
          </div>
        ))}
      </section>

      {/* Administración: sólo cuenta empresas propias. */}
      {ownedCount > 0 && (
        <section
          aria-label="Administración de tus empresas"
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        >
          <div className="rounded-card border border-border bg-surface px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs text-ink-muted">Empresas propias</p>
              <p className="tabular text-sm font-semibold text-ink">
                {ownedCount} de {ownedLimit}
              </p>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={clsx('h-full rounded-full', capPct >= 100 ? 'bg-amber' : 'bg-primary')}
                style={{ width: `${Math.max(capPct, 4)}%` }}
              />
            </div>
            <p className="mt-1.5 text-micro text-ink-faint">
              {ownedCount >= ownedLimit
                ? 'Llegaste al tope de empresas por cuenta.'
                : `Puedes crear ${ownedLimit - ownedCount} más.`}
            </p>
          </div>
          <Link
            href="/overview/people"
            className="group rounded-card border border-border bg-surface px-4 py-3.5 transition-colors hover:border-border-strong"
          >
            <p className="flex items-center justify-between text-xs text-ink-muted">
              Personas en tus empresas
              <ArrowRight className="h-3.5 w-3.5 text-ink-faint transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none" />
            </p>
            <p className="tabular mt-1 text-lg font-semibold text-ink">{admin.members}</p>
            <p className="text-micro text-ink-faint">
              {admin.pendingInvitations > 0
                ? `${admin.pendingInvitations} ${admin.pendingInvitations === 1 ? 'invitación' : 'invitaciones'} por aceptar`
                : 'Sin invitaciones pendientes'}
            </p>
          </Link>
          <div className="rounded-card border border-border bg-surface px-4 py-3.5">
            <p className="text-xs text-ink-muted">Rutinas con fallos · 7 días</p>
            <p
              className={clsx(
                'tabular mt-1 text-lg font-semibold',
                admin.failedRoutines > 0 ? 'text-amber' : 'text-ink',
              )}
            >
              {admin.failedRoutines}
            </p>
            <p className="text-micro text-ink-faint">Ejecuciones con error en tus empresas</p>
          </div>
          <div className="rounded-card border border-border bg-surface px-4 py-3.5">
            <p className="text-xs text-ink-muted">Empresas que piden atención</p>
            <p
              className={clsx(
                'tabular mt-1 text-lg font-semibold',
                admin.attention > 0 ? 'text-amber' : 'text-emerald',
              )}
            >
              {admin.attention}
            </p>
            <p className="text-micro text-ink-faint">Cupo, cobro, rutinas o bloqueos</p>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink">Tus espacios</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Cada empresa mantiene sus datos, conexiones y cerebro separados.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/notifications"
            className="inline-flex min-h-9 items-center gap-2 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
          >
            <Bell className="h-4 w-4" aria-hidden /> Bandeja global
          </Link>
          <fieldset className="inline-flex rounded-pill border border-border bg-surface p-0.5">
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
            ? '1 espacio no respondió; sus cifras no están incluidas.'
            : `${unavailable} espacios no respondieron; sus cifras no están incluidas.`}
        </output>
      )}

      {visible.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-10 text-center text-sm text-ink-muted">
          Ningún espacio en este grupo todavía.
        </p>
      ) : view === 'grid' ? (
        <section className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {visible.map((row) => (
            <CompanyCard key={row.id} row={row} />
          ))}
        </section>
      ) : (
        <CompanyTable rows={visible} />
      )}

      <aside className="flex items-start gap-3 rounded-card border border-border bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p>
          Esta consola consolida cantidades operativas. Los valores financieros permanecen por
          empresa y moneda; Cortex no suma monedas o periodos incompatibles. Plan, asientos y
          personas sólo se muestran en las empresas que fundaste.
        </p>
      </aside>
    </div>
  );
}

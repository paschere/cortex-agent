import type { FounderOverviewData, WorkspacePulse } from '@/lib/founder-overview';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Bell,
  Brain,
  Building2,
  CalendarClock,
  CircleAlert,
  Home,
  LockKeyhole,
  Send,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { OpenWorkspace } from './OpenWorkspace';

function roleLabel(role: WorkspacePulse['workspace']['role']) {
  if (role === 'owner') return 'Fundador';
  if (role === 'admin') return 'Gerente';
  return 'Colaborador';
}

const signals = [
  { key: 'approvals', label: 'Aprobaciones', caption: 'Pendientes de decisión', Icon: ShieldCheck },
  { key: 'actions', label: 'Acciones', caption: 'Listas para revisar', Icon: Send },
  {
    key: 'deadlines',
    label: 'Vencimientos',
    caption: 'Fechas que requieren atención',
    Icon: CalendarClock,
  },
  { key: 'blocked', label: 'Bloqueos', caption: 'Procesos que no avanzan', Icon: CircleAlert },
] as const;

function WorkspaceCard({ item, activeId }: { item: WorkspacePulse; activeId: string }) {
  const personal = item.workspace.kind === 'personal';
  const active = item.workspace.id === activeId;
  const Icon = personal ? Home : Building2;
  const total = signals.reduce((sum, signal) => sum + (item[signal.key] ?? 0), 0);
  return (
    <article
      className={clsx(
        'overflow-hidden rounded-card border bg-surface shadow-card',
        personal ? 'border-primary/30' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-bold text-ink">{item.workspace.name}</h3>
            {active && (
              <span className="rounded-pill bg-emerald-soft px-2 py-0.5 text-micro font-semibold text-emerald">
                Activo
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {personal
              ? 'Espacio personal · Solo tú'
              : `Empresa · ${roleLabel(item.workspace.role)}`}
          </p>
        </div>
        <span
          className={clsx(
            'rounded-pill px-2 py-0.5 text-xs font-semibold tabular-nums',
            total ? 'bg-amber-soft text-amber' : 'bg-surface-2 text-ink-faint',
          )}
        >
          {item.status === 'ready' ? `${total} pendientes` : 'Sin lectura'}
        </span>
      </div>
      {item.status === 'ready' ? (
        <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
          {signals.map(({ key, label, Icon: SignalIcon }) => (
            <div key={key} className="px-3 py-3">
              <SignalIcon className="mb-2 h-3.5 w-3.5 text-ink-faint" aria-hidden />
              <p className="text-lg font-bold tabular-nums text-ink">{item[key] ?? '—'}</p>
              <p className="text-micro text-ink-faint">{label}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 py-5 text-xs leading-relaxed text-rose">
          Cortex no pudo leer este espacio. Los demás resultados siguen separados y disponibles.
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <Brain className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span>Cerebro propio de {personal ? 'tu espacio' : 'esta empresa'}</span>
        </div>
        <OpenWorkspace
          workspaceId={item.workspace.id}
          href={total > 0 ? '/approvals' : '/chat'}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
        >
          {total > 0 ? 'Revisar' : 'Abrir'} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </OpenWorkspace>
      </div>
    </article>
  );
}

export function FounderOverview({
  data,
  activeId,
}: { data: FounderOverviewData; activeId: string }) {
  return (
    <div className="space-y-6">
      <section
        aria-label="Resumen de trabajo"
        className="relative grid grid-cols-2 overflow-hidden rounded-xl border border-white/10 bg-[#18171d] shadow-[0_24px_70px_rgba(17,12,30,0.18)] xl:grid-cols-4"
      >
        <div className="pointer-events-none absolute -right-20 -top-32 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        {signals.map(({ key, label, caption, Icon }, index) => (
          <div
            key={key}
            className={clsx(
              'relative px-5 py-5',
              index % 2 === 1 && 'border-l border-white/10',
              index > 1 && 'border-t border-white/10',
              index > 0 && 'xl:border-l xl:border-t-0',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-zinc-400">{label}</p>
              <Icon className="h-4 w-4 text-primary" aria-hidden />
            </div>
            <p className="mt-5 text-3xl font-medium tracking-[-0.04em] tabular-nums text-white">
              {data.totals[key]}
            </p>
            <p className="mt-1 text-micro text-zinc-500">{caption}</p>
          </div>
        ))}
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">Tus espacios</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Cada empresa mantiene sus datos, conexiones y cerebro separados.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/chat/global"
            className="inline-flex min-h-9 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-white hover:bg-primary-strong"
          >
            Consultar varios espacios
          </Link>
          <Link
            href="/notifications"
            className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-xs font-semibold text-ink-muted hover:border-border-strong hover:text-ink"
          >
            <Bell className="h-4 w-4" aria-hidden /> Bandeja global
          </Link>
        </div>
      </div>
      {data.unavailable > 0 && (
        <output className="flex items-start gap-2 rounded-card border border-amber/30 bg-amber-soft px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
          {data.unavailable}{' '}
          {data.unavailable === 1 ? 'espacio no respondió' : 'espacios no respondieron'}; sus cifras
          no están incluidas.
        </output>
      )}
      <section className="grid gap-4 lg:grid-cols-2">
        {data.workspaces.map((item) => (
          <WorkspaceCard key={item.workspace.id} item={item} activeId={activeId} />
        ))}
      </section>
      <aside className="flex items-start gap-3 rounded-card border border-border bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p>
          Este overview consolida cantidades operativas. Los valores financieros permanecen por
          empresa y moneda; Cortex no suma monedas o periodos incompatibles.
        </p>
      </aside>
    </div>
  );
}

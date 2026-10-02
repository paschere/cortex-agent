import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { PlanView, RunListEntry, RunView, SettingsView } from '@/lib/autopilot/screen';
import { endSentence } from '@/lib/autopilot/text';
import { chipClass } from '@/lib/status-chip';
import { ArrowRight, CalendarClock, History, KeyRound, Plane } from 'lucide-react';
import Link from 'next/link';
import { DryRunPanel } from './DryRunPanel';
import { RunTimeline } from './RunDetail';
import { SettingsForm } from './SettingsForm';
import type { AutopilotActions } from './types';

/**
 * /piloto: «hazte cargo». Arriba lo de HOY (lo que hice y lo que te espera);
 * después el ensayo, cómo trabajo y los días anteriores. Se pinta igual en el
 * servidor y en /v/piloto-showcase: todo llega armado (lib/autopilot/screen.ts).
 */
export function AutopilotHome({
  settings,
  today,
  todayLabel,
  history,
  waiting,
  actions,
  canEdit,
  initialPlan = null,
}: {
  settings: SettingsView;
  today: RunView | null;
  todayLabel: string;
  history: RunListEntry[];
  /** Lo que espera decisión de cualquier día vigente. */
  waiting: number;
  actions: AutopilotActions;
  canEdit: boolean;
  initialPlan?: PlanView | null;
}) {
  return (
    <>
      <PageHeader
        title="Piloto automático"
        subtitle="Cada mañana reviso la empresa, hago lo rutinario que me permitiste y te dejo sólo lo que de verdad necesita tu decisión."
        icon={<Plane className="h-5 w-5" />}
        actions={
          <Link
            href="/admin/mandates"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
            Lo que puedo hacer sin preguntar
          </Link>
        }
      />

      <div className="space-y-6">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Hoy · {todayLabel}
              </p>
              <h2 className="mt-1 text-balance text-xl font-extrabold leading-tight text-ink sm:text-2xl">
                {today
                  ? today.summary
                  : settings.enabled
                    ? `Todavía no he corrido hoy. ${endSentence(settings.nextRunLabel)}`
                    : 'El piloto está apagado.'}
              </h2>
              {today?.startedLabel && (
                <p className="mt-1 text-xs text-ink-muted">
                  {today.finishedLabel
                    ? `Corrí de ${today.startedLabel} a ${today.finishedLabel}`
                    : `Empecé a las ${today.startedLabel}`}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {today && <span className={chipClass(today.statusTone)}>{today.statusLabel}</span>}
              {waiting > 0 && (
                <span className={chipClass('amber')}>
                  {waiting === 1 ? '1 espera tu decisión' : `${waiting} esperan tu decisión`}
                </span>
              )}
              {today && (
                <Link
                  href={`/piloto/${today.id}`}
                  className="inline-flex min-h-9 items-center gap-1 rounded-pill px-3 py-1.5 text-xs font-semibold text-primary-ink hover:bg-primary-soft"
                >
                  Ver el detalle <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              )}
            </div>
          </div>
          <div className="px-5 py-5 sm:px-6">
            {today ? (
              <RunTimeline run={today} actions={actions} canDecide={canEdit} compact />
            ) : (
              <p className="flex items-start gap-2 text-sm text-ink-muted">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                {settings.enabled
                  ? `Corro ${settings.scheduleLabel}. Cuando termine te aviso en la campana${settings.notifyEmail ? ' y por correo' : ''}: «Hoy hice N cosas; necesito tu decisión en M».`
                  : 'Cuando lo enciendas, cada mañana haré lo rutinario y te dejaré la lista corta de lo que necesita tu decisión. Pruébalo abajo sin que haga nada.'}
              </p>
            )}
          </div>
        </Panel>

        <DryRunPanel actions={actions} initial={initialPlan} />

        <SettingsForm view={settings} actions={actions} canEdit={canEdit} />

        <Panel className="p-5 sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <History className="h-4 w-4 text-ink-faint" aria-hidden />
            <h2 className="text-lg font-extrabold text-ink">Días anteriores</h2>
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-ink-muted">Todavía no hay corridas.</p>
          ) : (
            <ul className="divide-y divide-border">
              {history.map((r) => (
                <li key={r.id}>
                  <Link
                    href={r.href}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 transition-colors hover:text-primary-ink"
                  >
                    <span className="w-44 shrink-0 text-sm font-semibold text-ink first-letter:uppercase">
                      {r.dayLabel}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-ink-muted">{r.summary}</span>
                    <span className={chipClass(r.statusTone)}>{r.statusLabel}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

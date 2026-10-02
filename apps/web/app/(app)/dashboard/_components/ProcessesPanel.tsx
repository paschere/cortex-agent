import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { PROCESS_STATE_LABEL, type ProcessState } from '@/lib/self-service/processes';
import { readProcesses } from '@/lib/self-service/read';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { AlarmClock, ArrowRight, FolderSync, RefreshCw } from 'lucide-react';
import Link from 'next/link';

/**
 * «TUS PROCESOS»: lo que Cortex tiene andando solo.
 *
 * Carpetas que llenan tablas, fuentes que sincronizan y rutinas con hora, en
 * una sola lista con un estado que se entiende sin abrir nada. Lo que falló va
 * arriba (el orden lo pone `shapeProcesses`). Sin procesos, la tarjeta invita
 * a activar el primero en lugar de mostrarse vacía.
 */

const TONE: Record<ProcessState, StatusTone> = {
  ok: 'emerald',
  error: 'rose',
  paused: 'neutral',
  waiting: 'amber',
};

const ICON = {
  drive: FolderSync,
  sync: RefreshCw,
  routine: AlarmClock,
} as const;

export async function ProcessesPanel({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const items = await readProcesses(getOrgScopedClient(organizationId), userId);

  return (
    <Panel className="mb-4 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Tus procesos</h2>
        <Link
          href="/onboarding/fuentes?paso=proceso"
          className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:text-primary-strong"
        >
          Activar otro <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-border-strong bg-surface-2/50 px-4 py-4">
          <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
            Todavía nada corre solo. Un proceso es algo que Cortex hace sin que se lo pidas: llenar
            una tabla con lo que llega al Drive, avisar la cartera, resumirte el día.
          </p>
          <Link
            href="/onboarding/fuentes?paso=proceso"
            className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-xs font-bold text-white hover:bg-primary-strong"
          >
            Ver los procesos listos <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const Icon = ICON[item.kind];
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="flex items-center gap-3 rounded-card px-1.5 py-3 transition-colors hover:bg-surface-2"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{item.name}</span>
                    <span className="block truncate text-xs text-ink-faint">
                      {item.state === 'error' && item.error ? item.error : item.detail}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-micro text-ink-faint sm:block">
                    {item.lastRunAt ? relativeTime(item.lastRunAt) : 'Aún no corre'}
                  </span>
                  <span className={chipClass(TONE[item.state])}>
                    {PROCESS_STATE_LABEL[item.state]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

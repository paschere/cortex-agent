import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { RunView } from '@/lib/autopilot/screen';
import { chipClass } from '@/lib/status-chip';
import { ArrowLeft, Info, Plane } from 'lucide-react';
import Link from 'next/link';
import { ItemCard, ItemList } from './ItemCard';
import { ItemDecision } from './ItemDecision';
import type { AutopilotActions } from './types';

/**
 * «LO QUE HICE HOY»: la corrida de un día, por secciones — lo que espera tu
 * decisión primero (es lo único que te pide algo), después lo hecho con su
 * verificación y su enlace para deshacer, lo que no salió, lo que sólo te
 * cuento y lo omitido.
 */
export function RunTimeline({
  run,
  actions,
  canDecide,
  compact = false,
}: {
  run: RunView;
  actions: AutopilotActions;
  canDecide: boolean;
  compact?: boolean;
}) {
  if (run.sections.length === 0)
    return <p className="text-sm text-ink-muted">Esta corrida no encontró nada que hacer.</p>;
  return (
    <div className="space-y-6">
      <dl className="flex flex-wrap gap-2 text-xs">
        <Count label="Hice" value={run.counts.done} tone="emerald" />
        <Count label="Esperan tu decisión" value={run.counts.asked} tone="amber" />
        <Count label="Para que sepas" value={run.counts.told} tone="neutral" />
        {run.counts.failed > 0 && (
          <Count label="No salieron" value={run.counts.failed} tone="rose" />
        )}
        {run.counts.skipped > 0 && (
          <Count label="Omitidas" value={run.counts.skipped} tone="neutral" />
        )}
      </dl>
      {run.sections.map((s) => (
        <section key={s.key} aria-label={s.title}>
          <h3 className="text-sm font-extrabold text-ink">
            {s.title} <span className="font-semibold text-ink-faint">({s.items.length})</span>
          </h3>
          {!compact && <p className="mb-3 text-xs text-ink-muted">{s.hint}</p>}
          <div className={compact ? 'mt-3' : ''}>
            <ItemList>
              {(compact && s.key !== 'asked' ? s.items.slice(0, 4) : s.items).map((item) => (
                <ItemCard
                  key={item.id ?? item.title}
                  item={item}
                  actions={
                    canDecide && item.id && item.contentHash && item.status === 'asked' ? (
                      <ItemDecision
                        itemId={item.id}
                        contentHash={item.contentHash}
                        actions={actions}
                      />
                    ) : null
                  }
                />
              ))}
            </ItemList>
            {compact && s.key !== 'asked' && s.items.length > 4 && (
              <Link
                href={`/piloto/${run.id}`}
                className="mt-2 inline-block pl-6 text-xs font-semibold text-primary-ink hover:underline"
              >
                Y {s.items.length - 4} más →
              </Link>
            )}
          </div>
        </section>
      ))}
      {run.sourceErrors.length > 0 && (
        <p className="flex gap-1.5 rounded-sm bg-amber-soft px-3 py-2 text-xs text-amber">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
          No pude mirar {run.sourceErrors.join(', ')}: lo de ahí no entró a la corrida.
        </p>
      )}
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'amber' | 'neutral' | 'rose';
}) {
  return (
    <div className={chipClass(tone)}>
      <dt>{label}:</dt>
      <dd className="tabular font-bold">{value}</dd>
    </div>
  );
}

export function RunDetail({
  run,
  actions,
  canDecide,
}: {
  run: RunView;
  actions: AutopilotActions;
  canDecide: boolean;
}) {
  return (
    <>
      <PageHeader
        title={`Lo que hice el ${run.dayLabel}`}
        subtitle={run.summary}
        icon={<Plane className="h-5 w-5" />}
        actions={
          <>
            <span className={chipClass(run.statusTone)}>{run.statusLabel}</span>
            <Link
              href="/piloto"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Piloto automático
            </Link>
          </>
        }
      />
      <Panel className="p-5 sm:p-6">
        <RunTimeline run={run} actions={actions} canDecide={canDecide} />
      </Panel>
    </>
  );
}

import { Panel } from '@/components/ui/panel';
import { METRIC_HELP, TIER_LABEL, delta, pct, toneFor, type Direction } from '@/lib/evaluation-shape';
import type { StoredRun } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, Minus } from 'lucide-react';

/**
 * The newest run, in full.
 *
 * A SERVER COMPONENT, and that is load-bearing rather than incidental: it
 * imports `StoredRun` from `@cortex/agent-tools`, and a `'use client'` file that
 * imported anything from that package — even a type, if the import is not
 * erased — pulls `node:dns` into the browser bundle and fails the production
 * build while typecheck and test stay green. Nothing on this card is
 * interactive, so there is nothing to gain by making it a client component and
 * a build to lose. See `lib/evaluation-shape.ts`.
 *
 * EVERY FIGURE IS MONOSPACED, per the design system: these are numbers somebody
 * will quote in a pull request, and a quotable number is evidence.
 */

function Trend({
  direction,
  before,
  after,
  asPercent = true,
}: {
  direction: Direction;
  before: number | undefined;
  after: number;
  asPercent?: boolean;
}) {
  const text = delta(before, after, asPercent);
  const tone = toneFor(direction, before, after);
  if (!text) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
        <Minus className="h-3 w-3" />
        {before === undefined ? 'sin comparación' : 'igual'}
      </span>
    );
  }
  const rising = after > (before ?? after);
  const Icon = rising ? ArrowUp : ArrowDown;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 font-mono text-[11px]',
        tone === 'good' && 'text-emerald',
        tone === 'bad' && 'text-rose',
        tone === 'flat' && 'text-ink-faint',
      )}
    >
      <Icon className="h-3 w-3" />
      {text}
    </span>
  );
}

function Metric({
  label,
  value,
  help,
  direction,
  before,
  after,
  asPercent = true,
}: {
  label: string;
  value: string;
  help: string;
  direction: Direction;
  before: number | undefined;
  after: number;
  asPercent?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="field-label">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-[22px] font-semibold tracking-[-0.02em] text-ink">
          {value}
        </span>
        <Trend direction={direction} before={before} after={after} asPercent={asPercent} />
      </div>
      <p className="mt-1 text-[11px] leading-snug text-ink-faint">{help}</p>
    </div>
  );
}

/** A count that is supposed to be zero, drawn so that not-zero is unmissable. */
function FailureCount({
  label,
  value,
  help,
  before,
}: {
  label: string;
  value: number;
  help: string;
  before: number | undefined;
}) {
  const bad = value > 0;
  return (
    <div
      className={clsx(
        'rounded-sm px-4 py-3',
        bad ? 'bg-rose-soft' : 'bg-emerald-soft',
      )}
    >
      <div className="field-label">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={clsx(
            'font-mono text-[22px] font-semibold tracking-[-0.02em]',
            bad ? 'text-rose' : 'text-emerald',
          )}
        >
          {value}
        </span>
        <Trend direction="down" before={before} after={value} asPercent={false} />
      </div>
      <p className={clsx('mt-1 text-[11px] leading-snug', bad ? 'text-rose' : 'text-ink-muted')}>
        {help}
      </p>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-sm bg-amber-soft px-4 py-3 text-[12px] leading-relaxed text-amber">
      <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

const FULL_DATE = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

export function RunCard({ run, baseline }: { run: StoredRun; baseline?: StoredRun }) {
  return (
    <Panel className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">Última corrida</h2>
          <p className="mt-1 font-mono text-[12px] text-ink-muted">
            {FULL_DATE.format(new Date(run.startedAt))} · {TIER_LABEL[run.tier]}
          </p>
          <p className="mt-1 text-[12px] text-ink-faint">
            {run.vectorSource} · embeddings{' '}
            <span className="font-mono text-ink-muted">{run.embeddingModel}</span> · corte{' '}
            <span className="font-mono text-ink-muted">{run.strongMatch}</span> · piso{' '}
            <span className="font-mono text-ink-muted">{run.weakFloor}</span>
          </p>
        </div>
        <div className="text-right">
          <div className="field-label">Costo y duración</div>
          <p className="mt-1 font-mono text-[13px] text-ink">
            USD {run.costUsd.toFixed(4)} · {(run.elapsedMs / 1000).toFixed(1)} s
          </p>
        </div>
      </div>

      {baseline ? (
        <p className="mt-3 text-[12px] text-ink-faint">
          Comparada contra la corrida del{' '}
          <span className="font-mono">
            {FULL_DATE.format(new Date(baseline.startedAt))}
          </span>
          , que respondió el mismo cuestionario en la misma modalidad.
        </p>
      ) : (
        <p className="mt-3 text-[12px] text-ink-faint">
          No hay una corrida anterior que haya respondido el mismo cuestionario en la misma
          modalidad, así que no se muestran diferencias. Comparar contra otra sería medir el cambio
          del cuestionario, no el del sistema.
        </p>
      )}

      {/* The two counts first: they are the two ways this system fails, and
          lowering the relevance floor trades one for the other. */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <FailureCount
          label="Descartados por el piso"
          value={run.retrieval.missedByFloor}
          help={METRIC_HELP.missedByFloor}
          before={baseline?.retrieval.missedByFloor}
        />
        <FailureCount
          label="Respondidos de más"
          value={run.retrieval.overclaimed}
          help={METRIC_HELP.overclaimed}
          before={baseline?.retrieval.overclaimed}
        />
      </div>

      <div className="mt-6">
        <h3 className="field-label mb-3">Recuperación · {run.retrieval.cases} preguntas</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          <Metric
            label="Fundamento"
            value={pct(run.retrieval.grounding)}
            help={METRIC_HELP.grounding}
            direction="up"
            before={baseline?.retrieval.grounding}
            after={run.retrieval.grounding}
          />
          <Metric
            label="Prudencia"
            value={pct(run.retrieval.restraint)}
            help={METRIC_HELP.restraint}
            direction="up"
            before={baseline?.retrieval.restraint}
            after={run.retrieval.restraint}
          />
          <Metric
            label="Primer lugar"
            value={pct(run.retrieval.top1)}
            help={METRIC_HELP.top1}
            direction="up"
            before={baseline?.retrieval.top1}
            after={run.retrieval.top1}
          />
        </div>
      </div>

      <div className="mt-6">
        <h3 className="field-label mb-3">Selección de herramientas · {run.selection.cases} peticiones</h3>
        <div className="grid gap-5 sm:grid-cols-3">
          <Metric
            label="Alcance"
            value={pct(run.selection.reach)}
            help={METRIC_HELP.reach}
            direction="up"
            before={baseline?.selection.reach}
            after={run.selection.reach}
          />
        </div>
      </div>

      {run.answers && (
        <div className="mt-6">
          <h3 className="field-label mb-3">Respuestas · {run.answers.cases} preguntas</h3>
          {!run.answers.judgeTrusted && (
            <Notice>
              El juez no pasó su propia calibración: dejó pasar el{' '}
              <span className="font-mono">{pct(run.answers.judgeLeniency)}</span> de las respuestas
              que están mal a propósito y reprobó el{' '}
              <span className="font-mono">{pct(run.answers.judgeSeverity)}</span> de las que están
              bien. Los dos números de abajo no son de fiar en esta corrida.
            </Notice>
          )}
          <div className={clsx('grid gap-5 sm:grid-cols-3', !run.answers.judgeTrusted && 'mt-4 opacity-60')}>
            <Metric
              label="Fundamento"
              value={pct(run.answers.grounding)}
              help={METRIC_HELP.grounding}
              direction="up"
              before={baseline?.answers?.grounding}
              after={run.answers.grounding}
            />
            <Metric
              label="Prudencia"
              value={pct(run.answers.restraint)}
              help={METRIC_HELP.restraint}
              direction="up"
              before={baseline?.answers?.restraint}
              after={run.answers.restraint}
            />
          </div>
        </div>
      )}

      {!run.calibrationMeasured && (
        <Notice>
          Los umbrales de relevancia de{' '}
          <span className="font-mono">{run.embeddingModel}</span> nunca se midieron, así que toda la
          capa de recuperación se calificó contra cortes provisionales. Hay que correrle la medición
          del corpus y agregar el modelo a <span className="font-mono">CALIBRATIONS</span> en{' '}
          <span className="font-mono">kb/relevance.ts</span>.
        </Notice>
      )}

      {run.warnings.map((warning) => (
        <Notice key={warning}>{warning}</Notice>
      ))}
    </Panel>
  );
}

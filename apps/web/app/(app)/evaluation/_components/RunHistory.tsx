import { Panel } from '@/components/ui/panel';
import { TIER_LABEL, pct } from '@/lib/evaluation-shape';
import type { StoredRun } from '@cortex/agent-tools';
import { clsx } from 'clsx';

/**
 * The runs before this one, as a table.
 *
 * WHY THE SUITE FINGERPRINT IS A COLUMN AND NOT A DETAIL. It is the only thing
 * on the row that says whether two lines may be read against each other. Two
 * runs with different fingerprints answered different questions, and a reader
 * scanning a column of percentages will compare them anyway unless the reason
 * not to is on the same line. It is printed short and monospaced, which is
 * enough for "these two are the same" without pretending anybody reads the hash.
 *
 * The count columns are drawn in rose whenever they are not zero, on every row,
 * because a month in which "descartados por el piso" was quietly two the whole
 * time is exactly the thing this table exists to make visible.
 */

const SHORT_DATE = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

function Count({ value }: { value: number }) {
  return (
    <span className={clsx('font-mono', value > 0 ? 'font-semibold text-rose' : 'text-ink-faint')}>
      {value}
    </span>
  );
}

export function RunHistory({ runs }: { runs: StoredRun[] }) {
  return (
    <section className="mt-8">
      <h2 className="field-label mb-3">Historial</h2>
      <Panel className="overflow-hidden">
        {/* The table scrolls inside its own box rather than pushing the page
            sideways on a phone. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-[12px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="field-label px-4 py-2.5 font-normal">Cuándo</th>
                <th className="field-label px-4 py-2.5 font-normal">Modalidad</th>
                <th className="field-label px-4 py-2.5 font-normal">Fundamento</th>
                <th className="field-label px-4 py-2.5 font-normal">Prudencia</th>
                <th className="field-label px-4 py-2.5 font-normal">Herramientas</th>
                <th className="field-label px-4 py-2.5 font-normal">Descartados</th>
                <th className="field-label px-4 py-2.5 font-normal">De más</th>
                <th className="field-label px-4 py-2.5 font-normal">Cuestionario</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-border/60 last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-ink-muted">
                    {SHORT_DATE.format(new Date(run.startedAt))}
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">{TIER_LABEL[run.tier]}</td>
                  <td className="px-4 py-2.5 font-mono text-ink">{pct(run.retrieval.grounding)}</td>
                  <td className="px-4 py-2.5 font-mono text-ink">{pct(run.retrieval.restraint)}</td>
                  <td className="px-4 py-2.5 font-mono text-ink">{pct(run.selection.reach)}</td>
                  <td className="px-4 py-2.5">
                    <Count value={run.retrieval.missedByFloor} />
                  </td>
                  <td className="px-4 py-2.5">
                    <Count value={run.retrieval.overclaimed} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-ink-faint">
                    {run.suiteDigest.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <p className="mt-2 text-[11px] leading-snug text-ink-faint">
        Dos filas solo se pueden leer una contra otra si tienen el mismo cuestionario y la misma
        modalidad. Con cuestionarios distintos no se respondió lo mismo, y la diferencia entre sus
        puntajes no es una mejora más pequeña: no es un número.
      </p>
    </section>
  );
}

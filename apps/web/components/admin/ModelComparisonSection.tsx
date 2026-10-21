import { Panel } from '@/components/ui/panel';
import type { ComparisonRow, ModelComparison } from '@/lib/model-comparison';
import { formatUsd } from '@/lib/model-pricing';
import { FlaskConical } from 'lucide-react';

/**
 * COMPARACIÓN POR MODELO en /admin/usage (0236): turnos, costo por turno y por
 * conversación, % de turnos con fallo de herramienta, reintentos, refusals y
 * 👍/👎, para el experimento de Haiku 5.5 contra Sonnet 5.5 en el chat. Todo
 * llega calculado (lib/model-comparison.ts); aquí sólo se pinta.
 */

const num = (n: number) => Math.round(n).toLocaleString('es-CO');
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(n < 10 ? 1 : 0)} %`);
const usd = (n: number | null) => (n === null ? '—' : formatUsd(n));

function Table({ title, note, rows }: { title: string; note?: string; rows: ComparisonRow[] }) {
  return (
    <div className="mb-5 last:mb-0">
      <div className="field-label mb-1">{title}</div>
      {note && <p className="mb-2 text-micro leading-relaxed text-ink-faint">{note}</p>}
      <div className="overflow-x-auto rounded-sm border border-border">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="bg-surface-2 text-micro uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="px-3 py-2 font-semibold">Modelo</th>
              <th className="px-3 py-2 text-right font-semibold">Turnos</th>
              <th className="px-3 py-2 text-right font-semibold">Conversaciones</th>
              <th className="px-3 py-2 text-right font-semibold">$ / turno</th>
              <th className="px-3 py-2 text-right font-semibold">$ / conversación</th>
              <th className="px-3 py-2 text-right font-semibold">
                Turnos con error de herramienta
              </th>
              <th className="px-3 py-2 text-right font-semibold">Reintentos</th>
              <th className="px-3 py-2 text-right font-semibold">Refusals</th>
              <th className="px-3 py-2 text-right font-semibold">👍 / 👎</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="px-3 py-2 font-semibold text-ink">
                  {r.label}
                  {r.fellBack > 0 && (
                    <span className="ml-2 font-normal text-ink-faint">
                      ({num(r.fellBack)} turnos rescatados por Sonnet)
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">{num(r.turns)}</td>
                <td className="px-3 py-2 text-right">{num(r.conversations)}</td>
                <td className="px-3 py-2 text-right">{usd(r.usdPerTurn)}</td>
                <td className="px-3 py-2 text-right">{usd(r.usdPerConversation)}</td>
                <td className="px-3 py-2 text-right">
                  {pct(r.turns > 0 ? r.toolErrorPct : null)}{' '}
                  <span className="text-ink-faint">({num(r.toolErrors)})</span>
                </td>
                <td className="px-3 py-2 text-right">{num(r.retries)}</td>
                <td className="px-3 py-2 text-right">{num(r.refusals)}</td>
                <td className="px-3 py-2 text-right">
                  {num(r.up)} / {num(r.down)}{' '}
                  <span className="text-ink-faint">({pct(r.downPct)} 👎)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ModelComparisonSection({
  data,
  days,
}: {
  data: ModelComparison;
  days: number;
}) {
  return (
    <Panel className="p-4" aria-label="Comparación por modelo">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
        <FlaskConical className="h-4 w-4 text-ink-faint" aria-hidden />
        Comparación por modelo · últimos {days} días
      </div>
      {data.byModel.length === 0 ? (
        <div className="flex h-20 items-center justify-center rounded-sm border border-border bg-surface-2 px-4 text-center text-xs text-ink-muted">
          Todavía no hay turnos de chat registrados en esta ventana.
        </div>
      ) : (
        <>
          <Table
            title="Por modelo que respondió"
            rows={data.byModel}
            note="Sólo turnos de chat. «Turnos con error de herramienta» cuenta los turnos con al menos una herramienta fallida; entre paréntesis, el total de fallos."
          />
          {data.hasExperiment && (
            <Table
              title="Experimento: por brazo asignado a la conversación"
              rows={data.byArm}
              note="Una conversación asignada a Haiku que pasó a Sonnet tras dos fallos de herramienta o un refusal sigue contando aquí como Haiku."
            />
          )}
        </>
      )}
    </Panel>
  );
}

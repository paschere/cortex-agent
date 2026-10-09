import { Panel, PanelHead } from '@/components/ui/panel';
import type { CompanyQuality } from '@/lib/quality-health';
import { Activity } from 'lucide-react';

/**
 * Salud interna de las respuestas por empresa (7 días). Sólo lectura, sólo para
 * quien dirige empresas: la página que lo monta ya exige contexto de fundador.
 */

const REASONS: Record<string, string> = {
  wrong_data: 'Dato equivocado',
  not_requested: 'No hizo lo que pedí',
  slow: 'Muy lento',
  other: 'Otro',
};

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;
}

export function QualityHealth({ companies }: { companies: CompanyQuality[] }) {
  if (companies.length === 0) return null;
  return (
    <section aria-label="Salud de las respuestas" className="mt-8">
      <Panel>
        <PanelHead
          title="Salud de las respuestas · 7 días"
          icon={<Activity className="h-4 w-4" />}
        />
        <div className="divide-y divide-border">
          {companies.map(({ organizationId, name, summary }) => (
            <div key={organizationId} className="space-y-3 px-6 py-4">
              <p className="text-sm font-bold text-ink">{name}</p>
              {!summary ? (
                <p className="text-xs text-ink-muted">Sin lectura.</p>
              ) : (
                <>
                  <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
                    <Stat label="Turnos" value={String(summary.turns)} />
                    <Stat
                      label="Cortados o con error"
                      value={
                        summary.brokenRatio === null
                          ? '—'
                          : `${Math.round(summary.brokenRatio * 100)} % (${summary.brokenTurns})`
                      }
                    />
                    <Stat label="Mediana" value={seconds(summary.p50Ms)} />
                    <Stat label="p95" value={seconds(summary.p95Ms)} />
                    <Stat label="👍 / 👎" value={`${summary.up} / ${summary.down}`} />
                  </dl>
                  {summary.failingTools.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-ink-muted">
                        Herramientas que más fallan
                      </p>
                      <ul className="mt-1 flex flex-wrap gap-1.5">
                        {summary.failingTools.map((t) => (
                          <li
                            key={t.toolId}
                            className="rounded-pill bg-rose-soft px-2.5 py-0.5 text-micro font-semibold text-rose"
                          >
                            {t.toolId} · {t.errors}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {summary.latestDown.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-ink-muted">
                        Últimos 👎 con comentario
                      </p>
                      <ul className="mt-1 space-y-1">
                        {summary.latestDown.map((d) => (
                          <li key={d.createdAt + d.comment} className="text-xs text-ink">
                            {d.reason && (
                              <span className="font-semibold text-rose">
                                {REASONS[d.reason] ?? d.reason}:{' '}
                              </span>
                            )}
                            {d.comment}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-base font-bold text-ink">{value}</dd>
    </div>
  );
}

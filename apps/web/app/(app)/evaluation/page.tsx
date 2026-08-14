import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { latestRuns } from '@cortex/agent-tools';
import { Gauge } from 'lucide-react';
import { RunCard } from './_components/RunCard';
import { RunHistory } from './_components/RunHistory';

/**
 * Evaluación — si un cambio mejoró o empeoró las respuestas.
 *
 * THE SHAPE OF THE SCREEN. The newest run in full at the top, with every number
 * carrying its change against the last COMPARABLE run underneath it; then the
 * history as a short table. Nothing on this page starts a run — the runs happen
 * in `pnpm test` and on somebody's terminal, and a button here would be a fourth
 * way to run the same thing, on a server that has no provider key.
 *
 * WHY THE BASELINE IS NOT SIMPLY "THE PREVIOUS ROW". A run is only comparable
 * with another that took the same test on the same tier: same `suite_digest`,
 * same tier. Comparing a `live` run against last week's `offline` one, or
 * against a run taken before four questions were added, produces a delta that is
 * about the change in the test rather than the change in the system. When there
 * is no comparable predecessor the screen says so and shows no deltas at all,
 * which is the honest version of not knowing.
 *
 * WHY THE TWO COUNTS COME BEFORE THE PERCENTAGES. `descartados por el piso` and
 * `respondidos de más` are the two ways this system fails, and lowering the
 * relevance floor trades one for the other. A percentage slides smoothly while
 * that happens; the counts do not, which is why they are the first thing on the
 * card and not a footnote.
 *
 * Everything is read through the workspace-scoped handle; nothing filters by
 * organization by hand.
 */

export const dynamic = 'force-dynamic';

export default async function EvaluationPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const runs = await latestRuns(db, 40);

  const latest = runs[0];
  // The most recent run that answered the same questions on the same tier.
  const baseline = runs
    .slice(1)
    .find(
      (r) =>
        !!latest && r.suiteDigest === latest.suiteDigest && r.tier === latest.tier,
    );

  return (
    <>
      <PageHeader
        title="Evaluación"
        subtitle="Un conjunto de preguntas con respuesta conocida que corre contra el sistema real. Dice con un número si un cambio mejoró o empeoró las respuestas, en vez de dejarlo a la impresión de quien lo hizo."
        icon={<Gauge className="h-5 w-5" />}
      />

      {!latest ? (
        <Panel className="p-8 text-center">
          <h2 className="text-base font-semibold text-ink">Todavía no hay corridas guardadas</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
            La evaluación corre sola en cada cambio, dentro de las pruebas, y ahí no guarda nada:
            pasa o falla. Acá se guarda lo que se corre a mano contra la API en vivo, que es lo que
            sirve para ver si un número viene bajando desde hace semanas. Está explicado en{' '}
            <span className="font-mono text-xs text-ink">docs/operations/answer-quality.md</span>.
          </p>
        </Panel>
      ) : (
        <>
          <RunCard run={latest} baseline={baseline} />
          {runs.length > 1 && <RunHistory runs={runs} />}
        </>
      )}
    </>
  );
}
